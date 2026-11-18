/* lib/keyring.js — the Notion token's place in the system keyring (libsecret). */

// Async on purpose: a locked keyring can make the user wait at an unlock
// prompt, and a blocking call would freeze the whole shell meanwhile.
// Everything rejects or resolves; nothing throws synchronously.

const AppletDir = imports.ui.appletManager.applets["better-workspaces@pedrou2000"];
const L = AppletDir.lib.logger.Logger.makeLogger("keyring");

// Missing typelib (no libsecret GIR installed) just means "no keyring".
let Secret = null;
try {
    Secret = imports.gi.Secret;
} catch (e) {
    L.log("libsecret not available: " + e.toString());
}

const ATTRS = { purpose: "notion-token" };
const LABEL = "BetterWorkspaces — Notion integration token";

let _schema = null;
function _getSchema() {
    if (!_schema) {
        _schema = new Secret.Schema(
            "io.github.pedrou2000.BetterWorkspaces",
            Secret.SchemaFlags.NONE,
            { purpose: Secret.SchemaAttributeType.STRING },
        );
    }
    return _schema;
}

function _call(start, finish) {
    return new Promise((resolve, reject) => {
        try {
            start((source, result) => {
                try {
                    resolve(finish(result));
                } catch (e) {
                    reject(e);
                }
            });
        } catch (e) {
            reject(e);
        }
    });
}

function available() {
    return Secret !== null;
}

// Resolves the stored token, or null if there is none.
function load() {
    return _call(
        (cb) => Secret.password_lookup(_getSchema(), ATTRS, null, cb),
        (res) => Secret.password_lookup_finish(res),
    );
}

// Resolves true once stored.
function save(token) {
    return _call(
        (cb) =>
            Secret.password_store(
                _getSchema(),
                ATTRS,
                Secret.COLLECTION_DEFAULT,
                LABEL,
                token,
                null,
                cb,
            ),
        (res) => Secret.password_store_finish(res),
    );
}

// Resolves true if an entry was removed.
function clear() {
    return _call(
        (cb) => Secret.password_clear(_getSchema(), ATTRS, null, cb),
        (res) => Secret.password_clear_finish(res),
    );
}

var Keyring = {
    available: available,
    load: load,
    save: save,
    clear: clear,
};
