/* lib/logger.js — tagged global.log/logError wrappers, one per module. */

const UUID = "better-workspaces@pedrou2000";

function makeLogger(tag) {
    let prefix = UUID + (tag ? " [" + tag + "]" : "") + ": ";
    return {
        log: function (msg) { global.log(prefix + msg); },
        error: function (msg) { global.logError(prefix + msg); },
    };
}

var Logger = { makeLogger: makeLogger };
