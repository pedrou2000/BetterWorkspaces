/* core/DeckCoordinator.js — the toggle/deck-sync application service. */

// Owns the decisions that used to live in applet.js: the optimistic Workspace
// toggle transaction, the sync-pull -> deck reconcile, and loading the deck from
// the store. Collaborators are INJECTED (store, controller, dialogs, hooks) so
// this has no GJS dependency and is unit-testable with fakes. The applet keeps
// only the GJS effects (building the panel/modal actors), passed in as hooks.

const AppletDir = imports.ui.appletManager.applets["better-workspaces@pedrou2000"];
const L = AppletDir.lib.logger.Logger.makeLogger("deck-coord");

var DeckCoordinator = class DeckCoordinator {

    // deps: {
    //   store, controller,
    //   dialogs: {confirm(title,msg,label)->Promise<bool>, notify(title,msg)},
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
    }

    _rebuildPanel() { if (this._hooks.rebuildPanel) this._hooks.rebuildPanel(); }
    _refresh() { if (this._hooks.refresh) this._hooks.refresh(); }
    _refreshTogglePanel() { if (this._hooks.refreshTogglePanel) this._hooks.refreshTogglePanel(); }

    // Cached project entry -> controller project def.
    toDef(p) {
        return {
            id: p.id,
            name: p.name,
            wsCount: this._defaultWsPerProject,
            icon: p.icon,
            notionUrl: p.notionUrl,
        };
    }

    // Build the deck from the store's catalog, filtered to inWorkspace projects
    // (in Workspace Order — store.all() is sorted). Placeholder deck when empty.
    loadDeckFromStore() {
        let inDeck = this._store.all().filter((p) => p.inWorkspace);
        if (inDeck.length === 0) {
            L.log("loadDeckFromStore: no in-workspace projects -> placeholder deck");
            this._controller.loadProjects(this._placeholder);
            return;
        }
        this._controller.loadProjects(inDeck.map((p) => this.toDef(p)));
        L.log("loadDeckFromStore: loaded " + inDeck.length + " in-workspace projects");
    }

    // A completed pull merges into the store: catalog fields update live; deck
    // fields keep local pending writes. A project newly checked in Notion auto-
    // APPENDS to the deck end (append never moves existing workspaces). Unchecking
    // in Notion never auto-removes; that stays behind the explicit toggle-off flow.
    onPull(projects) {
        let deckIds = [];
        let n = this._controller.state.projectCount();
        for (let i = 0; i < n; i++) deckIds.push(this._controller.state.getProject(i).id);

        let result = this._store.merge(projects, deckIds);

        for (let i = 0; i < result.newlyInWorkspace.length; i++) {
            let p = result.newlyInWorkspace[i];
            if (this._controller.state.indexOfProjectId(p.id) >= 0) continue;
            this._controller.addProjectLive(this.toDef(p));
            L.log("onPull: auto-appended newly-on project " + p.name);
        }

        this._rebuildPanel();
        this._refreshTogglePanel();
        this._refresh();
    }

    // Resolve the deck index of the ON project `movedId` and reorder it — the
    // toggle panel reports ids (never positions, which can drift), resolved here.
    reorderFromPanel(movedId, toOnPos) {
        let from = this._controller.state.indexOfProjectId(movedId);
        if (from >= 0) this._controller.reorderProject(from, toOnPos);
    }

    // Perform a Workspace toggle OPTIMISTICALLY: the store + deck update
    // immediately and the Notion write is queued (store reverts + shows the error
    // dot if the push later fails). Resolves on success; rejects only when the
    // change didn't happen (cancelled / windows open).
    async handleToggle(project, newValue) {
        if (!this._store) throw new Error("no-store");

        if (newValue) {
            // Turning ON: append to the deck and the store, Workspace Order =
            // max+1 so "bottom" survives reload. Writes are queued by the store.
            this._controller.addProjectLive(this.toDef(project));
            this._store.setInWorkspace(project.id, true);
            this._store.setOrder(project.id, this._store.maxOrder() + 1);
            this._rebuildPanel();
            this._refresh();
            return;
        }

        // Turning OFF: destructive — confirm, then remove from the deck (which
        // gracefully closes windows). Only after the deck removal succeeds does
        // the store flip the flag (and queue the Notion writes).
        let deckIdx = this._controller.state.indexOfProjectId(project.id);
        if (deckIdx < 0) {
            // Not in the live deck (shouldn't happen) — just flip the flag.
            this._store.setInWorkspace(project.id, false);
            return;
        }
        let confirmed = await this._confirmRemoval(project);
        if (!confirmed) throw new Error("cancelled");
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
        // Clear the order so it sorts last if reactivated later.
        this._store.setInWorkspace(project.id, false);
        this._store.setOrder(project.id, null);
    }

    // Confirm destructive removal via a modal. Resolves to true/false.
    _confirmRemoval(project) {
        let deckIdx = this._controller.state.indexOfProjectId(project.id);
        let p = this._controller.state.getProject(deckIdx);
        let wsCount = p ? p.wsCount : 1;
        return this._dialogs.confirm(
            "Remove “" + project.name + "” from workspaces?",
            "This will close its windows and remove its " + wsCount + " workspace(s).",
            "Remove");
    }

    _notifyWindowsOpen(project, info) {
        let titles = (info && info.openTitles) ? info.openTitles.join(", ") : "";
        this._dialogs.notify(
            "Couldn’t remove “" + project.name + "”",
            "Please close these window(s) first, then try again:\n" + titles);
    }
};
