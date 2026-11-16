/* core/DeckCoordinator.js — the toggle/deck-sync application service. */

// Owns the decisions that used to live in applet.js: the optimistic Workspace
// toggle transaction, the sync-pull -> deck reconcile, and loading the deck from
// the store. Collaborators are INJECTED (store, controller, dialogs, hooks) so
// this has no GJS dependency and is unit-testable with fakes. The applet keeps
// only the GJS effects (building the panel/modal actors), passed in as hooks.

const AppletDir = imports.ui.appletManager.applets["better-workspaces@pedrou2000"];
const L = AppletDir.lib.logger.Logger.makeLogger("deck-coord");

const LAYOUT_FILE = "layout.json"; // {strips: [{id, wsCount}]} in deck order

var DeckCoordinator = class DeckCoordinator {
    // deps: {
    //   store, controller,
    //   persistence: {readJSON, writeJSON} (optional; without it strip sizes
    //     don't survive a reload),
    //   dialogs: {notify(title,msg)},
    //   defaultWsPerProject: number,
    //   placeholderProjects: [{id,name,wsCount}],
    //   hooks: {rebuildPanel(), refresh(), refreshTogglePanel()},
    // }
    constructor(deps) {
        this._store = deps.store;
        this._controller = deps.controller;
        this._dialogs = deps.dialogs;
        this._defaultWsPerProject = deps.defaultWsPerProject;
        this._placeholder = deps.placeholderProjects || [];
        this._hooks = deps.hooks || {};
        this._persistence = deps.persistence || null;
        if (this._persistence) {
            this._controller.state.onLayoutChanged(() => this._saveLayout());
        }
    }

    _saveLayout() {
        const state = this._controller.state;
        const strips = [];
        for (let i = 0; i < state.projectCount(); i++) {
            const p = state.getProject(i);
            strips.push({ id: p.id, wsCount: p.wsCount });
        }
        this._persistence.writeJSON(LAYOUT_FILE, { strips: strips });
    }

    // Restarting Cinnamon reloads the applet over workspaces and windows that are
    // still there. Loading every project at its default size would delete the
    // extra workspaces and dump their windows, so re-adopt the saved strip sizes —
    // but only while they still describe reality: same deck in the same order,
    // same workspace total, and windows actually open (an empty session, i.e. a
    // fresh login, starts from the defaults instead). Mutates defs; true if applied.
    _restoreLayout(defs) {
        if (!this._persistence) return false;
        const saved = this._persistence.readJSON(LAYOUT_FILE, null);
        const strips = saved && Array.isArray(saved.strips) ? saved.strips : null;
        if (!strips || strips.length !== defs.length) return false;

        let total = 0;
        for (let i = 0; i < strips.length; i++) {
            const s = strips[i];
            if (!s || s.id !== defs[i].id) return false;
            if (!Number.isInteger(s.wsCount) || s.wsCount < 1) return false;
            total += s.wsCount;
        }

        const wm = this._controller.wm;
        if (total !== wm.getWorkspaceCount()) return false;
        let windows = 0;
        for (let i = 0; i < total; i++) windows += wm.countWindows(i);
        if (windows === 0) return false;

        for (let i = 0; i < strips.length; i++) defs[i].wsCount = strips[i].wsCount;
        return true;
    }

    _rebuildPanel() {
        if (this._hooks.rebuildPanel) this._hooks.rebuildPanel();
    }
    _refresh() {
        if (this._hooks.refresh) this._hooks.refresh();
    }
    _refreshTogglePanel() {
        if (this._hooks.refreshTogglePanel) this._hooks.refreshTogglePanel();
    }

    toDef(p) {
        return {
            id: p.id,
            name: p.name,
            wsCount: this._defaultWsPerProject,
            icon: p.icon,
            notionUrl: p.notionUrl,
        };
    }

    // The deck is the inWorkspace subset of the catalog, in Workspace Order.
    loadDeckFromStore() {
        const inDeck = this._store.all().filter((p) => p.inWorkspace);
        if (inDeck.length === 0) {
            L.log("loadDeckFromStore: no in-workspace projects -> placeholder deck");
            this._controller.loadProjects(this._placeholder);
            return;
        }
        const defs = inDeck.map((p) => this.toDef(p));
        const restored = this._restoreLayout(defs);
        this._controller.loadProjects(defs);
        L.log(
            "loadDeckFromStore: loaded " +
                inDeck.length +
                " in-workspace projects" +
                (restored ? " (saved strip sizes restored)" : ""),
        );
    }

    // A completed pull merges into the store: catalog fields update live; deck
    // fields keep local pending writes. A project newly checked in Notion auto-
    // APPENDS to the deck end (append never moves existing workspaces). Unchecking
    // in Notion never auto-removes; that stays behind the explicit toggle-off flow.
    onPull(projects) {
        const deckIds = [];
        const n = this._controller.state.projectCount();
        for (let i = 0; i < n; i++) deckIds.push(this._controller.state.getProject(i).id);

        const result = this._store.merge(projects, deckIds);

        if (this._controller.state.indexOfProjectId("placeholder") >= 0) {
            this.loadDeckFromStore(); // first real pull replaces the placeholder deck
        } else {
            // Refresh renamed/re-iconed projects already on the deck.
            const state = this._controller.state;
            for (let i = 0; i < state.projectCount(); i++) {
                const cur = state.getProject(i);
                const fresh = this._store.get(cur.id);
                if (fresh) state.updateProjectDisplay(cur.id, this.toDef(fresh));
            }
            for (let i = 0; i < result.newlyInWorkspace.length; i++) {
                const p = result.newlyInWorkspace[i];
                if (state.indexOfProjectId(p.id) >= 0) continue;
                this._controller.addProjectLive(this.toDef(p));
                L.log("onPull: auto-appended newly-on project " + p.name);
            }
        }

        this._rebuildPanel();
        this._refreshTogglePanel();
        this._refresh();
    }

    // Resolve the deck index of the ON project `movedId` and reorder it — the
    // toggle panel reports ids (never positions, which can drift), resolved here.
    reorderFromPanel(movedId, toOnPos) {
        const from = this._controller.state.indexOfProjectId(movedId);
        if (from >= 0) this._controller.reorderProject(from, toOnPos);
    }

    // Optimistic: store + deck update now, Notion writes queued by the store.
    // Resolves on success; rejects only when nothing changed (windows-open).
    async handleToggle(project, newValue) {
        if (!this._store) throw new Error("no-store");

        if (newValue) {
            // Order = max+1 so "bottom" survives reload.
            this._controller.addProjectLive(this.toDef(project));
            this._store.setInWorkspace(project.id, true);
            this._store.setOrder(project.id, this._store.maxOrder() + 1);
            this._rebuildPanel();
            this._refresh();
            return;
        }

        // Destructive, unconfirmed by design: windows get a graceful close request,
        // so an app with unsaved work vetoes the removal (windows-open). Flip the
        // store flag only once the removal actually succeeds.
        const deckIdx = this._controller.state.indexOfProjectId(project.id);
        if (deckIdx < 0) {
            this._store.setInWorkspace(project.id, false); // not in deck (shouldn't happen)
            return;
        }
        try {
            await this._controller.removeProjectLive(deckIdx);
        } catch (e) {
            if (e.message === "windows-open") {
                this._notifyWindowsOpen(project, { openTitles: e.openTitles });
            }
            throw e;
        }
        this._rebuildPanel();
        this._refresh();
        this._store.setInWorkspace(project.id, false);
        this._store.setOrder(project.id, null); // clear order so it sorts last if reactivated
    }

    // Turn a deck project OFF from outside the toggle panel (context menu,
    // double-click). Resolves true if it was removed; refusals resolve false
    // rather than reject, since handleToggle has already told the user why.
    async removeFromWorkspaces(projectId) {
        const project = this._store.get(projectId);
        if (!project) return false;
        try {
            await this.handleToggle(project, false);
        } catch (e) {
            L.log("removeFromWorkspaces: kept " + project.name + " (" + e.message + ")");
            return false;
        }
        this._refreshTogglePanel();
        return true;
    }

    _notifyWindowsOpen(project, info) {
        const titles = info && info.openTitles ? info.openTitles.join(", ") : "";
        this._dialogs.notify(
            "Couldn’t remove “" + project.name + "”",
            "Please close these window(s) first, then try again:\n" + titles,
        );
    }
};
