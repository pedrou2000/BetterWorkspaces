"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadGjsModule } = require("./helpers/loadGjsModule");

const StateModule = loadGjsModule("core/State.js", "State");

function def(id, wsCount) {
    return { id: id, name: id.toUpperCase(), wsCount: wsCount };
}

// A deck of three projects: a(3 ws), b(2 ws), c(1 ws).
function makeState() {
    const s = new StateModule();
    s.setProjects([def("a", 3), def("b", 2), def("c", 1)]);
    return s;
}

test("setProjects seeds counts, active pointer, and MRU", () => {
    const s = makeState();
    assert.equal(s.projectCount(), 3);
    assert.deepEqual(s.counts(), [3, 2, 1]);
    assert.equal(s.activeProjectIdx, 0);
    assert.deepEqual(s.mruOrder(), [0, 1, 2]);
});

test("makeProject clamps wsCount to >= 1 and defaults optional fields", () => {
    const s = new StateModule();
    s.setProjects([{ id: "x", name: "X", wsCount: 0 }, { id: "y", name: "Y" }]);
    assert.deepEqual(s.counts(), [1, 1]);
    const p = s.getProject(0);
    assert.equal(p.lastLocal, 0);
    assert.equal(p.icon, null);
    assert.equal(p.notionUrl, null);
});

test("getProject out of range returns null", () => {
    const s = makeState();
    assert.equal(s.getProject(-1), null);
    assert.equal(s.getProject(3), null);
});

test("indexOfProjectId finds by id, -1 when absent", () => {
    const s = makeState();
    assert.equal(s.indexOfProjectId("a"), 0);
    assert.equal(s.indexOfProjectId("c"), 2);
    assert.equal(s.indexOfProjectId("nope"), -1);
    // Tracks reorders.
    s.moveProject(0, 2);
    assert.equal(s.indexOfProjectId("a"), 2);
});

test("setActiveProject validates and touches MRU", () => {
    const s = makeState();
    assert.equal(s.setActiveProject(2), true);
    assert.deepEqual(s.mruOrder(), [2, 0, 1]);
    assert.equal(s.setActiveProject(1), true);
    assert.deepEqual(s.mruOrder(), [1, 2, 0]);
    // Invalid indices are rejected and change nothing.
    assert.equal(s.setActiveProject(-1), false);
    assert.equal(s.setActiveProject(3), false);
    assert.equal(s.activeProjectIdx, 1);
});

test("previousProjectIdx is the second MRU entry", () => {
    const s = makeState();
    s.setActiveProject(2);
    s.setActiveProject(1);
    assert.equal(s.previousProjectIdx(), 2);
});

test("previousProjectIdx with a single project falls back to active", () => {
    const s = new StateModule();
    s.setProjects([def("only", 1)]);
    assert.equal(s.previousProjectIdx(), 0);
});

test("lastLocal is remembered per project", () => {
    const s = makeState();
    s.setLastLocal(0, 2);
    s.setLastLocal(1, 1);
    assert.equal(s.getLastLocal(0), 2);
    assert.equal(s.getLastLocal(1), 1);
    assert.equal(s.getLastLocal(2), 0);       // untouched -> home
    assert.equal(s.getLastLocal(99), 0);      // invalid -> safe default
});

test("inc/decWorkspaceCount respect the >=1 floor", () => {
    const s = makeState();
    assert.equal(s.incWorkspaceCount(2), true);
    assert.deepEqual(s.counts(), [3, 2, 2]);
    assert.equal(s.decWorkspaceCount(2), true);
    assert.equal(s.decWorkspaceCount(2), false);  // at 1: refuses
    assert.deepEqual(s.counts(), [3, 2, 1]);
    assert.equal(s.incWorkspaceCount(99), false);
    assert.equal(s.decWorkspaceCount(99), false);
});

