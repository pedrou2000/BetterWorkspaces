/* notion/SyncService.js — Notion transport: pull loop + push writer. Owns no state. */

// Pull: queryDatabase -> ProjectMapper.mapResults -> onPull (the applet feeds it
// into ProjectStore.merge). Push: setWorkspaceFlag/Order are the store's writer.
// Status states: "unconfigured" | "loading" | "ok" | "error".

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
        this._onPull = null; // cb(projects[]) — a completed pull
        this._onStatus = null; // cb(status)
    }

    setToken(token) {
        this.client.setToken(token);
    }
    setDatabaseId(id) {
        this.databaseId = id;
    }
    onPull(cb) {
        this._onPull = cb;
    }
    onStatus(cb) {
        this._onStatus = cb;
    }

    _setStatus(s) {
        this._status = s;
        if (this._onStatus) {
            try {
                this._onStatus(s);
            } catch (e) {
                L.error("onStatus cb: " + e.toString());
            }
        }
    }

    setWorkspaceFlag(pageId, value) {
        return this.client.updatePageCheckbox(pageId, "Workspace", value);
    }

    setWorkspaceOrder(pageId, order) {
        return this.client.updatePageNumber(pageId, "Workspace Order", order);
    }

    // Errors never reject — status reflects the outcome and cached data serves on.
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
                this.databaseId,
                ProjectMapper.buildQueryBody(),
            );
        } catch (e) {
            L.error("syncNow failed: " + e.message + " (store keeps serving)");
            this._setStatus("error");
            return;
        }
        const projects = ProjectMapper.mapResults(result);
        this._setStatus("ok");
        L.log("syncNow: pulled " + projects.length + " projects");
        if (this._onPull) {
            try {
                this._onPull(projects);
            } catch (e) {
                L.error("onPull cb: " + e.toString());
            }
        }
    }

    start() {
        this.stop();
        this.syncNow();
        this._timer = Mainloop.timeout_add_seconds(this.intervalSec, () => {
            this.syncNow();
            return true;
        });
        this._watchNetwork();
        L.log("started: interval " + this.intervalSec + "s");
    }

    // Only the offline->online EDGE pulls: network-changed fires for many reasons
    // (routes, VPNs, metered flips) and we don't want a pull storm. Guarded so a
    // missing monitor just leaves the interval timer running.
    _watchNetwork() {
        try {
            this._netMonitor = Gio.NetworkMonitor.get_default();
            if (!this._netMonitor) return;
            this._wasOnline = this._netMonitor.get_network_available();
            this._netChangedId = this._netMonitor.connect(
                "network-changed",
                (monitor, available) => {
                    const online = !!available;
                    if (online && !this._wasOnline) {
                        L.log("network restored — pulling now");
                        this.syncNow();
                    }
                    this._wasOnline = online;
                },
            );
        } catch (e) {
            L.error("_watchNetwork: " + e.toString());
            this._netMonitor = null;
        }
    }

    _unwatchNetwork() {
        if (this._netMonitor && this._netChangedId) {
            try {
                this._netMonitor.disconnect(this._netChangedId);
            } catch (e) {}
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
