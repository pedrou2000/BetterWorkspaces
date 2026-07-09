/* core/KeybindingCoordinator.js — settings-driven keybinding registration. */

// Owns what applet.js used to do inline: reset shortcuts to defaults on a scheme
// bump, force-grab every non-empty binding via a fresh KeyBinder, reassign
// Cinnamon's own tiling/maximize actions in gsettings, and re-run all of that
// live when any shortcut setting changes. GJS collaborators (settings, the
// KeyBinder class, the IN binding-direction) are INJECTED.

const AppletDir = imports.ui.appletManager.applets["better-workspaces@pedrou2000"];
const L = AppletDir.lib.logger.Logger.makeLogger("kb-coord");

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

    // First registration: apply the scheme, bind live-rebind listeners for every
    // spec + WM action, then grab everything from current settings.
    register() {
        this._applyScheme();

        // Re-bind live when the user edits any shortcut. Listeners are bound for
        // EVERY spec — including ones whose accel is currently empty — so filling
        // in a blank shortcut takes effect immediately.
        let specs = this._getSpecs();
        specs.forEach((spec) => {
            this._settings.bindProperty(this._IN, spec.setting,
                spec.setting, () => this.rebind());
        });
        for (let action in WM_ASSIGN) {
            let setting = WM_ASSIGN[action];
            this._settings.bindProperty(this._IN, setting,
                setting, () => this.rebind());
        }

        this._forceBindAll();
        L.log("registered " + (specs.length + Object.keys(WM_ASSIGN).length)
            + " keybindings (settings-driven)");
    }

    // Re-register all keybindings from current settings (any change).
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

    // If the stored scheme is older than the current one, overwrite the shortcut
    // values with the current defaults (token/other settings untouched). Makes
    // changed defaults take effect without a manual wipe.
    _applyScheme() {
        let stored = this._settings.getValue("kbSchemeVersion") || 0;
        if (stored >= KB_SCHEME_VERSION) return;
        for (let key in KB_DEFAULTS) {
            try { this._settings.setValue(key, KB_DEFAULTS[key]); } catch (e) {}
        }
        this._settings.setValue("kbSchemeVersion", KB_SCHEME_VERSION);
        L.log("keybindings reset to scheme v" + KB_SCHEME_VERSION
            + " (was v" + stored + ")");
    }

    // Grab every non-empty binding from current settings into a fresh KeyBinder
    // (tearing down the previous one), and re-apply the tiling gsettings
    // assignments. Shared by first registration and every rebind.
    _forceBindAll() {
        if (this._keybinder) this._keybinder.teardown();
        this._keybinder = new this._KeyBinder();
        this._getSpecs().forEach((spec) => {
            let accel = this._settings.getValue(spec.setting);
            if (!accel) return;
            this._keybinder.force(spec.name, accel, () => {
                try { spec.run(); }
                catch (e) { L.error("hotkey " + spec.name + ": " + e.toString()); }
            });
        });
        this._assignTiling();
    }

    // Reassign Cinnamon's own window-management actions to the accelerators
    // stored in our settings. Recorded and restored on unload by the KeyBinder.
    _assignTiling() {
        for (let action in WM_ASSIGN) {
            let accel = this._settings.getValue(WM_ASSIGN[action]);
            if (!accel) continue;
            this._keybinder.assignGsettings(WM_SCHEMA, action, [accel]);
        }
    }
};
