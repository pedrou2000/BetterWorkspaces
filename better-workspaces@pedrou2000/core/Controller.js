/*
 * BetterWorkspaces — core/Controller.js
 *
 * The brain's façade (Design Doc §3.C). Owns State and the WM wrapper, and is
 * the single object the applet/UI talk to. Since M12 Stage C the actual work
 * lives in three collaborators, each with one responsibility:
 *
 *   core/Navigation.js       — switching intents (projects, strips, move-window)
 *   core/DeckReorder.js      — reordering whole projects (workspace-block moves)
 *   core/ProjectLifecycle.js — partition mutation (grow/shrink strips,
 *                              add/remove projects, count reconciliation)
 *
 * The public API is unchanged; every method here is a one-line delegation, so
 * callers (applet.js, ui/*) and the test suite need no knowledge of the split.
 *
 * Released under the GNU General Public License v2 (see LICENSE).
 */

const UUID = "better-workspaces@pedrou2000";
const AppletDir = imports.ui.appletManager.applets[UUID];
const Mapping = AppletDir.core.mapping.Mapping;
const State = AppletDir.core.State.State;
const Navigation = AppletDir.core.Navigation.Navigation;
const DeckReorder = AppletDir.core.DeckReorder.DeckReorder;
const ProjectLifecycle = AppletDir.core.ProjectLifecycle.ProjectLifecycle;

var Controller = class Controller {

    constructor(wm) {
        this.wm = wm;                       // wm/WorkspaceManager instance
        this.state = new State();
        this.nav = new Navigation(this);
        this.reorder = new DeckReorder(this);
        this.lifecycle = new ProjectLifecycle(this);
    }

    // Seed the deck. Ensures the WM has exactly as many flat workspaces as the
    // model requires, then activates project 0 / local 0.
    loadProjects(defs) {
        this.state.setProjects(defs);
        this.lifecycle.reconcileWorkspaceCount();
        this.goToProject(0);
    }

    // Ask the WM for the true active flat index, reverse-map to (project,local).
    // This keeps us correct even if the user switched via some external means.
    currentLocation() {
        let flat = this.wm.getActiveIndex();
        return Mapping.locationOf(this.state.counts(), flat); // {projectIdx, localIdx} or null
    }

    // ---- Navigation ----------------------------------------------------------

    goToProject(idx) { return this.nav.goToProject(idx); }
    goToNextProjectInOrder() { return this.nav.goToNextProjectInOrder(); }
    goToPrevProjectInOrder() { return this.nav.goToPrevProjectInOrder(); }
    openActiveProjectHome() { return this.nav.openActiveProjectHome(); }
    goToLocalWorkspace(localIdx) { return this.nav.goToLocalWorkspace(localIdx); }
    nextLocalWorkspace() { return this.nav.nextLocalWorkspace(); }
    prevLocalWorkspace() { return this.nav.prevLocalWorkspace(); }
    moveWindowToLocalWorkspace(localIdx) { return this.nav.moveWindowToLocalWorkspace(localIdx); }
    moveWindowToNextLocal() { return this.nav.moveWindowToNextLocal(); }
    moveWindowToPrevLocal() { return this.nav.moveWindowToPrevLocal(); }
    moveWindowToProject(idx) { return this.nav.moveWindowToProject(idx); }
    moveWindowToNextProjectInOrder() { return this.nav.moveWindowToNextProjectInOrder(); }
    moveWindowToPrevProjectInOrder() { return this.nav.moveWindowToPrevProjectInOrder(); }

    // ---- Deck reorder --------------------------------------------------------

    reorderProject(from, to) { return this.reorder.reorderProject(from, to); }
    moveActiveProjectBy(delta) { return this.reorder.moveActiveProjectBy(delta); }
    onOrderChanged(cb) { this.reorder.onOrderChanged(cb); }

    // ---- Project / strip lifecycle --------------------------------------------

    addWorkspaceToActiveProject() { return this.lifecycle.addWorkspaceToActiveProject(); }
    removeLastWorkspaceOfActiveProject() { return this.lifecycle.removeLastWorkspaceOfActiveProject(); }
    removeEmptyWorkspacesOfActiveProject() { return this.lifecycle.removeEmptyWorkspacesOfActiveProject(); }
    addProjectLive(def) { return this.lifecycle.addProjectLive(def); }
    removeProjectLive(idx) { return this.lifecycle.removeProjectLive(idx); }

    // ---- Introspection for logging / future UI --------------------------------

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
        this.nav = null;
        this.reorder = null;
        this.lifecycle = null;
        this.state = null;
        this.wm = null;
    }
};
