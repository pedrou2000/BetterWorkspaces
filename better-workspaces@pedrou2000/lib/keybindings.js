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
    this._cleared = []; // {schema, key, original: [..]} to restore on teardown
    this._added = [];   // hotkey names we registered
}

KeyBinder.prototype = {

    // Clear any Cinnamon binding that maps to `accel`, remembering the original.
    _clearConflicts: function (accel) {
        let want = _parse(accel);
        if (!want) { L.error("could not parse accel: " + accel); return; }

        for (let s = 0; s < KB_SCHEMAS.length; s++) {
            let schema = KB_SCHEMAS[s];
            let settings;
            try {
                // Guard: skip schemas not installed on this system. Use the
                // schema source (list_schemas is deprecated); if lookup returns
                // null the schema is absent, so skip it.
                let src = Gio.SettingsSchemaSource.get_default();
                if (!src || !src.lookup(schema, true)) continue;
                settings = new Gio.Settings({ schema_id: schema });
            } catch (e) { continue; }

            let keys;
            try { keys = settings.list_keys(); } catch (e) { continue; }

            for (let k = 0; k < keys.length; k++) {
                let key = keys[k];
                let value;
                try { value = settings.get_value(key); } catch (e) { continue; }
                if (!value || value.get_type_string() !== "as") continue;

                let accels = value.deep_unpack();
                let hit = accels.some(function (a) { return a && _parse(a) === want; });
                if (!hit) continue;

                // Save original once, then clear the whole key's bindings.
                this._cleared.push({ schema: schema, key: key, original: accels.slice() });
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

    // Remove our hotkeys and restore every cleared original binding.
    teardown: function () {
        for (let i = 0; i < this._added.length; i++) {
            try { Main.keybindingManager.removeHotKey(this._added[i]); } catch (e) {}
        }
        this._added = [];

        for (let i = 0; i < this._cleared.length; i++) {
            let c = this._cleared[i];
            try {
                let settings = new Gio.Settings({ schema_id: c.schema });
                settings.set_strv(c.key, c.original);
                L.log("restored " + c.schema + " " + c.key);
            } catch (e) {
                L.error("failed restoring " + c.schema + " " + c.key + ": " + e.toString());
            }
        }
        this._cleared = [];
        try { Gio.Settings.sync(); } catch (e) {}
    },
};

var KeyBindings = { KeyBinder: KeyBinder };
