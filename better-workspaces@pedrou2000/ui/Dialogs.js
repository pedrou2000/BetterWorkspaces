/* ui/Dialogs.js — notify(title,msg) modal. */

const St = imports.gi.St;
const Clutter = imports.gi.Clutter;
const ModalDialog = imports.ui.modalDialog;

const AppletDir = imports.ui.appletManager.applets["better-workspaces@pedrou2000"];
const DialogStyle = AppletDir.ui.DialogStyle.DialogStyle;

// buttons: [{label, action?, key?}]; each button's action also closes.
function _open(title, message, buttons) {
    const dialog = new ModalDialog.ModalDialog(DialogStyle.dialogParams());
    const box = new St.BoxLayout({
        vertical: true,
        style_class: "better-workspaces-toggle-panel",
    });
    box.add(
        new St.Label({
            style_class: "better-workspaces-toggle-title",
            text: title,
        }),
    );
    box.add(new St.Label({ style_class: "better-workspaces-dialog-body", text: message }));
    dialog.contentLayout.add(box);
    dialog.setButtons(
        buttons.map((b) => ({
            label: b.label,
            key: b.key,
            action: () => {
                dialog.close();
                if (b.action) b.action();
            },
        })),
    );
    dialog.open();
    return dialog;
}

function notify(title, message) {
    _open(title, message, [{ label: "OK", key: Clutter.KEY_Escape }]);
}

var Dialogs = { notify: notify };
