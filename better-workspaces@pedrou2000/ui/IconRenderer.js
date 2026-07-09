/*
 * BetterWorkspaces — ui/IconRenderer.js
 *
 * Shared icon rendering (Design Doc §5, "Icon rendering"). Turns a normalized
 * Notion icon ({type:"emoji"|"url", value}) into an St actor for any surface
 * (panel now; switcher/overview later), so everything looks identical.
 *
 *   - emoji  -> an St.Label showing the glyph
 *   - url    -> downloaded once to a disk cache, then an St.Icon from the file;
 *               until the download lands (or if it fails) we show a fallback
 *   - null   -> a fallback glyph derived from the project name's first letter
 *
 * Image downloads are async and cached under ~/.config/better-workspaces/icons,
 * so the panel never blocks and offline reuse is free.
 *
 * Released under the GNU General Public License v2 (see LICENSE).
 */
const St = imports.gi.St;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Soup = imports.gi.Soup;
const ByteArray = imports.byteArray;

const AppletDir = imports.ui.appletManager.applets["better-workspaces@pedrou2000"];
const L = AppletDir.lib.logger.Logger.makeLogger("icons");
const Persistence = AppletDir.lib.persistence.Persistence;
const SOUP3 = AppletDir.notion.NotionClient.SOUP3;

// One shared session for icon downloads.
let _session = null;
function _getSession() {
    if (!_session) {
        _session = new Soup.Session();
        try { _session.timeout = 15; } catch (e) {}
    }
    return _session;
}

function _iconsDir() {
    let dir = GLib.build_filenamev([Persistence.configDir(), "icons"]);
    try {
        let f = Gio.File.new_for_path(dir);
        if (!f.query_exists(null)) f.make_directory_with_parents(null);
    } catch (e) { L.error("_iconsDir: " + e.toString()); }
    return dir;
}

// Deterministic cache filename for a URL (no Math.random / Date). Uses a simple
// string hash + a best-effort extension from the URL.
function _hashString(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(16);
}

function _extFor(url) {
    let m = url.split("?")[0].match(/\.(png|jpg|jpeg|svg|gif|webp)$/i);
    return m ? m[0].toLowerCase() : ".png";
}

function _cachePathFor(url) {
    return GLib.build_filenamev([_iconsDir(), _hashString(url) + _extFor(url)]);
}

// A simple text fallback: the first character of the project name, uppercased.
function _fallbackLabel(name) {
    let ch = (name && name.length) ? name.trim().charAt(0).toUpperCase() : "?";
    return new St.Label({ style_class: 'better-workspaces-icon-fallback', text: ch });
}

// Build an St.Icon from a cached file path.
function _iconFromFile(path, size) {
    let gicon = new Gio.FileIcon({ file: Gio.File.new_for_path(path) });
    return new St.Icon({
        gicon: gicon,
        icon_size: size,
        style_class: 'better-workspaces-icon-img',
    });
}

// Download `url` to `dest` asynchronously; call cb(true) on success.
function _download(url, dest, cb) {
    try {
        let session = _getSession();
        let msg = Soup.Message.new("GET", url);
        if (SOUP3) {
            session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null,
                function (s, res) {
                    try {
                        let bytes = s.send_and_read_finish(res);
                        let status = msg.get_status();
                        if (status >= 200 && status < 300 && bytes) {
                            GLib.file_set_contents(dest, bytes.get_data());
                            cb(true);
                        } else { L.error("icon GET http " + status); cb(false); }
                    } catch (e) { L.error("icon finish: " + e.toString()); cb(false); }
                });
        } else {
            session.queue_message(msg, function (s, message) {
                try {
                    if (message.status_code >= 200 && message.status_code < 300
                        && message.response_body && message.response_body.data) {
                        GLib.file_set_contents(dest, message.response_body.data);
                        cb(true);
                    } else { L.error("icon GET http " + message.status_code); cb(false); }
                } catch (e) { L.error("icon queue: " + e.toString()); cb(false); }
            });
        }
    } catch (e) {
        L.error("_download: " + e.toString());
        cb(false);
    }
}

// Public: return an St actor for `icon` right now, and if it's a URL not yet
// cached, download it and call onReady() when the file is available so the
// caller can swap in the real icon.
//   icon: {type, value} | null
//   name: project name (for fallback)
//   size: pixel size for image icons
//   onReady: optional callback() fired after a successful async download
function makeActor(icon, name, size, onReady) {
    // Emoji: render the glyph directly.
    if (icon && icon.type === "emoji" && icon.value) {
        return new St.Label({
            style_class: 'better-workspaces-icon-emoji',
            text: icon.value,
        });
    }

    // URL image: use cache if present; else kick off a download + fallback now.
    if (icon && icon.type === "url" && icon.value) {
        let path = _cachePathFor(icon.value);
        if (Gio.File.new_for_path(path).query_exists(null)) {
            try { return _iconFromFile(path, size || 22); }
            catch (e) { L.error("iconFromFile: " + e.toString()); }
        }
        // Not cached yet: start the download, show a fallback meanwhile.
        _download(icon.value, path, function (ok) {
            if (ok && onReady) {
                try { onReady(); } catch (e) { L.error("onReady: " + e.toString()); }
            }
        });
        return _fallbackLabel(name);
    }

    // No icon: fallback glyph.
    return _fallbackLabel(name);
}

var IconRenderer = {
    makeActor: makeActor,
};
