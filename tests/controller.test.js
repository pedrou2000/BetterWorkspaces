"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadGjsModule } = require("./helpers/loadGjsModule");
const { FakeWm, makeFakeMainloop } = require("./helpers/fakeWm");

// Real model modules; only the WM and mainloop are faked.
const Mapping = loadGjsModule("core/mapping.js", "Mapping");
const State = loadGjsModule("core/State.js", "State");

// The Controller is a façade over Navigation/DeckReorder/ProjectLifecycle, so
// those real modules are loaded with the same fakes and injected too.
function makeController(defs, initialWsCount) {
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
    const wm = new FakeWm(initialWsCount || 1);
    const controller = new Controller(wm);
    if (defs) controller.loadProjects(defs);
    return { controller, wm, mainloop };
}

function def(id, wsCount) {
    return { id: id, name: id.toUpperCase(), wsCount: wsCount };
}

// Standard deck: a(2 ws), b(3 ws), c(1 ws) -> flat [a0 a1][b0 b1 b2][c0]
const DECK = [def("a", 2), def("b", 3), def("c", 1)];

// loading & reconciliation

test("loadProjects reconciles the flat count and lands on project 0", () => {
    const { controller, wm } = makeController(DECK, 1);
    assert.equal(wm.getWorkspaceCount(), 6);
    assert.equal(wm.getActiveIndex(), 0);
    assert.deepEqual(controller.currentLocation(), { projectIdx: 0, localIdx: 0 });
});

test("loadProjects shrinks an oversized flat list", () => {
    const { wm } = makeController([def("a", 2)], 10);
    assert.equal(wm.getWorkspaceCount(), 2);
});

// navigation

test("goToProject lands on the last-used local workspace", () => {
    const { controller, wm } = makeController(DECK);
    controller.goToProject(1);
    controller.goToLocalWorkspace(2); // b local 2 -> flat 4
    assert.equal(wm.getActiveIndex(), 4);
    controller.goToProject(0);
    assert.equal(wm.getActiveIndex(), 0);
    controller.goToProject(1); // returns to b's remembered local
    assert.equal(wm.getActiveIndex(), 4);
});

test("goToProject rejects invalid indices", () => {
    const { controller, wm } = makeController(DECK);
    assert.equal(controller.goToProject(-1), false);
    assert.equal(controller.goToProject(3), false);
    assert.equal(wm.getActiveIndex(), 0);
});

test("project cycling wraps in both directions", () => {
    const { controller } = makeController(DECK);
    controller.goToNextProjectInOrder();
    assert.equal(controller.currentLocation().projectIdx, 1);
    controller.goToNextProjectInOrder();
    controller.goToNextProjectInOrder(); // wraps c -> a
    assert.equal(controller.currentLocation().projectIdx, 0);
    controller.goToPrevProjectInOrder(); // wraps a -> c
    assert.equal(controller.currentLocation().projectIdx, 2);
});

test("prevLocalWorkspace at the strip start grows a new front workspace", () => {
    const { controller, wm } = makeController(DECK);
    controller.goToProject(2); // c: single ws at flat 5
    wm.addWindow(5, "c-home");
    assert.equal(controller.prevLocalWorkspace(), true);
    assert.deepEqual(controller.state.counts(), [2, 3, 2]);
    // Lands on the new front workspace; the old home shifted right with its window.
    assert.deepEqual(controller.currentLocation(), { projectIdx: 2, localIdx: 0 });
    assert.deepEqual(wm.layout()[5], []); // new empty front
    assert.deepEqual(wm.layout()[6], ["c-home"]);
});

test("nextLocalWorkspace at the strip end grows the strip", () => {
    const { controller, wm } = makeController(DECK);
    controller.goToProject(2); // c has 1 ws at flat 5
    assert.equal(controller.nextLocalWorkspace(), true);
    assert.deepEqual(controller.state.counts(), [2, 3, 2]);
    assert.equal(wm.getWorkspaceCount(), 7);
    assert.deepEqual(controller.currentLocation(), { projectIdx: 2, localIdx: 1 });
});

test("growing a MIDDLE project's strip inserts, not appends", () => {
    const { controller, wm } = makeController(DECK);
    wm.addWindow(5, "c-home"); // marker in c's partition
    controller.goToProject(1);
    controller.goToLocalWorkspace(2); // b's last local
    controller.nextLocalWorkspace(); // grow b: insert flat 5
    assert.deepEqual(controller.state.counts(), [2, 4, 1]);
    assert.deepEqual(controller.currentLocation(), { projectIdx: 1, localIdx: 3 });
    // c's window must have moved right with its workspace (now flat 6).
    assert.deepEqual(wm.layout()[6], ["c-home"]);
    assert.deepEqual(wm.layout()[5], []); // the new, empty b workspace
});

// moving windows

test("moveWindowToNextLocal carries the focused window and follows it", () => {
    const { controller, wm } = makeController(DECK);
    wm.focusedWindow = wm.addWindow(0, "editor");
    assert.equal(controller.moveWindowToNextLocal(), true);
    assert.equal(wm.getActiveIndex(), 1);
    assert.deepEqual(wm.layout()[1], ["editor"]);
    assert.deepEqual(wm.layout()[0], []);
});

