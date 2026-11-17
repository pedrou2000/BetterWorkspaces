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
        writeJSON(filename, obj) {
            files.set(filename, JSON.parse(JSON.stringify(obj)));
            return true;
        },
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
        async setWorkspaceFlag(id, value) {
            calls.push({ kind: "flag", id, value });
        },
        async setWorkspaceOrder(id, order) {
            calls.push({ kind: "order", id, value: order });
        },
    };
}

// Dialogs double: notify() is recorded.
function makeFakeDialogs() {
    const calls = { notify: [] };
    return {
        calls,
        notify(title, msg) {
            calls.notify.push({ title, msg });
        },
    };
}

function makeController(wm) {
    const mainloop = makeFakeMainloop();
    const lib = {
        browser: { Browser: { openUrlNewWindow() {} } },
        constants: { Constants: { CLOSE_GRACE_MS: 0 } },
    };
    const coreDeps = { core: { mapping: { Mapping: Mapping } }, lib: lib };
    const Navigation = loadGjsModule("core/Navigation.js", "Navigation", { applet: coreDeps });
    const DeckReorder = loadGjsModule("core/DeckReorder.js", "DeckReorder", { applet: coreDeps });
    const ProjectLifecycle = loadGjsModule("core/ProjectLifecycle.js", "ProjectLifecycle", {
        applet: coreDeps,
        extraImports: { mainloop: mainloop },
    });
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
    wm = wm || new FakeWm(1);
    return { controller: new Controller(wm), wm, mainloop };
}

function makeStore(persistence) {
    const ProjectStore = loadGjsModule("core/ProjectStore.js", "ProjectStore", {
        applet: { notion: { ProjectMapper: { ProjectMapper: ProjectMapper } } },
    });
    return new ProjectStore(persistence);
}

