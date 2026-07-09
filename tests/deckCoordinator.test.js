"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadGjsModule } = require("./helpers/loadGjsModule");
const { FakeWm, makeFakeMainloop } = require("./helpers/fakeWm");

// DeckCoordinator orchestrates a real Controller + real ProjectStore; only the
// WM, mainloop, persistence, Notion writer, and dialogs are faked. This is the
// whole point of the extraction: the toggle/deck-sync logic that used to live in
// applet.js is now exercisable under Node.

const Mapping = loadGjsModule("core/mapping.js", "Mapping");
const State = loadGjsModule("core/State.js", "State");
const ProjectMapper = loadGjsModule("notion/ProjectMapper.js", "ProjectMapper");

const DEFAULT_WS_PER_PROJECT = 1;
const PLACEHOLDER = [{ id: "placeholder", name: "Connect Notion", wsCount: 1 }];

function makeFakePersistence() {
    const files = new Map();
    return {
        files,
        writeJSON(filename, obj) { files.set(filename, JSON.parse(JSON.stringify(obj))); return true; },
        readJSON(filename, fallback) {
            if (!files.has(filename)) return fallback === undefined ? null : fallback;
            return JSON.parse(JSON.stringify(files.get(filename)));
        },
    };
}

// Always-succeeding Notion writer that records the pushes it received.
function makeAutoWriter() {
    const calls = [];
    return {
        calls,
        async setWorkspaceFlag(id, value) { calls.push({ kind: "flag", id, value }); },
        async setWorkspaceOrder(id, order) { calls.push({ kind: "order", id, value: order }); },
    };
}

// Dialogs double: confirm() answers from a queue; notify() is recorded.
function makeFakeDialogs(confirmAnswers) {
    const answers = (confirmAnswers || []).slice();
    const calls = { confirm: [], notify: [] };
    return {
        calls,
        confirm(title, msg, label) {
            calls.confirm.push({ title, msg, label });
            return Promise.resolve(answers.length ? answers.shift() : true);
        },
        notify(title, msg) { calls.notify.push({ title, msg }); },
    };
}

function makeController() {
    const mainloop = makeFakeMainloop();
    const lib = {
        browser: { Browser: { openUrlNewWindow() {} } },
        constants: { Constants: { CLOSE_GRACE_MS: 0 } },
    };
    const coreDeps = { core: { mapping: { Mapping: Mapping } }, lib: lib };
    const Navigation = loadGjsModule("core/Navigation.js", "Navigation", { applet: coreDeps });
    const DeckReorder = loadGjsModule("core/DeckReorder.js", "DeckReorder", { applet: coreDeps });
    const ProjectLifecycle = loadGjsModule("core/ProjectLifecycle.js", "ProjectLifecycle",
        { applet: coreDeps, extraImports: { mainloop: mainloop } });
    const Controller = loadGjsModule("core/Controller.js", "Controller", {
        applet: {
            core: {
                mapping: { Mapping: Mapping },
                State: { State: State },
                Navigation: { Navigation: Navigation },
                DeckReorder: { DeckReorder: DeckReorder },
                ProjectLifecycle: { ProjectLifecycle: ProjectLifecycle },
            },
            lib: lib,
        },
        extraImports: { mainloop: mainloop },
    });
    const wm = new FakeWm(1);
    return { controller: new Controller(wm), wm, mainloop };
}

function makeStore(persistence) {
    const ProjectStore = loadGjsModule("core/ProjectStore.js", "ProjectStore", {
        applet: { notion: { ProjectMapper: { ProjectMapper: ProjectMapper } } },
    });
    return new ProjectStore(persistence);
}

