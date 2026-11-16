"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadGjsModule } = require("./helpers/loadGjsModule");

const DotWindow = loadGjsModule("core/dotWindow.js", "DotWindow");

const SLOTS = 4;

// Walk `current` through `path`, feeding each window's start into the next call.
function walk(count, path, start) {
    const seen = [];
    for (const current of path) {
        const w = DotWindow.place(count, current, start, SLOTS);
        start = w.start;
        seen.push(w.start);
    }
    return seen;
}

test("a strip that fits is shown whole, with nothing beyond either edge", () => {
    for (let count = 1; count <= SLOTS; count++) {
        for (let current = 0; current < count; current++) {
            assert.deepEqual(DotWindow.place(count, current, 3, SLOTS), {
                start: 0,
                moreBefore: false,
                moreAfter: false,
            });
        }
    }
});

test("the window always contains the current workspace and stays in range", () => {
    for (let count = SLOTS + 1; count <= 12; count++) {
        for (let prev = -2; prev <= count; prev++) {
            for (let current = 0; current < count; current++) {
                const w = DotWindow.place(count, current, prev, SLOTS);
                assert.ok(w.start >= 0 && w.start <= count - SLOTS);
                assert.ok(current >= w.start && current < w.start + SLOTS);
            }
        }
    }
});

test("the current workspace is never on an edge that has more beyond it", () => {
    for (let count = SLOTS + 1; count <= 12; count++) {
        for (let prev = 0; prev <= count - SLOTS; prev++) {
            for (let current = 0; current < count; current++) {
                const w = DotWindow.place(count, current, prev, SLOTS);
                if (w.moreBefore) assert.notEqual(current, w.start);
                if (w.moreAfter) assert.notEqual(current, w.start + SLOTS - 1);
            }
        }
    }
});

test("stepping through a strip of 6 slides the window one at a time", () => {
    assert.deepEqual(walk(6, [0, 1, 2, 3, 4, 5], 0), [0, 0, 0, 1, 2, 2]);
    assert.deepEqual(walk(6, [5, 4, 3, 2, 1, 0], 2), [2, 2, 2, 1, 0, 0]);
});

test("moving inside the window doesn't slide it", () => {
    assert.deepEqual(walk(8, [3, 4, 3, 4, 3], 2), [2, 2, 2, 2, 2]);
});

test("a jump to a far workspace brings it into view", () => {
    assert.equal(DotWindow.place(10, 9, 0, SLOTS).start, 6);
    assert.equal(DotWindow.place(10, 0, 6, SLOTS).start, 0);
    assert.equal(DotWindow.place(10, 5, 0, SLOTS).start, 3); // lands off the edge slot
});

test("moreBefore/moreAfter report hidden workspaces on each side", () => {
    assert.deepEqual(DotWindow.place(6, 0, 0, SLOTS), {
        start: 0,
        moreBefore: false,
        moreAfter: true,
    });
    assert.deepEqual(DotWindow.place(6, 3, 0, SLOTS), {
        start: 1,
        moreBefore: true,
        moreAfter: true,
    });
    assert.deepEqual(DotWindow.place(6, 5, 1, SLOTS), {
        start: 2,
        moreBefore: true,
        moreAfter: false,
    });
});

test("a remembered start past the end (strip shrank) is clamped", () => {
    assert.equal(DotWindow.place(5, 2, 7, SLOTS).start, 1);
});
