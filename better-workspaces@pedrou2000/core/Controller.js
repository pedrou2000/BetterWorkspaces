/* core/Controller.js — façade over State + wm; delegates to the collaborators. */

const UUID = "better-workspaces@pedrou2000";
const AppletDir = imports.ui.appletManager.applets[UUID];
const Mapping = AppletDir.core.mapping.Mapping;
const State = AppletDir.core.State.State;
const Navigation = AppletDir.core.Navigation.Navigation;
const DeckReorder = AppletDir.core.DeckReorder.DeckReorder;
const ProjectLifecycle = AppletDir.core.ProjectLifecycle.ProjectLifecycle;

var Controller = class Controller {

    constructor(wm) {
        this.wm = wm;
        this.state = new State();
        this.nav = new Navigation(this);
        this.reorder = new DeckReorder(this);
        this.lifecycle = new ProjectLifecycle(this);
    }

    loadProjects(defs) {
        this.state.setProjects(defs);
        this.lifecycle.reconcileWorkspaceCount();
        this.goToProject(0);
    }

    // Reverse-mapped from the WM's real active index, so it stays correct even
    // after external navigation.
    currentLocation() {
        let flat = this.wm.getActiveIndex();
        return Mapping.locationOf(this.state.counts(), flat); // {projectIdx, localIdx} | null
    }

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

    reorderProject(from, to) { return this.reorder.reorderProject(from, to); }
    moveActiveProjectBy(delta) { return this.reorder.moveActiveProjectBy(delta); }
    onOrderChanged(cb) { this.reorder.onOrderChanged(cb); }

    addWorkspaceToActiveProject() { return this.lifecycle.addWorkspaceToActiveProject(); }
    removeLastWorkspaceOfActiveProject() { return this.lifecycle.removeLastWorkspaceOfActiveProject(); }
    removeEmptyWorkspacesOfActiveProject() { return this.lifecycle.removeEmptyWorkspacesOfActiveProject(); }
    addProjectLive(def) { return this.lifecycle.addProjectLive(def); }
    removeProjectLive(idx) { return this.lifecycle.removeProjectLive(idx); }

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
