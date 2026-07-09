/*
 * BetterWorkspaces — lib/browser.js
 *
 * Opening URLs in a NEW window of the user's default browser. General-purpose
 * (not workspace logic), so it lives in lib/. Detects the default browser via
 * xdg-settings and maps it to a binary that accepts --new-window; falls back to
 * xdg-open (default browser, but a new tab) when unrecognized or on failure.
 *
 * Released under the GNU General Public License v2 (see LICENSE).
 */
const Util = imports.misc.util;
const GLib = imports.gi.GLib;
const ByteArray = imports.byteArray;

const AppletDir = imports.ui.appletManager.applets["better-workspaces@pedrou2000"];
const L = AppletDir.lib.logger.Logger.makeLogger("browser");

// xdg default-web-browser .desktop id -> binary launched with --new-window.
// Mainstream browsers all accept --new-window.
const BROWSER_BINARIES = [
    { match: "firefox",  bin: "firefox" },
    { match: "chrome",   bin: "google-chrome" },
    { match: "chromium", bin: "chromium" },
    { match: "brave",    bin: "brave-browser" },
    { match: "edge",     bin: "microsoft-edge" },
    { match: "vivaldi",  bin: "vivaldi" },
    { match: "opera",    bin: "opera" },
];

let _cachedBin; // undefined = not looked up yet; null = unknown

// The default browser binary we know how to open with --new-window, or null.
function _defaultBrowserBin() {
    if (_cachedBin !== undefined) return _cachedBin;
    _cachedBin = null;
    try {
        let [ok, out] = GLib.spawn_command_line_sync("xdg-settings get default-web-browser");
        if (ok && out) {
            let desktop = (out instanceof Uint8Array
                ? ByteArray.toString(out) : String(out)).trim().toLowerCase();
            for (let i = 0; i < BROWSER_BINARIES.length; i++) {
                if (desktop.indexOf(BROWSER_BINARIES[i].match) !== -1) {
                    _cachedBin = BROWSER_BINARIES[i].bin;
                    break;
                }
            }
            L.log("default browser=" + desktop + " -> " + _cachedBin);
        }
    } catch (e) {
        L.error("_defaultBrowserBin: " + e.toString());
    }
    return _cachedBin;
}

// Open `url` in a new window of the default browser on the current workspace.
function openUrlNewWindow(url) {
    let bin = _defaultBrowserBin();
    let cmd = bin ? [bin, "--new-window", url] : ["xdg-open", url];
    try {
        Util.spawn(cmd);
    } catch (e) {
        L.error("openUrlNewWindow: spawn failed: " + e.toString() + " — trying xdg-open");
        try { Util.spawn(["xdg-open", url]); } catch (e2) {}
    }
}

var Browser = { openUrlNewWindow: openUrlNewWindow };
