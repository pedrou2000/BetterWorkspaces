/*
 * BetterWorkspaces — Cinnamon applet
 *
 * M4: Notion client + sync (headless). Adds Settings (token, database id, sync
 * interval, "sync now" button) and notion/SyncService, which pulls + filters +
 * caches the real project list to disk and logs the result. The deck driving
 * the workspaces is STILL the hardcoded one — fusing Notion data into the deck
 * is M5. This milestone only proves the pull/filter/cache pipeline.
 *
 * Released under the GNU General Public License v2 (see LICENSE).
 */
const Applet = imports.ui.applet;
const Lang = imports.lang;
const Main = imports.ui.main;
const Meta = imports.gi.Meta;
const Settings = imports.ui.settings;
const PopupMenu = imports.ui.popupMenu;

const UUID = "better-workspaces@pedrou2000";

const AppletDir = imports.ui.appletManager.applets[UUID];
const WorkspaceManager = AppletDir.wm.WorkspaceManager;
const ControllerModule = AppletDir.core.Controller;
const PanelIndicatorModule = AppletDir.ui.PanelIndicator;
const ProjectSwitcherModule = AppletDir.ui.ProjectSwitcher;
const SyncServiceModule = AppletDir.notion.SyncService.SyncServiceModule;

function log(msg) { global.log(UUID + ": " + msg); }
function logError(msg) { global.logError(UUID + ": " + msg); }

const HARDCODED_PROJECTS = [
    { id: "webapp",   name: "WebApp",   wsCount: 3 },
    { id: "blog",     name: "Blog",     wsCount: 2 },
    { id: "research", name: "Research", wsCount: 2 },
];

// Built-in WM actions we OVERRIDE (Ctrl+Alt+arrows are already bound to these
// by Cinnamon, so we replace their handlers instead of adding colliding
// hotkeys). Maps the WM action name -> the Controller method it should invoke.
const OVERRIDES = [
    { action: "switch-to-workspace-up",    fn: "goToPrevProjectInOrder" },
    { action: "switch-to-workspace-down",  fn: "goToNextProjectInOrder" },
    { action: "switch-to-workspace-left",  fn: "prevLocalWorkspace" },
    { action: "switch-to-workspace-right", fn: "nextLocalWorkspace" },
];

function MyApplet(orientation, panel_height, instanceId) {
    this._init(orientation, panel_height, instanceId);
}

MyApplet.prototype = {
    __proto__: Applet.Applet.prototype,

    _init: function (orientation, panel_height, instanceId) {
        Applet.Applet.prototype._init.call(this, orientation, panel_height, instanceId);

        try {
            log("loaded (M4 notion-sync v0.4.0)");

            this.wm = new WorkspaceManager.WorkspaceManager();
            this.controller = new ControllerModule.Controller(this.wm);
            this.controller.loadProjects(HARDCODED_PROJECTS);

            this.panelUI = new PanelIndicatorModule.PanelIndicator(this.actor, this.controller);
            this.switcher = new ProjectSwitcherModule.ProjectSwitcher(this.controller);

            this._switchId = global.window_manager.connect(
                'switch-workspace', Lang.bind(this, this._refresh));
            this._nWorkspacesId = global.workspace_manager.connect(
                'notify::n-workspaces', Lang.bind(this, this._refresh));

            this._initSettingsAndSync(instanceId);
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

    // Bind settings, create the SyncService, and kick off background sync.
    _initSettingsAndSync: function (instanceId) {
        this.settings = new Settings.AppletSettings(this, UUID, instanceId);

        let token = this.settings.getValue("notionToken") || "";
        let dbId = this.settings.getValue("notionDatabaseId") || "";
        let interval = this.settings.getValue("syncIntervalSec") || 300;

        this.sync = new SyncServiceModule.SyncService(token, dbId, { intervalSec: interval });

        // For M4 we only LOG what we synced (deck is still hardcoded). M5 will
        // feed these projects into the controller instead.
        this.sync.onUpdate(Lang.bind(this, function (projects) {
            log("sync produced " + projects.length + " projects: "
                + projects.map(function (p) {
                    let ic = p.icon ? (p.icon.type + ":" + p.icon.value) : "no-icon";
                    return p.name + " {" + (p.priority || "-") + ", " + ic + "}";
                }).join(" | "));
        }));

        // React to settings changes at runtime.
        this.settings.bindProperty(Settings.BindingDirection.IN, "notionToken",
            "notionToken", Lang.bind(this, function () {
                this.sync.setToken(this.settings.getValue("notionToken"));
            }));
        this.settings.bindProperty(Settings.BindingDirection.IN, "notionDatabaseId",
            "notionDatabaseId", Lang.bind(this, function () {
                this.sync.setDatabaseId(this.settings.getValue("notionDatabaseId"));
            }));

        if (token && dbId) {
            this.sync.start();
        } else {
            log("Notion not configured (missing token or database id) — "
                + "open applet settings to add them, then click 'Sync now'.");
        }
    },

    // settings-schema.json "syncNow" button callback.
    onSyncNowClicked: function () {
        try {
            if (this.sync) {
                this.sync.setToken(this.settings.getValue("notionToken"));
                this.sync.setDatabaseId(this.settings.getValue("notionDatabaseId"));
                this.sync.syncNow();
            }
        } catch (e) {
            logError("onSyncNowClicked: " + e.toString());
        }
    },

    _registerKeybindings: function () {
        this._boundKeys = [];

        // Override the built-in Ctrl+Alt+arrow WM actions so ours run instead
        // of Cinnamon's native workspace-switch/Expo (which caused the double
        // firing). set_custom_handler REPLACES the existing handler.
        OVERRIDES.forEach(Lang.bind(this, function (o) {
            try {
                Meta.keybindings_set_custom_handler(
                    o.action,
                    Lang.bind(this, function () {
                        try {
                            this.controller[o.fn]();
                            this._refresh();
                        } catch (e) {
                            logError("override " + o.action + ": " + e.toString());
                        }
                    }));
            } catch (e) {
                logError("failed to override " + o.action + ": " + e.toString());
            }
        }));

        // Super+Tab -> MRU project switcher overlay. This one is a NEW binding
        // (nothing built-in owns it for us here), so addHotKey is correct.
        Main.keybindingManager.addHotKey(
            "bw-switcher", "<Super>Tab",
            Lang.bind(this, function () {
                try { this.switcher.cycle(); }
                catch (e) { logError("switcher hotkey: " + e.toString()); }
            }));
        this._boundKeys.push("bw-switcher");

        log("registered keybindings (overrides + Super+Tab)");
    },

    // Restore Cinnamon's default handlers for the overridden actions, and
    // remove our added hotkeys.
    _unregisterKeybindings: function () {
        OVERRIDES.forEach(function (o) {
            try {
                Meta.keybindings_set_custom_handler(
                    o.action,
                    function (d, w, b) { Main.wm._showWorkspaceSwitcher(d, w, b); });
            } catch (e) {}
        });
        if (this._boundKeys) {
            this._boundKeys.forEach(function (name) {
                try { Main.keybindingManager.removeHotKey(name); } catch (e) {}
            });
            this._boundKeys = [];
        }
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
            if (this.sync) { this.sync.destroy(); this.sync = null; }
            if (this.settings) { this.settings.finalize(); this.settings = null; }
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
