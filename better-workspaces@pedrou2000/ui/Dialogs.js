/* ui/Dialogs.js — confirm(title,msg)->Promise<bool> and notify(title,msg) modals. */

const St = imports.gi.St;
const Clutter = imports.gi.Clutter;
const ModalDialog = imports.ui.modalDialog;

// buttons: [{label, action?, key?}]; each button's action also closes.
function _open(title, message, buttons) {
    let dialog = new ModalDialog.ModalDialog();
    let box = new St.BoxLayout({
        vertical: true,
        style_class: 'better-workspaces-toggle-panel',
    });
    box.add(new St.Label({
        style_class: 'better-workspaces-toggle-title',
        text: title,
    }));
    box.add(new St.Label({ text: message }));
    dialog.contentLayout.add(box);
    dialog.setButtons(buttons.map((b) => ({
        label: b.label,
        key: b.key,
        action: () => { dialog.close(); if (b.action) b.action(); },
    })));
    dialog.open();
    return dialog;
}

// Escape cancels; confirmLabel defaults to "OK".
function confirm(title, message, confirmLabel) {
    return new Promise((resolve) => {
        _open(title, message, [
            { label: "Cancel", action: () => resolve(false), key: Clutter.KEY_Escape },
            { label: confirmLabel || "OK", action: () => resolve(true) },
        ]);
    });
}

function notify(title, message) {
    _open(title, message, [{ label: "OK", key: Clutter.KEY_Escape }]);
}

var Dialogs = { confirm: confirm, notify: notify };
