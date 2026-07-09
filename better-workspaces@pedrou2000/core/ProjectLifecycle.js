/*
 * BetterWorkspaces — core/ProjectLifecycle.js
 *
 * Partition mutation (Design Doc §3.C, split out of Controller in M12 Stage C):
 * growing/shrinking a project's workspace strip, and adding/removing whole
 * projects from the live deck (including the graceful-close flow).
 *
 * Collaborator of core/Controller.js (the façade).
 *
 * Released under the GNU General Public License v2 (see LICENSE).
 */

const UUID = "better-workspaces@pedrou2000";
const AppletDir = imports.ui.appletManager.applets[UUID];
const Mapping = AppletDir.core.mapping.Mapping;
const Mainloop = imports.mainloop;
const CLOSE_GRACE_MS = AppletDir.lib.constants.Constants.CLOSE_GRACE_MS;

const L = AppletDir.lib.logger.Logger.makeLogger("lifecycle");

var ProjectLifecycle = class ProjectLifecycle {

    constructor(ctrl) {
        this._c = ctrl; // the Controller façade (state, wm, navigation)
    }

    // Make the real flat workspace count equal the sum of all project strips.
    reconcileWorkspaceCount() {
        let c = this._c;
        let need = Mapping.totalWorkspaces(c.state.counts());
        let have = c.wm.getWorkspaceCount();
        while (c.wm.getWorkspaceCount() < need) c.wm.createWorkspace();
        while (c.wm.getWorkspaceCount() > need) c.wm.removeLastWorkspace();
        L.log("reconcileWorkspaceCount: need " + need + ", had " + have
            + ", now " + c.wm.getWorkspaceCount());
    }

    // ---- Growing / shrinking the active project's strip ----------------------

    // Grow the active project's strip by one workspace WITHOUT navigating.
    // Projects are contiguous partitions, so the new workspace must land at flat
    // index insertAt = offset(P)+count(P). Cinnamon only appends at the very
    // end, so we append there, then use the native reorder to slide the new
    // (empty) workspace into insertAt — no per-window shuffling. Returns the new
    // last local index, or -1 on failure.
    growActiveProjectStrip() {
        let c = this._c;
        let pIdx = c.state.activeProjectIdx;
        let counts = c.state.counts();
        let oldTotal = Mapping.totalWorkspaces(counts);
        let insertAt = Mapping.offsetOf(counts, pIdx) + counts[pIdx];

        if (c.wm.createWorkspace() < 0) return -1;   // appended at oldTotal
        if (insertAt < oldTotal) {
            c.wm.reorderWorkspace(oldTotal, insertAt); // slide into place
        }

        c.state.incWorkspaceCount(pIdx);
        this.reconcileWorkspaceCount();

        L.log("growActiveProjectStrip: " + c.state.getProject(pIdx).name
            + " now " + c.state.getProject(pIdx).wsCount
            + " (inserted at flat " + insertAt + ")");
        return c.state.getProject(pIdx).wsCount - 1;
    }

    addWorkspaceToActiveProject() {
        let newLocal = this.growActiveProjectStrip();
        if (newLocal < 0) return false;
        return this._c.goToLocalWorkspace(newLocal);
    }

    // Remove the last workspace of a project's strip. Move its windows into the
    // previous workspace (same project — safe, since we keep >=1 home), then
    // remove that specific flat index. Cinnamon reindexes; other partitions
    // stay intact.
    removeLastWorkspaceOfActiveProject() {
        let c = this._c;
        let pIdx = c.state.activeProjectIdx;
        let p = c.state.getProject(pIdx);
        if (!p) return false;
        if (p.wsCount <= 1) {
            L.log("removeLastWorkspaceOfActiveProject: " + p.name
                + " keeps its home workspace (>=1)");
            return false;
        }
        let counts = c.state.counts();
        let removeAt = Mapping.offsetOf(counts, pIdx) + (p.wsCount - 1);

        // Preserve windows: fold them into the previous workspace of the strip.
        c.wm.moveAllWindows(removeAt, removeAt - 1);
        // Remove that exact workspace (not just the global last).
        c.wm.removeWorkspace(removeAt);

        c.state.decWorkspaceCount(pIdx);
        this.reconcileWorkspaceCount();

        // Ensure we're sitting on a valid local workspace of this project.
        let last = c.state.getProject(pIdx).wsCount - 1;
        let loc = c.currentLocation();
        if (!loc || loc.projectIdx !== pIdx || loc.localIdx > last) {
            c.goToLocalWorkspace(last);
        }
        L.log("removeLastWorkspaceOfActiveProject: " + p.name + " now "
            + c.state.getProject(pIdx).wsCount + " (removed flat " + removeAt + ")");
        return true;
    }

    // On-demand: remove ALL empty workspaces of the active project (including
    // the home workspace and middle ones), keeping only the one currently
    // focused. The active workspace is always kept, so the project retains >= 1.
    // We gather target flats first, then remove them high -> low so the
    // remaining indices stay valid as Cinnamon reindexes. Returns count removed.
    removeEmptyWorkspacesOfActiveProject() {
        let c = this._c;
        let pIdx = c.state.activeProjectIdx;
        let p = c.state.getProject(pIdx);
        if (!p) return 0;
        let activeFlat = c.wm.getActiveIndex();
        let base = Mapping.offsetOf(c.state.counts(), pIdx);

        // Collect flats to remove: every workspace in the partition that is not
        // the active one and is empty (home included).
        let toRemove = [];
        for (let local = 0; local < p.wsCount; local++) {
            let flat = base + local;
            if (flat === activeFlat) continue;
            if (c.wm.countWindows(flat) > 0) continue;
            toRemove.push(flat);
        }

        // Remove high -> low so earlier (smaller) flats remain valid.
        toRemove.sort((a, b) => b - a);
        for (let i = 0; i < toRemove.length; i++) {
            c.wm.removeWorkspace(toRemove[i]);
            c.state.decWorkspaceCount(pIdx);
        }
        if (toRemove.length > 0) this.reconcileWorkspaceCount();
        L.log("removeEmptyWorkspacesOfActiveProject: " + p.name + " removed "
            + toRemove.length + ", now " + c.state.getProject(pIdx).wsCount);
        return toRemove.length;
    }

    // ---- M9: live add / remove of whole projects -----------------------------

    // Add a project to the live deck: append its partition at the end of the
    // flat list (safe — no window shifting), grow the model. Stays put; open the
    // project's Notion page manually with the keybinding when you want it.
    addProjectLive(def) {
        let c = this._c;
        let idx = c.state.appendProject(def);
        // The new project's single home workspace goes at the global end, which
        // is exactly where Cinnamon appends — so a plain reconcile is correct.
        this.reconcileWorkspaceCount();
        L.log("addProjectLive: " + def.name + " (index " + idx + ")");
        return idx;
    }

    // Remove a project from the live deck (destructive). Requests a graceful
    // close of every window in the project's partition, waits, then:
    //   - if any window survives -> ABORT: rejects with Error("windows-open")
    //     carrying .openTitles (the surviving windows' titles); the project stays.
    //   - else -> remove the partition's workspaces and the project from the
    //     model, landing on the MRU-previous project if we removed the active one.
    async removeProjectLive(projectIdx) {
        let c = this._c;
        let p = c.state.getProject(projectIdx);
        if (!p) throw new Error("invalid-project");

        let counts = c.state.counts();
        let offset = Mapping.offsetOf(counts, projectIdx);
        let indices = [];
        for (let i = 0; i < p.wsCount; i++) indices.push(offset + i);

        // 1) Request graceful close of all windows in this partition.
        let windows = c.wm.listWindowsOnWorkspaces(indices);
        L.log("removeProjectLive: " + p.name + " has " + windows.length
            + " windows across workspaces [" + indices.join(",") + "]");
        for (let i = 0; i < windows.length; i++) c.wm.requestCloseWindow(windows[i]);

        // 2) After a grace period, recheck.
        await new Promise((resolve) => {
            Mainloop.timeout_add(CLOSE_GRACE_MS, () => { resolve(); return false; });
        });

        let remaining = c.wm.listWindowsOnWorkspaces(indices);
        if (remaining.length > 0) {
            let titles = remaining.map((w) => {
                try { return w.get_title(); } catch (e) { return "(window)"; }
            });
            L.log("removeProjectLive: ABORT — " + remaining.length + " window(s) still open");
            let err = new Error("windows-open");
            err.openTitles = titles;
            throw err;
        }

        // 3) All closed — remove the partition's workspaces high->low so
        //    indices stay valid, then remove the project from the model.
        let curCounts = c.state.counts();
        let curOffset = Mapping.offsetOf(curCounts, projectIdx);
        for (let i = p.wsCount - 1; i >= 0; i--) {
            c.wm.removeWorkspace(curOffset + i);
        }
        let wasActive = (c.state.activeProjectIdx === projectIdx);
        // MRU-previous is captured as an OLD index; removeProject() shifts
        // every index above projectIdx down by one, so adjust to match.
        let mruPrev = c.state.previousProjectIdx();
        if (mruPrev > projectIdx) mruPrev -= 1;
        c.state.removeProject(projectIdx);
        this.reconcileWorkspaceCount();

        // 4) If we removed the active project, land on the MRU-previous one
        //    (clamped to a valid index after the reindex).
        if (wasActive && c.state.projectCount() > 0) {
            let target = mruPrev;
            if (target < 0 || target >= c.state.projectCount()) target = 0;
            c.goToProject(target);
        }
        L.log("removeProjectLive: removed " + p.name);
    }
};
