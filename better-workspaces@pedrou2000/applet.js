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
const ProjectMapper = AppletDir.notion.ProjectMapper.ProjectMapper;
const KeyBindings = AppletDir.lib.keybindings.KeyBindings;

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

// Default keybindings, and a scheme version. When we change these defaults we
// bump KB_SCHEME_VERSION; on load, if the user's stored scheme is older, we
// reset the keybindings to these values (token/other settings untouched). This
// lets default changes actually take effect without a manual settings wipe.
const KB_SCHEME_VERSION = 5;
const KB_DEFAULTS = {
    // Super = navigate; +Alt = project axis; +Ctrl = carry the window.
    kbWorkspacePrev: "<Super>Left",
    kbWorkspaceNext: "<Super>Right",
    kbProjectPrev: "<Super><Alt>Left",
    kbProjectNext: "<Super><Alt>Right",
    kbMoveWindowPrev: "<Primary><Super>Left",
    kbMoveWindowNext: "<Primary><Super>Right",
    kbMoveWindowProjectPrev: "<Primary><Super><Alt>Left",
    kbMoveWindowProjectNext: "<Primary><Super><Alt>Right",
    kbSwitcher: "<Super>Tab",
    kbOpenNotion: "<Super>n",
    kbTogglePanel: "<Super>p",
    // Tiling on Super+Shift+arrows; maximize/minimize on Alt+A/S.
    kbTileLeft: "<Super><Shift>Left",
    kbTileRight: "<Super><Shift>Right",
    kbTileUp: "<Super><Shift>Up",
    kbTileDown: "<Super><Shift>Down",
    kbMaximize: "<Alt>a",
    kbMinimize: "<Alt>s",
};

// These reassign Cinnamon's OWN window-management actions (not our handlers):
// each maps a gsettings action key in org.cinnamon.desktop.keybindings.wm to
// the applet setting holding the desired accelerator. Editable in Configure;
// applied to gsettings on load and on change; restored on unload.
const WM_SCHEMA = "org.cinnamon.desktop.keybindings.wm";
const WM_ASSIGN = {
    "push-tile-left":  "kbTileLeft",
    "push-tile-right": "kbTileRight",
    "push-tile-up":    "kbTileUp",
    "push-tile-down":  "kbTileDown",
    "maximize":        "kbMaximize",
    "minimize":        "kbMinimize",
};

function MyApplet(orientation, panel_height, instanceId) {
    this._init(orientation, panel_height, instanceId);
}

