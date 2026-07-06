/*
 * BetterWorkspaces — Cinnamon applet
 *
 * Read-only stage: query Cinnamon's live workspace state (count, active index,
 * grid geometry, per-workspace window counts) and report it. NOTHING is mutated
 * yet — this proves we can safely talk to workspace_manager before we ever
 * change it. The panel shows a compact "active/total" summary that updates when
 * you switch workspaces; clicking dumps full detail to the log.
 *
 * Released under the GNU General Public License v2 (see LICENSE).
 */
const Applet = imports.ui.applet;
const Lang = imports.lang;

const UUID = "better-workspaces@pedrou2000";

function log(msg) { global.log(UUID + ": " + msg); }
function logError(msg) { global.logError(UUID + ": " + msg); }

function MyApplet(orientation, panel_height, instanceId) {
    this._init(orientation, panel_height, instanceId);
}

MyApplet.prototype = {
    __proto__: Applet.TextApplet.prototype,

    _init: function (orientation, panel_height, instanceId) {
        Applet.TextApplet.prototype._init.call(this, orientation, panel_height, instanceId);

        try {
            log("loaded (read-only v0.0.2)");

            // Update the panel label whenever the active workspace changes.
            // 'switch-workspace' fires on the window manager after a switch.
            this._switchId = global.window_manager.connect(
                'switch-workspace', Lang.bind(this, this._onWorkspaceChanged));

            // Also refresh if workspaces are added/removed elsewhere, so our
            // "total" count stays honest.
            this._nWorkspacesId = global.workspace_manager.connect(
                'notify::n-workspaces', Lang.bind(this, this._onWorkspaceChanged));

            this._refresh();
        } catch (e) {
            logError("init exception: " + e.toString());
        }
    },

    // Read current state and update the compact panel label + tooltip.
    _refresh: function () {
        try {
            let wm = global.workspace_manager;
            let total = wm.n_workspaces;
            let active = wm.get_active_workspace_index();

            // Panel: 1-based active index / total, e.g. "3/6".
            this.set_applet_label((active + 1) + "/" + total);

            // Tooltip: a per-workspace summary with window counts.
            let lines = ["BetterWorkspaces (read-only)"];
            for (let i = 0; i < total; i++) {
                let ws = wm.get_workspace_by_index(i);
                let nWindows = ws ? ws.list_windows().length : 0;
                let marker = (i === active) ? " *" : "";
                lines.push("  ws " + (i + 1) + ": " + nWindows + " windows" + marker);
            }
            this.set_applet_tooltip(lines.join("\n"));
        } catch (e) {
            logError("_refresh exception: " + e.toString());
        }
    },

    _onWorkspaceChanged: function () {
        this._refresh();
    },

    // Click: dump full detail to the log (view with Alt+F2 -> "lg" -> Log tab).
    on_applet_clicked: function () {
        try {
            let wm = global.workspace_manager;
            let total = wm.n_workspaces;
            let active = wm.get_active_workspace_index();

            // Grid geometry, if Cinnamon exposes it. This is the 2D layout the
            // flat workspace list is arranged into (rows x cols).
            let rows = "?", cols = "?";
            try {
                rows = wm.get_layout_rows();
                cols = wm.get_layout_columns();
            } catch (geomErr) {
                // Older/newer APIs may name these differently; ignore for now.
            }

            log("=== workspace snapshot ===");
            log("total workspaces : " + total);
            log("active index     : " + active + " (1-based: " + (active + 1) + ")");
            log("grid layout      : " + rows + " rows x " + cols + " cols");

            for (let i = 0; i < total; i++) {
                let ws = wm.get_workspace_by_index(i);
                let windows = ws ? ws.list_windows() : [];
                let titles = windows
                    .map(function (w) { return w.get_title(); })
                    .filter(function (t) { return t && t.length > 0; });
                log("ws " + (i + 1) + ": " + windows.length + " windows"
                    + (titles.length ? " [" + titles.join(", ") + "]" : ""));
            }
            log("=== end snapshot ===");
        } catch (e) {
            logError("on_applet_clicked exception: " + e.toString());
        }
    },

    // Cinnamon calls this when the applet is removed or the shell reloads.
    // Disconnect signals so we don't leak handlers into the host process.
    on_applet_removed_from_panel: function () {
        try {
            if (this._switchId) {
                global.window_manager.disconnect(this._switchId);
                this._switchId = 0;
            }
            if (this._nWorkspacesId) {
                global.workspace_manager.disconnect(this._nWorkspacesId);
                this._nWorkspacesId = 0;
            }
            log("removed, signals disconnected");
        } catch (e) {
            logError("cleanup exception: " + e.toString());
        }
    },
};

function main(metadata, orientation, panel_height, instanceId) {
    return new MyApplet(orientation, panel_height, instanceId);
}