// Full stack: seed the cache with `cached` projects, build store + controller +
// coordinator, and record which hooks fired. opts.wm / opts.layout stand in for
// a session that already exists when the applet loads (a Cinnamon restart).
function makeStack(cached, opts) {
    opts = opts || {};
    const persistence = makeFakePersistence();
    if (cached) persistence.writeJSON("projects-cache.json", { projects: cached });
    if (opts.layout) persistence.writeJSON("layout.json", { strips: opts.layout });

    const store = makeStore(persistence);
    const writer = makeAutoWriter();
    store.setWriter(writer);

    const { controller, wm, mainloop } = makeController(opts.wm);
    const dialogs = makeFakeDialogs();
    const hookCalls = { rebuildPanel: 0, refresh: 0, refreshTogglePanel: 0 };

    const DeckCoordinator = loadGjsModule("core/DeckCoordinator.js", "DeckCoordinator");
    const coord = new DeckCoordinator({
        store,
        controller,
        persistence,
        dialogs,
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
        proj("a", true, 0),
        proj("b", false, null),
        proj("c", true, 1),
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

// layout persistence (strip sizes across an applet reload)

function savedStrips(persistence) {
    return persistence.readJSON("layout.json").strips;
}

// A live session: 5 workspaces laid out as a=[0,1,2] b=[3,4], with windows.
function liveSession() {
    const wm = new FakeWm(5);
    wm.addWindow(1, "a-editor");
    wm.addWindow(4, "b-browser");
    wm.activeIndex = 4;
    return wm;
}

test("strip growth, deck changes and reorders are all saved to layout.json", async () => {
    const { coord, store, controller, persistence } = makeStack([
        proj("a", true, 0),
        proj("b", true, 1),
        proj("c", false, null),
    ]);
    coord.loadDeckFromStore();
    assert.deepEqual(savedStrips(persistence), [
        { id: "a", wsCount: 1 },
        { id: "b", wsCount: 1 },
    ]);

    controller.addWorkspaceToActiveProject(); // a grows to 2
    await coord.handleToggle(store.get("c"), true);
    controller.reorderProject(2, 0); // c to the front
    assert.deepEqual(savedStrips(persistence), [
        { id: "c", wsCount: 1 },
        { id: "a", wsCount: 2 },
        { id: "b", wsCount: 1 },
    ]);
});

test("reload over a live session restores strip sizes and moves nothing", () => {
    const wm = liveSession();
    const { coord, controller } = makeStack([proj("a", true, 0), proj("b", true, 1)], {
        wm,
        layout: [
            { id: "a", wsCount: 3 },
            { id: "b", wsCount: 2 },
        ],
    });
    coord.loadDeckFromStore();

    assert.deepEqual(controller.state.counts(), [3, 2]);
    assert.deepEqual(wm.layout(), [[], ["a-editor"], [], [], ["b-browser"]]);
    assert.equal(wm.activeIndex, 4); // the user stays where they were
    assert.equal(controller.state.activeProjectIdx, 1);
    assert.equal(controller.state.getLastLocal(1), 1);
});

test("an empty session (fresh login) starts from one workspace per project", () => {
    const { coord, controller, wm } = makeStack([proj("a", true, 0), proj("b", true, 1)], {
        wm: new FakeWm(5),
        layout: [
            { id: "a", wsCount: 3 },
            { id: "b", wsCount: 2 },
        ],
    });
    coord.loadDeckFromStore();
    assert.deepEqual(controller.state.counts(), [1, 1]);
    assert.equal(wm.getWorkspaceCount(), 2);
});

test("a saved layout that no longer matches the deck or the workspace total is ignored", () => {
    const cached = [proj("a", true, 0), proj("b", true, 1)];
    const cases = [
        [
            { id: "b", wsCount: 2 }, // deck order differs
            { id: "a", wsCount: 3 },
        ],
        [{ id: "a", wsCount: 5 }], // deck size differs
        [
            { id: "a", wsCount: 3 }, // total 4, reality has 5
            { id: "b", wsCount: 1 },
        ],
        [
            { id: "a", wsCount: 5 }, // corrupt count
            { id: "b", wsCount: 0 },
        ],
    ];
    for (const layout of cases) {
        const { coord, controller } = makeStack(cached, { wm: liveSession(), layout });
        coord.loadDeckFromStore();
        assert.deepEqual(controller.state.counts(), [1, 1], JSON.stringify(layout));
    }
});

// handleToggle ON

test("handleToggle ON appends to the deck, flips the flag, assigns max+1 order", async () => {
    const { coord, store, controller, wm, writer, hookCalls } = makeStack([
        proj("a", true, 0),
        proj("b", false, null),
    ]);
    coord.loadDeckFromStore();

    await coord.handleToggle(store.get("b"), true);

    assert.deepEqual(deckIds(controller), ["a", "b"]);
    assert.equal(controller.state.activeProjectIdx, 1); // and we land on it
    assert.equal(wm.getActiveIndex(), 1);
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

// openProject (the panel's "go")

test("openProject switches to a project that is already on the deck", async () => {
    const { coord, controller, wm } = makeStack([proj("a", true, 0), proj("b", true, 1)]);
    coord.loadDeckFromStore();

    await coord.openProject({ id: "b", name: "B" });
    assert.equal(controller.state.activeProject().id, "b");
    assert.equal(wm.getActiveIndex(), 1);
    assert.deepEqual(deckIds(controller), ["a", "b"]); // nothing added or removed
});

test("openProject turns an off project on and lands on it", async () => {
    const { coord, store, controller, wm } = makeStack([
        proj("a", true, 0),
        proj("b", false, null),
    ]);
    coord.loadDeckFromStore();

    await coord.openProject(store.get("b"));
    assert.deepEqual(deckIds(controller), ["a", "b"]);
    assert.equal(store.get("b").inWorkspace, true);
    assert.equal(wm.getActiveIndex(), 1);
});

test("openProject on the project you are on doesn't move you within it", async () => {
    const { coord, controller, wm } = makeStack([proj("a", true, 0), proj("b", true, 1)]);
    coord.loadDeckFromStore();
    controller.addWorkspaceToActiveProject(); // a: 2 workspaces, now on the second
    wm.goToWorkspace(0); // moved back by other means; a's last-used is still 1

    await coord.openProject({ id: "a", name: "A" });
    assert.equal(wm.getActiveIndex(), 0);
});

// handleToggle OFF

test("handleToggle OFF removes from the deck without asking, clears flag + order", async () => {
    const { coord, store, controller, wm, mainloop, dialogs } = makeStack([
        proj("a", true, 0),
        proj("b", true, 1),
    ]);
    coord.loadDeckFromStore();
    assert.equal(wm.getWorkspaceCount(), 2);

    const p = coord.handleToggle(store.get("b"), false);
    mainloop.flush(); // release the close-grace timeout
    await p;

    assert.equal(dialogs.calls.notify.length, 0);
    assert.deepEqual(deckIds(controller), ["a"]);
    assert.equal(wm.getWorkspaceCount(), 1);
    assert.equal(store.get("b").inWorkspace, false);
    assert.equal(store.get("b").order, null);
});

test("handleToggle OFF surfaces windows-open: notifies, rejects, keeps the project", async () => {
    const { coord, store, controller, wm, mainloop, dialogs } = makeStack([
        proj("a", true, 0),
        proj("b", true, 1),
    ]);
    coord.loadDeckFromStore();
    // b's home is flat index 1; a stubborn window that ignores the close request.
    wm.addWindow(1, "unsaved.txt");

    const p = coord.handleToggle(store.get("b"), false);
    mainloop.flush(); // grace elapses; window still there (no honorCloseRequests)
    await assert.rejects(
        () => p,
        (e) => e.message === "windows-open",
    );

    assert.equal(dialogs.calls.notify.length, 1);
    assert.deepEqual(deckIds(controller), ["a", "b"]); // still present
    assert.equal(store.get("b").inWorkspace, true);
});

// removeFromWorkspaces (context menu / double-click)

test("removeFromWorkspaces removes a deck project and resolves true", async () => {
    const { coord, store, controller, mainloop } = makeStack([
        proj("a", true, 0),
        proj("b", true, 1),
    ]);
    coord.loadDeckFromStore();

    const p = coord.removeFromWorkspaces("b");
    mainloop.flush();
    assert.equal(await p, true);
    assert.deepEqual(deckIds(controller), ["a"]);
    assert.equal(store.get("b").inWorkspace, false);
});

test("removeFromWorkspaces resolves false for an unknown id or a refused removal", async () => {
    const { coord, controller, wm, mainloop, dialogs } = makeStack([
        proj("a", true, 0),
        proj("b", true, 1),
    ]);
    coord.loadDeckFromStore();
    assert.equal(await coord.removeFromWorkspaces("placeholder"), false);

    wm.addWindow(1, "unsaved.txt"); // b's window ignores the close request
    const p = coord.removeFromWorkspaces("b");
    mainloop.flush();
    assert.equal(await p, false);
    assert.equal(dialogs.calls.notify.length, 1);
    assert.deepEqual(deckIds(controller), ["a", "b"]);
});

test("overlapping removals each remove their own project, not a stale position", async () => {
    // a and b go while c (with a window) must survive: once a is gone, b's
    // original position is c's.
    const { coord, store, controller, wm, mainloop } = makeStack([
        proj("a", true, 0),
        proj("b", true, 1),
        proj("c", true, 2),
    ]);
    coord.loadDeckFromStore();
    wm.addWindow(2, "c-win");

    const p1 = coord.removeFromWorkspaces("a");
    const p2 = coord.removeFromWorkspaces("b");
    mainloop.flush(); // both grace periods elapse together
    assert.deepEqual(await Promise.all([p1, p2]), [true, true]);

    assert.deepEqual(deckIds(controller), ["c"]);
    assert.deepEqual(wm.layout(), [["c-win"]]);
    assert.equal(store.get("c").inWorkspace, true);
});

test("removing the same project twice at once removes it once", async () => {
    const { coord, controller, wm, mainloop } = makeStack([
        proj("a", true, 0),
        proj("b", true, 1),
        proj("c", true, 2),
    ]);
    coord.loadDeckFromStore();
    wm.addWindow(2, "c-win");

    const p1 = coord.removeFromWorkspaces("b");
    const p2 = coord.removeFromWorkspaces("b"); // e.g. a triple-click
    mainloop.flush();
    assert.deepEqual(await Promise.all([p1, p2]), [true, false]);

    assert.deepEqual(deckIds(controller), ["a", "c"]);
    assert.deepEqual(wm.layout(), [[], ["c-win"]]);
});

// onPull

test("onPull merges catalog fields and auto-appends a newly-on project", () => {
    const { coord, store, controller, wm, hookCalls } = makeStack([proj("a", true, 0)]);
    coord.loadDeckFromStore();
    assert.deepEqual(deckIds(controller), ["a"]);

    coord.onPull([
        { id: "a", name: "A renamed", icon: null, notionUrl: null, inWorkspace: true, order: 0 },
        { id: "b", name: "B", icon: null, notionUrl: null, inWorkspace: true, order: 1 },
    ]);

    assert.equal(store.get("a").name, "A renamed"); // catalog field took remote
    assert.equal(controller.state.getProject(0).name, "A renamed"); // deck refreshed live
    assert.deepEqual(deckIds(controller), ["a", "b"]); // b auto-appended
    assert.equal(wm.getActiveIndex(), 0); // a background sync never moves the user
    assert.ok(hookCalls.rebuildPanel > 0);
});

test("onPull refreshes a changed icon on an existing deck project", () => {
    const { coord, controller } = makeStack([proj("a", true, 0)]);
    coord.loadDeckFromStore();

    const newIcon = { type: "emoji", value: "🚀" };
    coord.onPull([
        { id: "a", name: "A", icon: newIcon, notionUrl: null, inWorkspace: true, order: 0 },
    ]);
    assert.deepEqual(controller.state.getProject(0).icon, newIcon);
});

test("onPull never auto-removes a project unchecked in Notion", () => {
    const { coord, controller } = makeStack([proj("a", true, 0), proj("b", true, 1)]);
    coord.loadDeckFromStore();

    // Remote now shows b as OFF; the deck must keep it (removal is explicit-only).
    coord.onPull([
        { id: "a", name: "A", icon: null, notionUrl: null, inWorkspace: true, order: 0 },
        { id: "b", name: "B", icon: null, notionUrl: null, inWorkspace: false, order: null },
    ]);
    assert.deepEqual(deckIds(controller), ["a", "b"]);
});

test("onPull doesn't double-append a project already in the deck", () => {
    const { coord, controller } = makeStack([proj("a", true, 0)]);
    coord.loadDeckFromStore();
    coord.onPull([
        { id: "a", name: "A", icon: null, notionUrl: null, inWorkspace: true, order: 0 },
    ]);
    assert.deepEqual(deckIds(controller), ["a"]);
});

test("onPull replaces the placeholder deck with real projects (no leftover)", () => {
    const { coord, controller } = makeStack(); // empty cache -> placeholder deck
    coord.loadDeckFromStore();
    assert.deepEqual(deckIds(controller), ["placeholder"]);

    coord.onPull([
        { id: "a", name: "A", icon: null, notionUrl: null, inWorkspace: true, order: 0 },
        { id: "b", name: "B", icon: null, notionUrl: null, inWorkspace: true, order: 1 },
    ]);
    assert.deepEqual(deckIds(controller), ["a", "b"]);
});

// onPull: projects gone from Notion (archived / deleted)

function remote(id, inWorkspace, order) {
    return { id, name: id.toUpperCase(), icon: null, notionUrl: null, inWorkspace, order };
}

test("a deck project gone from Notion is removed once nothing is open on it", () => {
    const { coord, store, controller, wm } = makeStack([
        proj("a", true, 0),
        proj("b", true, 1),
        proj("c", true, 2),
    ]);
    coord.loadDeckFromStore();
    wm.addWindow(2, "c-win");

    coord.onPull([remote("a", true, 0), remote("c", true, 2)], true); // b was archived

    assert.deepEqual(deckIds(controller), ["a", "c"]);
    assert.deepEqual(wm.layout(), [[], ["c-win"]]); // c's window moved with it
    assert.equal(store.get("b"), null); // and it left the catalog
});

// Let the async part of a pull-driven removal finish: the close-grace timer,
// then the promise continuation behind it.
async function settle(mainloop) {
    mainloop.flush();
    await new Promise((r) => setImmediate(r));
}

test("a gone project's windows are closed and it leaves the deck and the catalog", async () => {
    const { coord, store, controller, wm, mainloop, dialogs } = makeStack([
        proj("a", true, 0),
        proj("b", true, 1),
    ]);
    coord.loadDeckFromStore();
    const win = wm.addWindow(1, "b-notes");

    coord.onPull([remote("a", true, 0)], true); // b was archived
    assert.equal(win.closeRequested, true);
    wm.honorCloseRequests(); // the app closes
    await settle(mainloop);

    assert.deepEqual(deckIds(controller), ["a"]);
    assert.equal(wm.getWorkspaceCount(), 1);
    assert.equal(store.get("b"), null);
    assert.equal(dialogs.calls.notify.length, 0); // a background sync never pops a dialog
});

test("a window that refuses to close is asked once; the project goes when it does close", async () => {
    const { coord, controller, wm, mainloop, dialogs } = makeStack([
        proj("a", true, 0),
        proj("b", true, 1),
    ]);
    coord.loadDeckFromStore();
    const win = wm.addWindow(1, "unsaved.txt");
    const pull = [remote("a", true, 0)];

    coord.onPull(pull, true);
    await settle(mainloop); // grace elapses with the window still open
    assert.deepEqual(deckIds(controller), ["a", "b"]);
    assert.equal(dialogs.calls.notify.length, 0);

    win.closeRequested = false;
    coord.onPull(pull, true); // next sync: no second close request
    await settle(mainloop);
    assert.equal(win.closeRequested, false);
    assert.deepEqual(deckIds(controller), ["a", "b"]);

    win.closeRequested = true;
    wm.honorCloseRequests(); // the user finally closes it
    coord.onPull(pull, true);
    assert.deepEqual(deckIds(controller), ["a"]);
});

test("a project that comes back and is archived again is asked to close again", async () => {
    const { coord, wm, mainloop } = makeStack([proj("a", true, 0), proj("b", true, 1)]);
    coord.loadDeckFromStore();
    const win = wm.addWindow(1, "unsaved.txt");

    coord.onPull([remote("a", true, 0)], true);
    await settle(mainloop);
    win.closeRequested = false;

    coord.onPull([remote("a", true, 0), remote("b", true, 1)], true); // un-archived
    coord.onPull([remote("a", true, 0)], true); // archived again
    assert.equal(win.closeRequested, true);
    await settle(mainloop);
});

test("a truncated pull, an empty pull, or another database touches nothing", async () => {
    const { coord, controller, wm, mainloop } = makeStack([proj("a", true, 0), proj("b", true, 1)]);
    coord.loadDeckFromStore();
    const win = wm.addWindow(1, "b-notes");

    coord.onPull([remote("a", true, 0)], false); // Notion had more pages
    coord.onPull([], true); // unreadable database
    coord.onPull([remote("x", true, 0), remote("y", false, null)], true); // a different one
    await settle(mainloop);

    assert.equal(win.closeRequested, false);
    assert.deepEqual(deckIds(controller).slice(0, 2), ["a", "b"]);
});

test("removing a gone project the user is on lands on the previous project", () => {
    const { coord, controller, wm } = makeStack([
        proj("a", true, 0),
        proj("b", true, 1),
        proj("c", true, 2),
    ]);
    coord.loadDeckFromStore();
    controller.goToProject(2);
    controller.goToProject(1); // on b, came from c

    coord.onPull([remote("a", true, 0), remote("c", true, 2)], true);
    assert.deepEqual(deckIds(controller), ["a", "c"]);
    assert.equal(controller.state.activeProject().id, "c");
    assert.equal(wm.getActiveIndex(), 1);
});

test("a deck whose every project is gone falls back to the placeholder", () => {
    const { coord, controller, wm } = makeStack([
        proj("a", true, 0),
        proj("b", true, 1),
        proj("c", false, null),
    ]);
    coord.loadDeckFromStore();

    coord.onPull([remote("c", false, null)], true); // same database: c is still there
    assert.deepEqual(deckIds(controller), ["placeholder"]);
    assert.equal(wm.getWorkspaceCount(), 1);
});

// an emptied deck

test("removing the last deck project terminates and leaves the placeholder", async () => {
    const { coord, store, controller, wm, mainloop } = makeStack([proj("a", true, 0)]);
    coord.loadDeckFromStore();

    const p = coord.removeFromWorkspaces("a");
    mainloop.flush();
    assert.equal(await p, true);

    assert.deepEqual(deckIds(controller), ["placeholder"]);
    assert.equal(wm.getWorkspaceCount(), 1);
    assert.equal(store.get("a").inWorkspace, false);
});

// reorderFromPanel

test("reorderFromPanel resolves the moved id to its deck index and reorders", () => {
    const { coord, controller } = makeStack([
        proj("a", true, 0),
        proj("b", true, 1),
        proj("c", true, 2),
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
