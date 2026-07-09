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
const Settings = imports.ui.settings;
const PopupMenu = imports.ui.popupMenu;

const UUID = "better-workspaces@pedrou2000";

const AppletDir = imports.ui.appletManager.applets[UUID];
const WorkspaceManager = AppletDir.wm.WorkspaceManager.WorkspaceManager;
const Controller = AppletDir.core.Controller.Controller;
const PanelIndicator = AppletDir.ui.PanelIndicator.PanelIndicator;
const ProjectSwitcher = AppletDir.ui.ProjectSwitcher.ProjectSwitcher;
const ProjectTogglePanel = AppletDir.ui.ProjectTogglePanel.ProjectTogglePanel;
const OSD = AppletDir.ui.OSD.OSD;
const Dialogs = AppletDir.ui.Dialogs.Dialogs;
const SyncService = AppletDir.notion.SyncService.SyncService;
const ProjectMapper = AppletDir.notion.ProjectMapper.ProjectMapper;
const KeyBinder = AppletDir.lib.keybindings.KeyBinder;
const Constants = AppletDir.lib.constants.Constants;

const _L = AppletDir.lib.logger.Logger.makeLogger("applet");
function log(msg) { _L.log(msg); }
function logError(msg) { _L.error(msg); }

// Shown only when no Notion cache exists yet (first run / unconfigured), so the
// applet is never empty. Replaced by the real deck as soon as a sync lands.
const PLACEHOLDER_PROJECTS = [
    { id: "placeholder", name: "Connect Notion", wsCount: 1 },
];

// Each synced Notion project starts with just its home workspace; grow a
// project's strip on demand. Keeps startup sane (N projects -> N workspaces).
const DEFAULT_WS_PER_PROJECT = Constants.DEFAULT_WS_PER_PROJECT;

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

