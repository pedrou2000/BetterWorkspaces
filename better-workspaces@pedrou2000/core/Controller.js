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

function log(msg) { global.log(UUID + " [ctrl]: " + msg); }
function logError(msg) { global.logError(UUID + " [ctrl]: " + msg); }

function Controller(wm) {
    this._init(wm);
}

Controller.prototype = {

    _init: function (wm) {
        this.wm = wm;                       // wm/WorkspaceManager instance
        this.state = new StateModule.State();
    },

    // Seed the deck (M2: hardcoded). Ensures the WM has exactly as many flat
    // workspaces as the model requires, then activates project 0 / local 0.
    loadProjects: function (defs) {
        this.state.setProjects(defs);
        this._reconcileWorkspaceCount();
        this.goToProject(0);
    },

    // Make the real flat workspace count equal the sum of all project strips.
    _reconcileWorkspaceCount: function () {
        let need = Mapping.totalWorkspaces(this.state.counts());
        let have = this.wm.getWorkspaceCount();
        while (this.wm.getWorkspaceCount() < need) this.wm.createWorkspace();
        while (this.wm.getWorkspaceCount() > need) this.wm.removeLastWorkspace();
        log("_reconcileWorkspaceCount: need " + need + ", had " + have
            + ", now " + this.wm.getWorkspaceCount());
    },

    // ---- Deriving "where am I" --------------------------------------------

    // Ask the WM for the true active flat index, reverse-map to (project,local).
    // This keeps us correct even if the user switched via some external means.
    currentLocation: function () {
        let flat = this.wm.getActiveIndex();
        let loc = Mapping.locationOf(this.state.counts(), flat);
        return loc; // {projectIdx, localIdx} or null
    },

    // ---- Intents: switching projects --------------------------------------

    // Switch to a project, landing on the local workspace we last used there.
    goToProject: function (projectIdx) {
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
    },

    // Alt-Tab-style flip to the most-recent other project.
    goToPreviousProject: function () {
        return this.goToProject(this.state.previousProjectIdx());
    },

    // Cycle to the next/previous project in *project order* (not MRU) — useful
    // as a simple deterministic navigation for testing.
    goToNextProjectInOrder: function () {
        let n = this.state.projectCount();
        if (n === 0) return false;
        return this.goToProject((this.state.activeProjectIdx + 1) % n);
    },

    goToPrevProjectInOrder: function () {
        let n = this.state.projectCount();
        if (n === 0) return false;
        return this.goToProject((this.state.activeProjectIdx + n - 1) % n);
    },

    // ---- Intents: navigating within the active project ---------------------

    _syncLastLocalFromReality: function () {
        let loc = this.currentLocation();
        if (loc) this.state.setLastLocal(loc.projectIdx, loc.localIdx);
    },

    goToLocalWorkspace: function (localIdx) {
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
    },

    nextLocalWorkspace: function () {
        let loc = this.currentLocation();
        if (!loc) return false;
        return this.goToLocalWorkspace(loc.localIdx + 1);
    },

    prevLocalWorkspace: function () {
        let loc = this.currentLocation();
        if (!loc) return false;
        return this.goToLocalWorkspace(loc.localIdx - 1);
    },

    // ---- Intents: adding/removing a workspace to the active project --------

    // Add a workspace to the END of a project's strip. Because projects are
    // contiguous partitions, inserting in the middle of the flat list would
    // shift every later project; for M2 we append the flat workspace at the
    // project's boundary and grow the model. Simplest correct approach: append
    // at the global position = offset(project)+wsCount (i.e. right after this
    // project's current last workspace).
    addWorkspaceToActiveProject: function () {
        let pIdx = this.state.activeProjectIdx;
        let counts = this.state.counts();
        let insertAt = Mapping.offsetOf(counts, pIdx) + counts[pIdx];

        // Create a workspace at the end of the flat list, then (conceptually)
        // it belongs to this project. Since Cinnamon only appends at the very
        // end, we grow the model and rely on reconcile to keep counts aligned.
        // For contiguous correctness we simply grow THIS project and re-append
        // globally; middle-insertion reordering is deferred to a later milestone.
        this.state.incWorkspaceCount(pIdx);
        this._reconcileWorkspaceCount();
        // Land on the new local workspace.
        let newLocal = this.state.getProject(pIdx).wsCount - 1;
        log("addWorkspaceToActiveProject: " + this.state.getProject(pIdx).name
            + " now has " + this.state.getProject(pIdx).wsCount + " (insertAt~"
            + insertAt + ")");
        return this.goToLocalWorkspace(newLocal);
    },

    removeLastWorkspaceOfActiveProject: function () {
        let pIdx = this.state.activeProjectIdx;
        let p = this.state.getProject(pIdx);
        if (!p) return false;
        if (p.wsCount <= 1) {
            log("removeLastWorkspaceOfActiveProject: " + p.name
                + " keeps its home workspace (>=1)");
            return false;
        }
        this.state.decWorkspaceCount(pIdx);
        this._reconcileWorkspaceCount();
        // Move onto the (new) last local workspace if we were past it.
        let last = this.state.getProject(pIdx).wsCount - 1;
        let loc = this.currentLocation();
        if (!loc || loc.projectIdx !== pIdx || loc.localIdx > last) {
            this.goToLocalWorkspace(last);
        }
        log("removeLastWorkspaceOfActiveProject: " + p.name + " now "
            + this.state.getProject(pIdx).wsCount);
        return true;
    },

    // ---- Introspection for logging / future UI -----------------------------

    describe: function () {
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
    },

    destroy: function () {
        this.state = null;
        this.wm = null;
    },
};
