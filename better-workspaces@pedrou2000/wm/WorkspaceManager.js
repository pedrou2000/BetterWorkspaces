/* wm/WorkspaceManager.js — the only module that touches Muffin/workspace APIs. */

// Every method is bounds-checked and guarded: a bad call degrades to a no-op +
// log line rather than crashing the shell. When Cinnamon's API drifts, fix here.

const UUID = "better-workspaces@pedrou2000";
const AppletDir = imports.ui.appletManager.applets[UUID];

const L = AppletDir.lib.logger.Logger.makeLogger("wm");

// Windows pinned to all workspaces appear on every workspace and would make each
// look non-empty; exclude them everywhere "real" occupancy matters.
function realWindows(ws) {
    if (!ws) return [];
    const out = [];
    const windows = ws.list_windows();
    for (let i = 0; i < windows.length; i++) {
        const w = windows[i];
        if (w.is_on_all_workspaces && w.is_on_all_workspaces()) continue;
        out.push(w);
    }
    return out;
}

var WorkspaceManager = class WorkspaceManager {
    constructor() {}

    _wm() {
        return global.workspace_manager;
    }

    _now() {
        return global.get_current_time();
    }

    getWorkspaceCount() {
        return this._wm().n_workspaces;
    }

    getActiveIndex() {
        return this._wm().get_active_workspace_index();
    }

    countWindows(index) {
        return realWindows(this._wm().get_workspace_by_index(index)).length;
    }

    goToWorkspace(index) {
        try {
            const ws = this._wm().get_workspace_by_index(index);
            if (ws === null) {
                L.log(
                    "goToWorkspace: index " +
                        index +
                        " out of range (count=" +
                        this.getWorkspaceCount() +
                        "), ignoring",
                );
                return false;
            }
            ws.activate(this._now());
            return true;
        } catch (e) {
            L.error("goToWorkspace(" + index + "): " + e.toString());
            return false;
        }
    }

    // Appends at the end. Returns the new index, or -1 on failure.
    createWorkspace() {
        try {
            const before = this.getWorkspaceCount();
            this._wm().append_new_workspace(false, this._now());
            const after = this.getWorkspaceCount();
            if (after > before) {
                const newIndex = after - 1;
                L.log(
                    "createWorkspace: added workspace at index " +
                        newIndex +
                        " (count " +
                        before +
                        " -> " +
                        after +
                        ")",
                );
                return newIndex;
            }
            L.log("createWorkspace: count did not increase (still " + after + ")");
            return -1;
        } catch (e) {
            L.error("createWorkspace: " + e.toString());
            return -1;
        }
    }

    // Hold onto the OBJECT across several reorders — indices shift after each move.
    getWorkspace(index) {
        return this._wm().get_workspace_by_index(index);
    }

    // Native reorder_workspace carries the workspace's windows (no per-window shuffle).
    reorderWorkspaceObject(ws, toIndex) {
        try {
            if (!ws) return false;
            this._wm().reorder_workspace(ws, toIndex);
            return true;
        } catch (e) {
            L.error("reorderWorkspaceObject(-> " + toIndex + "): " + e.toString());
            return false;
        }
    }

    reorderWorkspace(fromIndex, toIndex) {
        const count = this.getWorkspaceCount();
        if (fromIndex === toIndex) return true;
        if (fromIndex < 0 || fromIndex >= count || toIndex < 0 || toIndex >= count) {
            L.log("reorderWorkspace: index out of range " + fromIndex + "->" + toIndex);
            return false;
        }
        const ok = this.reorderWorkspaceObject(this.getWorkspace(fromIndex), toIndex);
        if (ok) L.log("reorderWorkspace: " + fromIndex + " -> " + toIndex);
        return ok;
    }

    // Refuses to remove the last workspace (Cinnamon needs >=1); out-of-range no-ops.
    removeWorkspace(index) {
        try {
            const count = this.getWorkspaceCount();
            if (count <= 1) {
                L.log("removeWorkspace: refusing to remove the last workspace");
                return false;
            }
            const ws = this._wm().get_workspace_by_index(index);
            if (ws === null) {
                L.log(
                    "removeWorkspace: index " +
                        index +
                        " out of range (count=" +
                        count +
                        "), ignoring",
                );
                return false;
            }
            this._wm().remove_workspace(ws, this._now());
            L.log(
                "removeWorkspace: removed index " +
                    index +
                    " (count " +
                    count +
                    " -> " +
                    this.getWorkspaceCount() +
                    ")",
            );
            return true;
        } catch (e) {
            L.error("removeWorkspace(" + index + "): " + e.toString());
            return false;
        }
    }

    removeLastWorkspace() {
        return this.removeWorkspace(this.getWorkspaceCount() - 1);
    }

    // Returns the moved window (so the caller can re-focus it after following),
    // or null if there was nothing to move.
    moveFocusedWindowTo(index) {
        try {
            const count = this.getWorkspaceCount();
            if (index < 0 || index > count - 1) {
                L.log("moveFocusedWindowTo: index " + index + " out of range");
                return null;
            }
            const win = global.display.get_focus_window();
            if (!win) {
                L.log("moveFocusedWindowTo: no focused window");
                return null;
            }
            win.change_workspace_by_index(index, false);
            L.log("moveFocusedWindowTo: moved '" + win.get_title() + "' to workspace " + index);
            return win;
        } catch (e) {
            L.error("moveFocusedWindowTo(" + index + "): " + e.toString());
            return null;
        }
    }

    // Re-assert focus on a specific window. Must run AFTER the target workspace is
    // active, or the workspace's own MRU focus overrides it.
    focusWindow(win) {
        try {
            if (win) win.activate(this._now());
            return true;
        } catch (e) {
            L.error("focusWindow: " + e.toString());
            return false;
        }
    }

    listWindowsOnWorkspace(index) {
        return realWindows(this._wm().get_workspace_by_index(index));
    }

    // Fold one workspace's windows into another so a partition can grow/shrink
    // without scattering later projects. Skips all-workspace-pinned windows.
    moveAllWindows(from, to) {
        try {
            const windows = realWindows(this._wm().get_workspace_by_index(from));
            for (let i = 0; i < windows.length; i++) {
                windows[i].change_workspace_by_index(to, false);
            }
            return true;
        } catch (e) {
            L.error("moveAllWindows(" + from + "->" + to + "): " + e.toString());
            return false;
        }
    }

    listWindowsOnWorkspaces(indices) {
        const out = [];
        try {
            for (let k = 0; k < indices.length; k++) {
                const wins = realWindows(this._wm().get_workspace_by_index(indices[k]));
                for (let i = 0; i < wins.length; i++) out.push(wins[i]);
            }
        } catch (e) {
            L.error("listWindowsOnWorkspaces: " + e.toString());
        }
        return out;
    }

    // Graceful close (like clicking X; the app may prompt to save). Never force-kills.
    requestCloseWindow(win) {
        try {
            win.delete(this._now());
            return true;
        } catch (e) {
            L.error("requestCloseWindow: " + e.toString());
            return false;
        }
    }

    destroy() {}
};