// Full stack: seed the cache with `cached` projects, build store + controller +
// coordinator, and record which hooks fired.
function makeStack(cached, confirmAnswers) {
    const persistence = makeFakePersistence();
    if (cached) persistence.writeJSON("projects-cache.json", { projects: cached });

    const store = makeStore(persistence);
    const writer = makeAutoWriter();
    store.setWriter(writer);

    const { controller, wm, mainloop } = makeController();
    const dialogs = makeFakeDialogs(confirmAnswers);
    const hookCalls = { rebuildPanel: 0, refresh: 0, refreshTogglePanel: 0 };

    const DeckCoordinator = loadGjsModule("core/DeckCoordinator.js", "DeckCoordinator");
    const coord = new DeckCoordinator({
        store, controller, dialogs,
        defaultWsPerProject: DEFAULT_WS_PER_PROJECT,
        placeholderProjects: PLACEHOLDER,
        hooks: {
            rebuildPanel: () => hookCalls.rebuildPanel++,
            refresh: () => hookCalls.refresh++,
            refreshTogglePanel: () => hookCalls.refreshTogglePanel++,
        },
    });

    return { coord, store, controller, wm, mainloop, writer, dialogs, hookCalls, persistence };
}

// handleToggle OFF awaits the confirm dialog (a microtask) BEFORE
// removeProjectLive registers its grace timeout, so we must let the microtask
// queue drain first, then flush the fake mainloop to release the timeout.
async function drainThenFlush(mainloop) {
    await new Promise((r) => setImmediate(r));
    mainloop.flush();
}

function proj(id, inWorkspace, order) {
    return { id, name: id.toUpperCase(), icon: null, notionUrl: null, inWorkspace, order };
}

function deckIds(controller) {
    const ids = [];
    for (let i = 0; i < controller.state.projectCount(); i++) {
        ids.push(controller.state.getProject(i).id);
    }
    return ids;
}

// loadDeckFromStore

test("loadDeckFromStore loads the inWorkspace subset in order", () => {
    const { coord, controller, wm } = makeStack([
        proj("a", true, 0), proj("b", false, null), proj("c", true, 1),
    ]);
    coord.loadDeckFromStore();
    assert.deepEqual(deckIds(controller), ["a", "c"]);
    assert.equal(wm.getWorkspaceCount(), 2); // one home each
});

test("loadDeckFromStore falls back to the placeholder when nothing is on", () => {
    const { coord, controller } = makeStack([proj("a", false, null)]);
    coord.loadDeckFromStore();
    assert.deepEqual(deckIds(controller), ["placeholder"]);
});

// handleToggle ON

test("handleToggle ON appends to the deck, flips the flag, assigns max+1 order", async () => {
    const { coord, store, controller, writer, hookCalls } = makeStack([
        proj("a", true, 0), proj("b", false, null),
    ]);
    coord.loadDeckFromStore();

    await coord.handleToggle(store.get("b"), true);

    assert.deepEqual(deckIds(controller), ["a", "b"]);
    assert.equal(store.get("b").inWorkspace, true);
    assert.equal(store.get("b").order, 1); // maxOrder was 0 -> 0+1
    await new Promise((r) => setImmediate(r)); // let queued pushes drain
    assert.ok(writer.calls.some((c) => c.kind === "flag" && c.id === "b" && c.value === true));
    assert.ok(hookCalls.rebuildPanel > 0);
});

test("handleToggle ON is idempotent — re-toggling an already-deck project doesn't duplicate", async () => {
    // Reproduces the class of the be29088 duplicate-deck bug from the service layer.
    const { coord, store, controller } = makeStack([proj("a", false, null)]);
    coord.loadDeckFromStore(); // placeholder deck
    await coord.handleToggle(store.get("a"), true);
    await coord.handleToggle(store.get("a"), true);
    const ids = deckIds(controller).filter((id) => id === "a");
    assert.equal(ids.length, 1);
});

// handleToggle OFF

test("handleToggle OFF confirms, removes from the deck, clears flag + order", async () => {
    const { coord, store, controller, wm, mainloop, dialogs } =
        makeStack([proj("a", true, 0), proj("b", true, 1)], [true]);
    coord.loadDeckFromStore();
    assert.equal(wm.getWorkspaceCount(), 2);

    const p = coord.handleToggle(store.get("b"), false);
    await drainThenFlush(mainloop); // confirm resolves, then release the grace timeout
    await p;

    assert.equal(dialogs.calls.confirm.length, 1);
    assert.deepEqual(deckIds(controller), ["a"]);
    assert.equal(store.get("b").inWorkspace, false);
    assert.equal(store.get("b").order, null);
});

