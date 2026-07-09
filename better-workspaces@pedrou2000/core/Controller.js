/*
 * BetterWorkspaces — core/Controller.js
 *
 * The brain (Design Doc §3.C). Owns State, uses mapping.js to translate the
 * deck-of-strips model onto the flat workspace list, and drives the WM wrapper.
 * Every user intent ("switch to project X", "next workspace within project",
 * "previous project") lands here and is turned into concrete WM calls.
 *
 * M2 scope: correctness of the model and its mapping, driven from a hardcoded
 * project list. No Notion, no UI yet.
 *
 * Released under the GNU General Public License v2 (see LICENSE).
 */

const UUID = "better-workspaces@pedrou2000";
const AppletDir = imports.ui.appletManager.applets[UUID];
const Mapping = AppletDir.core.mapping.Mapping;
const StateModule = AppletDir.core.State;
const Browser = AppletDir.lib.browser.Browser;
const Mainloop = imports.mainloop;
const CLOSE_GRACE_MS = AppletDir.lib.constants.Constants.CLOSE_GRACE_MS;

const _L = AppletDir.lib.logger.Logger.makeLogger("ctrl");
function log(msg) { _L.log(msg); }
function logError(msg) { _L.error(msg); }

var Controller = class Controller {

    constructor(wm) {
        this.wm = wm;                       // wm/WorkspaceManager instance
        this.state = new StateModule.State();
    }

    // Seed the deck (M2: hardcoded). Ensures the WM has exactly as many flat
    // workspaces as the model requires, then activates project 0 / local 0.
    loadProjects(defs) {
        this.state.setProjects(defs);
        this._reconcileWorkspaceCount();
        this.goToProject(0);
    }

    // Make the real flat workspace count equal the sum of all project strips.
    _reconcileWorkspaceCount() {
        let need = Mapping.totalWorkspaces(this.state.counts());
        let have = this.wm.getWorkspaceCount();
        while (this.wm.getWorkspaceCount() < need) this.wm.createWorkspace();
        while (this.wm.getWorkspaceCount() > need) this.wm.removeLastWorkspace();
        log("_reconcileWorkspaceCount: need " + need + ", had " + have
            + ", now " + this.wm.getWorkspaceCount());
    }

    // ---- Deriving "where am I" --------------------------------------------

    // Ask the WM for the true active flat index, reverse-map to (project,local).
    // This keeps us correct even if the user switched via some external means.
    currentLocation() {
        let flat = this.wm.getActiveIndex();
        let loc = Mapping.locationOf(this.state.counts(), flat);
        return loc; // {projectIdx, localIdx} or null
    }

    // ---- Intents: switching projects --------------------------------------

    // Switch to a project, landing on the local workspace we last used there.
    goToProject(projectIdx) {
        if (!this.state.setActiveProject(projectIdx)) {
            log("goToProject: invalid project " + projectIdx);
            return false;
        }
        let local = this.state.getLastLocal(projectIdx);
        let p = this.state.getProject(projectIdx);
        if (local > p.wsCount - 1) local = p.wsCount - 1; // clamp defensively
        let flat = Mapping.globalIndex(this.state.counts(), projectIdx, local);
        log("goToProject: project " + projectIdx + " (" + p.name
            + ") -> local " + local + " -> flat " + flat);
        return this.wm.goToWorkspace(flat);
    }

    // Reorder projects: move the project at `from` to index `to`. Each project
    // owns a contiguous block of workspaces; we move those blocks (with their
    // windows) into the new order using Muffin's native reorder_workspace — no
    // per-window snapshotting/relocation.
    //
    // Approach: capture the CURRENT flat layout as a list of workspace OBJECTS
    // grouped per project (objects survive the index shifts each reorder causes).
    // Apply the model move, compute the desired flat sequence of those objects,
    // then walk target positions left->right, reordering the right object into
    // each slot. Finally restore the active (project, local).
    reorderProject(from, to) {
        let n = this.state.projectCount();
        if (from < 0 || from >= n || to < 0 || to >= n || from === to) return false;

        let curLoc = this.currentLocation();

        // Capture each project's workspace OBJECTS in current flat order.
        let counts = this.state.counts();
        let blocks = []; // blocks[oldProjIdx] = [wsObj per local]
        for (let pi = 0; pi < n; pi++) {
            let base = Mapping.offsetOf(counts, pi);
            let objs = [];
            for (let l = 0; l < this.state.getProject(pi).wsCount; l++) {
                objs.push(this.wm.getWorkspace(base + l));
            }
            blocks.push(objs);
        }

        // Apply the model reorder; it returns order[newPos] = oldProjIdx, which
        // we reuse to place the workspace blocks (no recomputation here).
        let order = this.state.moveProject(from, to);
        if (!order) return false;

        // Desired flat sequence of workspace objects.
        let desired = [];
        for (let newPos = 0; newPos < n; newPos++) {
            let objs = blocks[order[newPos]];
            for (let l = 0; l < objs.length; l++) desired.push(objs[l]);
        }

        // Place each desired object at its target flat index, left->right. After
        // fixing position i, earlier positions are already correct and unaffected.
        for (let i = 0; i < desired.length; i++) {
            this.wm.reorderWorkspaceObject(desired[i], i);
        }

        // Return to the same (project, local), now at its new flat position.
        if (curLoc) {
            let newActivePos = order.indexOf(curLoc.projectIdx);
            let flat = Mapping.globalIndex(this.state.counts(), newActivePos, curLoc.localIdx);
            this.wm.goToWorkspace(flat);
        }

        // Persist the new order to Notion (ids in new order).
        let orderedIds = [];
        for (let i = 0; i < this.state.projectCount(); i++) {
            orderedIds.push(this.state.getProject(i).id);
        }
        if (this._onOrderChanged) this._onOrderChanged(orderedIds);

        log("reorderProject: " + from + " -> " + to + " done");
        return true;
    }

    // Register a callback(orderedIds[]) invoked after a reorder, so the applet
    // can persist the order to Notion.
    onOrderChanged(cb) { this._onOrderChanged = cb; },

    // Convenience: move a project one step left/right in the order.
    moveActiveProjectBy(delta) {
        let from = this.state.activeProjectIdx;
        let to = from + delta;
        if (to < 0 || to >= this.state.projectCount()) return false;
        return this.reorderProject(from, to);
    }

    // Open the active project's Notion page in a NEW browser window, so it
    // lands on the current (home) workspace instead of adding a tab to an
    // existing browser window on some other workspace. Manual by design.
    openActiveProjectHome() {
        let p = this.state.activeProject();
        if (!p || !p.notionUrl) {
            log("openActiveProjectHome: no Notion URL for active project");
            return false;
        }
        Browser.openUrlNewWindow(p.notionUrl);
        log("openActiveProjectHome: opened " + p.notionUrl + " in a new window");
        return true;
    }

    // The project index `delta` steps from the active one, wrapping. Returns -1
    // if there are no projects.
    _stepProjectIdx(delta) {
        let n = this.state.projectCount();
        if (n === 0) return -1;
        return (this.state.activeProjectIdx + delta + n) % n;
    }

    // Cycle to the next/previous project in list order (wrapping).
    goToNextProjectInOrder() {
        let idx = this._stepProjectIdx(1);
        return idx < 0 ? false : this.goToProject(idx);
    }

    goToPrevProjectInOrder() {
        let idx = this._stepProjectIdx(-1);
        return idx < 0 ? false : this.goToProject(idx);
    }

    // ---- Intents: navigating within the active project ---------------------

    goToLocalWorkspace(localIdx) {
        let pIdx = this.state.activeProjectIdx;
        let p = this.state.getProject(pIdx);
        if (!p || localIdx < 0 || localIdx > p.wsCount - 1) {
            log("goToLocalWorkspace: local " + localIdx + " out of range for "
                + (p ? p.name : "?"));
            return false;
        }
        let flat = Mapping.globalIndex(this.state.counts(), pIdx, localIdx);
        this.state.setLastLocal(pIdx, localIdx);
        return this.wm.goToWorkspace(flat);
    }

    nextLocalWorkspace() {
        let loc = this.currentLocation();
        if (!loc) return false;
        let p = this.state.getProject(loc.projectIdx);
        // At the project's last workspace: grow the strip and land on the new one.
        if (p && loc.localIdx >= p.wsCount - 1) {
            return this.addWorkspaceToActiveProject();
        }
        return this.goToLocalWorkspace(loc.localIdx + 1);
    }

    prevLocalWorkspace() {
        let loc = this.currentLocation();
        if (!loc) return false;
        return this.goToLocalWorkspace(loc.localIdx - 1);
    }

    // ---- Intents: moving the focused window --------------------------------

    // Move the focused window to a local workspace within the CURRENT project,
    // then follow it there. Bounds-checked against the active project's strip.
    moveWindowToLocalWorkspace(localIdx) {
        let pIdx = this.state.activeProjectIdx;
        let p = this.state.getProject(pIdx);
        if (!p || localIdx < 0 || localIdx > p.wsCount - 1) {
            log("moveWindowToLocalWorkspace: local " + localIdx + " out of range");
            return false;
        }
        let flat = Mapping.globalIndex(this.state.counts(), pIdx, localIdx);
        if (this.wm.moveFocusedWindowTo(flat)) {
            this.state.setLastLocal(pIdx, localIdx);
            this.wm.goToWorkspace(flat);
            return true;
        }
        return false;
    }

    moveWindowToNextLocal() {
        let loc = this.currentLocation();
        if (!loc) return false;
        let p = this.state.getProject(loc.projectIdx);
        // At the project's last workspace: create a new one, then move the
        // focused window there (and follow it).
        if (p && loc.localIdx >= p.wsCount - 1) {
            let pIdx = this.state.activeProjectIdx;
            this._growActiveProjectStrip();
            return this.moveWindowToLocalWorkspace(this.state.getProject(pIdx).wsCount - 1);
        }
        return this.moveWindowToLocalWorkspace(loc.localIdx + 1);
    }

    moveWindowToPrevLocal() {
        let loc = this.currentLocation();
        if (!loc) return false;
        return this.moveWindowToLocalWorkspace(loc.localIdx - 1);
    }

    // Move the focused window to another PROJECT (landing on that project's
    // last-used local workspace), and switch there with it.
    moveWindowToProject(projectIdx) {
        let p = this.state.getProject(projectIdx);
        if (!p) {
            log("moveWindowToProject: invalid project " + projectIdx);
            return false;
        }
        let local = this.state.getLastLocal(projectIdx);
        if (local > p.wsCount - 1) local = p.wsCount - 1;
        let flat = Mapping.globalIndex(this.state.counts(), projectIdx, local);
        if (this.wm.moveFocusedWindowTo(flat)) {
            this.state.setActiveProject(projectIdx);
            this.state.setLastLocal(projectIdx, local);
            this.wm.goToWorkspace(flat);
            log("moveWindowToProject: moved window to " + p.name + " local " + local);
            return true;
        }
        return false;
    }

    // Move the focused window to the next/previous project in list order
    // (wrapping), following it there.
    moveWindowToNextProjectInOrder() {
        let idx = this._stepProjectIdx(1);
        return idx < 0 ? false : this.moveWindowToProject(idx);
    }

    moveWindowToPrevProjectInOrder() {
        let idx = this._stepProjectIdx(-1);
        return idx < 0 ? false : this.moveWindowToProject(idx);
    }

    // ---- Intents: adding/removing a workspace to the active project --------

    // Grow the active project's strip by one workspace WITHOUT navigating.
    // Projects are contiguous partitions, so the new workspace must land at flat
    // index insertAt = offset(P)+count(P). Cinnamon only appends at the very
    // end, so we append there, then use the native reorder to slide the new
    // (empty) workspace into insertAt — no per-window shuffling. Returns the new
    // last local index, or -1 on failure.
    _growActiveProjectStrip() {
        let pIdx = this.state.activeProjectIdx;
        let counts = this.state.counts();
        let oldTotal = Mapping.totalWorkspaces(counts);
        let insertAt = Mapping.offsetOf(counts, pIdx) + counts[pIdx];

        if (this.wm.createWorkspace() < 0) return -1;   // appended at oldTotal
        if (insertAt < oldTotal) {
            this.wm.reorderWorkspace(oldTotal, insertAt); // slide into place
        }

        this.state.incWorkspaceCount(pIdx);
        this._reconcileWorkspaceCount();

        log("_growActiveProjectStrip: " + this.state.getProject(pIdx).name
            + " now " + this.state.getProject(pIdx).wsCount
            + " (inserted at flat " + insertAt + ")");
        return this.state.getProject(pIdx).wsCount - 1;
    }

    addWorkspaceToActiveProject() {
        let newLocal = this._growActiveProjectStrip();
        if (newLocal < 0) return false;
        return this.goToLocalWorkspace(newLocal);
    }

    // Remove the last workspace of a project's strip. Move its windows into the
    // previous workspace (same project — safe, since we keep >=1 home), then
    // remove that specific flat index. Cinnamon reindexes; other partitions
    // stay intact.
    removeLastWorkspaceOfActiveProject() {
        let pIdx = this.state.activeProjectIdx;
        let p = this.state.getProject(pIdx);
        if (!p) return false;
        if (p.wsCount <= 1) {
            log("removeLastWorkspaceOfActiveProject: " + p.name
                + " keeps its home workspace (>=1)");
            return false;
        }
        let counts = this.state.counts();
        let removeAt = Mapping.offsetOf(counts, pIdx) + (p.wsCount - 1);

        // Preserve windows: fold them into the previous workspace of the strip.
        this.wm.moveAllWindows(removeAt, removeAt - 1);
        // Remove that exact workspace (not just the global last).
        this.wm.removeWorkspace(removeAt);

        this.state.decWorkspaceCount(pIdx);
        this._reconcileWorkspaceCount();

        // Ensure we're sitting on a valid local workspace of this project.
        let last = this.state.getProject(pIdx).wsCount - 1;
        let loc = this.currentLocation();
        if (!loc || loc.projectIdx !== pIdx || loc.localIdx > last) {
            this.goToLocalWorkspace(last);
        }
        log("removeLastWorkspaceOfActiveProject: " + p.name + " now "
            + this.state.getProject(pIdx).wsCount + " (removed flat " + removeAt + ")");
        return true;
    }

    // On-demand: remove ALL empty workspaces of the active project (including
    // the home workspace and middle ones), keeping only the one currently
    // focused. The active workspace is always kept, so the project retains >= 1.
    // We gather target flats first, then remove them high -> low so the
    // remaining indices stay valid as Cinnamon reindexes. Returns count removed.
    removeEmptyWorkspacesOfActiveProject() {
        let pIdx = this.state.activeProjectIdx;
        let p = this.state.getProject(pIdx);
        if (!p) return 0;
        let activeFlat = this.wm.getActiveIndex();
        let base = Mapping.offsetOf(this.state.counts(), pIdx);

        // Collect flats to remove: every workspace in the partition that is not
        // the active one and is empty (home included).
        let toRemove = [];
        for (let local = 0; local < p.wsCount; local++) {
            let flat = base + local;
            if (flat === activeFlat) continue;
            if (this.wm.countWindows(flat) > 0) continue;
            toRemove.push(flat);
        }

        // Remove high -> low so earlier (smaller) flats remain valid.
        toRemove.sort(function (a, b) { return b - a; });
        for (let i = 0; i < toRemove.length; i++) {
            this.wm.removeWorkspace(toRemove[i]);
            this.state.decWorkspaceCount(pIdx);
        }
        if (toRemove.length > 0) this._reconcileWorkspaceCount();
        log("removeEmptyWorkspacesOfActiveProject: " + p.name + " removed "
            + toRemove.length + ", now " + this.state.getProject(pIdx).wsCount);
        return toRemove.length;
    }

    // ---- M9: live add / remove of whole projects ---------------------------

    // Add a project to the live deck: append its partition at the end of the
    // flat list (safe — no window shifting), grow the model. Stays put; open the
    // project's Notion page manually with the keybinding when you want it.
    addProjectLive(def) {
        let idx = this.state.appendProject(def);
        // The new project's single home workspace goes at the global end, which
        // is exactly where Cinnamon appends — so a plain reconcile is correct.
        this._reconcileWorkspaceCount();
        log("addProjectLive: " + def.name + " (index " + idx + ")");
        return idx;
    }

    // Remove a project from the live deck (destructive). Requests a graceful
    // close of every window in the project's partition, waits, then:
    //   - if any window survives -> ABORT (cb receives the surviving windows'
    //     titles); the project stays.
    //   - else -> remove the partition's workspaces and the project from the
    //     model, landing on the MRU-previous project if we removed the active one.
    // cb(err, info): err null on success; err "windows-open" with
    // info.openTitles when aborted.
    removeProjectLive(projectIdx, cb) {
        let p = this.state.getProject(projectIdx);
        if (!p) { cb && cb("invalid-project"); return; }

        let counts = this.state.counts();
        let offset = Mapping.offsetOf(counts, projectIdx);
        let indices = [];
        for (let i = 0; i < p.wsCount; i++) indices.push(offset + i);

        // 1) Request graceful close of all windows in this partition.
        let windows = this.wm.listWindowsOnWorkspaces(indices);
        log("removeProjectLive: " + p.name + " has " + windows.length
            + " windows across workspaces [" + indices.join(",") + "]");
        for (let i = 0; i < windows.length; i++) this.wm.requestCloseWindow(windows[i]);

        // 2) After a grace period, recheck.
        Mainloop.timeout_add(CLOSE_GRACE_MS, () => {
            let remaining = this.wm.listWindowsOnWorkspaces(indices);
            if (remaining.length > 0) {
                let titles = remaining.map(function (w) {
                    try { return w.get_title(); } catch (e) { return "(window)"; }
                });
                log("removeProjectLive: ABORT — " + remaining.length + " window(s) still open");
                cb && cb("windows-open", { openTitles: titles });
                return false;
            }

            // 3) All closed — remove the partition's workspaces high->low so
            //    indices stay valid, then remove the project from the model.
            let curCounts = this.state.counts();
            let curOffset = Mapping.offsetOf(curCounts, projectIdx);
            for (let i = p.wsCount - 1; i >= 0; i--) {
                this.wm.removeWorkspace(curOffset + i);
            }
            let wasActive = (this.state.activeProjectIdx === projectIdx);
            // MRU-previous is captured as an OLD index; removeProject() shifts
            // every index above projectIdx down by one, so adjust to match.
            let mruPrev = this.state.previousProjectIdx();
            if (mruPrev > projectIdx) mruPrev -= 1;
            this.state.removeProject(projectIdx);
            this._reconcileWorkspaceCount();

            // 4) If we removed the active project, land on the MRU-previous one
            //    (clamped to a valid index after the reindex).
            if (wasActive && this.state.projectCount() > 0) {
                let target = mruPrev;
                if (target < 0 || target >= this.state.projectCount()) target = 0;
                this.goToProject(target);
            }
            log("removeProjectLive: removed " + p.name);
            cb && cb(null);
            return false;
        });
    }

    // ---- Introspection for logging / future UI -----------------------------

    describe() {
        let loc = this.currentLocation();
        let p = this.state.activeProject();
        let where = loc
            ? (this.state.getProject(loc.projectIdx).name + " / local " + loc.localIdx)
            : "(unknown)";
        return "active project=" + (p ? p.name : "?")
            + " | reality=" + where
            + " | flat=" + this.wm.getActiveIndex() + "/" + this.wm.getWorkspaceCount()
            + " | counts=[" + this.state.counts().join(",") + "]"
            + " | mru=[" + this.state.mruOrder().join(",") + "]";
    }

    destroy() {
        this.state = null;
        this.wm = null;
    }
};
