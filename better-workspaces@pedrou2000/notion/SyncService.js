/*
 * BetterWorkspaces — notion/SyncService.js
 *
 * Background sync loop (Design Doc §3.A). Orchestrates: Client.queryDatabase ->
 * ProjectMapper.mapResults -> write JSON cache to disk -> invoke a callback so
 * the Core can react. Everything upstream reads the cache, never the live
 * client, so the panel is instant and offline-safe.
 *
 * Write methods (setWorkspaceFlag/setWorkspaceOrder/syncNow) are async and
 * resolve on success / reject with Error("no-token"|"http-<status>"|...) on
 * failure; callers await them and revert UI state on rejection.
 *
 * Released under the GNU General Public License v2 (see LICENSE).
 */
const Mainloop = imports.mainloop;

const AppletDir = imports.ui.appletManager.applets["better-workspaces@pedrou2000"];
const L = AppletDir.lib.logger.Logger.makeLogger("sync");
const Persistence = AppletDir.lib.persistence.Persistence;
const NotionClient = AppletDir.notion.NotionClient.NotionClient;
const ProjectMapper = AppletDir.notion.ProjectMapper.ProjectMapper;

const DEFAULT_SYNC_INTERVAL_S = AppletDir.lib.constants.Constants.DEFAULT_SYNC_INTERVAL_S;

var CACHE_FILE = "projects-cache.json";

var SyncService = class SyncService {

    constructor(token, databaseId, opts) {
        opts = opts || {};
        this.databaseId = databaseId;
        this.intervalSec = opts.intervalSec || DEFAULT_SYNC_INTERVAL_S;
        this.client = new NotionClient(token);
        this._timer = 0;
        this._onUpdate = null; // cb(projects[])
    }

    setToken(token) { this.client.setToken(token); }
    setDatabaseId(id) { this.databaseId = id; }
    onUpdate(cb) { this._onUpdate = cb; }
    onStatus(cb) { this._onStatus = cb; }

    // Notify the status callback (states: "unconfigured"|"loading"|"ok"|"error").
    _setStatus(s) {
        this._status = s;
        if (this._onStatus) {
            try { this._onStatus(s); } catch (e) { L.error("onStatus cb: " + e.toString()); }
        }
    }

    // Read whatever is currently cached on disk (instant, offline-safe).
    // Returns ALL non-archived projects; callers derive the deck by filtering
    // inWorkspace=true.
    readCache() {
        let cached = Persistence.readJSON(CACHE_FILE, null);
        return (cached && cached.projects) ? cached.projects : [];
    }

    // Update one cached project via `mutate(project)`, then rewrite the cache.
    _updateCached(pageId, mutate) {
        let projects = this.readCache();
        for (let i = 0; i < projects.length; i++) {
            if (projects[i].id === pageId) { mutate(projects[i]); break; }
        }
        this._writeCache(projects);
    }

    // Write the Workspace checkbox for a project back to Notion, then update the
    // cached entry's inWorkspace flag on success. Rejects on failure.
    async setWorkspaceFlag(pageId, value) {
        try {
            await this.client.updatePageCheckbox(pageId, "Workspace", value);
        } catch (e) {
            L.error("setWorkspaceFlag failed for " + pageId + ": " + e.message);
            throw e;
        }
        // Reflect the change in the on-disk cache so it survives reloads.
        this._updateCached(pageId, (p) => { p.inWorkspace = !!value; });
        L.log("setWorkspaceFlag: " + pageId + " -> " + value);
    }

    // Write the Workspace Order number for a project back to Notion and update
    // the cached entry. Rejects on failure.
    async setWorkspaceOrder(pageId, order) {
        try {
            await this.client.updatePageNumber(pageId, "Workspace Order", order);
        } catch (e) {
            L.error("setWorkspaceOrder failed for " + pageId + ": " + e.message);
            throw e;
        }
        this._updateCached(pageId, (p) => { p.order = order; });
    }

    // Clear a project's Workspace Order (set to null in Notion + cache), so it
    // sorts last (nulls-last) once deactivated.
    clearWorkspaceOrder(pageId) {
        return this.setWorkspaceOrder(pageId, null);
    }

    // Highest Workspace Order currently in the cache (among any project), or -1
    // if none set. Used to place a newly-activated project at the bottom.
    maxOrder() {
        let projects = this.readCache();
        let max = -1;
        for (let i = 0; i < projects.length; i++) {
            let o = projects[i].order;
            if (typeof o === "number" && o > max) max = o;
        }
        return max;
    }

    // Persist an ordered list of project ids as Workspace Order = 0,1,2,...
    // First update the local cache SYNCHRONOUSLY (so an immediate re-render sees
    // the new order), then fire the async Notion writes (fire-and-forget; each
    // write logs its own failure).
    persistOrder(orderedIds) {
        // 1) Synchronous cache update.
        let projects = this.readCache();
        let orderById = {};
        for (let i = 0; i < orderedIds.length; i++) orderById[orderedIds[i]] = i;
        for (let i = 0; i < projects.length; i++) {
            if (orderById[projects[i].id] !== undefined) projects[i].order = orderById[projects[i].id];
        }
        this._writeCache(projects);

        // 2) Async Notion writes (each also re-updates the cache when it lands).
        for (let i = 0; i < orderedIds.length; i++) {
            this.setWorkspaceOrder(orderedIds[i], i).catch(() => {});
        }
        L.log("persistOrder: cache updated + writing order for " + orderedIds.length + " projects");
    }

    // Trigger one sync now. Non-blocking; result flows via cache + onUpdate.
    async syncNow() {
        if (!this.databaseId || !this.client.hasToken()) {
            L.log("syncNow: not configured, skipping");
            this._setStatus("unconfigured");
            return;
        }

        L.log("syncNow: querying database " + this.databaseId);
        this._setStatus("loading");
        let result;
        try {
            result = await this.client.queryDatabase(
                this.databaseId, ProjectMapper.buildQueryBody());
        } catch (e) {
            L.error("syncNow failed: " + e.message + " (serving cache)");
            this._setStatus("error");
            return;
        }
        let projects = ProjectMapper.mapResults(result);
        this._setStatus("ok");
        this._writeCache(projects);
        L.log("syncNow: cached " + projects.length + " projects: ["
            + projects.map((p) => p.name).join(", ") + "]");
        if (this._onUpdate) {
            try { this._onUpdate(projects); }
            catch (e) { L.error("onUpdate cb: " + e.toString()); }
        }
    }

    _writeCache(projects) {
        Persistence.writeJSON(CACHE_FILE, { projects: projects });
    }

    // Start periodic background syncing (and do one immediately).
    start() {
        this.stop();
        this.syncNow();
        this._timer = Mainloop.timeout_add_seconds(
            this.intervalSec, () => { this.syncNow(); return true; });
        L.log("started: interval " + this.intervalSec + "s");
    }

    stop() {
        if (this._timer) {
            Mainloop.source_remove(this._timer);
            this._timer = 0;
        }
    }

    destroy() {
        this.stop();
        this._onUpdate = null;
        this.client = null;
    }
};
