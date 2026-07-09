"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadGjsModule } = require("./helpers/loadGjsModule");

// Real mapper (store uses its sortByOrder).
const ProjectMapper = loadGjsModule("notion/ProjectMapper.js", "ProjectMapper");

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

// A controllable writer: pushes resolve/reject when the test says so.
function makeManualWriter() {
    const pending = [];
    return {
        pending,
        setWorkspaceFlag(id, value) {
            return new Promise((resolve, reject) => {
                pending.push({ kind: "flag", id, value, resolve, reject });
            });
        },
        setWorkspaceOrder(id, order) {
            return new Promise((resolve, reject) => {
                pending.push({ kind: "order", id, value: order, resolve, reject });
            });
        },
        // Settle the oldest pending push and let the microtask queue drain.
        async settle(ok, err) {
            const p = pending.shift();
            if (ok) p.resolve(); else p.reject(err || new Error("http-500"));
            await new Promise((r) => setImmediate(r));
            return p;
        },
    };
}

// An always-succeeding writer for tests that don't care about push timing.
function makeAutoWriter() {
    const calls = [];
    return {
        calls,
        async setWorkspaceFlag(id, value) { calls.push({ kind: "flag", id, value }); },
        async setWorkspaceOrder(id, order) { calls.push({ kind: "order", id, value: order }); },
    };
}

function proj(id, order, inWorkspace) {
    return { id, name: id.toUpperCase(), icon: null, notionUrl: null,
             inWorkspace: !!inWorkspace, order: order === undefined ? null : order };
}

function makeStore(cachedProjects, writer) {
    const persistence = makeFakePersistence();
    if (cachedProjects) {
        persistence.writeJSON("projects-cache.json", { projects: cachedProjects });
    }
    const ProjectStore = loadGjsModule("core/ProjectStore.js", "ProjectStore", {
        applet: { notion: { ProjectMapper: { ProjectMapper } } },
    });
    const store = new ProjectStore(persistence);
    if (writer) store.setWriter(writer);
    return { store, persistence };
}

const cacheOf = (persistence) =>
    (persistence.files.get("projects-cache.json") || { projects: [] }).projects;

const drain = () => new Promise((r) => setImmediate(r));

// ---- loading & reads -----------------------------------------------------------

test("loads the catalog from the cache once; all() is sorted by order", () => {
    const { store } = makeStore([proj("b", 1, true), proj("a", 0, true), proj("c", null)]);
    assert.deepEqual(store.all().map(p => p.id), ["a", "b", "c"]);
    assert.equal(store.get("b").name, "B");
    assert.equal(store.get("nope"), null);
});

test("empty or missing cache -> empty catalog", () => {
    const { store } = makeStore();
    assert.deepEqual(store.all(), []);
    assert.equal(store.maxOrder(), -1);
});

test("maxOrder over mixed null/numeric", () => {
    const { store } = makeStore([proj("a", 3), proj("b"), proj("c", 0)]);
    assert.equal(store.maxOrder(), 3);
});

// ---- optimistic mutations ---------------------------------------------------------

test("setInWorkspace applies to store + cache immediately, before the push lands", () => {
    const writer = makeManualWriter();
    const { store, persistence } = makeStore([proj("a", 0, false)], writer);
    store.setInWorkspace("a", true);
    assert.equal(store.get("a").inWorkspace, true);                       // store: now
    assert.equal(cacheOf(persistence)[0].inWorkspace, true);              // cache: now
    assert.equal(writer.pending.length, 1);                               // push: queued
});

test("failed push reverts the field, persists the revert, and fires onWriteError", async () => {
    const writer = makeManualWriter();
    const { store, persistence } = makeStore([proj("a", 0, false)], writer);
    let errCb = null;
    store.onWriteError((id, field, e) => { errCb = { id, field }; });

    store.setInWorkspace("a", true);
    await writer.settle(false);

    assert.equal(store.get("a").inWorkspace, false);                      // reverted
    assert.equal(cacheOf(persistence)[0].inWorkspace, false);
    assert.deepEqual(errCb, { id: "a", field: "inWorkspace" });
});

test("successful push acknowledges: a later failure reverts to the ACKED value", async () => {
    const writer = makeManualWriter();
    const { store } = makeStore([proj("a", 0, false)], writer);
    store.setInWorkspace("a", true);
    await writer.settle(true);            // true is now acknowledged
    store.setInWorkspace("a", false);
    await writer.settle(false);           // this push fails
    assert.equal(store.get("a").inWorkspace, true);  // reverts to acked true, not original false
});

test("pushes are serialized FIFO, one in flight", async () => {
    const writer = makeManualWriter();
    const { store } = makeStore([proj("a", 0), proj("b", 1)], writer);
    store.setOrder("a", 5);
    store.setOrder("b", 6);
    assert.equal(writer.pending.length, 1);           // only the first is in flight
    await writer.settle(true);
    assert.equal(writer.pending.length, 1);           // now the second
    const second = await writer.settle(true);
    assert.deepEqual([second.id, second.value], ["b", 6]);
});

