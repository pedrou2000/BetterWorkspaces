/* ui/IconRenderer.js — normalized Notion icon -> St actor (emoji | cached image | fallback). */

// Image icons download once to ~/.config/better-workspaces/icons and swap in via
// onReady when ready, so the panel never blocks and offline reuse is free. Emoji
// are images too when setEmojiImages is on (Notion's own artwork), with the
// system emoji font as the fallback until, or instead of, the download.

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
const EmojiImage = AppletDir.lib.emojiImage.EmojiImage;

// How long a failed download is left alone. The server saying no (e.g. 404: no
// such image) won't change soon; a network error usually clears in seconds.
const RETRY_REFUSED_MS = 10 * 60 * 1000;
const RETRY_UNREACHABLE_MS = 20 * 1000;

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

// cb(ok, refused): refused = the server answered but not with the file.
function _download(url, dest, cb) {
    Http.request("GET", url)
        .then((res) => {
            try {
                if (res.status >= 200 && res.status < 300 && res.bytes.length > 0) {
                    GLib.file_set_contents(dest, res.bytes);
                    cb(true, false);
                } else {
                    L.error("icon GET http " + res.status);
                    cb(false, true);
                }
            } catch (e) {
                L.error("icon write: " + e.toString());
                cb(false, false);
            }
        })
        .catch((e) => {
            L.error("_download: " + e.toString());
            cb(false, false);
        });
}

// Every surface (panel, toggle panel, switcher) asks for the same icons, and the
// panel is rebuilt on every sync: share one request per URL and back off after
// a failure instead of re-hitting the host each time. onReady fires on success.
const _inFlight = {}; // url -> [onReady]
const _retryAt = {}; // url -> ms timestamp before which a failed URL isn't retried

function _fetchOnce(url, dest, onReady) {
    if (_inFlight[url]) {
        if (onReady) _inFlight[url].push(onReady);
        return;
    }
    if (_retryAt[url] && Date.now() < _retryAt[url]) return;

    _inFlight[url] = onReady ? [onReady] : [];
    _download(url, dest, function (ok, refused) {
        const waiting = _inFlight[url] || [];
        delete _inFlight[url];
        if (!ok) {
            _retryAt[url] = Date.now() + (refused ? RETRY_REFUSED_MS : RETRY_UNREACHABLE_MS);
            return;
        }
        delete _retryAt[url];
        for (let i = 0; i < waiting.length; i++) {
            try {
                waiting[i]();
            } catch (e) {
                L.error("onReady: " + e.toString());
            }
        }
    });
}

// The cached image for `url`, or null after starting its download. `inner`
// (optional, < size) draws the image that large, centered in a size x size box:
// rendered at the smaller size rather than scaled, so it stays sharp, and the
// box keeps the row's spacing.
function _cachedImage(url, size, onReady, inner) {
    const path = _cachePathFor(url);
    if (Gio.File.new_for_path(path).query_exists(null)) {
        try {
            if (!inner || inner >= size) return _iconFromFile(path, size);
            return new St.Bin({
                child: _iconFromFile(path, inner),
                style: "width: " + size + "px; height: " + size + "px;",
            });
        } catch (e) {
            L.error("iconFromFile: " + e.toString());
        }
    }
    _fetchOnce(url, path, onReady);
    return null;
}

let _emojiImages = true;

function setEmojiImages(on) {
    _emojiImages = !!on;
}

// How large an emoji is drawn inside its icon box; user-tunable (setEmojiScale)
// because matching emoji to image icons is a perceptual call, not a computable
// one. Font emoji carry baked-in margin and get a paint-only zoom; Twemoji
// images fill their box edge to edge, unlike Notion's padded icons, and are
// rendered smaller (never larger than the box).
let _emojiScale = AppletDir.lib.constants.Constants.PANEL_EMOJI_ZOOM;

function setEmojiScale(scale) {
    _emojiScale = scale > 0 ? scale : 1;
}

// icon: {type,value}|null. onReady() fires after a successful async download so
// the caller can swap in the real icon (returns a fallback meanwhile).
function makeActor(icon, name, size, onReady) {
    size = size || 22;
    if (icon && icon.type === "emoji" && icon.value) {
        if (_emojiImages) {
            const url = EmojiImage.urlFor(icon.value);
            const inner = Math.max(1, Math.round(size * Math.min(1, _emojiScale)));
            const image = url ? _cachedImage(url, size, onReady, inner) : null;
            if (image) return image;
        }
        // Locked to the image-icon box; font a touch under it so the glyph's
        // ascent/descent doesn't overflow and misalign the row.
        const label = _boxedLabel(
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
        // Noto Color Emoji bitmaps carry ~2px of transparent margin per side at
        // panel sizes, so the visible glyph is narrower than its box and reads as
        // extra inter-icon spacing next to edge-filling St.Icons. Scale is paint-
        // only (never layout), so the box metrics the row alignment relies on are
        // untouched; the drawn glyph just grows into its own baked-in air.
        label.set_pivot_point(0.5, 0.5);
        label.set_scale(_emojiScale, _emojiScale);
        return label;
    }

    if (icon && icon.type === "url" && icon.value) {
        return _cachedImage(icon.value, size, onReady) || _fallbackLabel(name, size);
    }

    return _fallbackLabel(name, size);
}

var IconRenderer = {
    makeActor: makeActor,
    setEmojiScale: setEmojiScale,
    setEmojiImages: setEmojiImages,
};
