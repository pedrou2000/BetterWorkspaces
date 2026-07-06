/*
 * BetterWorkspaces — lib/logger.js
 * Tiny shared logging helper so every module tags its output consistently.
 * Released under the GNU General Public License v2 (see LICENSE).
 */

const UUID = "better-workspaces@pedrou2000";

function makeLogger(tag) {
    let prefix = UUID + (tag ? " [" + tag + "]" : "") + ": ";
    return {
        log: function (msg) { global.log(prefix + msg); },
        error: function (msg) { global.logError(prefix + msg); },
    };
}

var Logger = { makeLogger: makeLogger };
