/*
 * BetterWorkspaces — Cinnamon applet
 *
 * M1: controlled mutation. The panel shows live "active/total"; the right-click
 * context menu exposes each WorkspaceManager action (create / switch / remove /
 * move window) so every mutation can be triggered and watched. All workspace
 * access goes through wm/WorkspaceManager.js (the Cinnamon quarantine).
 *
 * Released under the GNU General Public License v2 (see LICENSE).
 */
const Applet = imports.ui.applet;
const Lang = imports.lang;
const PopupMenu = imports.ui.popupMenu;

const UUID = "better-workspaces@pedrou2000";

// Import sibling modules from the applet's own directory. In Cinnamon the
// applet dir is exposed via appletManager; subfolders are nested importers.
const AppletDir = imports.ui.appletManager.applets[UUID];
const WorkspaceManager = AppletDir.wm.WorkspaceManager;

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
            log("loaded (M1 controlled-mutation v0.1.0)");

            this.wm = new WorkspaceManager.WorkspaceManager();

            // Refresh the label on workspace switch and on count changes.
            this._switchId = global.window_manager.connect(
                'switch-workspace', Lang.bind(this, this._refresh));
            this._nWorkspacesId = global.workspace_manager.connect(
                'notify::n-workspaces', Lang.bind(this, this._refresh));

            this._buildContextMenu();
            this._refresh();
        } catch (e) {
            logError("init exception: " + e.toString());
        }
    },

    // Compact panel label: 1-based active / total, e.g. "3/6".
    _refresh: function () {
        try {
            let total = this.wm.getWorkspaceCount();
            let active = this.wm.getActiveIndex();
            this.set_applet_label((active + 1) + "/" + total);
            this.set_applet_tooltip("BetterWorkspaces (M1) — active "
                + (active + 1) + " of " + total);
        } catch (e) {
            logError("_refresh exception: " + e.toString());
        }
    },

    // Build the right-click menu with one item per WorkspaceManager action.
    _buildContextMenu: function () {
        let menu = this._applet_context_menu;

        let addAction = Lang.bind(this, function (label, fn) {
            let item = new PopupMenu.PopupMenuItem(label);
            item.connect('activate', Lang.bind(this, function () {
                try {
                    fn.call(this);
                } catch (e) {
                    logError("menu action '" + label + "': " + e.toString());
                }
                this._refresh();
            }));
            menu.addMenuItem(item);
            return item;
        });

        addAction("Create workspace (append)", function () {
            let idx = this.wm.createWorkspace();
            log("menu: created workspace index " + idx);
        });

        addAction("Go to next workspace", function () {
            this.wm.goToNext();
        });

        addAction("Go to previous workspace", function () {
            this.wm.goToPrevious();
        });

        addAction("Move focused window to next (and follow)", function () {
            this.wm.moveFocusedWindowToNext();
        });

        addAction("Remove last workspace", function () {
            this.wm.removeLastWorkspace();
        });
    },

    on_applet_clicked: function () {
        // Left-click: quick jump to next workspace, so basic switching is
        // reachable without opening the menu.
        this.wm.goToNext();
        this._refresh();
    },

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
            if (this.wm) {
                this.wm.destroy();
                this.wm = null;
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