test("moveWindowToNextLocal at the strip end grows the strip first", () => {
    const { controller, wm } = makeController(DECK);
    controller.goToProject(2); // c: single workspace
    wm.focusedWindow = wm.addWindow(5, "notes");
    assert.equal(controller.moveWindowToNextLocal(), true);
    assert.deepEqual(controller.state.counts(), [2, 3, 2]);
    assert.deepEqual(controller.currentLocation(), { projectIdx: 2, localIdx: 1 });
    assert.deepEqual(wm.layout()[6], ["notes"]);
});

test("moveWindowToPrevLocal at the strip start grows a front workspace and moves there", () => {
    const { controller, wm } = makeController(DECK);
    controller.goToProject(2); // c: single ws at flat 5
    wm.focusedWindow = wm.addWindow(5, "notes");
    assert.equal(controller.moveWindowToPrevLocal(), true);
    assert.deepEqual(controller.state.counts(), [2, 3, 2]);
    assert.deepEqual(controller.currentLocation(), { projectIdx: 2, localIdx: 0 });
    assert.deepEqual(wm.layout()[5], ["notes"]); // window on the new front workspace
});

test("moveWindowToProject lands on that project's last-used local", () => {
    const { controller, wm } = makeController(DECK);
    controller.goToProject(1);
    controller.goToLocalWorkspace(1); // b remembers local 1
    controller.goToProject(0);
    wm.focusedWindow = wm.addWindow(0, "editor");
    assert.equal(controller.moveWindowToProject(1), true);
    assert.equal(wm.getActiveIndex(), 3); // b local 1 -> flat 3
    assert.deepEqual(wm.layout()[3], ["editor"]);
});

test("moveWindowToProject with no focused window fails without navigating", () => {
    const { controller, wm } = makeController(DECK);
    wm.focusedWindow = null;
    assert.equal(controller.moveWindowToProject(1), false);
    assert.equal(wm.getActiveIndex(), 0);
    assert.equal(controller.state.activeProjectIdx, 0);
});

// reorder: the workspace-block choreography

test("reorderProject moves whole partitions with their windows", () => {
    const { controller, wm } = makeController(DECK);
    wm.addWindow(0, "a0");
    wm.addWindow(1, "a1");
    wm.addWindow(2, "b0");
    wm.addWindow(4, "b2");
    wm.addWindow(5, "c0");

    assert.equal(controller.reorderProject(0, 2), true); // a b c -> b c a
    assert.deepEqual(
        controller.state.projects.map((p) => p.id),
        ["b", "c", "a"],
    );
    // Flat layout must now be [b0 b1 b2][c0][a0 a1] with windows intact.
    assert.deepEqual(wm.layout(), [["b0"], [], ["b2"], ["c0"], ["a0"], ["a1"]]);
});

test("reorderProject keeps the user on the same (project, local)", () => {
    const { controller, wm } = makeController(DECK);
    controller.goToProject(1);
    controller.goToLocalWorkspace(1); // b local 1 (flat 3)
    controller.reorderProject(0, 2); // b c a — b now starts at flat 0
    assert.deepEqual(controller.currentLocation(), { projectIdx: 0, localIdx: 1 });
    assert.equal(wm.getActiveIndex(), 1);
});

test("reorderProject fires onOrderChanged with ids in new order", () => {
    const { controller } = makeController(DECK);
    let got = null;
    controller.onOrderChanged((ids) => {
        got = ids;
    });
    controller.reorderProject(2, 0); // c a b
    assert.deepEqual(got, ["c", "a", "b"]);
});

test("reorderProject rejects invalid and no-op moves", () => {
    const { controller, wm } = makeController(DECK);
    const before = wm.layout();
    assert.equal(controller.reorderProject(0, 0), false);
    assert.equal(controller.reorderProject(-1, 1), false);
    assert.equal(controller.reorderProject(0, 3), false);
    assert.deepEqual(wm.layout(), before);
});

test("moveActiveProjectBy respects deck edges", () => {
    const { controller } = makeController(DECK);
    assert.equal(controller.moveActiveProjectBy(-1), false); // a at left edge
    assert.equal(controller.moveActiveProjectBy(1), true);
    assert.deepEqual(
        controller.state.projects.map((p) => p.id),
        ["b", "a", "c"],
    );
});

// shrinking strips

test("removeLastWorkspaceOfActiveProject folds windows into the previous ws", () => {
    const { controller, wm } = makeController(DECK);
    controller.goToProject(1);
    wm.addWindow(4, "b2-win"); // window on b's last ws
    assert.equal(controller.removeLastWorkspaceOfActiveProject(), true);
    assert.deepEqual(controller.state.counts(), [2, 2, 1]);
    assert.equal(wm.getWorkspaceCount(), 5);
    assert.deepEqual(wm.layout()[3], ["b2-win"]); // folded into b local 1
});

