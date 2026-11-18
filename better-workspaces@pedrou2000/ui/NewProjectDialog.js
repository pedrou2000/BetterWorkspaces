/* ui/NewProjectDialog.js — asks for a new project's name; the only way a page gets created. */

// Nothing is sent until the user types a name and presses Enter (or Create);
// Escape or Cancel leaves Notion untouched. While a create is in flight further
// Enters are ignored, and after an UNCLEAR outcome (the page may exist) creating
// is locked for this dialog, so a reflexive second Enter can't make a duplicate.

const St = imports.gi.St;
const Clutter = imports.gi.Clutter;
const ModalDialog = imports.ui.modalDialog;

const AppletDir = imports.ui.appletManager.applets["better-workspaces@pedrou2000"];
const DialogStyle = AppletDir.ui.DialogStyle.DialogStyle;
const L = AppletDir.lib.logger.Logger.makeLogger("new-project");

var NewProjectDialog = class NewProjectDialog {
    // opts: {
    //   title,
    //   initialName,
    //   details: string,  a line under the name saying what will be created
    //   prepare: () => Promise,  optional work the create depends on (reading the
    //       parent), started when the dialog opens and shown only if it fails:
    //       a rejection ({userMessage}) blocks creating
    //   nameExists: (name) => bool,
    //   submit: (name) => Promise,  rejects with {kind, userMessage}
    //   onClosed: () => void,
    //   onFailedAfterClose: (text) => void,  the create failed after Cancel/Esc
    // }
    constructor(opts) {
        this._opts = opts;
        this._busy = false;
        this._locked = false; // prepare failed, or an unclear outcome
        this._prepared = null; // prepare()'s promise; a create waits for it
    }

    open() {
        this._dialog = new ModalDialog.ModalDialog(DialogStyle.dialogParams());
        const box = new St.BoxLayout({
            vertical: true,
            style_class: "better-workspaces-toggle-panel better-workspaces-new-project",
        });
        this._dialog.contentLayout.add(box);

        box.add(
            new St.Label({ style_class: "better-workspaces-toggle-title", text: this._opts.title }),
        );

        // Leading space in the hint so the placeholder clears the caret.
        this._entry = new St.Entry({
            style_class: "better-workspaces-dialog-entry",
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
        this._show(this._details, this._opts.details || "");

        this._message = new St.Label({ style_class: "better-workspaces-dialog-message", text: "" });
        this._message.clutter_text.set_line_wrap(true);
        box.add(this._message);
        this._show(this._message, "");

        // ModalDialog hands each St.Button back on its info object.
        const createInfo = { label: "Create", action: () => this._submit() };
        this._dialog.setButtons([
            { label: "Cancel", action: () => this.close(), key: Clutter.KEY_Escape },
            createInfo,
        ]);

        // Enter means Create while the user is typing, so Create is marked as the
        // one Enter triggers. Notion look: it is the blue primary button. Classic
        // look: it wears the theme's focus outline, as if Tab had already reached
        // it (key focus itself stays in the entry — it has to, to type); once
        // focus moves to a button, that button's real focus look takes over.
        const createButton = createInfo.button || null;
        if (createButton && DialogStyle.is("notion")) {
            createButton.add_style_pseudo_class("primary");
        } else if (createButton) {
            this._entry.clutter_text.connect("key-focus-in", () =>
                createButton.add_style_pseudo_class("focus"),
            );
            this._entry.clutter_text.connect("key-focus-out", () =>
                createButton.remove_style_pseudo_class("focus"),
            );
        }

        this._dialog.open();
        global.stage.set_key_focus(this._entry);
        this._onTextChanged();
        this._prepare();
    }

    // An empty label still takes a line plus the box's spacing, so hide it.
    _show(label, text) {
        label.set_text(text);
        label.visible = text.length > 0;
    }

    // Runs while the user types, so it has usually finished by the time they
    // press Enter; a create that comes sooner simply waits for it.
    _prepare() {
        this._prepared = this._opts.prepare ? this._opts.prepare() : Promise.resolve();
        this._prepared.catch((e) => {
            this._locked = true;
            if (this._dialog) this._show(this._message, this._textOf(e));
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
        this._show(this._message, exists ? "A project named “" + name + "” already exists." : "");
    }

    _submit() {
        if (this._busy || this._locked) return;
        const name = this._name();
        if (!name) return;

        this._busy = true;
        this._show(this._message, "Creating in Notion…");
        this._prepared
            .then(() => this._opts.submit(name))
            .then(() => {
                this._busy = false;
                this.close();
            })
            .catch((e) => {
                this._busy = false;
                if (e && e.kind === "unclear") this._locked = true;
                L.log("create '" + name + "' failed: " + (e && e.kind ? e.kind : e));
                if (this._dialog) {
                    this._show(this._message, this._textOf(e));
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
