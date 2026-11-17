/* applet.js — entry point + wiring: settings, keybindings, signals, cleanup. */

// Composes core/ (model + Controller + ProjectStore + coordinators), wm/
// (workspace APIs), notion/ (transport), ui/ (panel, switcher, toggle panel,
// OSD, dialogs). The deck loads from the store at startup; the toggle/deck-sync
// orchestration lives in DeckCoordinator, keybinding registration in
// KeybindingCoordinator — this file only constructs and connects the parts.

const Applet = imports.ui.applet;
const Settings = imports.ui.settings;
const Clutter = imports.gi.Clutter;
const Mainloop = imports.mainloop;

const UUID = "better-workspaces@pedrou2000";

const AppletDir = imports.ui.appletManager.applets[UUID];
const WorkspaceManager = AppletDir.wm.WorkspaceManager.WorkspaceManager;
const Controller = AppletDir.core.Controller.Controller;
const ProjectStore = AppletDir.core.ProjectStore.ProjectStore;
const DeckCoordinator = AppletDir.core.DeckCoordinator.DeckCoordinator;
const KeybindingCoordinator = AppletDir.core.KeybindingCoordinator.KeybindingCoordinator;
const PanelIndicator = AppletDir.ui.PanelIndicator.PanelIndicator;
const IconRenderer = AppletDir.ui.IconRenderer.IconRenderer;
const ProjectSwitcher = AppletDir.ui.ProjectSwitcher.ProjectSwitcher;
const ProjectTogglePanel = AppletDir.ui.ProjectTogglePanel.ProjectTogglePanel;
const ContextMenu = AppletDir.ui.ContextMenu.ContextMenu;
const OSD = AppletDir.ui.OSD.OSD;
const Dialogs = AppletDir.ui.Dialogs.Dialogs;
const SyncService = AppletDir.notion.SyncService.SyncService;
const Persistence = AppletDir.lib.persistence.Persistence;
const KeyBinder = AppletDir.lib.keybindings.KeyBinder;
const Constants = AppletDir.lib.constants.Constants;

const L = AppletDir.lib.logger.Logger.makeLogger("applet");

// Keeps the applet non-empty on first run/unconfigured; replaced by the real deck.
const PLACEHOLDER_PROJECTS = [
    { id: "placeholder", name: "Connect Notion", wsCount: 1, icon: { type: "emoji", value: "🔌" } },
];

const DEFAULT_WS_PER_PROJECT = Constants.DEFAULT_WS_PER_PROJECT;

