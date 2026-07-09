"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadGjsModule } = require("./helpers/loadGjsModule");

const Mapping = loadGjsModule("core/mapping.js", "Mapping");

// The doc-comment example: counts [3,2,2] -> flat [0 1 2][3 4][5 6]
const COUNTS = [3, 2, 2];

test("totalWorkspaces sums all strips", () => {
    assert.equal(Mapping.totalWorkspaces(COUNTS), 7);
    assert.equal(Mapping.totalWorkspaces([1]), 1);
    assert.equal(Mapping.totalWorkspaces([]), 0);
});

test("offsetOf gives each partition's starting flat index", () => {
    assert.equal(Mapping.offsetOf(COUNTS, 0), 0);
    assert.equal(Mapping.offsetOf(COUNTS, 1), 3);
    assert.equal(Mapping.offsetOf(COUNTS, 2), 5);
    // One past the last project == the total (useful as an insertion point).
    assert.equal(Mapping.offsetOf(COUNTS, 3), 7);
});

test("globalIndex maps (project, local) to flat", () => {
    assert.equal(Mapping.globalIndex(COUNTS, 0, 0), 0);
    assert.equal(Mapping.globalIndex(COUNTS, 0, 2), 2);
    assert.equal(Mapping.globalIndex(COUNTS, 1, 0), 3);
    assert.equal(Mapping.globalIndex(COUNTS, 1, 1), 4);
    assert.equal(Mapping.globalIndex(COUNTS, 2, 1), 6);
});

test("locationOf is the exact inverse of globalIndex", () => {
    for (let p = 0; p < COUNTS.length; p++) {
        for (let l = 0; l < COUNTS[p]; l++) {
            const flat = Mapping.globalIndex(COUNTS, p, l);
            assert.deepEqual(Mapping.locationOf(COUNTS, flat),
                { projectIdx: p, localIdx: l },
                `flat ${flat} should map back to (${p}, ${l})`);
        }
    }
});

test("locationOf partition boundaries", () => {
    assert.deepEqual(Mapping.locationOf(COUNTS, 2), { projectIdx: 0, localIdx: 2 });
    assert.deepEqual(Mapping.locationOf(COUNTS, 3), { projectIdx: 1, localIdx: 0 });
    assert.deepEqual(Mapping.locationOf(COUNTS, 4), { projectIdx: 1, localIdx: 1 });
    assert.deepEqual(Mapping.locationOf(COUNTS, 5), { projectIdx: 2, localIdx: 0 });
});

test("locationOf returns null out of range", () => {
    assert.equal(Mapping.locationOf(COUNTS, -1), null);
    assert.equal(Mapping.locationOf(COUNTS, 7), null);
    assert.equal(Mapping.locationOf(COUNTS, 100), null);
    assert.equal(Mapping.locationOf([], 0), null);
});

test("single-project deck", () => {
    assert.deepEqual(Mapping.locationOf([4], 3), { projectIdx: 0, localIdx: 3 });
    assert.equal(Mapping.locationOf([4], 4), null);
    assert.equal(Mapping.globalIndex([4], 0, 3), 3);
});

test("all-singleton strips (the default deck shape)", () => {
    const counts = [1, 1, 1, 1];
    for (let i = 0; i < 4; i++) {
        assert.deepEqual(Mapping.locationOf(counts, i), { projectIdx: i, localIdx: 0 });
        assert.equal(Mapping.offsetOf(counts, i), i);
    }
});
