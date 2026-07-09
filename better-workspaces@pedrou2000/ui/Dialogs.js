/*
 * BetterWorkspaces — ui/Dialogs.js
 *
 * Small modal dialogs (title + message + buttons) built on Cinnamon's
 * ModalDialog, styled like the toggle panel. One internal builder; two
 * public shapes:
 *
 *   confirm(title, message)        -> Promise<boolean>
 *   notify(title, message)         -> void (single OK button)
 *
 * Pure UI — no model or Notion knowledge; callers compose the text.
 *
 * Released under the GNU General Public License v2 (see LICENSE).
 */
const St = imports.gi.St;
const Clutter = imports.gi.Clutter;
const ModalDialog = imports.ui.modalDialog;

// Build and open a modal with the shared title+message layout and the given
// buttons ([{label, action, key?}]); each button's action also closes.
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

// Two-button confirmation; Escape cancels. Resolves true iff confirmed.
// confirmLabel defaults to "OK".
function confirm(title, message, confirmLabel) {
    return new Promise((resolve) => {
        _open(title, message, [
            { label: "Cancel", action: () => resolve(false), key: Clutter.KEY_Escape },
            { label: confirmLabel || "OK", action: () => resolve(true) },
        ]);
    });
}

// Single-OK notification; Escape also dismisses.
function notify(title, message) {
    _open(title, message, [{ label: "OK", key: Clutter.KEY_Escape }]);
}

var Dialogs = { confirm: confirm, notify: notify };