var MyApplet = class MyApplet extends Applet.Applet {
    constructor(metadata, orientation, panel_height, instanceId) {
        super(orientation, panel_height, instanceId);

        try {
            L.log("loaded v" + (metadata && metadata.version ? metadata.version : "?"));

            // Drop the theme's applet-box hover background (our buttons show their
            // own); keep our own class for the container padding it also provided.
            this.actor.remove_style_class_name("applet-box");
            this.actor.add_style_class_name("better-workspaces-applet");

            this.wm = new WorkspaceManager();
            this.controller = new Controller(this.wm);
            this.osd = new OSD();

            this.store = new ProjectStore(Persistence);

            // Owns toggle/deck-sync decisions; hooks resolve panelUI/_togglePanel
            // lazily so this can be built before those UI parts exist.
            this.deckCoord = new DeckCoordinator({
                store: this.store,
                controller: this.controller,
                persistence: Persistence,
                dialogs: Dialogs,
                defaultWsPerProject: DEFAULT_WS_PER_PROJECT,
                placeholderProjects: PLACEHOLDER_PROJECTS,
                hooks: {
                    rebuildPanel: () => {
                        if (this.panelUI) this.panelUI.rebuild();
                    },
                    refresh: () => this._refresh(),
                    refreshTogglePanel: () => {
                        if (this._togglePanel) this._togglePanel.refresh();
                    },
                },
            });

            // Settings first — we need the token before deciding the deck; this
            // also creates this.sync and wires it to the store.
            this._initSettingsAndSync(instanceId);
            this.deckCoord.loadDeckFromStore();

            IconRenderer.setEmojiScale(this.settings.getValue("emojiZoom") / 100);
            IconRenderer.setEmojiImages(this.settings.getValue("notionStyleEmoji"));
            this.panelUI = new PanelIndicator(this.actor, this.controller, orientation, {
                onManage: () => this.openTogglePanel(),
                onRemoveProject: (id) => this.deckCoord.removeFromWorkspaces(id),
                iconSize: this.settings.getValue("panelIconSize"),
                spacing: this.settings.getValue("projectSpacing"),
                dotSize: this.settings.getValue("dotSize"),
                dotSizeSmall: this.settings.getValue("dotSizeSmall"),
            });
            this.settings.bindProperty(
                Settings.BindingDirection.IN,
                "panelIconSize",
                "panelIconSize",
                () => {
                    if (this.panelUI) {
                        this.panelUI.setIconSize(this.settings.getValue("panelIconSize"));
                    }
                },
            );
            this.settings.bindProperty(
                Settings.BindingDirection.IN,
                "projectSpacing",
                "projectSpacing",
                () => {
                    if (this.panelUI) {
                        this.panelUI.setSpacing(this.settings.getValue("projectSpacing"));
                    }
                },
            );
            this.settings.bindProperty(
                Settings.BindingDirection.IN,
                "emojiZoom",
                "emojiZoom",
                () => {
                    IconRenderer.setEmojiScale(this.settings.getValue("emojiZoom") / 100);
                    if (this.panelUI) this.panelUI.rebuild(); // existing labels keep their old scale
                },
            );
            this.settings.bindProperty(
                Settings.BindingDirection.IN,
                "notionStyleEmoji",
                "notionStyleEmoji",
                () => {
                    IconRenderer.setEmojiImages(this.settings.getValue("notionStyleEmoji"));
                    if (this.panelUI) this.panelUI.rebuild();
                },
            );
            this.settings.bindProperty(Settings.BindingDirection.IN, "dotSize", "dotSize", () => {
                if (this.panelUI) this.panelUI.setDotSize(this.settings.getValue("dotSize"));
            });
            this.settings.bindProperty(
                Settings.BindingDirection.IN,
                "dotSizeSmall",
                "dotSizeSmall",
                () => {
                    if (this.panelUI) {
                        this.panelUI.setDotSizeSmall(this.settings.getValue("dotSizeSmall"));
                    }
                },
            );
            this.switcher = new ProjectSwitcher(this.controller);
            this.switcher.onCommit(() => this._afterNav());

            this.controller.onOrderChanged((orderedIds) => {
                if (this.panelUI) this.panelUI.rebuild();
                if (this.store) this.store.setOrders(orderedIds);
            });

            // Initial status: unconfigured if no token, else neutral until sync.
            this.panelUI.setStatus(this._notionConfigured() ? "ok" : "unconfigured");

            this._switchId = global.window_manager.connect("switch-workspace", (wmgr, from) => {
                this._refresh();
                this._autoCleanLeft(from);
            });
            this._nWorkspacesId = global.workspace_manager.connect("notify::n-workspaces", () =>
                this._refresh(),
            );

            this.keybindings = new KeybindingCoordinator({
                settings: this.settings,
                KeyBinder: KeyBinder,
                bindingDirectionIn: Settings.BindingDirection.IN,
                getSpecs: () => this._bindingSpecs(),
            });
            this.keybindings.register();

            this._initContextMenu();
            this.osd.suppressBuiltin();
            this._refresh();

            if (this.sync && this._notionConfigured()) this.sync.start();
        } catch (e) {
            L.error("init exception: " + e.toString());
        }
    }

    // The workspace the user just left is dropped if it was empty (and not its
    // project's only one). Grabbed as an object and checked from idle: our own
    // multi-step moves (grow, carry a window, switch) must finish first, and the
    // flat indices can shift before we look.
    _autoCleanLeft(fromIndex) {
        if (!this.settings.getValue("autoCleanEmptyWorkspaces")) return;
        const ws = this.wm.getWorkspace(fromIndex);
        if (!ws) return;
        Mainloop.idle_add(() => {
            try {
                if (this.controller && this.controller.removeWorkspaceIfEmpty(ws)) {
                    this._refresh();
                }
            } catch (e) {
                L.error("autoClean: " + e.toString());
            }
            return false;
        });
    }

    _removeCurrentProject() {
        const loc = this.controller.currentLocation();
        const p = loc ? this.controller.state.getProject(loc.projectIdx) : null;
        if (!p) return;
        this.deckCoord
            .removeFromWorkspaces(p.id)
            .then((removed) => {
                if (removed && this.osd && this.controller) this.osd.show(this.controller);
            })
            .catch((e) => L.error("removeCurrentProject: " + e.toString()));
    }

    _notionConfigured() {
        return (
            this.settings &&
            this.settings.getValue("notionToken") &&
            this.settings.getValue("notionDatabaseId")
        );
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

        const token = this.settings.getValue("notionToken") || "";
        const dbId = this.settings.getValue("notionDatabaseId") || "";
        const interval =
            this.settings.getValue("syncIntervalSec") || Constants.DEFAULT_SYNC_INTERVAL_S;

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

        this.sync.onPull((projects, complete) => this.deckCoord.onPull(projects, complete));

        // "ok" doubles as the retry trigger: a successful pull proves Notion is
        // reachable, so writes held by a transient failure (offline toggles) resume.
        this.sync.onStatus((status) => {
            if (this.panelUI) this.panelUI.setStatus(status);
            if (status === "ok" && this.store) this.store.retryPending();
        });

        this.settings.bindProperty(
            Settings.BindingDirection.IN,
            "notionToken",
            "notionToken",
            () => {
                this.sync.setToken(this.settings.getValue("notionToken"));
            },
        );
        this.settings.bindProperty(
            Settings.BindingDirection.IN,
            "notionDatabaseId",
            "notionDatabaseId",
            () => {
                this.sync.setDatabaseId(this.settings.getValue("notionDatabaseId"));
            },
        );

        if (!token || !dbId) {
            L.log(
                "Notion not configured — open settings, add your token, click " +
                    "'Sync now', then reload Cinnamon (Alt+F2, r) to load the deck.",
            );
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

    openTogglePanel() {
        try {
            const panel = new ProjectTogglePanel(
                () => this.store.all(),
                (project, newValue) => this.deckCoord.handleToggle(project, newValue),
                (movedId, toOnPos) => this.deckCoord.reorderFromPanel(movedId, toOnPos),
                (project) =>
                    this.deckCoord
                        .openProject(project)
                        .then(() => this._afterNav())
                        .catch((e) => L.error("openProject: " + e.toString())),
            );
            this._togglePanel = panel;
            panel.open();
        } catch (e) {
            L.error("openTogglePanel: " + e.toString());
        }
    }

    // settings key -> hotkey name + handler; the KeybindingCoordinator grabs these.
    _bindingSpecs() {
        return [
            {
                setting: "kbWorkspacePrev",
                name: "bw-ws-prev",
                run: () => {
                    this.controller.prevLocalWorkspace();
                    this._afterNav();
                },
            },
            {
                setting: "kbWorkspaceNext",
                name: "bw-ws-next",
                run: () => {
                    this.controller.nextLocalWorkspace();
                    this._afterNav();
                },
            },
            {
                setting: "kbProjectPrev",
                name: "bw-proj-prev",
                run: () => {
                    this.controller.goToPrevProjectInOrder();
                    this._afterNav();
                },
            },
            {
                setting: "kbProjectNext",
                name: "bw-proj-next",
                run: () => {
                    this.controller.goToNextProjectInOrder();
                    this._afterNav();
                },
            },
            {
                setting: "kbMoveWindowPrev",
                name: "bw-move-prev",
                run: () => {
                    this.controller.moveWindowToPrevLocal();
                    this._afterNav();
                },
            },
            {
                setting: "kbMoveWindowNext",
                name: "bw-move-next",
                run: () => {
                    this.controller.moveWindowToNextLocal();
                    this._afterNav();
                },
            },
            {
                setting: "kbMoveWindowProjectPrev",
                name: "bw-move-proj-prev",
                run: () => {
                    this.controller.moveWindowToPrevProjectInOrder();
                    this._afterNav();
                },
            },
            {
                setting: "kbMoveWindowProjectNext",
                name: "bw-move-proj-next",
                run: () => {
                    this.controller.moveWindowToNextProjectInOrder();
                    this._afterNav();
                },
            },
            { setting: "kbSwitcher", name: "bw-switcher", run: () => this.switcher.cycle() },
            {
                setting: "kbOpenNotion",
                name: "bw-open-home",
                run: () => this.controller.openActiveProjectHome(),
            },
            {
                setting: "kbTogglePanel",
                name: "bw-toggle-panel",
                run: () => this.openTogglePanel(),
            },
            {
                setting: "kbRemoveProject",
                name: "bw-remove-project",
                run: () => this._removeCurrentProject(),
            },
        ];
    }

    // "<Super>p" (a keybinding setting) -> "Super+P"; "" when unset.
    _shortcutHint(settingKey) {
        return KeyBinder.label(this.settings.getValue(settingKey));
    }

    // Capture phase, so the menu is rebuilt for the clicked target before
    // Cinnamon's own handler on this actor toggles it open.
    _initContextMenu() {
        this.contextMenu = new ContextMenu({
            menu: this._applet_context_menu,
            controller: this.controller,
            onManage: () => this.openTogglePanel(),
            onSync: () => this.onSyncNowClicked(),
            onRemoveProject: (id) => this.deckCoord.removeFromWorkspaces(id),
            shortcutHint: (key) => this._shortcutHint(key),
            afterAction: () => this._refresh(),
        });
        this._contextCaptureId = this.actor.connect("captured-event", (actor, event) => {
            try {
                if (
                    event.type() === Clutter.EventType.BUTTON_PRESS &&
                    event.get_button() === 3 &&
                    !this._applet_context_menu.isOpen
                ) {
                    const id = this.panelUI ? this.panelUI.projectIdAt(event.get_source()) : null;
                    // The placeholder deck entry isn't a real (store) project.
                    this.contextMenu.populate(id && this.store.get(id) ? id : null);
                }
            } catch (e) {
                L.error("context menu: " + e.toString());
            }
            return Clutter.EVENT_PROPAGATE;
        });
    }

    on_applet_clicked() {
        this.controller.goToNextProjectInOrder();
        this._refresh();
    }

    on_applet_removed_from_panel() {
        try {
            if (this.keybindings) {
                this.keybindings.teardown();
                this.keybindings = null;
            }
            if (this.osd) {
                this.osd.destroy();
                this.osd = null;
            }
            if (this._switchId) {
                global.window_manager.disconnect(this._switchId);
                this._switchId = 0;
            }
            if (this._nWorkspacesId) {
                global.workspace_manager.disconnect(this._nWorkspacesId);
                this._nWorkspacesId = 0;
            }
            if (this._contextCaptureId) {
                this.actor.disconnect(this._contextCaptureId);
                this._contextCaptureId = 0;
            }
            if (this.contextMenu) {
                this.contextMenu.destroy();
                this.contextMenu = null;
            }
            if (this._togglePanel) {
                this._togglePanel.destroy();
                this._togglePanel = null;
            }
            if (this.sync) {
                this.sync.destroy();
                this.sync = null;
            }
            if (this.store) {
                this.store.destroy();
                this.store = null;
            }
            if (this.settings) {
                this.settings.finalize();
                this.settings = null;
            }
            if (this.switcher) {
                this.switcher.destroy();
                this.switcher = null;
            }
            if (this.panelUI) {
                this.panelUI.destroy();
                this.panelUI = null;
            }
            if (this.controller) {
                this.controller.destroy();
                this.controller = null;
            }
            if (this.wm) {
                this.wm.destroy();
                this.wm = null;
            }
            this.deckCoord = null;
            L.log("removed, cleaned up");
        } catch (e) {
            L.error("cleanup exception: " + e.toString());
        }
    }
};

function main(metadata, orientation, panel_height, instanceId) {
    return new MyApplet(metadata, orientation, panel_height, instanceId);
}
