/*
 * BetterWorkspaces — core/DeckReorder.js
 *
 * Project reordering (Design Doc §3.C, split out of Controller in M12 Stage C):
 * moving whole projects — each a contiguous block of workspaces — into a new
 * deck order, carrying their windows via Muffin's native reorder_workspace.
 * Owns the order-changed callback the applet uses to persist the order.
 *
 * Collaborator of core/Controller.js (the façade).
 *
 * Released under the GNU General Public License v2 (see LICENSE).
 */

const UUID = "better-workspaces@pedrou2000";
const AppletDir = imports.ui.appletManager.applets[UUID];
const Mapping = AppletDir.core.mapping.Mapping;

const _L = AppletDir.lib.logger.Logger.makeLogger("reorder");
function log(msg) { _L.log(msg); }

var DeckReorder = class DeckReorder {

    constructor(ctrl) {
        this._c = ctrl;             // the Controller façade (state, wm)
        this._onOrderChanged = null; // cb(orderedIds[])
    }

    // Register a callback(orderedIds[]) invoked after a reorder, so the applet
    // can persist the order to Notion.
    onOrderChanged(cb) { this._onOrderChanged = cb; }

    // Reorder projects: move the project at `from` to index `to`. Each project
    // owns a contiguous block of workspaces; we move those blocks (with their
    // windows) into the new order using Muffin's native reorder_workspace — no
    // per-window snapshotting/relocation.
    //
    // Approach: capture the CURRENT flat layout as a list of workspace OBJECTS
    // grouped per project (objects survive the index shifts each reorder causes).
    // Apply the model move, compute the desired flat sequence of those objects,
    // then walk target positions left->right, reordering the right object into
    // each slot. Finally restore the active (project, local).
    reorderProject(from, to) {
        let c = this._c;
        let n = c.state.projectCount();
        if (from < 0 || from >= n || to < 0 || to >= n || from === to) return false;

        let curLoc = c.currentLocation();

        // Capture each project's workspace OBJECTS in current flat order.
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

        // Apply the model reorder; it returns order[newPos] = oldProjIdx, which
        // we reuse to place the workspace blocks (no recomputation here).
        let order = c.state.moveProject(from, to);
        if (!order) return false;

        // Desired flat sequence of workspace objects.
        let desired = [];
        for (let newPos = 0; newPos < n; newPos++) {
            let objs = blocks[order[newPos]];
            for (let l = 0; l < objs.length; l++) desired.push(objs[l]);
        }

        // Place each desired object at its target flat index, left->right. After
        // fixing position i, earlier positions are already correct and unaffected.
        for (let i = 0; i < desired.length; i++) {
            c.wm.reorderWorkspaceObject(desired[i], i);
        }

        // Return to the same (project, local), now at its new flat position.
        if (curLoc) {
            let newActivePos = order.indexOf(curLoc.projectIdx);
            let flat = Mapping.globalIndex(c.state.counts(), newActivePos, curLoc.localIdx);
            c.wm.goToWorkspace(flat);
        }

        // Persist the new order to Notion (ids in new order).
        let orderedIds = [];
        for (let i = 0; i < c.state.projectCount(); i++) {
            orderedIds.push(c.state.getProject(i).id);
        }
        if (this._onOrderChanged) this._onOrderChanged(orderedIds);

        log("reorderProject: " + from + " -> " + to + " done");
        return true;
    }

    // Convenience: move a project one step left/right in the order.
    moveActiveProjectBy(delta) {
        let c = this._c;
        let from = c.state.activeProjectIdx;
        let to = from + delta;
        if (to < 0 || to >= c.state.projectCount()) return false;
        return this.reorderProject(from, to);
    }
};