var MyApplet = class MyApplet extends Applet.Applet {

    constructor(metadata, orientation, panel_height, instanceId) {
        super(orientation, panel_height, instanceId);

        try {
            log("loaded v" + (metadata && metadata.version ? metadata.version : "?"));

            this.wm = new WorkspaceManager();
            this.controller = new Controller(this.wm);
            this.osd = new OSD();

            // Settings first: we need the token before we decide the deck.
            // This also creates this.sync.
            this._initSettingsAndSync(instanceId);

            // Load the deck from the on-disk Notion cache (instant, offline).
            // Falls back to a placeholder if nothing is cached yet.
            this._loadDeckFromCache();

            this.panelUI = new PanelIndicator(
                this.actor, this.controller, orientation,
                { onManage: () => this.openTogglePanel() });
            this.switcher = new ProjectSwitcher(this.controller);
            this.switcher.onCommit(() => this._afterNav());

            // When projects are reordered, rebuild the panel and persist the new
            // order to Notion (Workspace Order = 0,1,2,...).
            this.controller.onOrderChanged((orderedIds) => {
                if (this.panelUI) this.panelUI.rebuild();
                if (this.sync) this.sync.persistOrder(orderedIds);
            });

            // Initial status: unconfigured if no token, else neutral until sync.
            this.panelUI.setStatus(this._notionConfigured() ? "ok" : "unconfigured");

            this._switchId = global.window_manager.connect(
                'switch-workspace', () => this._refresh());
            this._nWorkspacesId = global.workspace_manager.connect(
                'notify::n-workspaces', () => this._refresh());

            this._registerKeybindings();
            this._buildContextMenu();
            this.osd.suppressBuiltin();
            this._refresh();

            // Kick off a background sync to refresh the cache for NEXT launch.
            if (this.sync && this._notionConfigured()) this.sync.start();
        } catch (e) {
            logError("init exception: " + e.toString());
        }
    }

    _notionConfigured() {
        return this.settings
            && this.settings.getValue("notionToken")
            && this.settings.getValue("notionDatabaseId");
    }

    // Convert a cached project entry to a controller project def.
    _toDef(p) {
        return {
            id: p.id,
            name: p.name,
            wsCount: DEFAULT_WS_PER_PROJECT,
            icon: p.icon,
            notionUrl: p.notionUrl,
        };
    }

    // Build the deck from cached Notion projects, filtered to the ones whose
    // Workspace checkbox is true (inWorkspace). The cache holds ALL non-archived
    // projects (for the toggle panel); the DECK is the inWorkspace subset.
    _loadDeckFromCache() {
        let cached = this.sync ? this.sync.readCache() : [];
        let inDeck = cached.filter((p) => p.inWorkspace);
        if (!inDeck || inDeck.length === 0) {
            log("_loadDeckFromCache: no in-workspace projects cached -> placeholder deck");
            this.controller.loadProjects(PLACEHOLDER_PROJECTS);
            return;
        }
        this.controller.loadProjects(inDeck.map((p) => this._toDef(p)));
        log("_loadDeckFromCache: loaded " + inDeck.length + " in-workspace projects (of "
            + cached.length + " cached)");
    }

    _refresh() {
        try {
            if (this.panelUI) this.panelUI.update();
        } catch (e) {
            logError("_refresh exception: " + e.toString());
        }
    }

    // After a deliberate navigation: refresh the panel and show our own OSD
    // (project · workspace), instead of Cinnamon's flat "Workspace N" OSD.
    _afterNav() {
        this._refresh();
        this.osd.show(this.controller);
    }

    // Bind settings and create the SyncService (does not start it — the caller
    // decides when, after the deck is loaded).
    _initSettingsAndSync(instanceId) {
        this.settings = new Settings.AppletSettings(this, UUID, instanceId);

        let token = this.settings.getValue("notionToken") || "";
        let dbId = this.settings.getValue("notionDatabaseId") || "";
        let interval = this.settings.getValue("syncIntervalSec") || Constants.DEFAULT_SYNC_INTERVAL_S;

        this.sync = new SyncService(token, dbId, { intervalSec: interval });

        // A completed sync refreshes the on-disk cache (for the NEXT launch) and
        // logs the result. We deliberately do NOT reshape the live deck mid-
        // session — that could move workspaces and scatter your open windows.
        // New Notion changes take effect on the next Cinnamon reload/login.
        this.sync.onUpdate((projects) => {
            log("sync refreshed cache: " + projects.length + " projects ["
                + projects.map((p) => p.name).join(", ")
                + "] — applies on next reload");
        });

        // Reflect sync status in the panel (degraded-state feedback).
        this.sync.onStatus((status) => {
            if (this.panelUI) this.panelUI.setStatus(status);
        });

        this.settings.bindProperty(Settings.BindingDirection.IN, "notionToken",
            "notionToken", () => {
                this.sync.setToken(this.settings.getValue("notionToken"));
            });
        this.settings.bindProperty(Settings.BindingDirection.IN, "notionDatabaseId",
            "notionDatabaseId", () => {
                this.sync.setDatabaseId(this.settings.getValue("notionDatabaseId"));
            });

        if (!token || !dbId) {
            log("Notion not configured — open settings, add your token, click "
                + "'Sync now', then reload Cinnamon (Alt+F2, r) to load the deck.");
        }
    }

    // settings-schema.json "syncNow" button callback.
    onSyncNowClicked() {
        try {
            if (this.sync) {
                this.sync.setToken(this.settings.getValue("notionToken"));
                this.sync.setDatabaseId(this.settings.getValue("notionDatabaseId"));
                this.sync.syncNow();
            }
        } catch (e) {
            logError("onSyncNowClicked: " + e.toString());
        }
    }

    // ---- M9: Project Toggle Panel ------------------------------------------

    // Open the searchable toggle panel. Reads the full cached project list
    // (sorted by Workspace Order so ON rows match the deck); toggles go through
    // _handleToggle, reorders through reorderProject.
    openTogglePanel() {
        try {
            let panel = new ProjectTogglePanel(
                () => {
                    let cache = this.sync ? this.sync.readCache() : [];
                    return ProjectMapper.sortByOrder(cache);
                },
                (project, newValue, doneCb) => {
                    // Bridge the panel's doneCb(err) protocol to the async
                    // handler: null on success, an error string on failure.
                    this._handleToggle(project, newValue)
                        .then(() => doneCb(null))
                        .catch((e) => doneCb(e.message || e.toString()));
                },
                (fromOnIdx, toOnIdx) => {
                    // ON-project index == deck index; reorder relocates windows
                    // and persists Workspace Order.
                    this.controller.reorderProject(fromOnIdx, toOnIdx);
                });
            this._togglePanel = panel;
            panel.open();
        } catch (e) {
            logError("openTogglePanel: " + e.toString());
        }
    }

    // Perform a Workspace toggle: write to Notion, then add/remove the project
    // from the live deck. Resolves on success; rejects to revert the toggle.
    async _handleToggle(project, newValue) {
        if (!this.sync) throw new Error("no-sync");

        if (newValue) {
            // Turning ON: write Notion, add to the live deck (appends to end),
            // and assign Workspace Order = max+1 so "bottom" survives reload.
            await this.sync.setWorkspaceFlag(project.id, true);
            this.controller.addProjectLive(this._toDef(project));
            this.sync.setWorkspaceOrder(project.id, this.sync.maxOrder() + 1).catch(() => {});
            this.panelUI.rebuild();
            this._refresh();
            return;
        }

        // Turning OFF: destructive. Find the deck index, confirm, then remove
        // (which gracefully closes windows). Only on success do we write
        // Workspace=false to Notion.
        let deckIdx = this._deckIndexOf(project.id);
        if (deckIdx < 0) {
            // Not in the live deck (shouldn't happen) — just write the flag.
            await this.sync.setWorkspaceFlag(project.id, false);
            return;
        }
        let confirmed = await this._confirmRemoval(project);
        if (!confirmed) throw new Error("cancelled");
        try {
            await this.controller.removeProjectLive(deckIdx);
        } catch (e) {
            if (e.message === "windows-open") {
                this._notifyWindowsOpen(project, { openTitles: e.openTitles });
            }
            throw e;
        }
        this.panelUI.rebuild();
        this._refresh();
        // Deck change succeeded; persist Workspace=false and clear its order so
        // it sorts last if reactivated later. If the flag write fails, the
        // rejection reverts the panel's toggle.
        this.sync.clearWorkspaceOrder(project.id).catch(() => {});
        await this.sync.setWorkspaceFlag(project.id, false);
    }

    // Index of a project in the live controller deck by Notion id, or -1.
    _deckIndexOf(projectId) {
        let n = this.controller.state.projectCount();
        for (let i = 0; i < n; i++) {
            let p = this.controller.state.getProject(i);
            if (p && p.id === projectId) return i;
        }
        return -1;
    }

    // Confirm destructive removal via a modal. Resolves to true/false.
    _confirmRemoval(project) {
        let deckIdx = this._deckIndexOf(project.id);
        let p = this.controller.state.getProject(deckIdx);
        let wsCount = p ? p.wsCount : 1;
        return Dialogs.confirm(
            "Remove “" + project.name + "” from workspaces?",
            "This will close its windows and remove its " + wsCount + " workspace(s).",
            "Remove");
    }

    _notifyWindowsOpen(project, info) {
        let titles = (info && info.openTitles) ? info.openTitles.join(", ") : "";
        Dialogs.notify(
            "Couldn’t remove “" + project.name + "”",
            "Please close these window(s) first, then try again:\n" + titles);
    }

    // The full binding table: settings key -> hotkey name + handler. All
    // bindings are settings-driven and grabbed via KeyBinder.force(), which
    // clears any conflicting Cinnamon binding (restored on teardown) so our
    // grab reliably wins even for combos Cinnamon already owns.
    _bindingSpecs() {
        return [
            { setting: "kbWorkspacePrev", name: "bw-ws-prev",    run: () => { this.controller.prevLocalWorkspace(); this._afterNav(); } },
            { setting: "kbWorkspaceNext", name: "bw-ws-next",    run: () => { this.controller.nextLocalWorkspace(); this._afterNav(); } },
            { setting: "kbProjectPrev",   name: "bw-proj-prev",  run: () => { this.controller.goToPrevProjectInOrder(); this._afterNav(); } },
            { setting: "kbProjectNext",   name: "bw-proj-next",  run: () => { this.controller.goToNextProjectInOrder(); this._afterNav(); } },
            { setting: "kbMoveWindowPrev",name: "bw-move-prev",  run: () => { this.controller.moveWindowToPrevLocal(); this._afterNav(); } },
            { setting: "kbMoveWindowNext",name: "bw-move-next",  run: () => { this.controller.moveWindowToNextLocal(); this._afterNav(); } },
            { setting: "kbMoveWindowProjectPrev", name: "bw-move-proj-prev", run: () => { this.controller.moveWindowToPrevProjectInOrder(); this._afterNav(); } },
            { setting: "kbMoveWindowProjectNext", name: "bw-move-proj-next", run: () => { this.controller.moveWindowToNextProjectInOrder(); this._afterNav(); } },
            { setting: "kbSwitcher",      name: "bw-switcher",   run: () => this.switcher.cycle() },
            { setting: "kbOpenNotion",    name: "bw-open-home",  run: () => this.controller.openActiveProjectHome() },
            { setting: "kbTogglePanel",   name: "bw-toggle-panel", run: () => this.openTogglePanel() },
        ];
    }

    // If the stored keybinding scheme is older than the current one, overwrite
    // the shortcut values with the current defaults (token/other settings are
    // untouched). This makes changed defaults take effect without a manual wipe.
    _applyKeybindingScheme() {
        let stored = this.settings.getValue("kbSchemeVersion") || 0;
        if (stored >= KB_SCHEME_VERSION) return;
        for (let key in KB_DEFAULTS) {
            try { this.settings.setValue(key, KB_DEFAULTS[key]); } catch (e) {}
        }
        this.settings.setValue("kbSchemeVersion", KB_SCHEME_VERSION);
        log("keybindings reset to scheme v" + KB_SCHEME_VERSION
            + " (was v" + stored + ")");
    }

    _registerKeybindings() {
        this._applyKeybindingScheme();
        this._keybinder = new KeyBinder();
        let specs = this._bindingSpecs();
        specs.forEach((spec) => {
            let accel = this.settings.getValue(spec.setting);
            if (!accel) return;
            this._keybinder.force(spec.name, accel, () => {
                try { spec.run(); }
                catch (e) { logError("hotkey " + spec.name + ": " + e.toString()); }
            });
            // Re-bind live when the user edits this shortcut in settings.
            this.settings.bindProperty(Settings.BindingDirection.IN, spec.setting,
                spec.setting, () => this._rebindKeys());
        });
        // Also re-apply when a window-management shortcut is edited.
        for (let action in WM_ASSIGN) {
            let setting = WM_ASSIGN[action];
            this.settings.bindProperty(Settings.BindingDirection.IN, setting,
                setting, () => this._rebindKeys());
        }
        this._assignTiling();
        log("registered " + (specs.length + Object.keys(WM_ASSIGN).length)
            + " keybindings (settings-driven)");
    }

    // Reassign Cinnamon's own window-management actions to the accelerators
    // stored in our settings (Option A). Recorded and restored on unload.
    _assignTiling() {
        for (let action in WM_ASSIGN) {
            let accel = this.settings.getValue(WM_ASSIGN[action]);
            if (!accel) continue;
            this._keybinder.assignGsettings(WM_SCHEMA, action, [accel]);
        }
    }

    // Re-register all keybindings from current settings (called on any change).
    _rebindKeys() {
        if (this._keybinder) this._keybinder.teardown();
        this._keybinder = new KeyBinder();
        this._bindingSpecs().forEach((spec) => {
            let accel = this.settings.getValue(spec.setting);
            if (!accel) return;
            this._keybinder.force(spec.name, accel, () => {
                try { spec.run(); }
                catch (e) { logError("hotkey " + spec.name + ": " + e.toString()); }
            });
        });
        this._assignTiling();
        log("re-registered keybindings after settings change");
    }

    _unregisterKeybindings() {
        if (this._keybinder) {
            this._keybinder.teardown();
            this._keybinder = null;
        }
    }

    _buildContextMenu() {
        let menu = this._applet_context_menu;
        let addAction = (label, fn) => {
            let item = new PopupMenu.PopupMenuItem(label);
            item.connect('activate', () => {
                try { fn(); } catch (e) { logError("menu: " + e.toString()); }
                this._refresh();
            });
            menu.addMenuItem(item);
        };
        addAction("Manage workspace projects… (Super+P)", () => {
            this.openTogglePanel();
        });
        addAction("Open active project's Notion page (Super+N)", () => {
            this.controller.openActiveProjectHome();
        });

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        addAction("Move project left (reorder)", () => {
            this.controller.moveActiveProjectBy(-1);
            this.panelUI.update();
        });
        addAction("Move project right (reorder)", () => {
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
            sub.connect('activate', () => {
                try { this.controller.moveWindowToProject(idx); }
                catch (e) { logError("move-to-project menu: " + e.toString()); }
                this._refresh();
            });
            moveMenu.menu.addMenuItem(sub);
        }
        menu.addMenuItem(moveMenu);

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        addAction("Add workspace to active project", () => {
            this.controller.addWorkspaceToActiveProject();
            this.panelUI.update();
        });
        addAction("Remove last workspace of active project", () => {
            this.controller.removeLastWorkspaceOfActiveProject();
            this.panelUI.update();
        });
        addAction("Remove empty workspaces of active project", () => {
            this.controller.removeEmptyWorkspacesOfActiveProject();
            this.panelUI.update();
        });
        addAction("Log current state", () => {
            log(this.controller.describe());
        });
    }

    // Base Applet has no default click action; use it as "next project".
    on_applet_clicked() {
        this.controller.goToNextProjectInOrder();
        this._refresh();
    }

    on_applet_removed_from_panel() {
        try {
            this._unregisterKeybindings();
            if (this.osd) { this.osd.destroy(); this.osd = null; }
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
    }
};

function main(metadata, orientation, panel_height, instanceId) {
    return new MyApplet(metadata, orientation, panel_height, instanceId);
}
