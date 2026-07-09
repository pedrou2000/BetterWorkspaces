/* applet.js — entry point + wiring: settings, keybindings, signals, cleanup. */

// Composes core/ (model + Controller + ProjectStore), wm/ (workspace APIs),
// notion/ (transport), ui/ (panel, switcher, toggle panel, OSD, dialogs). The
// deck loads from the store at startup; mutations are optimistic (store + UI
// update now, Notion writes queued), and background pulls merge into the store.

const Applet = imports.ui.applet;
const Settings = imports.ui.settings;
const PopupMenu = imports.ui.popupMenu;

const UUID = "better-workspaces@pedrou2000";

const AppletDir = imports.ui.appletManager.applets[UUID];
const WorkspaceManager = AppletDir.wm.WorkspaceManager.WorkspaceManager;
const Controller = AppletDir.core.Controller.Controller;
const ProjectStore = AppletDir.core.ProjectStore.ProjectStore;
const PanelIndicator = AppletDir.ui.PanelIndicator.PanelIndicator;
const ProjectSwitcher = AppletDir.ui.ProjectSwitcher.ProjectSwitcher;
const ProjectTogglePanel = AppletDir.ui.ProjectTogglePanel.ProjectTogglePanel;
const OSD = AppletDir.ui.OSD.OSD;
const Dialogs = AppletDir.ui.Dialogs.Dialogs;
const SyncService = AppletDir.notion.SyncService.SyncService;
const Persistence = AppletDir.lib.persistence.Persistence;
const KeyBinder = AppletDir.lib.keybindings.KeyBinder;
const Constants = AppletDir.lib.constants.Constants;

const L = AppletDir.lib.logger.Logger.makeLogger("applet");

// Keeps the applet non-empty on first run/unconfigured; replaced by the real deck.
const PLACEHOLDER_PROJECTS = [
    { id: "placeholder", name: "Connect Notion", wsCount: 1 },
];

const DEFAULT_WS_PER_PROJECT = Constants.DEFAULT_WS_PER_PROJECT;

// Bumping KB_SCHEME_VERSION resets shortcuts to KB_DEFAULTS on next load (other
// settings untouched), so changed defaults take effect without a manual wipe.
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

