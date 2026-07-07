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
const ModalDialog = imports.ui.modalDialog;
const Clutter = imports.gi.Clutter;

const UUID = "better-workspaces@pedrou2000";

const AppletDir = imports.ui.appletManager.applets[UUID];
const WorkspaceManager = AppletDir.wm.WorkspaceManager;
const ControllerModule = AppletDir.core.Controller;
const PanelIndicatorModule = AppletDir.ui.PanelIndicator;
const ProjectSwitcherModule = AppletDir.ui.ProjectSwitcher;
const ProjectTogglePanelModule = AppletDir.ui.ProjectTogglePanel.ProjectTogglePanelModule;
const SyncServiceModule = AppletDir.notion.SyncService.SyncServiceModule;

function log(msg) { global.log(UUID + ": " + msg); }
function logError(msg) { global.logError(UUID + ": " + msg); }

// Shown only when no Notion cache exists yet (first run / unconfigured), so the
// applet is never empty. Replaced by the real deck as soon as a sync lands.
const PLACEHOLDER_PROJECTS = [
    { id: "placeholder", name: "Connect Notion", wsCount: 1 },
];

// Each synced Notion project starts with just its home workspace; you grow a
// project's strip with the add-workspace action. Keeps startup sane (N projects
// -> N workspaces) rather than exploding the flat list.
const DEFAULT_WS_PER_PROJECT = 1;

// Built-in WM actions we OVERRIDE (Ctrl+Alt+arrows are already bound to these
// by Cinnamon, so we replace their handlers instead of adding colliding
// hotkeys). Maps the WM action name -> the Controller method it should invoke.
const OVERRIDES = [
    { action: "switch-to-workspace-up",    fn: "goToPrevProjectInOrder" },
    { action: "switch-to-workspace-down",  fn: "goToNextProjectInOrder" },
    { action: "switch-to-workspace-left",  fn: "prevLocalWorkspace" },
    { action: "switch-to-workspace-right", fn: "nextLocalWorkspace" },
    // Shift+Ctrl+Alt+Left/Right: move the focused window within the project.
    { action: "move-to-workspace-left",    fn: "moveWindowToPrevLocal" },
    { action: "move-to-workspace-right",   fn: "moveWindowToNextLocal" },
];

function MyApplet(orientation, panel_height, instanceId) {
    this._init(orientation, panel_height, instanceId);
}

