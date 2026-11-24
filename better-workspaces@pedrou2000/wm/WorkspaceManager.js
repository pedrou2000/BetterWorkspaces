/* wm/WorkspaceManager.js — the only module that touches Muffin/workspace APIs. */

// Every method is bounds-checked and guarded: a bad call degrades to a no-op +
// log line rather than crashing the shell. When Cinnamon's API drifts, fix here.

const Main = imports.ui.main;

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
    constructor() {
        this._watched = null; // MetaWindow -> {ws, ids}, while window moves are watched
        this._onWindowMoved = null;
        this._createdId = 0;
        this._ownMove = false;
    }

    // Window moves the applet makes itself are not reported to the watcher.
    _asOwnMove(fn) {
        const was = this._ownMove;
        this._ownMove = true;
        try {
            return fn();
        } finally {
            this._ownMove = was;
        }
    }

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

    // Current index of a workspace OBJECT, or -1 once it no longer exists.
    indexOfWorkspace(ws) {
        try {
            const n = this.getWorkspaceCount();
            for (let i = 0; i < n; i++) {
                if (this._wm().get_workspace_by_index(i) === ws) return i;
            }
        } catch (e) {
            L.error("indexOfWorkspace: " + e.toString());
        }
        return -1;
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
            // Muffin relocates the workspace's windows to a neighbour.
            this._asOwnMove(() => this._wm().remove_workspace(ws, this._now()));
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
            this._asOwnMove(() => win.change_workspace_by_index(index, false));
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
            this._asOwnMove(() => {
                for (let i = 0; i < windows.length; i++) {
                    windows[i].change_workspace_by_index(to, false);
                }
            });
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

    // Calls onMoved(win, fromWorkspace, toWorkspace) — workspace OBJECTS — each
    // time something other than this applet moves a window to another workspace.
    watchWindowMoves(onMoved) {
        this.unwatchWindowMoves();
        this._watched = new Map();
        this._onWindowMoved = onMoved;
        try {
            const actors = global.get_window_actors();
            for (let i = 0; i < actors.length; i++) this._watch(actors[i].get_meta_window());
            this._createdId = global.display.connect("window-created", (display, win) =>
                this._watch(win),
            );
        } catch (e) {
            L.error("watchWindowMoves: " + e.toString());
        }
    }

    unwatchWindowMoves() {
        if (this._createdId) {
            global.display.disconnect(this._createdId);
            this._createdId = 0;
        }
        if (this._watched) {
            this._watched.forEach((entry, win) => this._disconnect(win, entry));
            this._watched = null;
        }
        this._onWindowMoved = null;
    }

    // A pinned window reports whichever workspace is active, so it has no home.
    _homeOf(win) {
        return win.is_on_all_workspaces() ? null : win.get_workspace();
    }

    _watch(win) {
        try {
            // Menus and tooltips: never on a workspace of their own.
            if (!win || !this._watched || this._watched.has(win)) return;
            if (win.is_override_redirect()) return;
            const entry = { ws: this._homeOf(win), ids: [] };
            entry.ids.push(win.connect("workspace-changed", () => this._workspaceChanged(win)));
            entry.ids.push(win.connect("unmanaged", () => this._unwatch(win)));
            this._watched.set(win, entry);
        } catch (e) {
            L.error("watch window: " + e.toString());
        }
    }

    _unwatch(win) {
        const entry = this._watched ? this._watched.get(win) : null;
        if (!entry) return;
        this._watched.delete(win);
        this._disconnect(win, entry);
    }

    _disconnect(win, entry) {
        for (let i = 0; i < entry.ids.length; i++) {
            try {
                win.disconnect(entry.ids[i]);
            } catch (e) {
                L.error("unwatch window: " + e.toString());
            }
        }
    }

    _workspaceChanged(win) {
        try {
            const entry = this._watched ? this._watched.get(win) : null;
            if (!entry) return;
            const from = entry.ws;
            // null once the window is closing (Muffin signals that as a change too).
            const to = this._homeOf(win);
            entry.ws = to;
            if (this._ownMove || !from || !to || from === to) return;
            if (this._onWindowMoved) this._onWindowMoved(win, from, to);
        } catch (e) {
            L.error("window moved: " + e.toString());
        }
    }

    // -1 for a closed window or one pinned to all workspaces.
    workspaceIndexOfWindow(win) {
        try {
            const ws = this._homeOf(win);
            return ws ? ws.index() : -1;
        } catch (e) {
            L.error("workspaceIndexOfWindow: " + e.toString());
            return -1;
        }
    }

    // False for dialogs and other windows that belong to another window.
    isTopLevelWindow(win) {
        try {
            return win.get_transient_for() === null;
        } catch (e) {
            L.error("isTopLevelWindow: " + e.toString());
            return false;
        }
    }

    // Whether a dialog of `win` (or a dialog of one of its dialogs) is on workspace `index`.
    hasDialogOnWorkspace(win, index) {
        try {
            const ws = this._wm().get_workspace_by_index(index);
            if (!ws) return false;
            let found = false;
            win.foreach_transient((dialog) => {
                if (this._homeOf(dialog) === ws) found = true;
                return !found; // false stops the walk
            });
            return found;
        } catch (e) {
            L.error("hasDialogOnWorkspace: " + e.toString());
            return false;
        }
    }

    // Muffin moves the window's dialogs along with it.
    moveWindowToWorkspace(win, index) {
        try {
            if (index < 0 || index > this.getWorkspaceCount() - 1) return false;
            this._asOwnMove(() => win.change_workspace_by_index(index, false));
            return true;
        } catch (e) {
            L.error("moveWindowToWorkspace(" + index + "): " + e.toString());
            return false;
        }
    }

    // Expo and the overview are where the user drags windows between workspaces.
    isOverviewOpen() {
        try {
            return !!((Main.expo && Main.expo.visible) || (Main.overview && Main.overview.visible));
        } catch (e) {
            L.error("isOverviewOpen: " + e.toString());
            return false;
        }
    }

    // Cinnamon's own setting: clicking a window elsewhere brings it here
    // instead of taking you there.
    bringsWindowsToCurrentWorkspace() {
        try {
            return global.settings.get_boolean("bring-windows-to-current-workspace");
        } catch (e) {
            L.error("bringsWindowsToCurrentWorkspace: " + e.toString());
            return false;
        }
    }

    destroy() {
        this.unwatchWindowMoves();
    }
};
