/*
 * BetterWorkspaces — Cinnamon applet
 *
 * M2: Core model + hardcoded strips. The applet seeds a hardcoded deck of
 * projects and drives everything through core/Controller.js, which maps the
 * deck-of-strips model onto the flat workspace list (core/mapping.js) and acts
 * via wm/WorkspaceManager.js. The panel shows "Project L/N" (active project +
 * local workspace); the right-click menu exercises every intent. No Notion, no
 * real UI yet.
 *
 * Released under the GNU General Public License v2 (see LICENSE).
 */
const Applet = imports.ui.applet;
const Lang = imports.lang;
const PopupMenu = imports.ui.popupMenu;

const UUID = "better-workspaces@pedrou2000";

const AppletDir = imports.ui.appletManager.applets[UUID];
const WorkspaceManager = AppletDir.wm.WorkspaceManager;
const ControllerModule = AppletDir.core.Controller;

function log(msg) { global.log(UUID + ": " + msg); }
function logError(msg) { global.logError(UUID + ": " + msg); }

// M2 hardcoded deck. Each project has a home workspace (index 0) plus extras.
const HARDCODED_PROJECTS = [
    { id: "webapp",   name: "WebApp",   wsCount: 3 },
    { id: "blog",     name: "Blog",     wsCount: 2 },
    { id: "research", name: "Research", wsCount: 2 },
];

function MyApplet(orientation, panel_height, instanceId) {
    this._init(orientation, panel_height, instanceId);
}

MyApplet.prototype = {
    __proto__: Applet.TextApplet.prototype,

    _init: function (orientation, panel_height, instanceId) {
        Applet.TextApplet.prototype._init.call(this, orientation, panel_height, instanceId);

        try {
            log("loaded (M2 core-model v0.2.0)");

            this.wm = new WorkspaceManager.WorkspaceManager();
            this.controller = new ControllerModule.Controller(this.wm);
            this.controller.loadProjects(HARDCODED_PROJECTS);

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

    // Panel: "ProjectName  L/N" for the active project, from reality.
    _refresh: function () {
        try {
            let loc = this.controller.currentLocation();
            if (loc) {
                let p = this.controller.state.getProject(loc.projectIdx);
                this.set_applet_label(
                    p.name + " " + (loc.localIdx + 1) + "/" + p.wsCount);
            } else {
                this.set_applet_label("BetterWS ?");
            }
            this.set_applet_tooltip(this.controller.describe());
        } catch (e) {
            logError("_refresh exception: " + e.toString());
        }
    },

    _buildContextMenu: function () {
        let menu = this._applet_context_menu;

        let addAction = Lang.bind(this, function (label, fn) {
            let item = new PopupMenu.PopupMenuItem(label);
            item.connect('activate', Lang.bind(this, function () {
                try { fn.call(this); }
                catch (e) { logError("menu '" + label + "': " + e.toString()); }
                this._refresh();
                log(this.controller.describe());
            }));
            menu.addMenuItem(item);
            return item;
        });

        addAction("Next project (in order)", function () {
            this.controller.goToNextProjectInOrder();
        });
        addAction("Previous project (in order)", function () {
            this.controller.goToPrevProjectInOrder();
        });
        addAction("Flip to previous project (MRU)", function () {
            this.controller.goToPreviousProject();
        });

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        addAction("Next workspace (within project)", function () {
            this.controller.nextLocalWorkspace();
        });
        addAction("Previous workspace (within project)", function () {
            this.controller.prevLocalWorkspace();
        });

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        addAction("Add workspace to active project", function () {
            this.controller.addWorkspaceToActiveProject();
        });
        addAction("Remove last workspace of active project", function () {
            this.controller.removeLastWorkspaceOfActiveProject();
        });

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        addAction("Log current state", function () {
            log(this.controller.describe());
        });
    },

    on_applet_clicked: function () {
        // Left-click: next workspace within the active project.
        this.controller.nextLocalWorkspace();
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
            if (this.controller) { this.controller.destroy(); this.controller = null; }
            if (this.wm) { this.wm.destroy(); this.wm = null; }
            log("removed, signals disconnected");
        } catch (e) {
            logError("cleanup exception: " + e.toString());
        }
    },
};

function main(metadata, orientation, panel_height, instanceId) {
    return new MyApplet(orientation, panel_height, instanceId);
}
