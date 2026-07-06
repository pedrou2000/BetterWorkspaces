/*
 * BetterWorkspaces — Cinnamon applet
 *
 * M3: project-switching UX. The Core (M2) now drives real UI:
 *   - PanelIndicator: a clickable project button row + position label.
 *   - ProjectSwitcher: a Super+Tab MRU overlay.
 *   - Keybindings: Super+Tab (projects, MRU), Ctrl+Alt+Left/Right (workspace
 *     within project), Ctrl+Alt+Up/Down (project in order).
 * Still a hardcoded deck; no Notion yet.
 *
 * Released under the GNU General Public License v2 (see LICENSE).
 */
const Applet = imports.ui.applet;
const Lang = imports.lang;
const Main = imports.ui.main;
const PopupMenu = imports.ui.popupMenu;

const UUID = "better-workspaces@pedrou2000";

const AppletDir = imports.ui.appletManager.applets[UUID];
const WorkspaceManager = AppletDir.wm.WorkspaceManager;
const ControllerModule = AppletDir.core.Controller;
const PanelIndicatorModule = AppletDir.ui.PanelIndicator;
const ProjectSwitcherModule = AppletDir.ui.ProjectSwitcher;

function log(msg) { global.log(UUID + ": " + msg); }
function logError(msg) { global.logError(UUID + ": " + msg); }

const HARDCODED_PROJECTS = [
    { id: "webapp",   name: "WebApp",   wsCount: 3 },
    { id: "blog",     name: "Blog",     wsCount: 2 },
    { id: "research", name: "Research", wsCount: 2 },
];

// keybinding name -> { keys, handler-method-name }
const KEYBINDINGS = [
    { name: "bw-next-project",   keys: "<Control><Alt>Down",  fn: "goToNextProjectInOrder" },
    { name: "bw-prev-project",   keys: "<Control><Alt>Up",    fn: "goToPrevProjectInOrder" },
    { name: "bw-next-workspace", keys: "<Control><Alt>Right", fn: "nextLocalWorkspace" },
    { name: "bw-prev-workspace", keys: "<Control><Alt>Left",  fn: "prevLocalWorkspace" },
];

function MyApplet(orientation, panel_height, instanceId) {
    this._init(orientation, panel_height, instanceId);
}

MyApplet.prototype = {
    __proto__: Applet.Applet.prototype,

    _init: function (orientation, panel_height, instanceId) {
        Applet.Applet.prototype._init.call(this, orientation, panel_height, instanceId);

        try {
            log("loaded (M3 switching-UX v0.3.0)");

            this.wm = new WorkspaceManager.WorkspaceManager();
            this.controller = new ControllerModule.Controller(this.wm);
            this.controller.loadProjects(HARDCODED_PROJECTS);

            this.panelUI = new PanelIndicatorModule.PanelIndicator(this.actor, this.controller);
            this.switcher = new ProjectSwitcherModule.ProjectSwitcher(this.controller);

            this._switchId = global.window_manager.connect(
                'switch-workspace', Lang.bind(this, this._refresh));
            this._nWorkspacesId = global.workspace_manager.connect(
                'notify::n-workspaces', Lang.bind(this, this._refresh));

            this._registerKeybindings();
            this._buildContextMenu();
            this._refresh();
        } catch (e) {
            logError("init exception: " + e.toString());
        }
    },

    _refresh: function () {
        try {
            if (this.panelUI) this.panelUI.update();
        } catch (e) {
            logError("_refresh exception: " + e.toString());
        }
    },

    _registerKeybindings: function () {
        this._boundKeys = [];

        // Directional / within-project bindings -> Controller methods.
        KEYBINDINGS.forEach(Lang.bind(this, function (kb) {
            Main.keybindingManager.addHotKey(
                kb.name, kb.keys,
                Lang.bind(this, function () {
                    try {
                        this.controller[kb.fn]();
                        this._refresh();
                    } catch (e) {
                        logError("hotkey " + kb.name + ": " + e.toString());
                    }
                }));
            this._boundKeys.push(kb.name);
        }));

        // Super+Tab -> MRU project switcher overlay.
        Main.keybindingManager.addHotKey(
            "bw-switcher", "<Super>Tab",
            Lang.bind(this, function () {
                try { this.switcher.cycle(); }
                catch (e) { logError("switcher hotkey: " + e.toString()); }
            }));
        this._boundKeys.push("bw-switcher");

        log("registered keybindings: " + this._boundKeys.join(", "));
    },

    _unregisterKeybindings: function () {
        if (!this._boundKeys) return;
        this._boundKeys.forEach(function (name) {
            try { Main.keybindingManager.removeHotKey(name); } catch (e) {}
        });
        this._boundKeys = [];
    },

    _buildContextMenu: function () {
        let menu = this._applet_context_menu;
        let addAction = Lang.bind(this, function (label, fn) {
            let item = new PopupMenu.PopupMenuItem(label);
            item.connect('activate', Lang.bind(this, function () {
                try { fn.call(this); } catch (e) { logError("menu: " + e.toString()); }
                this._refresh();
            }));
            menu.addMenuItem(item);
        });
        addAction("Add workspace to active project", function () {
            this.controller.addWorkspaceToActiveProject();
            this.panelUI.update();
        });
        addAction("Remove last workspace of active project", function () {
            this.controller.removeLastWorkspaceOfActiveProject();
            this.panelUI.update();
        });
        addAction("Log current state", function () {
            log(this.controller.describe());
        });
    },

    // Base Applet has no default click action; use it as "next project".
    on_applet_clicked: function () {
        this.controller.goToNextProjectInOrder();
        this._refresh();
    },

    on_applet_removed_from_panel: function () {
        try {
            this._unregisterKeybindings();
            if (this._switchId) {
                global.window_manager.disconnect(this._switchId);
                this._switchId = 0;
            }
            if (this._nWorkspacesId) {
                global.workspace_manager.disconnect(this._nWorkspacesId);
                this._nWorkspacesId = 0;
            }
            if (this.switcher) { this.switcher.destroy(); this.switcher = null; }
            if (this.panelUI) { this.panelUI.destroy(); this.panelUI = null; }
            if (this.controller) { this.controller.destroy(); this.controller = null; }
            if (this.wm) { this.wm.destroy(); this.wm = null; }
            log("removed, cleaned up");
        } catch (e) {
            logError("cleanup exception: " + e.toString());
        }
    },
};

function main(metadata, orientation, panel_height, instanceId) {
    return new MyApplet(orientation, panel_height, instanceId);
}
