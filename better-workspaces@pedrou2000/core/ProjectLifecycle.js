/* core/ProjectLifecycle.js — grow/shrink strips; add/remove whole projects. */

const UUID = "better-workspaces@pedrou2000";
const AppletDir = imports.ui.appletManager.applets[UUID];
const Mapping = AppletDir.core.mapping.Mapping;
const Mainloop = imports.mainloop;
const CLOSE_GRACE_MS = AppletDir.lib.constants.Constants.CLOSE_GRACE_MS;

const L = AppletDir.lib.logger.Logger.makeLogger("lifecycle");

var ProjectLifecycle = class ProjectLifecycle {
    constructor(ctrl) {
        this._c = ctrl;
    }

    // Make the real flat workspace count equal the sum of all project strips.
    reconcileWorkspaceCount() {
        const c = this._c;
        const need = Mapping.totalWorkspaces(c.state.counts());
        const have = c.wm.getWorkspaceCount();
        while (c.wm.getWorkspaceCount() < need) c.wm.createWorkspace();
        while (c.wm.getWorkspaceCount() > need) c.wm.removeLastWorkspace();
        L.log(
            "reconcileWorkspaceCount: need " +
                need +
                ", had " +
                have +
                ", now " +
                c.wm.getWorkspaceCount(),
        );
    }

    // Grow the active strip by one without navigating. Cinnamon only appends at
    // the global end, so append then native-reorder the new empty workspace into
    // the partition's slot. Returns the new last local index, or -1 on failure.
    growActiveProjectStrip() {
        const c = this._c;
        const pIdx = c.state.activeProjectIdx;
        const counts = c.state.counts();
        const oldTotal = Mapping.totalWorkspaces(counts);
        const insertAt = Mapping.offsetOf(counts, pIdx) + counts[pIdx];

        if (c.wm.createWorkspace() < 0) return -1; // appended at oldTotal
        if (insertAt < oldTotal) {
            c.wm.reorderWorkspace(oldTotal, insertAt);
        }

        c.state.incWorkspaceCount(pIdx);
        this.reconcileWorkspaceCount();

        L.log(
            "growActiveProjectStrip: " +
                c.state.getProject(pIdx).name +
                " now " +
                c.state.getProject(pIdx).wsCount +
                " (inserted at flat " +
                insertAt +
                ")",
        );
        return c.state.getProject(pIdx).wsCount - 1;
    }

    addWorkspaceToActiveProject() {
        const newLocal = this.growActiveProjectStrip();
        if (newLocal < 0) return false;
        return this._c.goToLocalWorkspace(newLocal);
    }

    // Fold the last workspace's windows into the previous one (kept >=1 home),
    // then remove that exact flat index.
    removeLastWorkspaceOfActiveProject() {
        const c = this._c;
        const pIdx = c.state.activeProjectIdx;
        const p = c.state.getProject(pIdx);
        if (!p) return false;
        if (p.wsCount <= 1) {
            L.log(
                "removeLastWorkspaceOfActiveProject: " + p.name + " keeps its home workspace (>=1)",
            );
            return false;
        }
        const counts = c.state.counts();
        const removeAt = Mapping.offsetOf(counts, pIdx) + (p.wsCount - 1);

        c.wm.moveAllWindows(removeAt, removeAt - 1);
        c.wm.removeWorkspace(removeAt);

        c.state.decWorkspaceCount(pIdx);
        this.reconcileWorkspaceCount();

        const last = c.state.getProject(pIdx).wsCount - 1;
        const loc = c.currentLocation();
        if (!loc || loc.projectIdx !== pIdx || loc.localIdx > last) {
            c.goToLocalWorkspace(last);
        }
        L.log(
            "removeLastWorkspaceOfActiveProject: " +
                p.name +
                " now " +
                c.state.getProject(pIdx).wsCount +
                " (removed flat " +
                removeAt +
                ")",
        );
        return true;
    }

    // Remove every empty workspace of the active project except the focused one
    // (so the project keeps >=1). Removed high->low so lower flats stay valid.
    removeEmptyWorkspacesOfActiveProject() {
        const c = this._c;
        const pIdx = c.state.activeProjectIdx;
        const p = c.state.getProject(pIdx);
        if (!p) return 0;
        const activeFlat = c.wm.getActiveIndex();
        const base = Mapping.offsetOf(c.state.counts(), pIdx);

        const toRemove = [];
        for (let local = 0; local < p.wsCount; local++) {
            const flat = base + local;
            if (flat === activeFlat) continue;
            if (c.wm.countWindows(flat) > 0) continue;
            toRemove.push(flat);
        }

        toRemove.sort((a, b) => b - a);
        for (let i = 0; i < toRemove.length; i++) {
            c.wm.removeWorkspace(toRemove[i]);
            c.state.decWorkspaceCount(pIdx);
        }
        if (toRemove.length > 0) this.reconcileWorkspaceCount();
        L.log(
            "removeEmptyWorkspacesOfActiveProject: " +
                p.name +
                " removed " +
                toRemove.length +
                ", now " +
                c.state.getProject(pIdx).wsCount,
        );
        return toRemove.length;
    }

    // Idempotent by id: if the deck and store disagree (e.g. an offline toggle
    // appended the project but its Notion write later reverted), a retry must not
    // create a second partition for the same project.
    addProjectLive(def) {
        const c = this._c;
        const existing = c.state.indexOfProjectId(def.id);
        if (existing >= 0) {
            L.log(
                "addProjectLive: " +
                    def.name +
                    " already in deck (index " +
                    existing +
                    "), skipping append",
            );
            return existing;
        }
        const idx = c.state.appendProject(def);
        this.reconcileWorkspaceCount(); // new home lands at the global end (== Cinnamon append)
        L.log("addProjectLive: " + def.name + " (index " + idx + ")");
        return idx;
    }

    // Destructive: gracefully close the partition's windows, wait a grace period,
    // then remove the workspaces + project. If any window survives, abort and
    // reject with Error("windows-open") carrying .openTitles; the project stays.
    async removeProjectLive(projectIdx) {
        const c = this._c;
        const p = c.state.getProject(projectIdx);
        if (!p) throw new Error("invalid-project");

        const counts = c.state.counts();
        const offset = Mapping.offsetOf(counts, projectIdx);
        const indices = [];
        for (let i = 0; i < p.wsCount; i++) indices.push(offset + i);

        const windows = c.wm.listWindowsOnWorkspaces(indices);
        L.log(
            "removeProjectLive: " +
                p.name +
                " has " +
                windows.length +
                " windows across workspaces [" +
                indices.join(",") +
                "]",
        );
        for (let i = 0; i < windows.length; i++) c.wm.requestCloseWindow(windows[i]);

        await new Promise((resolve) => {
            Mainloop.timeout_add(CLOSE_GRACE_MS, () => {
                resolve();
                return false;
            });
        });

        const remaining = c.wm.listWindowsOnWorkspaces(indices);
        if (remaining.length > 0) {
            const titles = remaining.map((w) => {
                try {
                    return w.get_title();
                } catch (e) {
                    return "(window)";
                }
            });
            L.log("removeProjectLive: ABORT — " + remaining.length + " window(s) still open");
            const err = new Error("windows-open");
            err.openTitles = titles;
            throw err;
        }

        // Remove high->low so indices stay valid as Cinnamon reindexes.
        const curCounts = c.state.counts();
        const curOffset = Mapping.offsetOf(curCounts, projectIdx);
        for (let i = p.wsCount - 1; i >= 0; i--) {
            c.wm.removeWorkspace(curOffset + i);
        }
        const wasActive = c.state.activeProjectIdx === projectIdx;
        // mruPrev is an OLD index; removeProject shifts indices above projectIdx down.
        let mruPrev = c.state.previousProjectIdx();
        if (mruPrev > projectIdx) mruPrev -= 1;
        c.state.removeProject(projectIdx);
        this.reconcileWorkspaceCount();

        if (wasActive && c.state.projectCount() > 0) {
            let target = mruPrev;
            if (target < 0 || target >= c.state.projectCount()) target = 0;
            c.goToProject(target);
        }
        L.log("removeProjectLive: removed " + p.name);
    }
};