test("appendProject adds at the end, least-recent in MRU", () => {
    const s = makeState();
    s.setActiveProject(1);
    const idx = s.appendProject(def("d", 1));
    assert.equal(idx, 3);
    assert.equal(s.projectCount(), 4);
    assert.deepEqual(s.mruOrder(), [1, 0, 2, 3]);
});

// ---- removeProject: index fixups --------------------------------------------

test("removeProject drops the project and reindexes MRU", () => {
    const s = makeState();
    s.setActiveProject(2);            // MRU [2,0,1]
    assert.equal(s.removeProject(1), true);
    assert.equal(s.projectCount(), 2);
    assert.deepEqual(s.counts(), [3, 1]);       // a and c remain
    // MRU: drop 1, decrement 2 -> [1, 0]
    assert.deepEqual(s.mruOrder(), [1, 0]);
    // Active was 2 (c), which is now index 1.
    assert.equal(s.activeProjectIdx, 1);
    assert.equal(s.activeProject().id, "c");
});

test("removeProject of the active project clamps the pointer to a valid index", () => {
    const s = makeState();
    s.setActiveProject(2);
    assert.equal(s.removeProject(2), true);
    assert.equal(s.projectCount(), 2);
    assert.ok(s.activeProjectIdx >= 0 && s.activeProjectIdx < 2);
    assert.deepEqual(s.mruOrder().slice().sort(), [0, 1]);
});

test("removeProject below the active pointer shifts it down", () => {
    const s = makeState();
    s.setActiveProject(2);
    assert.equal(s.removeProject(0), true);
    assert.equal(s.activeProject().id, "c");
    assert.equal(s.activeProjectIdx, 1);
});

test("removeProject rejects invalid indices", () => {
    const s = makeState();
    assert.equal(s.removeProject(-1), false);
    assert.equal(s.removeProject(3), false);
    assert.equal(s.projectCount(), 3);
});

// ---- moveProject: the reorder map -------------------------------------------

test("moveProject reorders the array and returns order[newPos] = oldIdx", () => {
    const s = makeState();
    const order = s.moveProject(0, 2);          // a b c -> b c a
    assert.deepEqual(order, [1, 2, 0]);
    assert.deepEqual(s.projects.map(p => p.id), ["b", "c", "a"]);
    assert.deepEqual(s.counts(), [2, 1, 3]);
});

test("moveProject remaps the active pointer and MRU through the move", () => {
    const s = makeState();
    s.setActiveProject(1);                      // active b, MRU [1,0,2]
    s.moveProject(0, 2);                        // a -> end; b c a
    assert.equal(s.activeProject().id, "b");
    assert.equal(s.activeProjectIdx, 0);
    // MRU indices follow their projects: b=0, a=2, c=1.
    assert.deepEqual(s.mruOrder(), [0, 2, 1]);
    assert.equal(s.getProject(s.previousProjectIdx()).id, "a");
});

test("moveProject backwards (right to left)", () => {
    const s = makeState();
    const order = s.moveProject(2, 0);          // a b c -> c a b
    assert.deepEqual(order, [2, 0, 1]);
    assert.deepEqual(s.projects.map(p => p.id), ["c", "a", "b"]);
});

test("moveProject rejects invalid or no-op moves", () => {
    const s = makeState();
    assert.equal(s.moveProject(0, 0), null);
    assert.equal(s.moveProject(-1, 1), null);
    assert.equal(s.moveProject(0, 3), null);
    assert.deepEqual(s.projects.map(p => p.id), ["a", "b", "c"]);
});

test("moveProject then removeProject keeps indices coherent", () => {
    const s = makeState();
    s.setActiveProject(2);                      // active c
    s.moveProject(2, 0);                        // c a b — active c now at 0
    assert.equal(s.activeProject().id, "c");
    s.removeProject(1);                         // drop a
    assert.deepEqual(s.projects.map(p => p.id), ["c", "b"]);
    assert.equal(s.activeProject().id, "c");
    assert.deepEqual(s.mruOrder().slice().sort(), [0, 1]);
});
