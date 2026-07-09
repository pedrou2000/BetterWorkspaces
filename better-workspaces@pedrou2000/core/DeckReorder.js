/* core/DeckReorder.js — move whole projects (workspace blocks + windows). */

const UUID = "better-workspaces@pedrou2000";
const AppletDir = imports.ui.appletManager.applets[UUID];
const Mapping = AppletDir.core.mapping.Mapping;

const L = AppletDir.lib.logger.Logger.makeLogger("reorder");

var DeckReorder = class DeckReorder {

    constructor(ctrl) {
        this._c = ctrl;
        this._onOrderChanged = null; // cb(orderedIds[])
    }

    onOrderChanged(cb) { this._onOrderChanged = cb; }

    // Capture each project's workspace OBJECTS (they survive the index shifts each
    // reorder causes), apply the model move, then slide objects into their target
    // flat slots left->right via Muffin's native reorder — no per-window shuffling.
    reorderProject(from, to) {
        let c = this._c;
        let n = c.state.projectCount();
        if (from < 0 || from >= n || to < 0 || to >= n || from === to) return false;

        let curLoc = c.currentLocation();

        let counts = c.state.counts();
        let blocks = []; // blocks[oldProjIdx] = [wsObj per local]
        for (let pi = 0; pi < n; pi++) {
            let base = Mapping.offsetOf(counts, pi);
            let objs = [];
            for (let l = 0; l < c.state.getProject(pi).wsCount; l++) {
                objs.push(c.wm.getWorkspace(base + l));
            }
            blocks.push(objs);
        }

        let order = c.state.moveProject(from, to); // order[newPos] = oldProjIdx
        if (!order) return false;

        let desired = [];
        for (let newPos = 0; newPos < n; newPos++) {
            let objs = blocks[order[newPos]];
            for (let l = 0; l < objs.length; l++) desired.push(objs[l]);
        }

        // After slot i is fixed, earlier slots are already correct and unaffected.
        for (let i = 0; i < desired.length; i++) {
            c.wm.reorderWorkspaceObject(desired[i], i);
        }

        if (curLoc) {
            let newActivePos = order.indexOf(curLoc.projectIdx);
            let flat = Mapping.globalIndex(c.state.counts(), newActivePos, curLoc.localIdx);
            c.wm.goToWorkspace(flat);
        }

        let orderedIds = [];
        for (let i = 0; i < c.state.projectCount(); i++) {
            orderedIds.push(c.state.getProject(i).id);
        }
        if (this._onOrderChanged) this._onOrderChanged(orderedIds);

        L.log("reorderProject: " + from + " -> " + to + " done");
        return true;
    }

    moveActiveProjectBy(delta) {
        let c = this._c;
        let from = c.state.activeProjectIdx;
        let to = from + delta;
        if (to < 0 || to >= c.state.projectCount()) return false;
        return this.reorderProject(from, to);
    }
};
