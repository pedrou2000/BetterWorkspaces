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
const AppletDir = imports.ui.appletManager.applets[UUID];
const _L = AppletDir.lib.logger.Logger.makeLogger("state");
function log(msg) { _L.log(msg); }

// Build a project record from a def. Single source of truth for the shape;
// every project (>= 1 workspace, the home) starts on local 0.
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

// project := { id, name, wsCount, lastLocal, icon, notionUrl }
var State = class State {

    constructor() {
        this.projects = [];
        this.activeProjectIdx = 0;
        this._mru = []; // project indices, most-recent first
    }

    // Replace the whole project set. `defs` is
    // [{id, name, wsCount, icon, notionUrl}, ...].
    setProjects(defs) {
        this.projects = defs.map(makeProject);
        this.activeProjectIdx = 0;
        this._mru = this.projects.map((_, i) => i);
        log("setProjects: " + this.projects.length + " projects, counts=["
            + this.counts().join(",") + "]");
    }

    // Per-project workspace counts, in project order — the array mapping.js needs.
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

    // ---- Active project + recency bookkeeping ------------------------------

    setActiveProject(idx) {
        if (idx < 0 || idx >= this.projects.length) return false;
        this.activeProjectIdx = idx;
        this._touchMru(idx);
        return true;
    }

    // Remember which local workspace we were on within a project.
    setLastLocal(projectIdx, localIdx) {
        let p = this.getProject(projectIdx);
        if (p) p.lastLocal = localIdx;
    }

    getLastLocal(projectIdx) {
        let p = this.getProject(projectIdx);
        return p ? p.lastLocal : 0;
    }

    // Move `idx` to the front of the MRU list.
    _touchMru(idx) {
        this._mru = this._mru.filter((i) => i !== idx);
        this._mru.unshift(idx);
    }

    // MRU order as project indices (most recent first).
    mruOrder() {
        return this._mru.slice();
    }

    // The project to switch to for an Alt-Tab-style "previous" (second in MRU).
    previousProjectIdx() {
        return this._mru.length > 1 ? this._mru[1] : this.activeProjectIdx;
    }

    // ---- Adding / removing whole projects (M9 live deck changes) -----------

    // Append a project to the end of the deck. Returns its new index.
    appendProject(def) {
        this.projects.push(makeProject(def));
        let idx = this.projects.length - 1;
        this._mru.push(idx); // least-recent until visited
        log("appendProject: " + def.name + " at index " + idx);
        return idx;
    }

    // Remove the project at `idx`, fixing up MRU + activeProjectIdx to account
    // for the reindexing of everything after `idx`.
    removeProject(idx) {
        if (idx < 0 || idx >= this.projects.length) return false;
        this.projects.splice(idx, 1);

        // Rebuild MRU: drop `idx`, decrement any index above it.
        this._mru = this._mru
            .filter((i) => i !== idx)
            .map((i) => (i > idx ? i - 1 : i));

        // Fix active pointer similarly (caller usually re-sets it right after).
        if (this.activeProjectIdx === idx) {
            this.activeProjectIdx = Math.max(0, Math.min(this.activeProjectIdx, this.projects.length - 1));
        } else if (this.activeProjectIdx > idx) {
            this.activeProjectIdx -= 1;
        }
        log("removeProject: removed index " + idx + ", " + this.projects.length + " remain");
        return true;
    }

    // Move the project at `from` to index `to`, reindexing the projects array
    // and remapping MRU + active pointer by tracking positions across the move.
    // Returns the position map `order` where order[newPos] = oldIndex (the
    // caller needs it to relocate workspaces), or null on invalid indices.
    moveProject(from, to) {
        let n = this.projects.length;
        if (from < 0 || from >= n || to < 0 || to >= n || from === to) return null;

        // order[newPos] = oldIndex, by simulating the array splice.
        let order = [];
        for (let i = 0; i < n; i++) order.push(i);
        order.splice(to, 0, order.splice(from, 1)[0]);
        // Invert to oldIndex -> newPos.
        let newOf = {};
        for (let newPos = 0; newPos < n; newPos++) newOf[order[newPos]] = newPos;

        // Apply the same reorder to the projects array.
        this.projects.splice(to, 0, this.projects.splice(from, 1)[0]);

        // Remap MRU indices and the active pointer through newOf.
        this._mru = this._mru.map((i) => newOf[i]);
        this.activeProjectIdx = newOf[this.activeProjectIdx];

        log("moveProject: " + from + " -> " + to);
        return order;
    }

    // ---- Mutating a project's workspace count ------------------------------

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
