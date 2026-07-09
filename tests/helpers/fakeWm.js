/*
 * Test double for wm/WorkspaceManager: simulates Muffin's flat workspace list
 * in memory so Controller's model<->reality choreography can be tested without
 * Cinnamon. Mirrors the real class's API and semantics:
 *
 *   - workspaces are OBJECTS that survive reorders (identity matters for
 *     reorderWorkspaceObject, like real MetaWorkspaces)
 *   - each workspace holds a list of window objects ({title})
 *   - removeWorkspace refuses to drop the last one; out-of-range is a no-op
 *   - removing a workspace moves its windows nowhere (they vanish with it),
 *     matching Muffin's behavior of reparenting only on some paths — the
 *     Controller is responsible for moving windows FIRST, which is exactly
 *     what these tests need to catch.
 *
 * Also provides a fake `mainloop` whose timers are captured and flushed
 * manually, so removeProjectLive's grace period is deterministic.
 */
"use strict";

let _wsSeq = 0;

class FakeWorkspace {
    constructor() {
        this._id = ++_wsSeq;   // stable identity for debugging
        this.windows = [];      // [{title, sticky?}]
    }
}

class FakeWm {
    constructor(initialCount) {
        this.workspaces = [];
        for (let i = 0; i < (initialCount || 1); i++) {
            this.workspaces.push(new FakeWorkspace());
        }
        this.activeIndex = 0;
        this.focusedWindow = null; // {title}, assumed on the active workspace
    }

    // ---- test conveniences ---------------------------------------------------

    // Place a window (created here) on workspace `index`; returns it.
    // Windows expose get_title() like real MetaWindows.
    addWindow(index, title, sticky) {
        const w = {
            title: title,
            sticky: !!sticky,
            closeRequested: false,
            get_title() { return this.title; },
        };
        this.workspaces[index].windows.push(w);
        return w;
    }

    // The per-workspace window titles, for whole-layout assertions.
    layout() {
        return this.workspaces.map(ws => ws.windows.filter(w => !w.sticky).map(w => w.title));
    }

    _real(ws) {
        return ws ? ws.windows.filter(w => !w.sticky) : [];
    }

    _indexOfWindow(win) {
        return this.workspaces.findIndex(ws => ws.windows.indexOf(win) !== -1);
    }

    // ---- WorkspaceManager API --------------------------------------------------

    getWorkspaceCount() { return this.workspaces.length; }
    getActiveIndex() { return this.activeIndex; }
    countWindows(index) { return this._real(this.workspaces[index]).length; }

    goToWorkspace(index) {
        if (index < 0 || index >= this.workspaces.length) return false;
        this.activeIndex = index;
        return true;
    }

    createWorkspace() {
        this.workspaces.push(new FakeWorkspace());
        return this.workspaces.length - 1;
    }

    getWorkspace(index) { return this.workspaces[index] || null; }

    reorderWorkspaceObject(ws, toIndex) {
        const from = this.workspaces.indexOf(ws);
        if (from === -1 || toIndex < 0 || toIndex >= this.workspaces.length) return false;
        const active = this.workspaces[this.activeIndex];
        this.workspaces.splice(toIndex, 0, this.workspaces.splice(from, 1)[0]);
        this.activeIndex = this.workspaces.indexOf(active); // active ws keeps focus
        return true;
    }

    reorderWorkspace(fromIndex, toIndex) {
        if (fromIndex === toIndex) return true;
        if (fromIndex < 0 || fromIndex >= this.workspaces.length
            || toIndex < 0 || toIndex >= this.workspaces.length) return false;
        return this.reorderWorkspaceObject(this.workspaces[fromIndex], toIndex);
    }

    removeWorkspace(index) {
        if (this.workspaces.length <= 1) return false;
        if (index < 0 || index >= this.workspaces.length) return false;
        this.workspaces.splice(index, 1);
        if (this.activeIndex >= this.workspaces.length) {
            this.activeIndex = this.workspaces.length - 1;
        } else if (this.activeIndex > index) {
            this.activeIndex -= 1;
        }
        return true;
    }

    removeLastWorkspace() {
        return this.removeWorkspace(this.workspaces.length - 1);
    }

    moveFocusedWindowTo(index) {
        if (index < 0 || index >= this.workspaces.length) return false;
        if (!this.focusedWindow) return false;
        const from = this._indexOfWindow(this.focusedWindow);
        if (from !== -1) {
            const ws = this.workspaces[from];
            ws.windows.splice(ws.windows.indexOf(this.focusedWindow), 1);
        }
        this.workspaces[index].windows.push(this.focusedWindow);
        return true;
    }

    listWindowsOnWorkspace(index) { return this._real(this.workspaces[index]); }

    listWindowsOnWorkspaces(indices) {
        const out = [];
        for (const i of indices) {
            if (this.workspaces[i]) out.push(...this._real(this.workspaces[i]));
        }
        return out;
    }

    moveAllWindows(from, to) {
        const src = this.workspaces[from], dst = this.workspaces[to];
        if (!src || !dst) return false;
        const movable = this._real(src);
        src.windows = src.windows.filter(w => w.sticky);
        dst.windows.push(...movable);
        return true;
    }

    // Marks the window; the test decides whether it "closes" (removes it).
    requestCloseWindow(win) {
        win.closeRequested = true;
        return true;
    }

    // Test helper: actually close every window marked closeRequested.
    honorCloseRequests() {
        for (const ws of this.workspaces) {
            ws.windows = ws.windows.filter(w => !w.closeRequested);
        }
    }

    destroy() {}
}

// Deterministic mainloop: timers are queued, tests flush them explicitly.
function makeFakeMainloop() {
    let seq = 0;
    const pending = new Map(); // id -> fn
    return {
        timeout_add(ms, fn) { pending.set(++seq, fn); return seq; },
        timeout_add_seconds(s, fn) { pending.set(++seq, fn); return seq; },
        source_remove(id) { pending.delete(id); },
        // Run and clear all pending timers (repeating timers are not re-armed).
        flush() {
            const fns = [...pending.values()];
            pending.clear();
            for (const fn of fns) fn();
        },
        pendingCount() { return pending.size; },
    };
}

module.exports = { FakeWm, makeFakeMainloop };
