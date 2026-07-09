/*
 * BetterWorkspaces — lib/keybindings.js
 *
 * Force-claim keyboard shortcuts even when Cinnamon already binds them.
 *
 * Why this exists: on X11 a key+modifier combo can be grabbed by only one
 * client. If Cinnamon already grabs e.g. <Super>n (notifications), our
 * Main.keybindingManager.addHotKey grab silently fails and Cinnamon keeps the
 * key. To reliably override, we first CLEAR the conflicting binding from
 * Cinnamon's gsettings (saving the original), then register ours. On teardown
 * we restore every original so the user's system is left exactly as it was.
 *
 * Released under the GNU General Public License v2 (see LICENSE).
 */
const Gio = imports.gi.Gio;
const Gtk = imports.gi.Gtk;
const Main = imports.ui.main;

const AppletDir = imports.ui.appletManager.applets["better-workspaces@pedrou2000"];
const L = AppletDir.lib.logger.Logger.makeLogger("keys");

// Fixed (non-relocatable) Cinnamon schemas that hold keybinding arrays. We scan
// each key whose value is an array of accelerator strings ("as").
const KB_SCHEMAS = [
    "org.cinnamon.desktop.keybindings.wm",
    "org.cinnamon.desktop.keybindings.media-keys",
    "org.cinnamon.muffin.keybindings",
    "org.gnome.desktop.wm.keybindings",
    "org.gnome.settings-daemon.plugins.media-keys",
];

// Parse an accelerator ("<Super>o") to a normalized [keyval, mods] key, or null.
function _parse(accel) {
    try {
        let res = Gtk.accelerator_parse(accel);
        // GTK3: [keyval, mods]; GTK4: [ok, keyval, mods].
        let keyval, mods;
        if (res.length === 3) { keyval = res[1]; mods = res[2]; }
        else { keyval = res[0]; mods = res[1]; }
        if (!keyval) return null;
        return keyval + ":" + mods;
    } catch (e) {
        return null;
    }
}

function KeyBinder() {
    this._touched = {}; // "schema\0key" -> original [..] (saved once, for restore)
    this._added = [];   // hotkey names we registered
}

function _open(schema) {
    try {
        let src = Gio.SettingsSchemaSource.get_default();
        if (!src || !src.lookup(schema, true)) return null;
        return new Gio.Settings({ schema_id: schema });
    } catch (e) { return null; }
}

