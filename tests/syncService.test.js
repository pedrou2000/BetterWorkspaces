"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadGjsModule } = require("./helpers/loadGjsModule");
const { makeFakeMainloop } = require("./helpers/fakeWm");

// Real mapper (owns schema knowledge); NotionClient and Persistence are faked.
const ProjectMapper = loadGjsModule("notion/ProjectMapper.js", "ProjectMapper");

// In-memory Persistence: same readJSON/writeJSON contract, no disk.
function makeFakePersistence() {
    const files = new Map();
    return {
        files,
        configDir: () => "/fake",
        pathFor: (f) => "/fake/" + f,
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

// Fake NotionClient (class, since SyncService `new`s it): records calls,
// resolves by default; set failNext / failAll to reject like the real one.
class FakeNotionClient {
    constructor(token) {
        this.token = token || "";
        this.calls = [];
        this.failAll = null;      // Error to reject every call with
        this.queryResult = { results: [] };
        FakeNotionClient.last = this;
    }
    setToken(token) { this.token = token || ""; }
    hasToken() { return this.token.length > 0; }
    // Mirrors the real client's _request: every call rejects without a token.
    _gate() {
        if (!this.hasToken()) throw new Error("no-token");
        if (this.failAll) throw this.failAll;
    }
    async queryDatabase(dbId, body) {
        this.calls.push({ method: "queryDatabase", dbId, body });
        this._gate();
        return this.queryResult;
    }
    async updatePageCheckbox(pageId, propName, value) {
        this.calls.push({ method: "updatePageCheckbox", pageId, propName, value });
        this._gate();
    }
    async updatePageNumber(pageId, propName, value) {
        this.calls.push({ method: "updatePageNumber", pageId, propName, value });
        this._gate();
    }
}

// Load SyncService with all collaborators injected. Returns everything a test
// scenario needs. `cachedProjects` pre-seeds the cache file when given.
function makeSync(opts) {
    opts = opts || {};
    const persistence = makeFakePersistence();
    const mainloop = makeFakeMainloop();
    const SyncService = loadGjsModule("notion/SyncService.js", "SyncService", {
        applet: {
            lib: {
                persistence: { Persistence: persistence },
                constants: { Constants: { DEFAULT_SYNC_INTERVAL_S: 300 } },
            },
            notion: {
                NotionClient: { NotionClient: FakeNotionClient },
                ProjectMapper: { ProjectMapper: ProjectMapper },
            },
        },
        extraImports: { mainloop: mainloop },
    });
    if (opts.cachedProjects) {
        persistence.writeJSON("projects-cache.json", { projects: opts.cachedProjects });
    }
    const sync = new SyncService(
        opts.token !== undefined ? opts.token : "tok",
        opts.dbId !== undefined ? opts.dbId : "db1");
    const client = FakeNotionClient.last;
    const statuses = [];
    sync.onStatus((s) => statuses.push(s));
    return { sync, client, persistence, mainloop, statuses };
}

function proj(id, order, inWorkspace) {
    return { id, name: id.toUpperCase(), icon: null, notionUrl: null,
             inWorkspace: !!inWorkspace, order: order === undefined ? null : order };
}

const cacheOf = (persistence) =>
    (persistence.files.get("projects-cache.json") || { projects: [] }).projects;

// ---- readCache ---------------------------------------------------------------

test("readCache returns [] when nothing is cached or shape is wrong", () => {
    const { sync, persistence } = makeSync();
    assert.deepEqual(sync.readCache(), []);
    persistence.writeJSON("projects-cache.json", { junk: true });
    assert.deepEqual(sync.readCache(), []);
});

test("readCache returns the cached projects", () => {
    const { sync } = makeSync({ cachedProjects: [proj("a", 0, true)] });
    assert.equal(sync.readCache().length, 1);
    assert.equal(sync.readCache()[0].id, "a");
});

// ---- setWorkspaceFlag / setWorkspaceOrder -------------------------------------

test("setWorkspaceFlag writes Notion then updates the cache entry", async () => {
    const { sync, client, persistence } =
        makeSync({ cachedProjects: [proj("a", 0, false), proj("b", 1, true)] });
    await sync.setWorkspaceFlag("a", true);
    assert.deepEqual(client.calls, [
        { method: "updatePageCheckbox", pageId: "a", propName: "Workspace", value: true },
    ]);
    assert.equal(cacheOf(persistence).find(p => p.id === "a").inWorkspace, true);
    assert.equal(cacheOf(persistence).find(p => p.id === "b").inWorkspace, true); // untouched
});

test("setWorkspaceFlag rejects and leaves the cache untouched on HTTP failure", async () => {
    const { sync, client, persistence } =
        makeSync({ cachedProjects: [proj("a", 0, false)] });
    client.failAll = new Error("http-403");
    await assert.rejects(sync.setWorkspaceFlag("a", true), /http-403/);
    assert.equal(cacheOf(persistence)[0].inWorkspace, false);
});

test("setWorkspaceOrder updates the cached order; clearWorkspaceOrder nulls it", async () => {
    const { sync, client, persistence } = makeSync({ cachedProjects: [proj("a", 2, true)] });
    await sync.setWorkspaceOrder("a", 7);
    assert.equal(cacheOf(persistence)[0].order, 7);
    await sync.clearWorkspaceOrder("a");
    assert.equal(cacheOf(persistence)[0].order, null);
    assert.deepEqual(client.calls.map(c => c.value), [7, null]);
});

test("write methods reject with no-token and leave the cache untouched", async () => {
    const { sync, persistence } = makeSync({ token: "", cachedProjects: [proj("a", 5, false)] });
    await assert.rejects(sync.setWorkspaceFlag("a", true), /no-token/);
    await assert.rejects(sync.setWorkspaceOrder("a", 1), /no-token/);
    assert.equal(cacheOf(persistence)[0].inWorkspace, false);
    assert.equal(cacheOf(persistence)[0].order, 5);
});

// ---- maxOrder ------------------------------------------------------------------

test("maxOrder is the highest numeric order; -1 when none", () => {
    const none = makeSync({ cachedProjects: [proj("a"), proj("b")] });
    assert.equal(none.sync.maxOrder(), -1);
    const some = makeSync({ cachedProjects: [proj("a", 3), proj("b"), proj("c", 0)] });
    assert.equal(some.sync.maxOrder(), 3);
    const empty = makeSync();
    assert.equal(empty.sync.maxOrder(), -1);
});

// ---- persistOrder ----------------------------------------------------------------

test("persistOrder updates the cache synchronously, before any Notion write lands", () => {
    const { sync, persistence } = makeSync({
        cachedProjects: [proj("a", 0, true), proj("b", 1, true), proj("c", null, false)],
    });
    sync.persistOrder(["b", "a"]);
    // Immediately (no await): cache already reflects the new order.
    const byId = {};
    for (const p of cacheOf(persistence)) byId[p.id] = p.order;
    assert.equal(byId.b, 0);
    assert.equal(byId.a, 1);
    assert.equal(byId.c, null);            // not in the ordered list -> untouched
});

test("persistOrder fires one Notion write per id with its new order", async () => {
    const { sync, client } = makeSync({
        cachedProjects: [proj("a", 0, true), proj("b", 1, true)],
    });
    sync.persistOrder(["b", "a"]);
    await new Promise((r) => setImmediate(r)); // let the fire-and-forget writes run
    const writes = client.calls.filter(c => c.method === "updatePageNumber");
    assert.deepEqual(writes.map(c => [c.pageId, c.value]), [["b", 0], ["a", 1]]);
});

test("persistOrder survives Notion write failures (cache keeps the new order)", async () => {
    const { sync, client, persistence } = makeSync({
        cachedProjects: [proj("a", 0, true), proj("b", 1, true)],
    });
    client.failAll = new Error("http-500");
    sync.persistOrder(["b", "a"]);
    await new Promise((r) => setImmediate(r));
    assert.equal(cacheOf(persistence).find(p => p.id === "b").order, 0);
});

// ---- syncNow ---------------------------------------------------------------------

// A minimal raw Notion page the real ProjectMapper can digest.
function rawPage(id, name, inWorkspace, order) {
    return {
        id, url: "https://notion.so/" + id, archived: false, icon: null,
        properties: {
            "Project": { title: [{ plain_text: name }] },
            "Workspace": { checkbox: !!inWorkspace },
            "Archive": { checkbox: false },
            "Workspace Order": { type: "number", number: order === undefined ? null : order },
        },
    };
}

test("syncNow: loading -> ok, cache rewritten, onUpdate fired with mapped projects", async () => {
    const { sync, client, persistence, statuses } =
        makeSync({ cachedProjects: [proj("stale", 0, true)] });
    client.queryResult = { results: [rawPage("p1", "Zulu", true, 1), rawPage("p2", "Alpha", false, 0)] };
    let updated = null;
    sync.onUpdate((projects) => { updated = projects; });

    await sync.syncNow();

    assert.deepEqual(statuses, ["loading", "ok"]);
    // Cache fully replaced by the sorted mapper output (order 0 first).
    assert.deepEqual(cacheOf(persistence).map(p => p.name), ["Alpha", "Zulu"]);
    assert.deepEqual(updated.map(p => p.id), ["p2", "p1"]);
});

test("syncNow failure: loading -> error, cache preserved", async () => {
    const { sync, client, persistence, statuses } =
        makeSync({ cachedProjects: [proj("keep", 0, true)] });
    client.failAll = new Error("http-500");
    await sync.syncNow();
    assert.deepEqual(statuses, ["loading", "error"]);
    assert.equal(cacheOf(persistence)[0].id, "keep");   // still serving the old cache
});

test("syncNow unconfigured: status only, no query, cache preserved", async () => {
    const noToken = makeSync({ token: "", cachedProjects: [proj("keep")] });
    await noToken.sync.syncNow();
    assert.deepEqual(noToken.statuses, ["unconfigured"]);
    assert.equal(noToken.client.calls.length, 0);
    assert.equal(cacheOf(noToken.persistence)[0].id, "keep");

    const noDb = makeSync({ dbId: "" });
    await noDb.sync.syncNow();
    assert.deepEqual(noDb.statuses, ["unconfigured"]);
});

test("setToken/setDatabaseId make a previously unconfigured sync work", async () => {
    const { sync, client, statuses } = makeSync({ token: "", dbId: "" });
    await sync.syncNow();
    assert.deepEqual(statuses, ["unconfigured"]);
    sync.setToken("tok2");
    sync.setDatabaseId("db2");
    await sync.syncNow();
    assert.equal(statuses[statuses.length - 1], "ok");
    assert.equal(client.calls[0].dbId, "db2");
});

// ---- start / stop -------------------------------------------------------------------

test("start syncs immediately and arms the interval timer; stop disarms it", async () => {
    const { sync, client, mainloop } = makeSync();
    sync.start();
    await new Promise((r) => setImmediate(r));
    assert.equal(client.calls.filter(c => c.method === "queryDatabase").length, 1);
    assert.equal(mainloop.pendingCount(), 1);          // interval timer armed

    mainloop.flush();                                   // interval fires -> another sync
    await new Promise((r) => setImmediate(r));
    assert.equal(client.calls.filter(c => c.method === "queryDatabase").length, 2);

    sync.stop();
    assert.equal(mainloop.pendingCount(), 0);
});

test("destroy stops the timer and drops callbacks", async () => {
    const { sync, mainloop } = makeSync();
    sync.start();
    sync.destroy();
    assert.equal(mainloop.pendingCount(), 0);
});
