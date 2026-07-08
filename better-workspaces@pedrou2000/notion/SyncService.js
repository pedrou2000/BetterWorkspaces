/*
 * BetterWorkspaces — notion/SyncService.js
 *
 * Background sync loop (Design Doc §3.A). Orchestrates: Client.queryDatabase ->
 * ProjectMapper.mapResults -> write JSON cache to disk -> invoke a callback so
 * the Core can react. Everything upstream reads the cache, never the live
 * client, so the panel is instant and offline-safe.
 *
 * M4 scope: headless. Prove we can pull + filter + cache the real project list.
 *
 * Released under the GNU General Public License v2 (see LICENSE).
 */
const Mainloop = imports.mainloop;

const AppletDir = imports.ui.appletManager.applets["better-workspaces@pedrou2000"];
const L = AppletDir.lib.logger.Logger.makeLogger("sync");
const Persistence = AppletDir.lib.persistence.Persistence;
const NotionClientModule = AppletDir.notion.NotionClient.NotionClientModule;
const ProjectMapper = AppletDir.notion.ProjectMapper.ProjectMapper;

const CACHE_FILE = "projects-cache.json";

function SyncService(token, databaseId, opts) {
    this._init(token, databaseId, opts);
}

SyncService.prototype = {

    _init: function (token, databaseId, opts) {
        opts = opts || {};
        this.databaseId = databaseId;
        this.intervalSec = opts.intervalSec || 300; // default 5 min
        this.client = new NotionClientModule.NotionClient(token);
        this._timer = 0;
        this._onUpdate = null; // cb(projects[])
    },

    setToken: function (token) { this.client.setToken(token); },
    setDatabaseId: function (id) { this.databaseId = id; },
    onUpdate: function (cb) { this._onUpdate = cb; },
    onStatus: function (cb) { this._onStatus = cb; },

    // last status: "unconfigured" | "loading" | "ok" | "error"
    status: function () { return this._status || "unconfigured"; },

    _setStatus: function (s) {
        this._status = s;
        if (this._onStatus) {
            try { this._onStatus(s); } catch (e) { L.error("onStatus cb: " + e.toString()); }
        }
    },

    // Read whatever is currently cached on disk (instant, offline-safe).
    // Returns ALL non-archived projects; callers derive the deck by filtering
    // inWorkspace=true.
    readCache: function () {
        let cached = Persistence.readJSON(CACHE_FILE, null);
        return (cached && cached.projects) ? cached.projects : [];
    },

    // Write the Workspace checkbox for a project back to Notion, then update the
    // cached entry's inWorkspace flag on success. cb(err) — err null on success.
    setWorkspaceFlag: function (pageId, value, cb) {
        if (!this.client.hasToken()) { cb && cb("no-token"); return; }
        this.client.updatePageCheckbox(pageId, "Workspace", value, (err) => {
            if (err) {
                L.error("setWorkspaceFlag failed for " + pageId + ": " + err);
                cb && cb(err);
                return;
            }
            // Reflect the change in the on-disk cache so it survives reloads.
            let projects = this.readCache();
            for (let i = 0; i < projects.length; i++) {
                if (projects[i].id === pageId) { projects[i].inWorkspace = !!value; break; }
            }
            this._writeCache(projects);
            L.log("setWorkspaceFlag: " + pageId + " -> " + value);
            cb && cb(null);
        });
    },

    // Write the Workspace Order number for a project back to Notion and update
    // the cached entry. cb(err) — err null on success.
    setWorkspaceOrder: function (pageId, order, cb) {
        if (!this.client.hasToken()) { cb && cb("no-token"); return; }
        this.client.updatePageNumber(pageId, "Workspace Order", order, (err) => {
            if (err) {
                L.error("setWorkspaceOrder failed for " + pageId + ": " + err);
                cb && cb(err);
                return;
            }
            let projects = this.readCache();
            for (let i = 0; i < projects.length; i++) {
                if (projects[i].id === pageId) { projects[i].order = order; break; }
            }
            this._writeCache(projects);
            cb && cb(null);
        });
    },

    // Clear a project's Workspace Order (set to null in Notion + cache), so it
    // sorts last (nulls-last) once deactivated.
    clearWorkspaceOrder: function (pageId, cb) {
        this.setWorkspaceOrder(pageId, null, cb);
    },

    // Highest Workspace Order currently in the cache (among any project), or -1
    // if none set. Used to place a newly-activated project at the bottom.
    maxOrder: function () {
        let projects = this.readCache();
        let max = -1;
        for (let i = 0; i < projects.length; i++) {
            let o = projects[i].order;
            if (typeof o === "number" && o > max) max = o;
        }
        return max;
    },

    // Persist an ordered list of project ids as Workspace Order = 0,1,2,...
    // First update the local cache SYNCHRONOUSLY (so an immediate re-render sees
    // the new order), then fire the async Notion writes.
    persistOrder: function (orderedIds) {
        // 1) Synchronous cache update.
        let projects = this.readCache();
        let orderById = {};
        for (let i = 0; i < orderedIds.length; i++) orderById[orderedIds[i]] = i;
        for (let i = 0; i < projects.length; i++) {
            if (orderById[projects[i].id] !== undefined) projects[i].order = orderById[projects[i].id];
        }
        this._writeCache(projects);

        // 2) Async Notion writes (each also re-updates the cache when it returns).
        for (let i = 0; i < orderedIds.length; i++) {
            this.setWorkspaceOrder(orderedIds[i], i, null);
        }
        L.log("persistOrder: cache updated + writing order for " + orderedIds.length + " projects");
    },

    // Trigger one sync now. Non-blocking; result flows via cache + onUpdate.
    syncNow: function () {
        if (!this.databaseId || !this.client.hasToken()) {
            L.log("syncNow: not configured, skipping");
            this._setStatus("unconfigured");
            return;
        }

        L.log("syncNow: querying database " + this.databaseId);
        this._setStatus("loading");
        let body = ProjectMapper.buildQueryBody();
        this.client.queryDatabase(this.databaseId, body, (err, result) => {
            if (err) {
                L.error("syncNow failed: " + err + " (serving cache)");
                this._setStatus("error");
                return;
            }
            let projects = ProjectMapper.mapResults(result);
            this._setStatus("ok");
            this._writeCache(projects);
            L.log("syncNow: cached " + projects.length + " projects: ["
                + projects.map(function (p) { return p.name; }).join(", ") + "]");
            if (this._onUpdate) {
                try { this._onUpdate(projects); }
                catch (e) { L.error("onUpdate cb: " + e.toString()); }
            }
        });
    },

    _writeCache: function (projects) {
        Persistence.writeJSON(CACHE_FILE, {
            // No Date.now() dependency here; timestamp added by callers if needed.
            projects: projects,
        });
    },

    // Start periodic background syncing (and do one immediately).
    start: function () {
        this.stop();
        this.syncNow();
        this._timer = Mainloop.timeout_add_seconds(
            this.intervalSec, () => { this.syncNow(); return true; });
        L.log("started: interval " + this.intervalSec + "s");
    },

    stop: function () {
        if (this._timer) {
            Mainloop.source_remove(this._timer);
            this._timer = 0;
        }
    },

    destroy: function () {
        this.stop();
        this._onUpdate = null;
        this.client = null;
    },
};

var SyncServiceModule = { SyncService: SyncService, CACHE_FILE: CACHE_FILE };
