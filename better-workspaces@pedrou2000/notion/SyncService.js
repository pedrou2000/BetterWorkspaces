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
 *   - reconnect: while started, Gio.NetworkMonitor is watched and the
 *     offline->online transition triggers an immediate pull, so stale state
 *     and the error dot recover right away instead of waiting out the
 *     interval timer
 *
 * Status callback states: "unconfigured" | "loading" | "ok" | "error".
 *
 * Released under the GNU General Public License v2 (see LICENSE).
 */
const Mainloop = imports.mainloop;
const Gio = imports.gi.Gio;

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

    // Start periodic background pulls (and do one immediately), and watch the
    // network so the offline->online transition pulls right away.
    start() {
        this.stop();
        this.syncNow();
        this._timer = Mainloop.timeout_add_seconds(
            this.intervalSec, () => { this.syncNow(); return true; });
        this._watchNetwork();
        L.log("started: interval " + this.intervalSec + "s");
    }

    // Subscribe to Gio.NetworkMonitor. Only the offline->online EDGE triggers
    // a pull (the monitor fires network-changed for many reasons — routes,
    // VPNs, metered flips — and we don't want a pull storm). Fully guarded:
    // on platforms where the monitor is unavailable we just keep the timer.
    _watchNetwork() {
        try {
            this._netMonitor = Gio.NetworkMonitor.get_default();
            if (!this._netMonitor) return;
            this._wasOnline = this._netMonitor.get_network_available();
            this._netChangedId = this._netMonitor.connect(
                'network-changed', (monitor, available) => {
                    let online = !!available;
                    if (online && !this._wasOnline) {
                        L.log("network restored — pulling now");
                        this.syncNow();
                    }
                    this._wasOnline = online;
                });
        } catch (e) {
            L.error("_watchNetwork: " + e.toString());
            this._netMonitor = null;
        }
    }

    _unwatchNetwork() {
        if (this._netMonitor && this._netChangedId) {
            try { this._netMonitor.disconnect(this._netChangedId); } catch (e) {}
        }
        this._netChangedId = 0;
        this._netMonitor = null;
    }

    stop() {
        if (this._timer) {
            Mainloop.source_remove(this._timer);
            this._timer = 0;
        }
        this._unwatchNetwork();
    }

    destroy() {
        this.stop();
        this._onPull = null;
        this.client = null;
    }
};