// Reassign Cinnamon's OWN wm actions (gsettings action key -> our setting),
// applied on load/change and restored on unload.
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
            L.log("loaded v" + (metadata && metadata.version ? metadata.version : "?"));

            this.wm = new WorkspaceManager();
            this.controller = new Controller(this.wm);
            this.osd = new OSD();

            this.store = new ProjectStore(Persistence);

            // Settings first — we need the token before deciding the deck; this
            // also creates this.sync and wires it to the store.
            this._initSettingsAndSync(instanceId);
            this._loadDeckFromStore();

            this.panelUI = new PanelIndicator(
                this.actor, this.controller, orientation,
                { onManage: () => this.openTogglePanel() });
            this.switcher = new ProjectSwitcher(this.controller);
            this.switcher.onCommit(() => this._afterNav());

            this.controller.onOrderChanged((orderedIds) => {
                if (this.panelUI) this.panelUI.rebuild();
                if (this.store) this.store.setOrders(orderedIds);
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

            if (this.sync && this._notionConfigured()) this.sync.start();
        } catch (e) {
            L.error("init exception: " + e.toString());
        }
    }

    _notionConfigured() {
        return this.settings
            && this.settings.getValue("notionToken")
            && this.settings.getValue("notionDatabaseId");
    }

    _toDef(p) {
        return {
            id: p.id,
            name: p.name,
            wsCount: DEFAULT_WS_PER_PROJECT,
            icon: p.icon,
            notionUrl: p.notionUrl,
        };
    }

    // The deck is the inWorkspace subset of the catalog, in Workspace Order.
    _loadDeckFromStore() {
        let inDeck = this.store.all().filter((p) => p.inWorkspace);
        if (inDeck.length === 0) {
            L.log("_loadDeckFromStore: no in-workspace projects -> placeholder deck");
            this.controller.loadProjects(PLACEHOLDER_PROJECTS);
            return;
        }
        this.controller.loadProjects(inDeck.map((p) => this._toDef(p)));
        L.log("_loadDeckFromStore: loaded " + inDeck.length + " in-workspace projects");
    }

    _refresh() {
        try {
            if (this.panelUI) this.panelUI.update();
        } catch (e) {
            L.error("_refresh exception: " + e.toString());
        }
    }

    _afterNav() {
        this._refresh();
        this.osd.show(this.controller);
    }

    // Binds settings and creates SyncService; the caller starts it after the deck loads.
    _initSettingsAndSync(instanceId) {
        this.settings = new Settings.AppletSettings(this, UUID, instanceId);

        let token = this.settings.getValue("notionToken") || "";
        let dbId = this.settings.getValue("notionDatabaseId") || "";
        let interval = this.settings.getValue("syncIntervalSec") || Constants.DEFAULT_SYNC_INTERVAL_S;

        this.sync = new SyncService(token, dbId, { intervalSec: interval });

        this.store.setWriter(this.sync);
        this.store.onWriteError(() => {
            if (this.panelUI) this.panelUI.setStatus("error");
        });

        // Only revert:* — set:* comes from UI handlers that already re-render, and
        // re-rendering mid-click would destroy the row actors the in-flight toggle
        // callback still references. A revert means the optimistic ON/OFF is stale.
        this.store.onChange((reason) => {
            if (reason.indexOf("revert:") !== 0) return;
            if (this._togglePanel) this._togglePanel.refresh();
            if (this.panelUI) this.panelUI.rebuild();
            this._refresh();
        });

        // Deck ids are protected from removal on merge; a project newly checked in
        // Notion auto-appends (append never moves existing workspaces). Unchecking
        // never auto-removes — that stays behind the explicit toggle-off flow.
        this.sync.onPull((projects) => {
            let deckIds = [];
            let n = this.controller.state.projectCount();
            for (let i = 0; i < n; i++) deckIds.push(this.controller.state.getProject(i).id);

            let result = this.store.merge(projects, deckIds);

            for (let i = 0; i < result.newlyInWorkspace.length; i++) {
                let p = result.newlyInWorkspace[i];
                if (this.controller.state.indexOfProjectId(p.id) >= 0) continue;
                this.controller.addProjectLive(this._toDef(p));
                L.log("sync: auto-appended newly-on project " + p.name);
            }

            if (this.panelUI) this.panelUI.rebuild();
            if (this._togglePanel) this._togglePanel.refresh();
            this._refresh();
        });

        // "ok" doubles as the retry trigger: a successful pull proves Notion is
        // reachable, so writes held by a transient failure (offline toggles) resume.
        this.sync.onStatus((status) => {
            if (this.panelUI) this.panelUI.setStatus(status);
            if (status === "ok" && this.store) this.store.retryPending();
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
            L.log("Notion not configured — open settings, add your token, click "
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
            L.error("onSyncNowClicked: " + e.toString());
        }
    }

    // Reorders arrive id-keyed and resolve to a deck index here, at action time.
    openTogglePanel() {
        try {
            let panel = new ProjectTogglePanel(
                () => this.store.all(),
                (project, newValue) => this._handleToggle(project, newValue),
                (movedId, toOnPos) => {
                    let from = this.controller.state.indexOfProjectId(movedId);
                    if (from >= 0) this.controller.reorderProject(from, toOnPos);
                });
            this._togglePanel = panel;
            panel.open();
        } catch (e) {
            L.error("openTogglePanel: " + e.toString());
        }
    }

    // Optimistic: store + deck update now, Notion writes queued by the store.
    // Resolves on success; rejects only when nothing changed (cancelled/windows-open).
    async _handleToggle(project, newValue) {
        if (!this.store) throw new Error("no-store");

        if (newValue) {
            // Order = max+1 so "bottom" survives reload.
            this.controller.addProjectLive(this._toDef(project));
            this.store.setInWorkspace(project.id, true);
            this.store.setOrder(project.id, this.store.maxOrder() + 1);
            this.panelUI.rebuild();
            this._refresh();
            return;
        }

        // Destructive: confirm, remove from the deck (closes windows), then flip
        // the store flag only once the removal actually succeeds.
        let deckIdx = this.controller.state.indexOfProjectId(project.id);
        if (deckIdx < 0) {
            this.store.setInWorkspace(project.id, false); // not in deck (shouldn't happen)
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
        this.store.setInWorkspace(project.id, false);
        this.store.setOrder(project.id, null); // clear order so it sorts last if reactivated
    }

    _confirmRemoval(project) {
        let deckIdx = this.controller.state.indexOfProjectId(project.id);
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

    // settings key -> hotkey name + handler; grabbed via KeyBinder.force().
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

    _applyKeybindingScheme() {
        let stored = this.settings.getValue("kbSchemeVersion") || 0;
        if (stored >= KB_SCHEME_VERSION) return;
        for (let key in KB_DEFAULTS) {
            try { this.settings.setValue(key, KB_DEFAULTS[key]); } catch (e) {}
        }
        this.settings.setValue("kbSchemeVersion", KB_SCHEME_VERSION);
        L.log("keybindings reset to scheme v" + KB_SCHEME_VERSION
            + " (was v" + stored + ")");
    }

    // Fresh KeyBinder + grab every non-empty binding + reapply tiling. Shared by
    // first registration and every rebind.
    _forceBindAll() {
        if (this._keybinder) this._keybinder.teardown();
        this._keybinder = new KeyBinder();
        this._bindingSpecs().forEach((spec) => {
            let accel = this.settings.getValue(spec.setting);
            if (!accel) return;
            this._keybinder.force(spec.name, accel, () => {
                try { spec.run(); }
                catch (e) { L.error("hotkey " + spec.name + ": " + e.toString()); }
            });
        });
        this._assignTiling();
    }

    _registerKeybindings() {
        this._applyKeybindingScheme();

        // Bind a listener for EVERY spec, including empty ones, so filling in a
        // blank shortcut later takes effect immediately (not just on reload).
        let specs = this._bindingSpecs();
        specs.forEach((spec) => {
            this.settings.bindProperty(Settings.BindingDirection.IN, spec.setting,
                spec.setting, () => this._rebindKeys());
        });
        for (let action in WM_ASSIGN) {
            let setting = WM_ASSIGN[action];
            this.settings.bindProperty(Settings.BindingDirection.IN, setting,
                setting, () => this._rebindKeys());
        }

        this._forceBindAll();
        L.log("registered " + (specs.length + Object.keys(WM_ASSIGN).length)
            + " keybindings (settings-driven)");
    }

    _assignTiling() {
        for (let action in WM_ASSIGN) {
            let accel = this.settings.getValue(WM_ASSIGN[action]);
            if (!accel) continue;
            this._keybinder.assignGsettings(WM_SCHEMA, action, [accel]);
        }
    }

    _rebindKeys() {
        this._forceBindAll();
        L.log("re-registered keybindings after settings change");
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
                try { fn(); } catch (e) { L.error("menu: " + e.toString()); }
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

        let moveMenu = new PopupMenu.PopupSubMenuMenuItem("Move focused window to project");
        let nProjects = this.controller.state.projectCount();
        for (let i = 0; i < nProjects; i++) {
            let p = this.controller.state.getProject(i);
            let idx = i;
            let sub = new PopupMenu.PopupMenuItem(p.name);
            sub.connect('activate', () => {
                try { this.controller.moveWindowToProject(idx); }
                catch (e) { L.error("move-to-project menu: " + e.toString()); }
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
            L.log(this.controller.describe());
        });
    }

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
            if (this.store) { this.store.destroy(); this.store = null; }
            if (this.settings) { this.settings.finalize(); this.settings = null; }
            if (this.switcher) { this.switcher.destroy(); this.switcher = null; }
            if (this.panelUI) { this.panelUI.destroy(); this.panelUI = null; }
            if (this.controller) { this.controller.destroy(); this.controller = null; }
            if (this.wm) { this.wm.destroy(); this.wm = null; }
            L.log("removed, cleaned up");
        } catch (e) {
            L.error("cleanup exception: " + e.toString());
        }
    }
};

function main(metadata, orientation, panel_height, instanceId) {
    return new MyApplet(metadata, orientation, panel_height, instanceId);
}
