/* core/Navigation.js — switching intents: projects, within-strip, move-window. */

const UUID = "better-workspaces@pedrou2000";
const AppletDir = imports.ui.appletManager.applets[UUID];
const Mapping = AppletDir.core.mapping.Mapping;
const Browser = AppletDir.lib.browser.Browser;

const L = AppletDir.lib.logger.Logger.makeLogger("nav");

var Navigation = class Navigation {

    constructor(ctrl) {
        this._c = ctrl;
    }

    goToProject(projectIdx) {
        let c = this._c;
        if (!c.state.setActiveProject(projectIdx)) {
            L.log("goToProject: invalid project " + projectIdx);
            return false;
        }
        let local = c.state.getLastLocal(projectIdx);
        let p = c.state.getProject(projectIdx);
        if (local > p.wsCount - 1) local = p.wsCount - 1; // clamp defensively
        let flat = Mapping.globalIndex(c.state.counts(), projectIdx, local);
        L.log("goToProject: project " + projectIdx + " (" + p.name
            + ") -> local " + local + " -> flat " + flat);
        return c.wm.goToWorkspace(flat);
    }

    // Active project +delta, wrapping; -1 if there are no projects.
    _stepProjectIdx(delta) {
        let c = this._c;
        let n = c.state.projectCount();
        if (n === 0) return -1;
        return (c.state.activeProjectIdx + delta + n) % n;
    }

    goToNextProjectInOrder() {
        let idx = this._stepProjectIdx(1);
        return idx < 0 ? false : this.goToProject(idx);
    }

    goToPrevProjectInOrder() {
        let idx = this._stepProjectIdx(-1);
        return idx < 0 ? false : this.goToProject(idx);
    }

    // New window so it lands on the current workspace, not as a tab in a browser
    // window living on some other workspace.
    openActiveProjectHome() {
        let p = this._c.state.activeProject();
        if (!p || !p.notionUrl) {
            L.log("openActiveProjectHome: no Notion URL for active project");
            return false;
        }
        Browser.openUrlNewWindow(p.notionUrl);
        L.log("openActiveProjectHome: opened " + p.notionUrl + " in a new window");
        return true;
    }

    goToLocalWorkspace(localIdx) {
        let c = this._c;
        let pIdx = c.state.activeProjectIdx;
        let p = c.state.getProject(pIdx);
        if (!p || localIdx < 0 || localIdx > p.wsCount - 1) {
            L.log("goToLocalWorkspace: local " + localIdx + " out of range for "
                + (p ? p.name : "?"));
            return false;
        }
        let flat = Mapping.globalIndex(c.state.counts(), pIdx, localIdx);
        c.state.setLastLocal(pIdx, localIdx);
        return c.wm.goToWorkspace(flat);
    }

    // Past the strip end grows it and lands on the new workspace.
    nextLocalWorkspace() {
        let c = this._c;
        let loc = c.currentLocation();
        if (!loc) return false;
        let p = c.state.getProject(loc.projectIdx);
        if (p && loc.localIdx >= p.wsCount - 1) {
            return c.addWorkspaceToActiveProject();
        }
        return this.goToLocalWorkspace(loc.localIdx + 1);
    }

    prevLocalWorkspace() {
        let loc = this._c.currentLocation();
        if (!loc) return false;
        return this.goToLocalWorkspace(loc.localIdx - 1);
    }

    // Move the focused window within the current project, then follow it.
    moveWindowToLocalWorkspace(localIdx) {
        let c = this._c;
        let pIdx = c.state.activeProjectIdx;
        let p = c.state.getProject(pIdx);
        if (!p || localIdx < 0 || localIdx > p.wsCount - 1) {
            L.log("moveWindowToLocalWorkspace: local " + localIdx + " out of range");
            return false;
        }
        let flat = Mapping.globalIndex(c.state.counts(), pIdx, localIdx);
        if (c.wm.moveFocusedWindowTo(flat)) {
            c.state.setLastLocal(pIdx, localIdx);
            c.wm.goToWorkspace(flat);
            return true;
        }
        return false;
    }

    // Past the strip end grows it first, then moves the window there.
    moveWindowToNextLocal() {
        let c = this._c;
        let loc = c.currentLocation();
        if (!loc) return false;
        let p = c.state.getProject(loc.projectIdx);
        if (p && loc.localIdx >= p.wsCount - 1) {
            let pIdx = c.state.activeProjectIdx;
            c.lifecycle.growActiveProjectStrip();
            return this.moveWindowToLocalWorkspace(c.state.getProject(pIdx).wsCount - 1);
        }
        return this.moveWindowToLocalWorkspace(loc.localIdx + 1);
    }

    moveWindowToPrevLocal() {
        let loc = this._c.currentLocation();
        if (!loc) return false;
        return this.moveWindowToLocalWorkspace(loc.localIdx - 1);
    }

    // Move the focused window to another project (its last-used local) and follow.
    moveWindowToProject(projectIdx) {
        let c = this._c;
        let p = c.state.getProject(projectIdx);
        if (!p) {
            L.log("moveWindowToProject: invalid project " + projectIdx);
            return false;
        }
        let local = c.state.getLastLocal(projectIdx);
        if (local > p.wsCount - 1) local = p.wsCount - 1;
        let flat = Mapping.globalIndex(c.state.counts(), projectIdx, local);
        if (c.wm.moveFocusedWindowTo(flat)) {
            c.state.setActiveProject(projectIdx);
            c.state.setLastLocal(projectIdx, local);
            c.wm.goToWorkspace(flat);
            L.log("moveWindowToProject: moved window to " + p.name + " local " + local);
            return true;
        }
        return false;
    }

    moveWindowToNextProjectInOrder() {
        let idx = this._stepProjectIdx(1);
        return idx < 0 ? false : this.moveWindowToProject(idx);
    }

    moveWindowToPrevProjectInOrder() {
        let idx = this._stepProjectIdx(-1);
        return idx < 0 ? false : this.moveWindowToProject(idx);
    }
};
