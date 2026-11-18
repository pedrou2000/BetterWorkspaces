/* ui/NewProjectDialog.js — asks for a new project's name; the only way a page gets created. */

// Nothing is sent until the user types a name and presses Enter (or Create);
// Escape or Cancel leaves Notion untouched. While a create is in flight further
// Enters are ignored, and after an UNCLEAR outcome (the page may exist) creating
// is locked for this dialog, so a reflexive second Enter can't make a duplicate.

const St = imports.gi.St;
const Clutter = imports.gi.Clutter;
const ModalDialog = imports.ui.modalDialog;

const AppletDir = imports.ui.appletManager.applets["better-workspaces@pedrou2000"];
const L = AppletDir.lib.logger.Logger.makeLogger("new-project");

var NewProjectDialog = class NewProjectDialog {
    // opts: {
    //   title,
    //   initialName,
    //   loadDetails: () => Promise<string>,  optional: a line saying what will be
    //       copied; if it rejects ({userMessage}) creating is blocked
    //   nameExists: (name) => bool,
    //   submit: (name) => Promise,  rejects with {kind, userMessage}
    //   onClosed: () => void,
    //   onFailedAfterClose: (text) => void,  the create failed after Cancel/Esc
    // }
    constructor(opts) {
        this._opts = opts;
        this._busy = false;
        this._locked = false; // details unreadable, or an unclear outcome
        this._ready = !opts.loadDetails;
    }

    open() {
        this._dialog = new ModalDialog.ModalDialog();
        const box = new St.BoxLayout({
            vertical: true,
            style_class: "better-workspaces-toggle-panel",
        });
        this._dialog.contentLayout.add(box);

        box.add(
            new St.Label({ style_class: "better-workspaces-toggle-title", text: this._opts.title }),
        );

        this._entry = new St.Entry({
            style_class: "better-workspaces-toggle-search",
            hint_text: " Project name",
            can_focus: true,
        });
        if (this._opts.initialName) this._entry.set_text(this._opts.initialName);
        this._entry.clutter_text.connect("text-changed", () => this._onTextChanged());
        this._entry.clutter_text.connect("key-press-event", (actor, event) => {
            const sym = event.get_key_symbol();
            if (sym !== Clutter.KEY_Return && sym !== Clutter.KEY_KP_Enter) {
                return Clutter.EVENT_PROPAGATE;
            }
            this._submit();
            return Clutter.EVENT_STOP;
        });
        box.add(this._entry);

        this._details = new St.Label({ style_class: "better-workspaces-dialog-details", text: "" });
        this._details.clutter_text.set_line_wrap(true);
        box.add(this._details);

        this._message = new St.Label({ style_class: "better-workspaces-dialog-message", text: "" });
        this._message.clutter_text.set_line_wrap(true);
        box.add(this._message);

        this._dialog.setButtons([
            { label: "Cancel", action: () => this.close(), key: Clutter.KEY_Escape },
            { label: "Create", action: () => this._submit() },
        ]);

        this._dialog.open();
        global.stage.set_key_focus(this._entry);
        this._onTextChanged();
        this._loadDetails();
    }

    _loadDetails() {
        if (!this._opts.loadDetails) return;
        this._details.set_text("Reading the parent project…");
        this._opts
            .loadDetails()
            .then((text) => {
                this._ready = true;
                if (this._dialog) this._details.set_text(text || "");
            })
            .catch((e) => {
                this._locked = true;
                if (!this._dialog) return;
                this._details.set_text("");
                this._message.set_text(this._textOf(e));
            });
    }

    _textOf(e) {
        return e && e.userMessage ? e.userMessage : "Something went wrong. Nothing was created.";
    }

    _name() {
        return this._entry.get_text().trim();
    }

    // The same-name note is advice, not a block: two projects may share a name.
    _onTextChanged() {
        if (this._busy || this._locked) return;
        const name = this._name();
        const exists = name && this._opts.nameExists && this._opts.nameExists(name);
        this._message.set_text(exists ? "A project named “" + name + "” already exists." : "");
    }

    _submit() {
        if (this._busy || this._locked || !this._ready) return;
        const name = this._name();
        if (!name) return;

        this._busy = true;
        this._message.set_text("Creating in Notion…");
        this._opts
            .submit(name)
            .then(() => {
                this._busy = false;
                this.close();
            })
            .catch((e) => {
                this._busy = false;
                if (e && e.kind === "unclear") this._locked = true;
                L.log("create '" + name + "' failed: " + (e && e.kind ? e.kind : e));
                if (this._dialog) {
                    this._message.set_text(this._textOf(e));
                } else if (this._opts.onFailedAfterClose) {
                    this._opts.onFailedAfterClose(this._textOf(e));
                }
            });
    }

    close() {
        if (!this._dialog) return;
        this._dialog.close();
        this._dialog = null;
        if (this._opts.onClosed) this._opts.onClosed();
    }
};
