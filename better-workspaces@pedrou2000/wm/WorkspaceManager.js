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
const AppletDir = imports.ui.appletManager.applets[UUID];

const _L = AppletDir.lib.logger.Logger.makeLogger("wm");
function log(msg) { _L.log(msg); }
function logError(msg) { _L.error(msg); }

// Non-pinned windows on a workspace object (windows pinned to all workspaces
// appear on every workspace and would otherwise make each look non-empty).
function realWindows(ws) {
    if (!ws) return [];
    let out = [];
    let windows = ws.list_windows();
    for (let i = 0; i < windows.length; i++) {
        let w = windows[i];
        if (w.is_on_all_workspaces && w.is_on_all_workspaces()) continue;
        out.push(w);
    }
    return out;
}

var WorkspaceManager = class WorkspaceManager {

    constructor() {
        // Nothing to hold yet; global.workspace_manager is always live.
    }

    // Convenience accessor so the rest of the method bodies stay short.
    _wm() {
        return global.workspace_manager;
    }

    _now() {
        return global.get_current_time();
    }

    // ---- Reads -------------------------------------------------------------

    getWorkspaceCount() {
        return this._wm().n_workspaces;
    }

    getActiveIndex() {
        return this._wm().get_active_workspace_index();
    }

    // Number of "real" windows on a workspace, EXCLUDING windows pinned to all
    // workspaces (sticky windows appear in every workspace's list and would
    // otherwise make every workspace look non-empty).
    countWindows(index) {
        return realWindows(this._wm().get_workspace_by_index(index)).length;
    }

    // ---- Switching ---------------------------------------------------------

    // Activate the workspace at `index`. Returns true on success, false if the
    // index is out of range (no-op, logged) — never throws.
    goToWorkspace(index) {
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
    }

    // ---- Creating / removing ----------------------------------------------

    // Append a new workspace at the end. Returns its index, or -1 on failure.
    createWorkspace() {
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
    }

    // The MetaWorkspace object at `index` (or null). Hold onto the OBJECT when
    // doing several reorders in a row, since indices shift after each move.
    getWorkspace(index) {
        return this._wm().get_workspace_by_index(index);
    }

    // Move a specific workspace OBJECT to `toIndex`, carrying its windows, via
    // Muffin's native reorder_workspace (no per-window shuffling).
    reorderWorkspaceObject(ws, toIndex) {
        try {
            if (!ws) return false;
            this._wm().reorder_workspace(ws, toIndex);
            return true;
        } catch (e) {
            logError("reorderWorkspaceObject(-> " + toIndex + "): " + e.toString());
            return false;
        }
    }

    // Move the workspace at `fromIndex` to `toIndex` (single move). No-op if
    // equal/out of range.
    reorderWorkspace(fromIndex, toIndex) {
        let count = this.getWorkspaceCount();
        if (fromIndex === toIndex) return true;
        if (fromIndex < 0 || fromIndex >= count || toIndex < 0 || toIndex >= count) {
            log("reorderWorkspace: index out of range " + fromIndex + "->" + toIndex);
            return false;
        }
        let ok = this.reorderWorkspaceObject(this.getWorkspace(fromIndex), toIndex);
        if (ok) log("reorderWorkspace: " + fromIndex + " -> " + toIndex);
        return ok;
    }

    // Remove the workspace at `index`. Guards:
    //   - refuses to remove the last remaining workspace (Cinnamon needs >= 1)
    //   - out-of-range index is a logged no-op
    // Returns true on success.
    removeWorkspace(index) {
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
    }

    // Remove the last workspace (convenient inverse of createWorkspace).
    removeLastWorkspace() {
        return this.removeWorkspace(this.getWorkspaceCount() - 1);
    }

    // ---- Moving windows ----------------------------------------------------

    // Move the currently focused window to workspace `index`.
    // Returns true if a window was moved, false if there was no focused window
    // or the index was invalid.
    moveFocusedWindowTo(index) {
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
    }

    // List non-pinned windows on a single workspace index.
    listWindowsOnWorkspace(index) {
        return realWindows(this._wm().get_workspace_by_index(index));
    }

    // Move EVERY window on workspace `from` to workspace `to`. Used when
    // inserting/removing a workspace in the middle of the flat list so a
    // project's partition can grow/shrink without scattering later projects.
    // Skips windows pinned to all workspaces (is_on_all_workspaces()).
    moveAllWindows(from, to) {
        try {
            let windows = realWindows(this._wm().get_workspace_by_index(from));
            for (let i = 0; i < windows.length; i++) {
                windows[i].change_workspace_by_index(to, false);
            }
            return true;
        } catch (e) {
            logError("moveAllWindows(" + from + "->" + to + "): " + e.toString());
            return false;
        }
    }

    // ---- Closing windows (graceful) ----------------------------------------

    // List non-pinned windows across a set of workspace indices.
    listWindowsOnWorkspaces(indices) {
        let out = [];
        try {
            for (let k = 0; k < indices.length; k++) {
                let wins = realWindows(this._wm().get_workspace_by_index(indices[k]));
                for (let i = 0; i < wins.length; i++) out.push(wins[i]);
            }
        } catch (e) {
            logError("listWindowsOnWorkspaces: " + e.toString());
        }
        return out;
    }

    // Request a graceful close of a window (behaves like clicking the X; the
    // app may prompt to save). Does NOT force-kill.
    requestCloseWindow(win) {
        try {
            win.delete(this._now());
            return true;
        } catch (e) {
            logError("requestCloseWindow: " + e.toString());
            return false;
        }
    }

    // ---- Lifecycle ---------------------------------------------------------

    destroy() {
        // No persistent signals held in M1; present for interface symmetry.
    }
};
