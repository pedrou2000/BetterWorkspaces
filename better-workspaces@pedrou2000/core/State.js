/* core/State.js — the in-memory deck model: projects, workspace counts, MRU. */

const UUID = "better-workspaces@pedrou2000";
const AppletDir = imports.ui.appletManager.applets[UUID];
const L = AppletDir.lib.logger.Logger.makeLogger("state");

// Single source of truth for a project record's shape; wsCount >= 1 (the home).
function makeProject(def) {
    return {
        id: def.id,
        name: def.name,
        wsCount: Math.max(1, def.wsCount || 1),
        lastLocal: 0,
        icon: def.icon || null,
        notionUrl: def.notionUrl || null,
    };
}

var State = class State {

    constructor() {
        this.projects = [];
        this.activeProjectIdx = 0;
        this._mru = []; // project indices, most-recent first
    }

    setProjects(defs) {
        this.projects = defs.map(makeProject);
        this.activeProjectIdx = 0;
        this._mru = this.projects.map((_, i) => i);
        L.log("setProjects: " + this.projects.length + " projects, counts=["
            + this.counts().join(",") + "]");
    }

    // Per-project workspace counts in project order — the array mapping.js takes.
    counts() {
        return this.projects.map((p) => p.wsCount);
    }

    projectCount() {
        return this.projects.length;
    }

    getProject(idx) {
        return this.projects[idx] || null;
    }

    activeProject() {
        return this.getProject(this.activeProjectIdx);
    }

    indexOfProjectId(id) {
        for (let i = 0; i < this.projects.length; i++) {
            if (this.projects[i].id === id) return i;
        }
        return -1;
    }

    setActiveProject(idx) {
        if (idx < 0 || idx >= this.projects.length) return false;
        this.activeProjectIdx = idx;
        this._touchMru(idx);
        return true;
    }

    setLastLocal(projectIdx, localIdx) {
        let p = this.getProject(projectIdx);
        if (p) p.lastLocal = localIdx;
    }

    getLastLocal(projectIdx) {
        let p = this.getProject(projectIdx);
        return p ? p.lastLocal : 0;
    }

    _touchMru(idx) {
        this._mru = this._mru.filter((i) => i !== idx);
        this._mru.unshift(idx);
    }

    mruOrder() {
        return this._mru.slice();
    }

    // Alt-Tab "previous" target: second in MRU.
    previousProjectIdx() {
        return this._mru.length > 1 ? this._mru[1] : this.activeProjectIdx;
    }

    appendProject(def) {
        this.projects.push(makeProject(def));
        let idx = this.projects.length - 1;
        this._mru.push(idx); // least-recent until visited
        L.log("appendProject: " + def.name + " at index " + idx);
        return idx;
    }

    // Removing shifts every index above `idx` down by one, so MRU and the active
    // pointer are remapped to match.
    removeProject(idx) {
        if (idx < 0 || idx >= this.projects.length) return false;
        this.projects.splice(idx, 1);

        this._mru = this._mru
            .filter((i) => i !== idx)
            .map((i) => (i > idx ? i - 1 : i));

        if (this.activeProjectIdx === idx) {
            this.activeProjectIdx = Math.max(0, Math.min(this.activeProjectIdx, this.projects.length - 1));
        } else if (this.activeProjectIdx > idx) {
            this.activeProjectIdx -= 1;
        }
        L.log("removeProject: removed index " + idx + ", " + this.projects.length + " remain");
        return true;
    }

    // Move `from` to `to`. Returns order[newPos] = oldIndex — the caller reuses
    // it to relocate the matching workspace blocks — or null on invalid indices.
    moveProject(from, to) {
        let n = this.projects.length;
        if (from < 0 || from >= n || to < 0 || to >= n || from === to) return null;

        let order = [];
        for (let i = 0; i < n; i++) order.push(i);
        order.splice(to, 0, order.splice(from, 1)[0]);
        let newOf = {};
        for (let newPos = 0; newPos < n; newPos++) newOf[order[newPos]] = newPos;

        this.projects.splice(to, 0, this.projects.splice(from, 1)[0]);

        this._mru = this._mru.map((i) => newOf[i]);
        this.activeProjectIdx = newOf[this.activeProjectIdx];

        L.log("moveProject: " + from + " -> " + to);
        return order;
    }

    incWorkspaceCount(projectIdx) {
        let p = this.getProject(projectIdx);
        if (p) { p.wsCount += 1; return true; }
        return false;
    }

    // Refuse to drop below 1 (a project always keeps its home workspace).
    decWorkspaceCount(projectIdx) {
        let p = this.getProject(projectIdx);
        if (p && p.wsCount > 1) { p.wsCount -= 1; return true; }
        return false;
    }
};