test("handleToggle OFF rejects with 'cancelled' and leaves the deck intact", async () => {
    const { coord, store, controller } =
        makeStack([proj("a", true, 0), proj("b", true, 1)], [false]);
    coord.loadDeckFromStore();

    await assert.rejects(() => coord.handleToggle(store.get("b"), false),
        (e) => e.message === "cancelled");
    assert.deepEqual(deckIds(controller), ["a", "b"]);
    assert.equal(store.get("b").inWorkspace, true); // unchanged
});

test("handleToggle OFF surfaces windows-open: notifies, rejects, keeps the project", async () => {
    const { coord, store, controller, wm, mainloop, dialogs } =
        makeStack([proj("a", true, 0), proj("b", true, 1)], [true]);
    coord.loadDeckFromStore();
    // b's home is flat index 1; a stubborn window that ignores the close request.
    wm.addWindow(1, "unsaved.txt");

    const p = coord.handleToggle(store.get("b"), false);
    await drainThenFlush(mainloop); // grace elapses; window still there (no honorCloseRequests)
    await assert.rejects(() => p, (e) => e.message === "windows-open");

    assert.equal(dialogs.calls.notify.length, 1);
    assert.deepEqual(deckIds(controller), ["a", "b"]); // still present
    assert.equal(store.get("b").inWorkspace, true);
});

// onPull

test("onPull merges catalog fields and auto-appends a newly-on project", () => {
    const { coord, store, controller, hookCalls } = makeStack([proj("a", true, 0)]);
    coord.loadDeckFromStore();
    assert.deepEqual(deckIds(controller), ["a"]);

    coord.onPull([
        { id: "a", name: "A renamed", icon: null, notionUrl: null, inWorkspace: true, order: 0 },
        { id: "b", name: "B", icon: null, notionUrl: null, inWorkspace: true, order: 1 },
    ]);

    assert.equal(store.get("a").name, "A renamed"); // catalog field took remote
    assert.deepEqual(deckIds(controller), ["a", "b"]); // b auto-appended
    assert.ok(hookCalls.rebuildPanel > 0);
});

test("onPull never auto-removes a project unchecked in Notion", () => {
    const { coord, store, controller } = makeStack([proj("a", true, 0), proj("b", true, 1)]);
    coord.loadDeckFromStore();

    // Remote now shows b as OFF; the deck must keep it (removal is explicit-only).
    coord.onPull([
        { id: "a", name: "A", icon: null, notionUrl: null, inWorkspace: true, order: 0 },
        { id: "b", name: "B", icon: null, notionUrl: null, inWorkspace: false, order: null },
    ]);
    assert.deepEqual(deckIds(controller), ["a", "b"]);
});

test("onPull doesn't double-append a project already in the deck", () => {
    const { coord, store, controller } = makeStack([proj("a", true, 0)]);
    coord.loadDeckFromStore();
    coord.onPull([{ id: "a", name: "A", icon: null, notionUrl: null, inWorkspace: true, order: 0 }]);
    assert.deepEqual(deckIds(controller), ["a"]);
});

// reorderFromPanel

test("reorderFromPanel resolves the moved id to its deck index and reorders", () => {
    const { coord, controller } = makeStack([
        proj("a", true, 0), proj("b", true, 1), proj("c", true, 2),
    ]);
    coord.loadDeckFromStore();
    coord.reorderFromPanel("c", 0); // move c to the front
    assert.deepEqual(deckIds(controller), ["c", "a", "b"]);
});

test("reorderFromPanel is a no-op for an unknown id", () => {
    const { coord, controller } = makeStack([proj("a", true, 0), proj("b", true, 1)]);
    coord.loadDeckFromStore();
    coord.reorderFromPanel("nope", 0);
    assert.deepEqual(deckIds(controller), ["a", "b"]);
});