MyApplet.prototype = {
    __proto__: Applet.Applet.prototype,

    _init: function (orientation, panel_height, instanceId) {
        Applet.Applet.prototype._init.call(this, orientation, panel_height, instanceId);

        try {
            log("loaded (M11 reorder v0.11.10 drag-reorder-working)");

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

            // When projects are reordered, rebuild the panel and persist the new
            // order to Notion (Workspace Order = 0,1,2,...).
            this.controller.onOrderChanged(Lang.bind(this, function (orderedIds) {
                if (this.panelUI) this.panelUI.rebuild();
                if (this.sync) this.sync.persistOrder(orderedIds);
            }));

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

    // Open the searchable toggle panel. Reads the full cached project list
    // (sorted by Workspace Order so ON rows match the deck); toggles go through
    // _handleToggle, reorders through reorderProject.
    openTogglePanel: function () {
        try {
            let panel = new ProjectTogglePanelModule.ProjectTogglePanel(
                Lang.bind(this, function () {
                    let cache = this.sync ? this.sync.readCache() : [];
                    return ProjectMapper.sortByOrder(cache);
                }),
                Lang.bind(this, this._handleToggle),
                Lang.bind(this, function (fromOnIdx, toOnIdx) {
                    // ON-project index == deck index; reorder relocates windows
                    // and persists Workspace Order.
                    this.controller.reorderProject(fromOnIdx, toOnIdx);
                }));
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

    // The full binding table: settings key -> hotkey name + handler. All
    // bindings are settings-driven and grabbed via KeyBinder.force(), which
    // clears any conflicting Cinnamon binding (restored on teardown) so our
    // grab reliably wins even for combos Cinnamon already owns.
    _bindingSpecs: function () {
        let self = this;
        return [
            { setting: "kbWorkspacePrev", name: "bw-ws-prev",    run: function () { self.controller.prevLocalWorkspace(); self._refresh(); } },
            { setting: "kbWorkspaceNext", name: "bw-ws-next",    run: function () { self.controller.nextLocalWorkspace(); self._refresh(); } },
            { setting: "kbProjectPrev",   name: "bw-proj-prev",  run: function () { self.controller.goToPrevProjectInOrder(); self._refresh(); } },
            { setting: "kbProjectNext",   name: "bw-proj-next",  run: function () { self.controller.goToNextProjectInOrder(); self._refresh(); } },
            { setting: "kbMoveWindowPrev",name: "bw-move-prev",  run: function () { self.controller.moveWindowToPrevLocal(); self._refresh(); } },
            { setting: "kbMoveWindowNext",name: "bw-move-next",  run: function () { self.controller.moveWindowToNextLocal(); self._refresh(); } },
            { setting: "kbMoveWindowProjectPrev", name: "bw-move-proj-prev", run: function () { self.controller.moveWindowToPrevProjectInOrder(); self._refresh(); } },
            { setting: "kbMoveWindowProjectNext", name: "bw-move-proj-next", run: function () { self.controller.moveWindowToNextProjectInOrder(); self._refresh(); } },
            { setting: "kbSwitcher",      name: "bw-switcher",   run: function () { self.switcher.cycle(); } },
            { setting: "kbOpenNotion",    name: "bw-open-home",  run: function () { self.controller.openActiveProjectHome(); } },
            { setting: "kbTogglePanel",   name: "bw-toggle-panel", run: function () { self.openTogglePanel(); } },
        ];
    },

    // If the stored keybinding scheme is older than the current one, overwrite
    // the shortcut values with the current defaults (token/other settings are
    // untouched). This makes changed defaults take effect without a manual wipe.
    _applyKeybindingScheme: function () {
        let stored = this.settings.getValue("kbSchemeVersion") || 0;
        if (stored >= KB_SCHEME_VERSION) return;
        for (let key in KB_DEFAULTS) {
            try { this.settings.setValue(key, KB_DEFAULTS[key]); } catch (e) {}
        }
        this.settings.setValue("kbSchemeVersion", KB_SCHEME_VERSION);
        log("keybindings reset to scheme v" + KB_SCHEME_VERSION
            + " (was v" + stored + ")");
    },

    _registerKeybindings: function () {
        this._applyKeybindingScheme();
        this._keybinder = new KeyBindings.KeyBinder();
        let specs = this._bindingSpecs();
        specs.forEach(Lang.bind(this, function (spec) {
            let accel = this.settings.getValue(spec.setting);
            if (!accel) return;
            this._keybinder.force(spec.name, accel, Lang.bind(this, function () {
                try { spec.run(); }
                catch (e) { logError("hotkey " + spec.name + ": " + e.toString()); }
            }));
            // Re-bind live when the user edits this shortcut in settings.
            this.settings.bindProperty(Settings.BindingDirection.IN, spec.setting,
                spec.setting, Lang.bind(this, this._rebindKeys));
        }));
        // Also re-apply when a window-management shortcut is edited.
        for (let action in WM_ASSIGN) {
            let setting = WM_ASSIGN[action];
            this.settings.bindProperty(Settings.BindingDirection.IN, setting,
                setting, Lang.bind(this, this._rebindKeys));
        }
        this._assignTiling();
        log("registered " + (specs.length + Object.keys(WM_ASSIGN).length)
            + " keybindings (settings-driven)");
    },

    // Reassign Cinnamon's own window-management actions to the accelerators
    // stored in our settings (Option A). Recorded and restored on unload.
    _assignTiling: function () {
        for (let action in WM_ASSIGN) {
            let accel = this.settings.getValue(WM_ASSIGN[action]);
            if (!accel) continue;
            this._keybinder.assignGsettings(WM_SCHEMA, action, [accel]);
        }
    },

    // Re-register all keybindings from current settings (called on any change).
    _rebindKeys: function () {
        if (this._keybinder) this._keybinder.teardown();
        this._keybinder = new KeyBindings.KeyBinder();
        this._bindingSpecs().forEach(Lang.bind(this, function (spec) {
            let accel = this.settings.getValue(spec.setting);
            if (!accel) return;
            this._keybinder.force(spec.name, accel, Lang.bind(this, function () {
                try { spec.run(); }
                catch (e) { logError("hotkey " + spec.name + ": " + e.toString()); }
            }));
        }));
        this._assignTiling();
        log("re-registered keybindings after settings change");
    },

    _unregisterKeybindings: function () {
        if (this._keybinder) {
            this._keybinder.teardown();
            this._keybinder = null;
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
        addAction("Open active project's Notion page (Super+N)", function () {
            this.controller.openActiveProjectHome();
        });

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        addAction("Move project left (reorder)", function () {
            this.controller.moveActiveProjectBy(-1);
            this.panelUI.update();
        });
        addAction("Move project right (reorder)", function () {
            this.controller.moveActiveProjectBy(1);
            this.panelUI.update();
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
        addAction("Remove empty workspaces of active project", function () {
            this.controller.removeEmptyWorkspacesOfActiveProject();
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