test("removeLastWorkspaceOfActiveProject keeps the home workspace", () => {
    const { controller } = makeController(DECK);
    controller.goToProject(2); // c has 1 ws
    assert.equal(controller.removeLastWorkspaceOfActiveProject(), false);
    assert.deepEqual(controller.state.counts(), [2, 3, 1]);
});

test("removeEmptyWorkspacesOfActiveProject keeps active + occupied", () => {
    const { controller, wm } = makeController(DECK);
    controller.goToProject(1); // b local 0 (flat 2) active
    wm.addWindow(4, "busy"); // b local 2 occupied; local 1 empty
    assert.equal(controller.removeEmptyWorkspacesOfActiveProject(), 1);
    assert.deepEqual(controller.state.counts(), [2, 2, 1]);
    // b is now [active, busy]; c untouched.
    assert.deepEqual(wm.layout(), [[], [], [], ["busy"], []]);
    assert.deepEqual(controller.currentLocation(), { projectIdx: 1, localIdx: 0 });
});

test("removeEmptyWorkspacesOfActiveProject ignores sticky windows", () => {
    const { controller, wm } = makeController(DECK);
    controller.goToProject(1);
    wm.addWindow(3, "pinned", true); // sticky -> workspace counts as empty
    assert.equal(controller.removeEmptyWorkspacesOfActiveProject(), 2);
    assert.deepEqual(controller.state.counts(), [2, 1, 1]);
});

// live add / remove of whole projects

test("addProjectLive appends a partition at the end", () => {
    const { controller, wm } = makeController(DECK);
    const idx = controller.addProjectLive(def("d", 1));
    assert.equal(idx, 3);
    assert.deepEqual(controller.state.counts(), [2, 3, 1, 1]);
    assert.equal(wm.getWorkspaceCount(), 7);
    // Adding must not navigate away.
    assert.equal(wm.getActiveIndex(), 0);
});

// Regression (found in VM verify): offline toggle appends the project, the
// failed Notion write reverts the store flag, and a later retry toggles ON
// again — the second addProjectLive must NOT create a duplicate partition.
test("addProjectLive is idempotent by project id", () => {
    const { controller, wm } = makeController(DECK);
    const first = controller.addProjectLive(def("d", 1));
    const again = controller.addProjectLive(def("d", 1));
    assert.equal(again, first); // same index back
    assert.equal(controller.state.projectCount(), 4); // no duplicate entry
    assert.deepEqual(controller.state.counts(), [2, 3, 1, 1]);
    assert.equal(wm.getWorkspaceCount(), 7); // no duplicate workspace
    // Also idempotent for projects loaded at startup, not just appended ones.
    assert.equal(controller.addProjectLive(def("a", 2)), 0);
    assert.equal(controller.state.projectCount(), 4);
});

// removeProjectLive is async: the grace-period timer is registered synchronously
// before its first await, so the pattern is — start the call, let (or don't let)
// windows close, flush the fake mainloop, then await.

test("removeProjectLive removes the partition after windows close", async () => {
    const { controller, wm, mainloop } = makeController(DECK);
    wm.addWindow(2, "b-win");
    wm.addWindow(5, "c-keep");
    const done = controller.removeProjectLive(1);
    wm.honorCloseRequests(); // windows oblige
    mainloop.flush(); // grace period elapses
    await done;
    assert.deepEqual(
        controller.state.projects.map((p) => p.id),
        ["a", "c"],
    );
    assert.equal(wm.getWorkspaceCount(), 3);
    assert.deepEqual(wm.layout()[2], ["c-keep"]); // c's window untouched
});

test("removeProjectLive aborts when a window refuses to close", async () => {
    const { controller, wm, mainloop } = makeController(DECK);
    wm.addWindow(3, "stubborn");
    const done = controller.removeProjectLive(1);
    // Do NOT honor close requests — the window stays.
    mainloop.flush();
    await assert.rejects(done, (err) => {
        assert.equal(err.message, "windows-open");
        assert.deepEqual(err.openTitles, ["stubborn"]);
        return true;
    });
    // Nothing removed: model and flat list intact.
    assert.equal(controller.state.projectCount(), 3);
    assert.equal(wm.getWorkspaceCount(), 6);
});

test("removing the ACTIVE project lands on the MRU-previous project", async () => {
    const { controller, wm, mainloop } = makeController(DECK);
    controller.goToProject(2); // visit c
    controller.goToProject(1); // active b, MRU-prev c
    const done = controller.removeProjectLive(1);
    wm.honorCloseRequests();
    mainloop.flush();
    await done;
    assert.deepEqual(
        controller.state.projects.map((p) => p.id),
        ["a", "c"],
    );
    assert.equal(controller.state.activeProject().id, "c");
    assert.deepEqual(controller.currentLocation(), { projectIdx: 1, localIdx: 0 });
});

test("removeProjectLive with an invalid index rejects", async () => {
    const { controller } = makeController(DECK);
    await assert.rejects(controller.removeProjectLive(9), /invalid-project/);
});