MyApplet.prototype = {
    __proto__: Applet.Applet.prototype,

    _init: function (orientation, panel_height, instanceId) {
        Applet.Applet.prototype._init.call(this, orientation, panel_height, instanceId);

        try {
            log("loaded (M9 toggle-panel v0.9.1)");

            this.wm = new WorkspaceManager.WorkspaceManager();
            this.controller = new ControllerModule.Controller(this.wm);

            // Settings first: we need the token before we decide the deck.
            // This also creates this.sync.
            this._initSettingsAndSync(instanceId);

            // Load the deck from the on-disk Notion cache (instant, offline).
            // Falls back to a placeholder if nothing is cached yet.
            this._loadDeckFromCache();

            this.panelUI = new PanelIndicatorModule.PanelIndicator(this.actor, this.controller, orientation);
            this.switcher = new ProjectSwitcherModule.ProjectSwitcher(this.controller);

            // Initial status: unconfigured if no token, else neutral until sync.
            this.panelUI.setStatus(this._notionConfigured() ? "ok" : "unconfigured");

            this._switchId = global.window_manager.connect(
                'switch-workspace', Lang.bind(this, this._refresh));
            this._nWorkspacesId = global.workspace_manager.connect(
                'notify::n-workspaces', Lang.bind(this, this._refresh));

            this._registerKeybindings();
            this._buildContextMenu();
            this._refresh();

            // Kick off a background sync to refresh the cache for NEXT launch.
            if (this.sync && this._notionConfigured()) this.sync.start();

            // Eagerly open each project's Notion page on its (empty) home
            // workspace, so every project's home always has its page open.
            this.controller.ensureProjectHomesOpen();
        } catch (e) {
            logError("init exception: " + e.toString());
        }
    },

    _notionConfigured: function () {
        return this.settings
            && this.settings.getValue("notionToken")
            && this.settings.getValue("notionDatabaseId");
    },

    // Convert a cached project entry to a controller project def.
    _toDef: function (p) {
        return {
            id: p.id,
            name: p.name,
            wsCount: DEFAULT_WS_PER_PROJECT,
            icon: p.icon,
            notionUrl: p.notionUrl,
        };
    },

    // Build the deck from cached Notion projects, filtered to the ones whose
    // Workspace checkbox is true (inWorkspace). The cache holds ALL non-archived
    // projects (for the toggle panel); the DECK is the inWorkspace subset.
    _loadDeckFromCache: function () {
        let cached = this.sync ? this.sync.readCache() : [];
        let inDeck = cached.filter(function (p) { return p.inWorkspace; });
        if (!inDeck || inDeck.length === 0) {
            log("_loadDeckFromCache: no in-workspace projects cached -> placeholder deck");
            this.controller.loadProjects(PLACEHOLDER_PROJECTS);
            return;
        }
        this.controller.loadProjects(inDeck.map(Lang.bind(this, this._toDef)));
        log("_loadDeckFromCache: loaded " + inDeck.length + " in-workspace projects (of "
            + cached.length + " cached)");
    },

    _refresh: function () {
        try {
            if (this.panelUI) this.panelUI.update();
        } catch (e) {
            logError("_refresh exception: " + e.toString());
        }
    },

    // Bind settings and create the SyncService (does not start it — the caller
    // decides when, after the deck is loaded).
    _initSettingsAndSync: function (instanceId) {
        this.settings = new Settings.AppletSettings(this, UUID, instanceId);

        let token = this.settings.getValue("notionToken") || "";
        let dbId = this.settings.getValue("notionDatabaseId") || "";
        let interval = this.settings.getValue("syncIntervalSec") || 300;

        this.sync = new SyncServiceModule.SyncService(token, dbId, { intervalSec: interval });

        // A completed sync refreshes the on-disk cache (for the NEXT launch) and
        // logs the result. We deliberately do NOT reshape the live deck mid-
        // session — that could move workspaces and scatter your open windows.
        // New Notion changes take effect on the next Cinnamon reload/login.
        this.sync.onUpdate(Lang.bind(this, function (projects) {
            log("sync refreshed cache: " + projects.length + " projects ["
                + projects.map(function (p) { return p.name; }).join(", ")
                + "] — applies on next reload");
        }));

        // Reflect sync status in the panel (degraded-state feedback).
        this.sync.onStatus(Lang.bind(this, function (status) {
            if (this.panelUI) this.panelUI.setStatus(status);
        }));

        this.settings.bindProperty(Settings.BindingDirection.IN, "notionToken",
            "notionToken", Lang.bind(this, function () {
                this.sync.setToken(this.settings.getValue("notionToken"));
            }));
        this.settings.bindProperty(Settings.BindingDirection.IN, "notionDatabaseId",
            "notionDatabaseId", Lang.bind(this, function () {
                this.sync.setDatabaseId(this.settings.getValue("notionDatabaseId"));
            }));

        if (!token || !dbId) {
            log("Notion not configured — open settings, add your token, click "
                + "'Sync now', then reload Cinnamon (Alt+F2, r) to load the deck.");
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

    // ---- M9: Project Toggle Panel ------------------------------------------

    // Open the searchable toggle panel. Reads the full cached project list; each
    // toggle change is orchestrated by _handleToggle below.
    openTogglePanel: function () {
        try {
            let panel = new ProjectTogglePanelModule.ProjectTogglePanel(
                Lang.bind(this, function () { return this.sync ? this.sync.readCache() : []; }),
                Lang.bind(this, this._handleToggle));
            this._togglePanel = panel;
            panel.open();
        } catch (e) {
            logError("openTogglePanel: " + e.toString());
        }
    },

    // Perform a Workspace toggle: write to Notion, then add/remove the project
    // from the live deck. doneCb(err) — err non-null reverts the toggle.
    _handleToggle: function (project, newValue, doneCb) {
        if (!this.sync) { doneCb("no-sync"); return; }

        if (newValue) {
            // Turning ON: write Notion, then add to the live deck immediately.
            this.sync.setWorkspaceFlag(project.id, true, Lang.bind(this, function (err) {
                if (err) { doneCb(err); return; }
                this.controller.addProjectLive(this._toDef(project));
                this.panelUI.rebuild();
                this._refresh();
                doneCb(null);
            }));
        } else {
            // Turning OFF: destructive. Find the deck index, confirm, then
            // remove (which gracefully closes windows). Only on success do we
            // write Workspace=false to Notion.
            let deckIdx = this._deckIndexOf(project.id);
            if (deckIdx < 0) {
                // Not in the live deck (shouldn't happen) — just write the flag.
                this.sync.setWorkspaceFlag(project.id, false, function (err) { doneCb(err); });
                return;
            }
            this._confirmRemoval(project, Lang.bind(this, function (confirmed) {
                if (!confirmed) { doneCb("cancelled"); return; }
                this.controller.removeProjectLive(deckIdx, Lang.bind(this, function (rmErr, info) {
                    if (rmErr === "windows-open") {
                        this._notifyWindowsOpen(project, info);
                        doneCb("windows-open");
                        return;
                    }
                    if (rmErr) { doneCb(rmErr); return; }
                    this.panelUI.rebuild();
                    this._refresh();
                    // Deck change succeeded; now persist Workspace=false.
                    this.sync.setWorkspaceFlag(project.id, false, function (wErr) {
                        doneCb(wErr); // if the write fails, panel reverts the toggle
                    });
                }));
            }));
        }
    },

    // Index of a project in the live controller deck by Notion id, or -1.
    _deckIndexOf: function (projectId) {
        let n = this.controller.state.projectCount();
        for (let i = 0; i < n; i++) {
            let p = this.controller.state.getProject(i);
            if (p && p.id === projectId) return i;
        }
        return -1;
    },

    // Confirm destructive removal via a modal. cb(confirmedBool).
    _confirmRemoval: function (project, cb) {
        let deckIdx = this._deckIndexOf(project.id);
        let p = this.controller.state.getProject(deckIdx);
        let wsCount = p ? p.wsCount : 1;
        let dialog = new ModalDialog.ModalDialog();
        let box = new (imports.gi.St.BoxLayout)({ vertical: true, style_class: 'better-workspaces-toggle-panel' });
        box.add(new (imports.gi.St.Label)({
            style_class: 'better-workspaces-toggle-title',
            text: "Remove “" + project.name + "” from workspaces?",
        }));
        box.add(new (imports.gi.St.Label)({
            text: "This will close its windows and remove its " + wsCount + " workspace(s).",
        }));
        dialog.contentLayout.add(box);
        dialog.setButtons([
            { label: "Cancel", action: function () { dialog.close(); cb(false); }, key: Clutter.KEY_Escape },
            { label: "Remove", action: function () { dialog.close(); cb(true); } },
        ]);
        dialog.open();
    },

    _notifyWindowsOpen: function (project, info) {
        let titles = (info && info.openTitles) ? info.openTitles.join(", ") : "";
        let dialog = new ModalDialog.ModalDialog();
        let box = new (imports.gi.St.BoxLayout)({ vertical: true, style_class: 'better-workspaces-toggle-panel' });
        box.add(new (imports.gi.St.Label)({
            style_class: 'better-workspaces-toggle-title',
            text: "Couldn’t remove “" + project.name + "”",
        }));
        box.add(new (imports.gi.St.Label)({
            text: "Please close these window(s) first, then try again:\n" + titles,
        }));
        dialog.contentLayout.add(box);
        dialog.setButtons([{ label: "OK", action: function () { dialog.close(); }, key: Clutter.KEY_Escape }]);
        dialog.open();
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

        // Super+H -> open the active project's Notion home page in the browser.
        Main.keybindingManager.addHotKey(
            "bw-open-home", "<Super>h",
            Lang.bind(this, function () {
                try { this.controller.openActiveProjectHome(); }
                catch (e) { logError("open-home hotkey: " + e.toString()); }
            }));
        this._boundKeys.push("bw-open-home");

        // Super+P -> open the Project Toggle Panel.
        Main.keybindingManager.addHotKey(
            "bw-toggle-panel", "<Super>p",
            Lang.bind(this, function () {
                try { this.openTogglePanel(); }
                catch (e) { logError("toggle-panel hotkey: " + e.toString()); }
            }));
        this._boundKeys.push("bw-toggle-panel");

        log("registered keybindings (overrides + Super+Tab + Super+H)");
    },

    // Restore Cinnamon's default handlers for the overridden actions, and
    // remove our added hotkeys.
    _unregisterKeybindings: function () {
        OVERRIDES.forEach(function (o) {
            try {
                // null restores Cinnamon's built-in default handler for the
                // action (correct for both switch-to and move-to families).
                Meta.keybindings_set_custom_handler(o.action, null);
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
        addAction("Manage workspace projects… (Super+P)", function () {
            this.openTogglePanel();
        });
        addAction("Open active project's Notion page", function () {
            this.controller.openActiveProjectHome();
        });

        // Submenu: move the focused window to another project.
        let moveMenu = new PopupMenu.PopupSubMenuMenuItem("Move focused window to project");
        let nProjects = this.controller.state.projectCount();
        for (let i = 0; i < nProjects; i++) {
            let p = this.controller.state.getProject(i);
            let idx = i;
            let sub = new PopupMenu.PopupMenuItem(p.name);
            sub.connect('activate', Lang.bind(this, function () {
                try { this.controller.moveWindowToProject(idx); }
                catch (e) { logError("move-to-project menu: " + e.toString()); }
                this._refresh();
            }));
            moveMenu.menu.addMenuItem(sub);
        }
        menu.addMenuItem(moveMenu);

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
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
            if (this._togglePanel) { this._togglePanel.destroy(); this._togglePanel = null; }
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
