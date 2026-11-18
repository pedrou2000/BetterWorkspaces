"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadGjsModule } = require("./helpers/loadGjsModule");
const { makeFakeMainloop } = require("./helpers/fakeWm");

// Real mapper (owns schema knowledge); NotionClient is faked.
// Since the ProjectStore redesign, SyncService is TRANSPORT-ONLY: it never
// touches the disk cache. Pull -> onPull(projects); push methods are plain
// Notion writes (the store owns queueing/optimism/reverts).
const ProjectMapper = loadGjsModule("notion/ProjectMapper.js", "ProjectMapper");

// Fake NotionClient (class, since SyncService `new`s it): records calls,
// resolves by default; failAll rejects like the real one; no-token gate
// mirrors the real client's _request.
class FakeNotionClient {
    constructor(token) {
        this.token = token || "";
        this.calls = [];
        this.failAll = null;
        this.queryResult = { results: [] };
        FakeNotionClient.last = this;
    }
    setToken(token) {
        this.token = token || "";
    }
    hasToken() {
        return this.token.length > 0;
    }
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
    // pages: id -> page object, or an Error to throw for that id.
    async getPage(pageId) {
        this.calls.push({ method: "getPage", pageId });
        this._gate();
        const page = (this.pages || {})[pageId];
        if (page instanceof Error) throw page;
        return page;
    }
}

// Fake Gio.NetworkMonitor: tests flip availability and emit network-changed.
function makeFakeNetMonitor(initiallyOnline) {
    let online = initiallyOnline !== false;
    const handlers = new Map();
    let seq = 0;
    return {
        get_network_available: () => online,
        connect(signal, cb) {
            handlers.set(++seq, cb);
            return seq;
        },
        disconnect(id) {
            handlers.delete(id);
        },
        handlerCount() {
            return handlers.size;
        },
        // Test helper: change availability and emit the signal.
        setOnline(value) {
            online = !!value;
            for (const cb of handlers.values()) cb(this, online);
        },
    };
}

function makeSync(opts) {
    opts = opts || {};
    const mainloop = makeFakeMainloop();
    const netMonitor = makeFakeNetMonitor(opts.online);
    const SyncService = loadGjsModule("notion/SyncService.js", "SyncService", {
        applet: {
            lib: { constants: { Constants: { DEFAULT_SYNC_INTERVAL_S: 300 } } },
            notion: {
                NotionClient: { NotionClient: FakeNotionClient },
                ProjectMapper: { ProjectMapper: ProjectMapper },
            },
        },
        extraImports: {
            mainloop: mainloop,
            gi: { Gio: { NetworkMonitor: { get_default: () => netMonitor } } },
        },
    });
    const sync = new SyncService(
        opts.token !== undefined ? opts.token : "tok",
        opts.dbId !== undefined ? opts.dbId : "db1",
    );
    const client = FakeNotionClient.last;
    const statuses = [];
    sync.onStatus((s) => statuses.push(s));
    return { sync, client, mainloop, netMonitor, statuses };
}

// A minimal raw Notion page the real ProjectMapper can digest.
function rawPage(id, name, inWorkspace, order) {
    return {
        id,
        url: "https://notion.so/" + id,
        archived: false,
        icon: null,
        properties: {
            Project: { title: [{ plain_text: name }] },
            Workspace: { checkbox: !!inWorkspace },
            Archive: { checkbox: false },
            "Workspace Order": { type: "number", number: order === undefined ? null : order },
        },
    };
}

// push: the store's writer interface

test("setWorkspaceFlag/-Order are plain Notion writes with the right property names", async () => {
    const { sync, client } = makeSync();
    await sync.setWorkspaceFlag("p1", true);
    await sync.setWorkspaceOrder("p1", 4);
    await sync.setWorkspaceOrder("p1", null); // clearing = writing null
    assert.deepEqual(client.calls, [
        { method: "updatePageCheckbox", pageId: "p1", propName: "Workspace", value: true },
        { method: "updatePageNumber", pageId: "p1", propName: "Workspace Order", value: 4 },
        { method: "updatePageNumber", pageId: "p1", propName: "Workspace Order", value: null },
    ]);
});

test("push failures reject (the store handles reverts)", async () => {
    const { sync, client } = makeSync();
    client.failAll = new Error("http-403");
    await assert.rejects(sync.setWorkspaceFlag("p1", true), /http-403/);
    await assert.rejects(sync.setWorkspaceOrder("p1", 1), /http-403/);
});

test("pushes without a token reject with no-token", async () => {
    const { sync } = makeSync({ token: "" });
    await assert.rejects(sync.setWorkspaceFlag("p1", true), /no-token/);
});

// pull

test("syncNow: loading -> ok, onPull gets the mapped+sorted projects", async () => {
    const { sync, client, statuses } = makeSync();
    client.queryResult = {
        results: [rawPage("p1", "Zulu", true, 1), rawPage("p2", "Alpha", false, 0)],
    };
    let pulled = null;
    sync.onPull((projects, complete) => {
        assert.equal(complete, true);
        pulled = projects;
    });

    assert.equal(await sync.syncNow(), "ok");

    assert.deepEqual(statuses, ["loading", "ok"]);
    assert.deepEqual(
        pulled.map((p) => p.id),
        ["p2", "p1"],
    ); // sorted by order
    assert.equal(pulled[0].name, "Alpha");
});

