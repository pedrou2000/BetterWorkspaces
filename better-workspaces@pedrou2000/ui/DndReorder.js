/*
 * BetterWorkspaces — ui/DndReorder.js
 *
 * Shared drag-to-reorder machinery for a row of items (Cinnamon DnD protocol),
 * used by the panel's project buttons (horizontal) and the toggle panel's ON
 * rows (vertical). One instance per surface:
 *
 *   let dnd = new DndReorderHelper({
 *       axis: 'x' | 'y',          // which coordinate picks the insertion slot
 *       getItems: () => actors[], // current draggable items, in display order
 *       onReorder: (from, to) => {...},
 *   });
 *   dnd.attachTo(containerActor);            // container accepts drops
 *   dnd.makeDraggable(item, idx, getDragActor); // each item is a drag source
 *
 * The insertion slot is computed against item centers along the axis; the
 * slot -> target-index adjustment (removing `from` shifts later slots down by
 * one) lives here so both surfaces share the fiddly off-by-one logic. Drops
 * from a different surface (another helper instance) are rejected.
 *
 * Released under the GNU General Public License v2 (see LICENSE).
 */
const DND = imports.ui.dnd;

const AppletDir = imports.ui.appletManager.applets["better-workspaces@pedrou2000"];
const L = AppletDir.lib.logger.Logger.makeLogger("dnd");

var DndReorderHelper = class DndReorderHelper {

    constructor(opts) {
        this._axis = opts.axis === 'y' ? 'y' : 'x';
        this._getItems = opts.getItems;
        this._onReorder = opts.onReorder;
        this._hinted = null;
    }

    // Make `container` a drop target for this surface's items.
    attachTo(container) {
        container._delegate = {
            handleDragOver: (source, actor, x, y, time) => {
                this._showHint(this._slotFor(x, y));
                return DND.DragMotionResult.MOVE_DROP;
            },
            handleDragOut: () => this.clearHint(),
            acceptDrop: (source, actor, x, y, time) => {
                // Only accept items we made draggable ourselves.
                let from = (source && source._bwReorder === this) ? source._bwDragIdx : -1;
                let slot = this._slotFor(x, y);
                this.clearHint();
                if (from < 0) return false;
                // slot is an insertion point 0..count. After removing `from`,
                // the insertion index shifts down by one if slot was past it.
                let target = slot;
                if (target > from) target -= 1;
                if (target !== from && target >= 0) this._onReorder(from, target);
                return true;
            },
        };
    }

    // Register `actor` as the drag source for the item at `index`.
    // getDragActor() must return a floating clone to show under the pointer.
    makeDraggable(actor, index, getDragActor) {
        actor._bwReorder = this;
        actor._bwDragIdx = index;
        actor._delegate = actor;
        actor.getDragActor = getDragActor;
        actor.getDragActorSource = () => actor;
        try {
            let draggable = DND.makeDraggable(actor);
            draggable.connect('drag-end', () => this.clearHint());
            draggable.connect('drag-cancelled', () => this.clearHint());
        } catch (e) {
            L.error("makeDraggable: " + e.toString());
        }
    }

    // Insertion slot 0..count from the pointer position, vs item centers.
    _slotFor(x, y) {
        let items = this._getItems() || [];
        let pos = this._axis === 'y' ? y : x;
        for (let i = 0; i < items.length; i++) {
            let box = items[i].get_allocation_box();
            let center = this._axis === 'y'
                ? (box.y1 + box.y2) / 2
                : (box.x1 + box.x2) / 2;
            if (pos < center) return i;
        }
        return items.length;
    }

    // Lightweight hint: highlight the item currently at the target slot.
    _showHint(slot) {
        this.clearHint();
        let items = this._getItems() || [];
        let idx = Math.min(slot, items.length - 1);
        if (idx >= 0 && items[idx]) {
            items[idx].add_style_pseudo_class('drop-target');
            this._hinted = items[idx];
        }
    }

    clearHint() {
        if (this._hinted) {
            try { this._hinted.remove_style_pseudo_class('drop-target'); } catch (e) {}
            this._hinted = null;
        }
    }
};
