/* lib/browser.js — open a URL in a NEW window of the default browser. */

const Util = imports.misc.util;
const GLib = imports.gi.GLib;
const ByteArray = imports.byteArray;

const AppletDir = imports.ui.appletManager.applets["better-workspaces@pedrou2000"];
const L = AppletDir.lib.logger.Logger.makeLogger("browser");

// xdg default-web-browser .desktop id substring -> binary that takes --new-window.
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

function openUrlNewWindow(url) {
    let bin = _defaultBrowserBin();
    // Fall back to xdg-open (right browser, but a new tab) when unrecognized.
    let cmd = bin ? [bin, "--new-window", url] : ["xdg-open", url];
    try {
        Util.spawn(cmd);
    } catch (e) {
        L.error("openUrlNewWindow: spawn failed: " + e.toString() + " — trying xdg-open");
        try { Util.spawn(["xdg-open", url]); } catch (e2) {}
    }
}

var Browser = { openUrlNewWindow: openUrlNewWindow };
