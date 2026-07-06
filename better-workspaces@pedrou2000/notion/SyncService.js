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

    // Read whatever is currently cached on disk (instant, offline-safe).
    readCache: function () {
        let cached = Persistence.readJSON(CACHE_FILE, null);
        return (cached && cached.projects) ? cached.projects : [];
    },

    // Trigger one sync now. Non-blocking; result flows via cache + onUpdate.
    syncNow: function () {
        if (!this.databaseId) { L.error("syncNow: no databaseId set"); return; }
        if (!this.client.hasToken()) { L.log("syncNow: no token, skipping"); return; }

        L.log("syncNow: querying database " + this.databaseId);
        let body = ProjectMapper.buildQueryBody();
        this.client.queryDatabase(this.databaseId, body, (err, result) => {
            if (err) {
                L.error("syncNow failed: " + err + " (serving cache)");
                return;
            }
            let projects = ProjectMapper.mapResults(result);
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
