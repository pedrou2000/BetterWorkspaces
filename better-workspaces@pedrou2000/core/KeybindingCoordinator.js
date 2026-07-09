/* core/KeybindingCoordinator.js — settings-driven keybinding registration. */

// GJS collaborators (settings, the KeyBinder class, the IN binding-direction)
// are injected, so this is unit-testable with fakes.

const AppletDir = imports.ui.appletManager.applets["better-workspaces@pedrou2000"];
const L = AppletDir.lib.logger.Logger.makeLogger("kb-coord");

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
    "push-tile-left": "kbTileLeft",
    "push-tile-right": "kbTileRight",
    "push-tile-up": "kbTileUp",
    "push-tile-down": "kbTileDown",
    maximize: "kbMaximize",
    minimize: "kbMinimize",
};

var KeybindingCoordinator = class KeybindingCoordinator {
    // deps: {
    //   settings,                    // AppletSettings
    //   KeyBinder,                   // lib/keybindings KeyBinder class
    //   bindingDirectionIn,          // Settings.BindingDirection.IN
    //   getSpecs: () => [{setting, name, run}],  // handlers bound by the applet
    // }
    constructor(deps) {
        this._settings = deps.settings;
        this._KeyBinder = deps.KeyBinder;
        this._IN = deps.bindingDirectionIn;
        this._getSpecs = deps.getSpecs;
        this._keybinder = null;
    }

    register() {
        this._applyScheme();

        // Bind a listener for EVERY spec, including empty ones, so filling in a
        // blank shortcut later takes effect immediately (not just on reload).
        const specs = this._getSpecs();
        specs.forEach((spec) => {
            this._settings.bindProperty(this._IN, spec.setting, spec.setting, () => this.rebind());
        });
        for (const action in WM_ASSIGN) {
            const setting = WM_ASSIGN[action];
            this._settings.bindProperty(this._IN, setting, setting, () => this.rebind());
        }

        this._forceBindAll();
        L.log(
            "registered " +
                (specs.length + Object.keys(WM_ASSIGN).length) +
                " keybindings (settings-driven)",
        );
    }

    rebind() {
        this._forceBindAll();
        L.log("re-registered keybindings after settings change");
    }

    teardown() {
        if (this._keybinder) {
            this._keybinder.teardown();
            this._keybinder = null;
        }
    }

    _applyScheme() {
        const stored = this._settings.getValue("kbSchemeVersion") || 0;
        if (stored >= KB_SCHEME_VERSION) return;
        for (const key in KB_DEFAULTS) {
            try {
                this._settings.setValue(key, KB_DEFAULTS[key]);
            } catch (e) {}
        }
        this._settings.setValue("kbSchemeVersion", KB_SCHEME_VERSION);
        L.log("keybindings reset to scheme v" + KB_SCHEME_VERSION + " (was v" + stored + ")");
    }

    // Fresh KeyBinder + grab every non-empty binding + reapply tiling. Shared by
    // first registration and every rebind.
    _forceBindAll() {
        if (this._keybinder) this._keybinder.teardown();
        this._keybinder = new this._KeyBinder();
        this._getSpecs().forEach((spec) => {
            const accel = this._settings.getValue(spec.setting);
            if (!accel) return;
            this._keybinder.force(spec.name, accel, () => {
                try {
                    spec.run();
                } catch (e) {
                    L.error("hotkey " + spec.name + ": " + e.toString());
                }
            });
        });
        this._assignTiling();
    }

    _assignTiling() {
        for (const action in WM_ASSIGN) {
            const accel = this._settings.getValue(WM_ASSIGN[action]);
            if (!accel) continue;
            this._keybinder.assignGsettings(WM_SCHEMA, action, [accel]);
        }
    }
};