test("queued (not in-flight) pushes for the same field coalesce to the newest value", async () => {
    const writer = makeManualWriter();
    const { store } = makeStore([proj("a", 0), proj("b", 1)], writer);
    store.setOrder("a", 5);              // in flight
    store.setOrder("b", 6);              // queued
    store.setOrder("b", 7);              // supersedes the queued 6
    await writer.settle(true);           // a:5 lands
    const bPush = await writer.settle(true);
    assert.deepEqual([bPush.id, bPush.value], ["b", 7]);
    assert.equal(writer.pending.length, 0);           // no third push for b
});

test("setOrders assigns 0..n-1 following the id list", async () => {
    const writer = makeAutoWriter();
    const { store } = makeStore([proj("a", 0, true), proj("b", 1, true)], writer);
    store.setOrders(["b", "a"]);
    assert.equal(store.get("b").order, 0);
    assert.equal(store.get("a").order, 1);
    await drain(); await drain();
    assert.deepEqual(writer.calls.map(c => [c.id, c.value]), [["b", 0], ["a", 1]]);
});

test("redundant set (same value, nothing pending) does not queue a push", () => {
    const writer = makeManualWriter();
    const { store } = makeStore([proj("a", 0, true)], writer);
    store.setInWorkspace("a", true);     // already true
    assert.equal(writer.pending.length, 0);
});

test("onChange fires on mutation with a reason", () => {
    const { store } = makeStore([proj("a", 0)], makeAutoWriter());
    const reasons = [];
    store.onChange((r) => reasons.push(r));
    store.setOrder("a", 2);
    assert.deepEqual(reasons, ["set:order"]);
});

// ---- merge ---------------------------------------------------------------------

test("merge adds new ids and reports newly-inWorkspace ones", () => {
    const { store } = makeStore([proj("a", 0, true)]);
    const result = store.merge([proj("a", 0, true), proj("b", 1, true), proj("c", null, false)], ["a"]);
    assert.deepEqual(result.added.sort(), ["b", "c"]);
    assert.deepEqual(result.newlyInWorkspace.map(p => p.id), ["b"]);
    assert.equal(store.all().length, 3);
});

test("merge: catalog fields always take the remote value", () => {
    const { store } = makeStore([proj("a", 0, true)]);
    const remote = Object.assign(proj("a", 0, true), {
        name: "Renamed", icon: { type: "emoji", value: "🚀" }, notionUrl: "https://x" });
    store.merge([remote], []);
    assert.equal(store.get("a").name, "Renamed");
    assert.deepEqual(store.get("a").icon, { type: "emoji", value: "🚀" });
});

test("merge: deck fields take remote when clean, keep local when a write is pending", async () => {
    const writer = makeManualWriter();
    const { store } = makeStore([proj("a", 0, false), proj("b", 1, false)], writer);
    store.setInWorkspace("a", true);      // pending (push not settled)

    store.merge([proj("a", 0, false), proj("b", 1, true)], []);

    assert.equal(store.get("a").inWorkspace, true);   // local pending wins
    assert.equal(store.get("b").inWorkspace, true);   // clean field: remote wins
    // b went false -> true via merge, so it must be reported as newly-on.
});

test("merge reports a clean project flipped on remotely as newlyInWorkspace", () => {
    const { store } = makeStore([proj("a", 0, false)]);
    const result = store.merge([proj("a", 0, true)], []);
    assert.deepEqual(result.newlyInWorkspace.map(p => p.id), ["a"]);
    // And NOT one that was already on.
    const again = store.merge([proj("a", 0, true)], []);
    assert.deepEqual(again.newlyInWorkspace, []);
});

test("merge drops ids missing from remote unless protected", () => {
    const { store } = makeStore([proj("a", 0, true), proj("b", 1, true), proj("c", 2, false)]);
    const result = store.merge([proj("a", 0, true)], ["b"]);   // b is in the live deck
    assert.deepEqual(result.removed, ["c"]);
    assert.ok(store.get("b"));                                  // protected survives
    assert.equal(store.get("c"), null);
});

test("merge persists the merged catalog to the cache", () => {
    const { store, persistence } = makeStore([proj("a", 0, true)]);
    store.merge([proj("a", 0, true), proj("b", 1, false)], []);
    assert.equal(cacheOf(persistence).length, 2);
});

test("merge acks the remote value: post-merge failure reverts to the merged value", async () => {
    const writer = makeManualWriter();
    const { store } = makeStore([proj("a", 3, true)], writer);
    store.merge([proj("a", 9, true)], []);            // remote order 9 acked
    store.setOrder("a", 4);
    await writer.settle(false);
    assert.equal(store.get("a").order, 9);            // reverts to merged 9, not stale 3
});

// ---- destroy -------------------------------------------------------------------

test("destroy drops queued pushes (by design)", async () => {
    const writer = makeManualWriter();
    const { store } = makeStore([proj("a", 0), proj("b", 1)], writer);
    store.setOrder("a", 5);              // in flight
    store.setOrder("b", 6);              // queued
    store.destroy();
    await writer.settle(true);           // in-flight one settles harmlessly
    assert.equal(writer.pending.length, 0);  // queued push never sent
});
