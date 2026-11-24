/* core/WindowKeeper.js — sends back a window that its own dialog dragged to the active workspace. */

// Muffin moves a dialog that asks for focus to the active workspace, and the
// window it belongs to follows (meta_window_activate_full: "Move transients to
// current workspace"). So an app that raises a dialog while you are elsewhere —
// VS Code's "Cannot reconnect. Please reload the window" after a night away —
// lands in whichever project you happen to be looking at. A main window that
// asks for focus is left where it is by Muffin; this gives dialogs the same
// treatment, and the dialog waits on its own workspace.

const Mainloop = imports.mainloop;

const UUID = "better-workspaces@pedrou2000";
const AppletDir = imports.ui.appletManager.applets[UUID];

const L = AppletDir.lib.logger.Logger.makeLogger("keeper");

var WindowKeeper = class WindowKeeper {
    // opts: { enabled: () => bool }
    constructor(wm, opts) {
        this._wm = wm;
        this._enabled = opts && opts.enabled ? opts.enabled : () => true;
        this._arrived = new Map(); // window -> the workspace it was on before
        this._timer = 0;
    }

    start() {
        this._wm.watchWindowMoves((win, from, to) => this._onMoved(win, from, to));
    }

    _onMoved(win, from, to) {
        if (!this._enabled()) return;
        if (this._wm.indexOfWorkspace(to) !== this._wm.getActiveIndex()) return;
        // Then a window arriving here is the user's doing.
        if (this._wm.isOverviewOpen() || this._wm.bringsWindowsToCurrentWorkspace()) return;
        if (!this._arrived.has(win)) this._arrived.set(win, from);
        // Deferred: Muffin moves the dialog and then its window in one walk, and
        // moving a window from inside that walk would re-enter it. A zero timeout
        // rather than an idle: it runs ahead of the next repaint, so the window
        // is usually gone again before it is ever drawn here.
        if (!this._timer) this._timer = Mainloop.timeout_add(0, () => this._settle());
    }

    _settle() {
        this._timer = 0;
        const arrived = this._arrived;
        this._arrived = new Map();
        arrived.forEach((from, win) => {
            try {
                this._sendBackIfPulled(win, from);
            } catch (e) {
                L.error("settle: " + e.toString());
            }
        });
        return false;
    }

    // Only a window that came with a dialog was pulled; anything else that
    // lands here (a session restore, wmctrl) is left alone.
    _sendBackIfPulled(win, from) {
        const wm = this._wm;
        const active = wm.getActiveIndex();
        const home = wm.indexOfWorkspace(from);
        if (home === -1 || home === active) return;
        if (!wm.isTopLevelWindow(win)) return; // a dialog goes back with its window
        if (wm.workspaceIndexOfWindow(win) !== active) return; // closed or moved on since
        if (!wm.hasDialogOnWorkspace(win, active)) return;
        if (!wm.moveWindowToWorkspace(win, home)) return;
        L.log(
            "sent '" +
                win.get_title() +
                "' back to workspace " +
                home +
                ": its dialog had pulled it to workspace " +
                active,
        );
    }

    destroy() {
        if (this._timer) {
            Mainloop.source_remove(this._timer);
            this._timer = 0;
        }
        this._arrived = new Map();
        this._wm.unwatchWindowMoves();
    }
};
