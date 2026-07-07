/*
 * BetterWorkspaces — wm/WorkspaceManager.js
 *
 * The Cinnamon quarantine (Design Doc §3.B): the ONLY module allowed to touch
 * global.workspace_manager / Muffin internals. Everything else calls these
 * clean methods. When Cinnamon's API drifts between versions, this is the one
 * file to fix.
 *
 * M1 scope: controlled mutation — create, switch, remove workspaces, and move
 * the focused window. Every method is bounds-checked and guarded so a bad call
 * degrades to a no-op + log line instead of crashing the shell.
 *
 * Released under the GNU General Public License v2 (see LICENSE).
 */

const UUID = "better-workspaces@pedrou2000";

function log(msg) { global.log(UUID + " [wm]: " + msg); }
function logError(msg) { global.logError(UUID + " [wm]: " + msg); }

function WorkspaceManager() {
    this._init();
}

WorkspaceManager.prototype = {

    _init: function () {
        // Nothing to hold yet; global.workspace_manager is always live.
    },

    // Convenience accessor so the rest of the method bodies stay short.
    _wm: function () {
        return global.workspace_manager;
    },

    _now: function () {
        return global.get_current_time();
    },

    // ---- Reads -------------------------------------------------------------

    getWorkspaceCount: function () {
        return this._wm().n_workspaces;
    },

    getActiveIndex: function () {
        return this._wm().get_active_workspace_index();
    },

    // Number of windows on a given workspace (normal windows only would need
    // extra filtering; for M1 we report the raw list length).
    countWindows: function (index) {
        let ws = this._wm().get_workspace_by_index(index);
        return ws ? ws.list_windows().length : 0;
    },

    // ---- Switching ---------------------------------------------------------

    // Activate the workspace at `index`. Returns true on success, false if the
    // index is out of range (no-op, logged) — never throws.
    goToWorkspace: function (index) {
        try {
            let ws = this._wm().get_workspace_by_index(index);
            if (ws === null) {
                log("goToWorkspace: index " + index + " out of range (count="
                    + this.getWorkspaceCount() + "), ignoring");
                return false;
            }
            ws.activate(this._now());
            return true;
        } catch (e) {
            logError("goToWorkspace(" + index + "): " + e.toString());
            return false;
        }
    },

    // Move by a signed delta, clamped to valid range (does not wrap).
    goBy: function (delta) {
        let target = this.getActiveIndex() + delta;
        let count = this.getWorkspaceCount();
        if (target < 0) target = 0;
        if (target > count - 1) target = count - 1;
        return this.goToWorkspace(target);
    },

    goToNext: function () { return this.goBy(1); },
    goToPrevious: function () { return this.goBy(-1); },

    // ---- Creating / removing ----------------------------------------------

    // Append a new workspace at the end. Returns its index, or -1 on failure.
    createWorkspace: function () {
        try {
            let before = this.getWorkspaceCount();
            this._wm().append_new_workspace(false, this._now());
            let after = this.getWorkspaceCount();
            if (after > before) {
                let newIndex = after - 1;
                log("createWorkspace: added workspace at index " + newIndex
                    + " (count " + before + " -> " + after + ")");
                return newIndex;
            }
            log("createWorkspace: count did not increase (still " + after + ")");
            return -1;
        } catch (e) {
            logError("createWorkspace: " + e.toString());
            return -1;
        }
    },

    // Remove the workspace at `index`. Guards:
    //   - refuses to remove the last remaining workspace (Cinnamon needs >= 1)
    //   - out-of-range index is a logged no-op
    // Returns true on success.
    removeWorkspace: function (index) {
        try {
            let count = this.getWorkspaceCount();
            if (count <= 1) {
                log("removeWorkspace: refusing to remove the last workspace");
                return false;
            }
            let ws = this._wm().get_workspace_by_index(index);
            if (ws === null) {
                log("removeWorkspace: index " + index + " out of range (count="
                    + count + "), ignoring");
                return false;
            }
            this._wm().remove_workspace(ws, this._now());
            log("removeWorkspace: removed index " + index
                + " (count " + count + " -> " + this.getWorkspaceCount() + ")");
            return true;
        } catch (e) {
            logError("removeWorkspace(" + index + "): " + e.toString());
            return false;
        }
    },

    // Remove the last workspace (convenient inverse of createWorkspace).
    removeLastWorkspace: function () {
        return this.removeWorkspace(this.getWorkspaceCount() - 1);
    },

    // ---- Moving windows ----------------------------------------------------

    // Move the currently focused window to workspace `index`.
    // Returns true if a window was moved, false if there was no focused window
    // or the index was invalid.
    moveFocusedWindowTo: function (index) {
        try {
            let count = this.getWorkspaceCount();
            if (index < 0 || index > count - 1) {
                log("moveFocusedWindowTo: index " + index + " out of range");
                return false;
            }
            let win = global.display.get_focus_window();
            if (!win) {
                log("moveFocusedWindowTo: no focused window");
                return false;
            }
            // Muffin: change_workspace_by_index(space_index, append)
            win.change_workspace_by_index(index, false);
            log("moveFocusedWindowTo: moved '" + win.get_title()
                + "' to workspace " + index);
            return true;
        } catch (e) {
            logError("moveFocusedWindowTo(" + index + "): " + e.toString());
            return false;
        }
    },

    // Move the focused window to the next workspace, following it there.
    moveFocusedWindowToNext: function () {
        let target = this.getActiveIndex() + 1;
        if (target > this.getWorkspaceCount() - 1) {
            log("moveFocusedWindowToNext: already on the last workspace");
            return false;
        }
        if (this.moveFocusedWindowTo(target)) {
            this.goToWorkspace(target);
            return true;
        }
        return false;
    },

    // Move EVERY window on workspace `from` to workspace `to`. Used when
    // inserting/removing a workspace in the middle of the flat list so a
    // project's partition can grow/shrink without scattering later projects.
    // Skips windows pinned to all workspaces (is_on_all_workspaces()).
    moveAllWindows: function (from, to) {
        try {
            let ws = this._wm().get_workspace_by_index(from);
            if (!ws) return false;
            let windows = ws.list_windows();
            for (let i = 0; i < windows.length; i++) {
                let w = windows[i];
                if (w.is_on_all_workspaces && w.is_on_all_workspaces()) continue;
                w.change_workspace_by_index(to, false);
            }
            return true;
        } catch (e) {
            logError("moveAllWindows(" + from + "->" + to + "): " + e.toString());
            return false;
        }
    },

    // ---- Lifecycle ---------------------------------------------------------

    destroy: function () {
        // No persistent signals held in M1; present for interface symmetry.
    },
};