KeyBinder.prototype = {

    // Save a gsettings key's current value ONCE, so teardown restores the true
    // original even if we both clear and reassign the same key.
    _recordOriginal: function (schema, key, settings) {
        let id = schema + "\0" + key;
        if (this._touched[id] !== undefined) return;
        try { this._touched[id] = settings.get_strv(key); }
        catch (e) { this._touched[id] = []; }
    },

    // Clear any Cinnamon binding that maps to `accel`, remembering the original.
    // `exceptId` ("schema\0key") is left untouched — used when assigning an
    // action to an accel so we don't clear the very key we're about to set.
    _clearConflicts: function (accel, exceptId) {
        let want = _parse(accel);
        if (!want) { L.error("could not parse accel: " + accel); return; }

        for (let s = 0; s < KB_SCHEMAS.length; s++) {
            let schema = KB_SCHEMAS[s];
            let settings = _open(schema);
            if (!settings) continue;

            let keys;
            try { keys = settings.list_keys(); } catch (e) { continue; }

            for (let k = 0; k < keys.length; k++) {
                let key = keys[k];
                if (exceptId && (schema + "\0" + key) === exceptId) continue;
                let value;
                try { value = settings.get_value(key); } catch (e) { continue; }
                if (!value || value.get_type_string() !== "as") continue;

                let accels = value.deep_unpack();
                let hit = accels.some(function (a) { return a && _parse(a) === want; });
                if (!hit) continue;

                this._recordOriginal(schema, key, settings);
                try {
                    settings.set_strv(key, []);
                    L.log("cleared conflict " + schema + " " + key + " (had " + accels.join(",") + ")");
                } catch (e) {
                    L.error("failed clearing " + schema + " " + key + ": " + e.toString());
                }
            }
        }
        try { Gio.Settings.sync(); } catch (e) {}
    },

    // Force-remove any XLET hotkey whose registered key matches `substr`
    // (e.g. "notification-open"). Cinnamon applets register hotkeys via
    // addXletHotKey under keys like "uuid::name::<accel>" in
    // keybindingManager.applet_bindings — invisible to gsettings, so a
    // gsettings clear can't touch them. We remove the muffin binding and purge
    // the entry so it isn't re-committed. Best-effort; guarded. Not restored on
    // teardown (the applet re-registers it on its own next load).
    removeXletHotKeyMatching: function (substr) {
        try {
            let km = Main.keybindingManager;
            if (!km || !km.applet_bindings || !km.applet_bindings.keys) return;
            let toRemove = [];
            let iter = km.applet_bindings.keys();
            let k = iter.next();
            while (!k.done) {
                if (String(k.value).indexOf(substr) !== -1) toRemove.push(k.value);
                k = iter.next();
            }
            for (let i = 0; i < toRemove.length; i++) {
                try { km.removeHotKey(toRemove[i]); } catch (e) {}
                try { km.applet_bindings.delete(toRemove[i]); } catch (e) {}
                L.log("removed xlet hotkey: " + toRemove[i]);
            }
        } catch (e) {
            L.error("removeXletHotKeyMatching(" + substr + "): " + e.toString());
        }
    },

    // Force-register a hotkey: clear conflicts, then add ours.
    force: function (name, accel, handler) {
        this._clearConflicts(accel);
        try {
            Main.keybindingManager.addHotKey(name, accel, handler);
            this._added.push(name);
            L.log("bound " + name + " -> " + accel);
        } catch (e) {
            L.error("addHotKey(" + name + "," + accel + "): " + e.toString());
        }
    },

    // Assign a Cinnamon gsettings keybinding to specific accelerators (e.g. put
    // window tiling on Super+Shift+arrows). Clears any OTHER action holding the
    // same accel first (so ours wins — e.g. move-to-monitor-down also claiming
    // Super+Shift+Down), records originals for restore. Returns true on success.
    assignGsettings: function (schema, key, accels) {
        let settings = _open(schema);
        if (!settings) { L.error("assign: schema not found " + schema); return false; }
        try {
            if (settings.list_keys().indexOf(key) === -1) {
                L.error("assign: key not found " + schema + " " + key);
                return false;
            }
            // Free the accel from any competing action (but not this key itself).
            let selfId = schema + "\0" + key;
            for (let i = 0; i < accels.length; i++) this._clearConflicts(accels[i], selfId);

            this._recordOriginal(schema, key, settings);
            settings.set_strv(key, accels);
            Gio.Settings.sync();
            L.log("assigned " + schema + " " + key + " -> " + accels.join(","));
            return true;
        } catch (e) {
            L.error("assign " + schema + " " + key + ": " + e.toString());
            return false;
        }
    },

    // Remove our hotkeys and restore every touched gsettings key to its original.
    teardown: function () {
        for (let i = 0; i < this._added.length; i++) {
            try { Main.keybindingManager.removeHotKey(this._added[i]); } catch (e) {}
        }
        this._added = [];

        for (let id in this._touched) {
            let parts = id.split("\0");
            let settings = _open(parts[0]);
            if (!settings) continue;
            try {
                settings.set_strv(parts[1], this._touched[id]);
                L.log("restored " + parts[0] + " " + parts[1]);
            } catch (e) {
                L.error("failed restoring " + parts[0] + " " + parts[1] + ": " + e.toString());
            }
        }
        this._touched = {};
        try { Gio.Settings.sync(); } catch (e) {}
    },
};

var KeyBindings = { KeyBinder: KeyBinder };
