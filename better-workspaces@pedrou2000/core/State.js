/*
 * BetterWorkspaces — core/State.js
 *
 * The in-memory data model (Design Doc §3.C). Holds the deck of projects, each
 * project's workspace count, the MRU (recency) order used by Super+Tab, and the
 * per-project "last local workspace" so switching back to a project returns you
 * where you left off.
 *
 * Pure data + bookkeeping — no Cinnamon, no Notion. In M2 the projects are
 * seeded from a hardcoded list; later milestones feed them from the Notion
 * sync cache instead.
 *
 * Released under the GNU General Public License v2 (see LICENSE).
 */

const UUID = "better-workspaces@pedrou2000";
function log(msg) { global.log(UUID + " [state]: " + msg); }

// project := { id, name, wsCount, lastLocal }
function State() {
    this._init();
}

State.prototype = {

    _init: function () {
        this.projects = [];
        this.activeProjectIdx = 0;
        this._mru = []; // project indices, most-recent first
    },

    // Replace the whole project set. `defs` is
    // [{id, name, wsCount, icon, notionUrl}, ...].
    setProjects: function (defs) {
        this.projects = defs.map(function (d) {
            return {
                id: d.id,
                name: d.name,
                wsCount: Math.max(1, d.wsCount || 1), // every project >= 1 (home)
                lastLocal: 0,
                icon: d.icon || null,
                notionUrl: d.notionUrl || null,
            };
        });
        this.activeProjectIdx = 0;
        this._mru = this.projects.map(function (_, i) { return i; });
        log("setProjects: " + this.projects.length + " projects, counts=["
            + this.counts().join(",") + "]");
    },

    // Per-project workspace counts, in project order — the array mapping.js needs.
    counts: function () {
        return this.projects.map(function (p) { return p.wsCount; });
    },

    projectCount: function () {
        return this.projects.length;
    },

    getProject: function (idx) {
        return this.projects[idx] || null;
    },

    activeProject: function () {
        return this.getProject(this.activeProjectIdx);
    },

    // ---- Active project + recency bookkeeping ------------------------------

    setActiveProject: function (idx) {
        if (idx < 0 || idx >= this.projects.length) return false;
        this.activeProjectIdx = idx;
        this._touchMru(idx);
        return true;
    },

    // Remember which local workspace we were on within a project.
    setLastLocal: function (projectIdx, localIdx) {
        let p = this.getProject(projectIdx);
        if (p) p.lastLocal = localIdx;
    },

    getLastLocal: function (projectIdx) {
        let p = this.getProject(projectIdx);
        return p ? p.lastLocal : 0;
    },

    // Move `idx` to the front of the MRU list.
    _touchMru: function (idx) {
        this._mru = this._mru.filter(function (i) { return i !== idx; });
        this._mru.unshift(idx);
    },

    // MRU order as project indices (most recent first).
    mruOrder: function () {
        return this._mru.slice();
    },

    // The project to switch to for an Alt-Tab-style "previous" (second in MRU).
    previousProjectIdx: function () {
        return this._mru.length > 1 ? this._mru[1] : this.activeProjectIdx;
    },

    // ---- Mutating a project's workspace count ------------------------------

    incWorkspaceCount: function (projectIdx) {
        let p = this.getProject(projectIdx);
        if (p) { p.wsCount += 1; return true; }
        return false;
    },

    // Refuse to drop below 1 (a project always keeps its home workspace).
    decWorkspaceCount: function (projectIdx) {
        let p = this.getProject(projectIdx);
        if (p && p.wsCount > 1) { p.wsCount -= 1; return true; }
        return false;
    },
};
