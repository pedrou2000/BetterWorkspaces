/* lib/persistence.js — read/write JSON under the applet's config dir. */

// All failures degrade to null/false + a log line rather than throwing.

const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;

const AppletDir = imports.ui.appletManager.applets["better-workspaces@pedrou2000"];
const L = AppletDir.lib.logger.Logger.makeLogger("persist");

// ~/.config/better-workspaces
function configDir() {
    return GLib.build_filenamev([GLib.get_user_config_dir(), "better-workspaces"]);
}

function _ensureDir() {
    let dir = configDir();
    try {
        let f = Gio.File.new_for_path(dir);
        if (!f.query_exists(null)) f.make_directory_with_parents(null);
        return dir;
    } catch (e) {
        L.error("ensureDir: " + e.toString());
        return dir;
    }
}

function pathFor(filename) {
    return GLib.build_filenamev([configDir(), filename]);
}

function writeJSON(filename, obj) {
    try {
        _ensureDir();
        let path = pathFor(filename);
        let text = JSON.stringify(obj, null, 2);
        let ok = GLib.file_set_contents(path, text);
        if (!ok) L.error("writeJSON: file_set_contents returned false for " + path);
        return ok;
    } catch (e) {
        L.error("writeJSON(" + filename + "): " + e.toString());
        return false;
    }
}

// Returns `fallback` (default null) on any failure (missing file, bad JSON).
function readJSON(filename, fallback) {
    if (fallback === undefined) fallback = null;
    try {
        let path = pathFor(filename);
        let f = Gio.File.new_for_path(path);
        if (!f.query_exists(null)) return fallback;
        let [ok, contents] = GLib.file_get_contents(path);
        if (!ok) return fallback;
        let text = contents instanceof Uint8Array
            ? imports.byteArray.toString(contents)
            : contents.toString();
        return JSON.parse(text);
    } catch (e) {
        L.error("readJSON(" + filename + "): " + e.toString());
        return fallback;
    }
}

var Persistence = {
    configDir: configDir,
    pathFor: pathFor,
    writeJSON: writeJSON,
    readJSON: readJSON,
};
