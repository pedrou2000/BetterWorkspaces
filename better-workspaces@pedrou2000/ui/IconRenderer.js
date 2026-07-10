/* ui/IconRenderer.js — normalized Notion icon -> St actor (emoji | cached image | fallback). */

// URL icons download once to ~/.config/better-workspaces/icons and swap in via
// onReady when ready, so the panel never blocks and offline reuse is free.

const St = imports.gi.St;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Pango = imports.gi.Pango;

// St.Label pinned to a fixed width otherwise ellipsizes (…) any glyph wider than
// the box — wide emoji (📁 🏢) collapse to "...". Center in the box, don't clip.
function _boxedLabel(styleClass, text, style) {
    const label = new St.Label({ style_class: styleClass, text: text, style: style });
    label.clutter_text.set_ellipsize(Pango.EllipsizeMode.NONE);
    return label;
}

const AppletDir = imports.ui.appletManager.applets["better-workspaces@pedrou2000"];
const L = AppletDir.lib.logger.Logger.makeLogger("icons");
const Persistence = AppletDir.lib.persistence.Persistence;
const Http = AppletDir.lib.http.Http;

function _iconsDir() {
    const dir = GLib.build_filenamev([Persistence.configDir(), "icons"]);
    try {
        const f = Gio.File.new_for_path(dir);
        if (!f.query_exists(null)) f.make_directory_with_parents(null);
    } catch (e) {
        L.error("_iconsDir: " + e.toString());
    }
    return dir;
}

// djb2; deterministic so the cache filename is stable (no Math.random/Date).
function _hashString(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(16);
}

function _extFor(url) {
    const m = url.split("?")[0].match(/\.(png|jpg|jpeg|svg|gif|webp)$/i);
    return m ? m[0].toLowerCase() : ".png";
}

function _cachePathFor(url) {
    return GLib.build_filenamev([_iconsDir(), _hashString(url) + _extFor(url)]);
}

// Fallback glyph: the project name's first character, uppercased.
function _fallbackLabel(name, size) {
    const ch = name && name.length ? name.trim().charAt(0).toUpperCase() : "?";
    return _boxedLabel(
        "better-workspaces-icon-fallback",
        ch,
        "font-size: " + Math.round(size * 0.7) + "px; width: " + size + "px; text-align: center;",
    );
}

function _iconFromFile(path, size) {
    const gicon = new Gio.FileIcon({ file: Gio.File.new_for_path(path) });
    return new St.Icon({
        gicon: gicon,
        icon_size: size,
        style_class: "better-workspaces-icon-img",
    });
}

// cb(true) on success.
function _download(url, dest, cb) {
    Http.request("GET", url)
        .then((res) => {
            try {
                if (res.status >= 200 && res.status < 300 && res.bytes.length > 0) {
                    GLib.file_set_contents(dest, res.bytes);
                    cb(true);
                } else {
                    L.error("icon GET http " + res.status);
                    cb(false);
                }
            } catch (e) {
                L.error("icon write: " + e.toString());
                cb(false);
            }
        })
        .catch((e) => {
            L.error("_download: " + e.toString());
            cb(false);
        });
}

// icon: {type,value}|null. onReady() fires after a successful async download so
// the caller can swap in the real icon (returns a fallback meanwhile).
function makeActor(icon, name, size, onReady) {
    size = size || 22;
    if (icon && icon.type === "emoji" && icon.value) {
        // Locked to the image-icon box; font a touch under it so the glyph's
        // ascent/descent doesn't overflow and misalign the row.
        return _boxedLabel(
            "better-workspaces-icon-emoji",
            icon.value,
            "font-size: " +
                Math.round(size * 0.82) +
                "px; width: " +
                size +
                "px; height: " +
                size +
                "px; text-align: center;",
        );
    }

    if (icon && icon.type === "url" && icon.value) {
        const path = _cachePathFor(icon.value);
        if (Gio.File.new_for_path(path).query_exists(null)) {
            try {
                return _iconFromFile(path, size);
            } catch (e) {
                L.error("iconFromFile: " + e.toString());
            }
        }
        _download(icon.value, path, function (ok) {
            if (ok && onReady) {
                try {
                    onReady();
                } catch (e) {
                    L.error("onReady: " + e.toString());
                }
            }
        });
        return _fallbackLabel(name, size);
    }

    return _fallbackLabel(name, size);
}

var IconRenderer = {
    makeActor: makeActor,
};
