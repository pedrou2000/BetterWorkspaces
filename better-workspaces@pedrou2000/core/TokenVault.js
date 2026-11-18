/* core/TokenVault.js — keeps the Notion token out of the settings file. */

// Cinnamon stores applet settings as plain JSON, and the token field is the
// only place the user can type the token. So a token typed there is moved to
// the system keyring and the field is left holding MARKER instead. From then
// on the field means: MARKER = "use the keyring's token", a new token = "replace
// it", empty = "not connected".
//
// The field is only overwritten after the keyring has been read back and holds
// exactly that token, so a failing keyring can never lose it: the token then
// simply stays in the settings, as before. With no keyring at all, the field
// IS the token. Collaborators are injected, so this has no GJS dependency.

const AppletDir = imports.ui.appletManager.applets["better-workspaces@pedrou2000"];
const L = AppletDir.lib.logger.Logger.makeLogger("token");

const MARKER = "(stored in the system keyring)";

var TokenVault = class TokenVault {
    // deps: {
    //   keyring: {available(), load()->Promise<string|null>, save(t)->Promise<bool>,
    //             clear()->Promise<bool>},
    //   getSetting(): the token field's current value,
    //   setSetting(value),
    // }
    constructor(deps) {
        this._keyring = deps.keyring;
        this._getSetting = deps.getSetting;
        this._setSetting = deps.setSetting;
    }

    // Resolves the token to use ("" = not connected); never rejects.
    // userEdited: the field was just changed by the user, as opposed to being
    // read at startup. Only then does an EMPTY field also erase the keyring's
    // token — at startup an empty field may just be a reset settings file.
    async resolve(userEdited) {
        const value = String(this._getSetting() || "").trim();
        if (!this._keyring.available()) return value === MARKER ? "" : value;

        if (value === "") {
            if (userEdited) await this._try(() => this._keyring.clear(), "clear");
            return "";
        }
        if (value === MARKER) {
            return (await this._try(() => this._keyring.load(), "load")) || "";
        }

        if (await this._moveToKeyring(value)) this._setSetting(MARKER);
        return value;
    }

    async _moveToKeyring(token) {
        const saved = await this._try(() => this._keyring.save(token), "save");
        if (!saved) return false;
        const readBack = await this._try(() => this._keyring.load(), "read back");
        if (readBack !== token) {
            L.error("the keyring did not return the token it was given; keeping it in settings");
            return false;
        }
        L.log("token moved to the system keyring");
        return true;
    }

    async _try(fn, what) {
        try {
            return await fn();
        } catch (e) {
            L.error("keyring " + what + " failed: " + (e && e.message ? e.message : e));
            return null;
        }
    }
};

TokenVault.MARKER = MARKER;