test("syncNow failure: loading -> error, onPull not called", async () => {
    const { sync, client, statuses } = makeSync();
    client.failAll = new Error("http-500");
    let pulled = false;
    sync.onPull(() => {
        pulled = true;
    });
    assert.equal(await sync.syncNow(), "error");
    assert.deepEqual(statuses, ["loading", "error"]);
    assert.equal(pulled, false);
});

test("syncNow unconfigured: status only, no query", async () => {
    const noToken = makeSync({ token: "" });
    await noToken.sync.syncNow();
    assert.deepEqual(noToken.statuses, ["unconfigured"]);
    assert.equal(noToken.client.calls.length, 0);

    const noDb = makeSync({ dbId: "" });
    await noDb.sync.syncNow();
    assert.deepEqual(noDb.statuses, ["unconfigured"]);
});

test("setToken/setDatabaseId make a previously unconfigured sync work", async () => {
    const { sync, client, statuses } = makeSync({ token: "", dbId: "" });
    assert.equal(await sync.syncNow(), "unconfigured");
    assert.deepEqual(statuses, ["unconfigured"]);
    sync.setToken("tok2");
    sync.setDatabaseId("db2");
    assert.equal(await sync.syncNow(), "ok");
    assert.equal(statuses[statuses.length - 1], "ok");
    assert.equal(client.calls[0].dbId, "db2");
});

// start / stop

test("start pulls immediately and arms the interval timer; stop disarms it", async () => {
    const { sync, client, mainloop } = makeSync();
    sync.start();
    await new Promise((r) => setImmediate(r));
    assert.equal(client.calls.filter((c) => c.method === "queryDatabase").length, 1);
    assert.equal(mainloop.pendingCount(), 1);

    mainloop.flush();
    await new Promise((r) => setImmediate(r));
    assert.equal(client.calls.filter((c) => c.method === "queryDatabase").length, 2);

    sync.stop();
    assert.equal(mainloop.pendingCount(), 0);
});

test("destroy stops the timer", () => {
    const { sync, mainloop } = makeSync();
    sync.start();
    sync.destroy();
    assert.equal(mainloop.pendingCount(), 0);
});

// reconnect

test("offline->online transition triggers an immediate pull", async () => {
    const { sync, client, netMonitor } = makeSync({ online: false });
    sync.start(); // initial pull fires (and fails or not — irrelevant)
    await new Promise((r) => setImmediate(r));
    const before = client.calls.filter((c) => c.method === "queryDatabase").length;

    netMonitor.setOnline(true); // reconnect
    await new Promise((r) => setImmediate(r));
    const after = client.calls.filter((c) => c.method === "queryDatabase").length;
    assert.equal(after, before + 1); // exactly one extra pull
});

test("reconnect pull recovers status from error to ok", async () => {
    const { sync, client, netMonitor, statuses } = makeSync({ online: true });
    client.failAll = new Error("http-0"); // network down: pulls fail
    sync.start();
    await new Promise((r) => setImmediate(r));
    assert.equal(statuses[statuses.length - 1], "error");

    netMonitor.setOnline(false); // offline edge (no pull)
    client.failAll = null; // network back
    netMonitor.setOnline(true); // online edge -> pull
    await new Promise((r) => setImmediate(r));
    assert.equal(statuses[statuses.length - 1], "ok"); // error dot clears
});

test("online->online churn (routes/VPN) does not cause a pull storm", async () => {
    const { sync, client, netMonitor } = makeSync({ online: true });
    sync.start();
    await new Promise((r) => setImmediate(r));
    const before = client.calls.filter((c) => c.method === "queryDatabase").length;

    netMonitor.setOnline(true); // no edge: already online
    netMonitor.setOnline(true);
    await new Promise((r) => setImmediate(r));
    const after = client.calls.filter((c) => c.method === "queryDatabase").length;
    assert.equal(after, before); // no extra pulls
});

test("stop/destroy disconnect the network watcher", () => {
    const { sync, netMonitor } = makeSync();
    sync.start();
    assert.equal(netMonitor.handlerCount(), 1);
    sync.stop();
    assert.equal(netMonitor.handlerCount(), 0);
    sync.start();
    sync.destroy();
    assert.equal(netMonitor.handlerCount(), 0);
});

// projectStatus (one page, asked directly)

test("projectStatus: present, archived, in the trash, missing, and no answer", async () => {
    const { sync, client } = makeSync();
    const notFound = new Error("http-404");
    notFound.status = 404;
    const serverError = new Error("http-502");
    serverError.status = 502;
    client.pages = {
        live: rawPage("live", "Live", true, 0),
        trashed: Object.assign(rawPage("trashed", "T", true, 1), {
            archived: true,
            in_trash: true,
        }),
        trashedOnly: Object.assign(rawPage("t2", "T2", true, 1), { in_trash: true }),
        missing: notFound,
        flaky: serverError,
        offline: new Error("Could not connect"),
    };
    const checkbox = rawPage("boxed", "Boxed", true, 2);
    checkbox.properties.Archive = { checkbox: true };
    client.pages.boxed = checkbox;

    assert.equal(await sync.projectStatus("live"), "present");
    assert.equal(await sync.projectStatus("trashed"), "gone");
    assert.equal(await sync.projectStatus("trashedOnly"), "gone");
    assert.equal(await sync.projectStatus("boxed"), "gone"); // our own Archive checkbox
    assert.equal(await sync.projectStatus("missing"), "gone"); // deleted for good
    assert.equal(await sync.projectStatus("flaky"), "unknown");
    assert.equal(await sync.projectStatus("offline"), "unknown");
});
