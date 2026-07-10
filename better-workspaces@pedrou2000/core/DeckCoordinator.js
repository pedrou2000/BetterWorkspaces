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
        this._controller.loadProjects(inDeck.map((p) => this.toDef(p)));
        L.log("loadDeckFromStore: loaded " + inDeck.length + " in-workspace projects");
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
            for (let i = 0; i < result.newlyInWorkspace.length; i++) {
                const p = result.newlyInWorkspace[i];
                if (this._controller.state.indexOfProjectId(p.id) >= 0) continue;
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
    // Resolves on success; rejects only when nothing changed (cancelled/windows-open).
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

        // Destructive: confirm, remove from the deck (closes windows), then flip
        // the store flag only once the removal actually succeeds.
        const deckIdx = this._controller.state.indexOfProjectId(project.id);
        if (deckIdx < 0) {
            this._store.setInWorkspace(project.id, false); // not in deck (shouldn't happen)
            return;
        }
        const confirmed = await this._confirmRemoval(project);
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
        this._store.setInWorkspace(project.id, false);
        this._store.setOrder(project.id, null); // clear order so it sorts last if reactivated
    }

    _confirmRemoval(project) {
        const deckIdx = this._controller.state.indexOfProjectId(project.id);
        const p = this._controller.state.getProject(deckIdx);
        const wsCount = p ? p.wsCount : 1;
        return this._dialogs.confirm(
            "Remove “" + project.name + "” from workspaces?",
            "This will close its windows and remove its " + wsCount + " workspace(s).",
            "Remove",
        );
    }

    _notifyWindowsOpen(project, info) {
        const titles = info && info.openTitles ? info.openTitles.join(", ") : "";
        this._dialogs.notify(
            "Couldn’t remove “" + project.name + "”",
            "Please close these window(s) first, then try again:\n" + titles,
        );
    }
};
