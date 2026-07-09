/*
 * BetterWorkspaces — core/Navigation.js
 *
 * Switching intents (Design Doc §3.C, split out of Controller in M12 Stage C):
 * everything that answers "take me / my window somewhere" — project switching,
 * within-strip movement, and the move-window variants. Pure choreography over
 * ctrl.state + ctrl.wm; owns no state of its own.
 *
 * Collaborator of core/Controller.js (the façade): reached via ctrl.*, and
 * calls back through the façade for cross-cutting intents (e.g. growing the
 * strip when navigating past its end, which ProjectLifecycle owns).
 *
 * Released under the GNU General Public License v2 (see LICENSE).
 */

const UUID = "better-workspaces@pedrou2000";
const AppletDir = imports.ui.appletManager.applets[UUID];
const Mapping = AppletDir.core.mapping.Mapping;
const Browser = AppletDir.lib.browser.Browser;

const L = AppletDir.lib.logger.Logger.makeLogger("nav");

var Navigation = class Navigation {

    constructor(ctrl) {
        this._c = ctrl; // the Controller façade (state, wm, cross-cutting intents)
    }

    // ---- Switching projects -------------------------------------------------

    // Switch to a project, landing on the local workspace we last used there.
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

    // The project index `delta` steps from the active one, wrapping. Returns -1
    // if there are no projects.
    _stepProjectIdx(delta) {
        let c = this._c;
        let n = c.state.projectCount();
        if (n === 0) return -1;
        return (c.state.activeProjectIdx + delta + n) % n;
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

    // Open the active project's Notion page in a NEW browser window, so it
    // lands on the current (home) workspace instead of adding a tab to an
    // existing browser window on some other workspace. Manual by design.
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

    // ---- Navigating within the active project -------------------------------

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

    nextLocalWorkspace() {
        let c = this._c;
        let loc = c.currentLocation();
        if (!loc) return false;
        let p = c.state.getProject(loc.projectIdx);
        // At the project's last workspace: grow the strip and land on the new one.
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

    // ---- Moving the focused window ------------------------------------------

    // Move the focused window to a local workspace within the CURRENT project,
    // then follow it there. Bounds-checked against the active project's strip.
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

    moveWindowToNextLocal() {
        let c = this._c;
        let loc = c.currentLocation();
        if (!loc) return false;
        let p = c.state.getProject(loc.projectIdx);
        // At the project's last workspace: create a new one, then move the
        // focused window there (and follow it).
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

    // Move the focused window to another PROJECT (landing on that project's
    // last-used local workspace), and switch there with it.
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
};
