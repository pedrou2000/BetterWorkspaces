/*
 * BetterWorkspaces — notion/SyncService.js
 *
 * Notion TRANSPORT only (Design Doc §3.A). Since the ProjectStore redesign it
 * owns no state and never touches the disk cache:
 *
 *   - pull loop: queryDatabase -> ProjectMapper.mapResults -> onPull(projects)
 *     (the applet feeds the result into ProjectStore.merge)
 *   - push: setWorkspaceFlag/setWorkspaceOrder are plain Notion writes used as
 *     the store's writer; the store owns queueing, optimism, and reverts
 *
 * Status callback states: "unconfigured" | "loading" | "ok" | "error".
 *
 * Released under the GNU General Public License v2 (see LICENSE).
 */
const Mainloop = imports.mainloop;

const AppletDir = imports.ui.appletManager.applets["better-workspaces@pedrou2000"];
const L = AppletDir.lib.logger.Logger.makeLogger("sync");
const NotionClient = AppletDir.notion.NotionClient.NotionClient;
const ProjectMapper = AppletDir.notion.ProjectMapper.ProjectMapper;

const DEFAULT_SYNC_INTERVAL_S = AppletDir.lib.constants.Constants.DEFAULT_SYNC_INTERVAL_S;

var SyncService = class SyncService {

    constructor(token, databaseId, opts) {
        opts = opts || {};
        this.databaseId = databaseId;
        this.intervalSec = opts.intervalSec || DEFAULT_SYNC_INTERVAL_S;
        this.client = new NotionClient(token);
        this._timer = 0;
        this._onPull = null;   // cb(projects[]) — a completed pull
        this._onStatus = null; // cb(status)
    }

    setToken(token) { this.client.setToken(token); }
    setDatabaseId(id) { this.databaseId = id; }
    onPull(cb) { this._onPull = cb; }
    onStatus(cb) { this._onStatus = cb; }

    _setStatus(s) {
        this._status = s;
        if (this._onStatus) {
            try { this._onStatus(s); } catch (e) { L.error("onStatus cb: " + e.toString()); }
        }
    }

    // ---- push: the ProjectStore's writer interface -------------------------

    // Write the Workspace checkbox for a project. Rejects on failure.
    setWorkspaceFlag(pageId, value) {
        return this.client.updatePageCheckbox(pageId, "Workspace", value);
    }

    // Write the Workspace Order number (null clears it). Rejects on failure.
    setWorkspaceOrder(pageId, order) {
        return this.client.updatePageNumber(pageId, "Workspace Order", order);
    }

    // ---- pull ----------------------------------------------------------------

    // One pull now. Resolves after onPull has run (or on error/unconfigured —
    // status reflects the outcome; errors never reject, cached data keeps
    // serving).
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
            L.error("syncNow failed: " + e.message + " (store keeps serving)");
            this._setStatus("error");
            return;
        }
        let projects = ProjectMapper.mapResults(result);
        this._setStatus("ok");
        L.log("syncNow: pulled " + projects.length + " projects");
        if (this._onPull) {
            try { this._onPull(projects); }
            catch (e) { L.error("onPull cb: " + e.toString()); }
        }
    }

    // Start periodic background pulls (and do one immediately).
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
        this._onPull = null;
        this.client = null;
    }
};
