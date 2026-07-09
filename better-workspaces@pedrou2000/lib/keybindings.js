/* lib/keybindings.js — force-claim shortcuts Cinnamon already binds. */

// On X11 a key+mods combo is grabbed by one client, so addHotKey silently loses
// to an existing grab (e.g. <Super>n). We clear the conflicting binding first
// (saving the original) then register ours, and restore everything on teardown.

const Gio = imports.gi.Gio;
const Gtk = imports.gi.Gtk;
const Main = imports.ui.main;

const AppletDir = imports.ui.appletManager.applets["better-workspaces@pedrou2000"];
const L = AppletDir.lib.logger.Logger.makeLogger("keys");

// Fixed schemas holding keybinding arrays; we scan each "as"-typed key.
const KB_SCHEMAS = [
    "org.cinnamon.desktop.keybindings.wm",
    "org.cinnamon.desktop.keybindings.media-keys",
    "org.cinnamon.muffin.keybindings",
    "org.gnome.desktop.wm.keybindings",
    "org.gnome.settings-daemon.plugins.media-keys",
];

// "<Super>o" -> normalized "keyval:mods" string, or null.
function _parse(accel) {
    try {
        const res = Gtk.accelerator_parse(accel);
        // GTK3 returns [keyval, mods]; GTK4 returns [ok, keyval, mods].
        let keyval, mods;
        if (res.length === 3) {
            keyval = res[1];
            mods = res[2];
        } else {
            keyval = res[0];
            mods = res[1];
        }
        if (!keyval) return null;
        return keyval + ":" + mods;
    } catch (e) {
        return null;
    }
}

function _open(schema) {
    try {
        const src = Gio.SettingsSchemaSource.get_default();
        if (!src || !src.lookup(schema, true)) return null;
        return new Gio.Settings({ schema_id: schema });
    } catch (e) {
        return null;
    }
}

var KeyBinder = class KeyBinder {
    constructor() {
        this._touched = {}; // "schema\0key" -> original [..] (saved once, for restore)
        this._added = []; // hotkey names we registered
    }

    // Save ONCE so teardown restores the true original even if we clear AND
    // reassign the same key.
    _recordOriginal(schema, key, settings) {
        const id = schema + "\0" + key;
        if (this._touched[id] !== undefined) return;
        try {
            this._touched[id] = settings.get_strv(key);
        } catch (e) {
            this._touched[id] = [];
        }
    }

    // Clear any Cinnamon binding that maps to `accel`, remembering the original.
    // `exceptId` ("schema\0key") is left untouched — used when assigning an
    // action to an accel so we don't clear the very key we're about to set.
    _clearConflicts(accel, exceptId) {
        const want = _parse(accel);
        if (!want) {
            L.error("could not parse accel: " + accel);
            return;
        }

        for (let s = 0; s < KB_SCHEMAS.length; s++) {
            const schema = KB_SCHEMAS[s];
            const settings = _open(schema);
            if (!settings) continue;

            let keys;
            try {
                keys = settings.list_keys();
            } catch (e) {
                continue;
            }

            for (let k = 0; k < keys.length; k++) {
                const key = keys[k];
                if (exceptId && schema + "\0" + key === exceptId) continue;
                let value;
                try {
                    value = settings.get_value(key);
                } catch (e) {
                    continue;
                }
                if (!value || value.get_type_string() !== "as") continue;

                const accels = value.deep_unpack();
                const hit = accels.some(function (a) {
                    return a && _parse(a) === want;
                });
                if (!hit) continue;

                this._recordOriginal(schema, key, settings);
                try {
                    settings.set_strv(key, []);
                    L.log(
                        "cleared conflict " +
                            schema +
                            " " +
                            key +
                            " (had " +
                            accels.join(",") +
                            ")",
                    );
                } catch (e) {
                    L.error("failed clearing " + schema + " " + key + ": " + e.toString());
                }
            }
        }
        try {
            Gio.Settings.sync();
        } catch (e) {}

        // Xlet hotkeys live in keybindingManager.bindings, invisible to gsettings.
        this._clearXletConflicts(want);
    }

    // Remove xlet/applet/media hotkeys matching `want` that live in the manager's
    // `bindings` Map (e.g. the notifications applet's <Super>n) — not ours ("bw-").
    // Not restored on teardown; the owning applet re-registers on its next load.
    _clearXletConflicts(want) {
        try {
            const km = Main.keybindingManager;
            if (!km || !km.bindings || !km.bindings.values) return;
            const names = [];
            const iter = km.bindings.values();
            let e = iter.next();
            while (!e.done) {
                const entry = e.value;
                if (entry && entry.name && Array.isArray(entry.bindings)) {
                    if (entry.name.indexOf("bw-") !== 0) {
                        // skip our own

                        const hit = entry.bindings.some(function (a) {
                            return a && _parse(a) === want;
                        });
                        if (hit) names.push(entry.name);
                    }
                }
                e = iter.next();
            }
            for (let i = 0; i < names.length; i++) {
                try {
                    km.removeHotKey(names[i]);
                    L.log("cleared hotkey conflict: " + names[i]);
                } catch (err) {
                    L.error("removeHotKey(" + names[i] + "): " + err.toString());
                }
            }
        } catch (e) {
            L.error("_clearXletConflicts: " + e.toString());
        }
    }

    force(name, accel, handler) {
        this._clearConflicts(accel);
        try {
            Main.keybindingManager.addHotKey(name, accel, handler);
            this._added.push(name);
            L.log("bound " + name + " -> " + accel);
        } catch (e) {
            L.error("addHotKey(" + name + "," + accel + "): " + e.toString());
        }
    }

    // Point a Cinnamon gsettings action at `accels`, first freeing them from any
    // competing action so ours wins (e.g. tiling vs move-to-monitor on Super+Shift+Down).
    assignGsettings(schema, key, accels) {
        const settings = _open(schema);
        if (!settings) {
            L.error("assign: schema not found " + schema);
            return false;
        }
        try {
            if (settings.list_keys().indexOf(key) === -1) {
                L.error("assign: key not found " + schema + " " + key);
                return false;
            }
            const selfId = schema + "\0" + key; // don't clear the key we're setting

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
    }

    teardown() {
        for (let i = 0; i < this._added.length; i++) {
            try {
                Main.keybindingManager.removeHotKey(this._added[i]);
            } catch (e) {}
        }
        this._added = [];

        for (const id in this._touched) {
            const parts = id.split("\0");
            const settings = _open(parts[0]);
            if (!settings) continue;
            try {
                settings.set_strv(parts[1], this._touched[id]);
                L.log("restored " + parts[0] + " " + parts[1]);
            } catch (e) {
                L.error("failed restoring " + parts[0] + " " + parts[1] + ": " + e.toString());
            }
        }
        this._touched = {};
        try {
            Gio.Settings.sync();
        } catch (e) {}
    }
};
