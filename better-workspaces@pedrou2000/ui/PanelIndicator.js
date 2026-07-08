/*
 * BetterWorkspaces — ui/PanelIndicator.js
 *
 * Always-on panel surface (Design Doc §5.1). Renders one clickable button per
 * project showing its Notion icon (M6, via ui/IconRenderer.js): emoji glyphs
 * render directly, image icons download+cache and swap in when ready. The
 * active project is highlighted; a trailing label shows within-project position
 * ("2/3"). Project name is the tooltip. Left-click a button -> switch project.
 *
 * Released under the GNU General Public License v2 (see LICENSE).
 */
const St = imports.gi.St;
const Lang = imports.lang;
const Tooltips = imports.ui.tooltips;
const DND = imports.ui.dnd;

const AppletDir = imports.ui.appletManager.applets["better-workspaces@pedrou2000"];
const IconRenderer = AppletDir.ui.IconRenderer.IconRenderer;

const UUID = "better-workspaces@pedrou2000";
function log(msg) { global.log(UUID + " [panel]: " + msg); }

const ICON_SIZE = 22;

function PanelIndicator(appletActor, controller, orientation, opts) {
    this._init(appletActor, controller, orientation, opts);
}

PanelIndicator.prototype = {

    _init: function (appletActor, controller, orientation, opts) {
        this.actor = appletActor;
        this.controller = controller;
        this.orientation = orientation;
        this._opts = opts || {};
        this._buttons = [];
        this._posLabel = null;
        this._status = "ok";
        this._installDropTarget();
        this.rebuild();
    },

    // Make the applet's button row a DnD drop target so dragged project icons
    // can be reordered horizontally (Cinnamon protocol; the panel isn't modal,
    // so DnD works here). acceptDrop computes the target slot from pointer x.
    _installDropTarget: function () {
        let self = this;
        this.actor._delegate = {
            handleDragOver: function (source, actor, x, y, time) {
                self._showDropHint(self._dropSlotForX(x));
                return DND.DragMotionResult.MOVE_DROP;
            },
            handleDragOut: function () { self._clearDropHint(); },
            acceptDrop: function (source, actor, x, y, time) {
                let from = (source && source._bwIdx !== undefined) ? source._bwIdx : -1;
                let slot = self._dropSlotForX(x);
                self._clearDropHint();
                if (from < 0) return false;
                let target = slot;
                if (target > from) target -= 1;
                if (target !== from && target >= 0) {
                    self.controller.reorderProject(from, target);
                    // onOrderChanged (applet) rebuilds panel + persists order.
                }
                return true;
            },
        };
    },

    // Insertion slot 0..count from pointer x, vs project button horizontal centers.
    _dropSlotForX: function (x) {
        let n = this._buttons.length;
        for (let i = 0; i < n; i++) {
            let box = this._buttons[i].get_allocation_box();
            let center = (box.x1 + box.x2) / 2;
            if (x < center) return i;
        }
        return n;
    },

    _showDropHint: function (slot) {
        this._clearDropHint();
        let idx = Math.min(slot, this._buttons.length - 1);
        if (idx >= 0 && this._buttons[idx]) {
            this._buttons[idx].add_style_pseudo_class('drop-target');
            this._hintedBtn = this._buttons[idx];
        }
    },

    _clearDropHint: function () {
        if (this._hintedBtn) {
            try { this._hintedBtn.remove_style_pseudo_class('drop-target'); } catch (e) {}
            this._hintedBtn = null;
        }
    },

    // Reflect Notion connection state: "unconfigured" | "loading" | "ok" |
    // "error". Shown as a small leading status dot with a tooltip; when not OK
    // the icons are also dimmed via a style class on the container.
    setStatus: function (status) {
        this._status = status;
        if (!this._statusDot) return;
        let map = {
            unconfigured: { text: "⚫", tip: "Notion not connected — open settings to add your token" },
            loading:      { text: "◌", tip: "Syncing with Notion…" },
            ok:           { text: "",       tip: "" },
            error:        { text: "⚠", tip: "Notion sync failed — showing cached projects" },
        };
        let s = map[status] || map.ok;
        this._statusDot.set_text(s.text);
        this._statusDot.visible = (s.text.length > 0);
        if (this._statusTip) this._statusTip.set_text(s.tip);
    },

    // Full rebuild: one icon button per project + a trailing position label.
    rebuild: function () {
        for (let i = 0; i < this._buttons.length; i++) {
            let t = this._buttons[i]._bwTooltip;
            if (t && t.destroy) { try { t.destroy(); } catch (e) {} }
        }
        if (this._statusTip && this._statusTip.destroy) {
            try { this._statusTip.destroy(); } catch (e) {}
        }
        this.actor.destroy_all_children();
        this._buttons = [];

        // Leading status dot (hidden when OK) for degraded-state feedback.
        this._statusDot = new St.Label({
            style_class: 'better-workspaces-status',
            text: '',
            reactive: true, // needed so hover tooltips fire (labels aren't reactive by default)
        });
        this._statusDot.visible = false;
        this.actor.add(this._statusDot, { y_align: St.Align.MIDDLE, y_fill: false });
        this._statusTip = new Tooltips.PanelItemTooltip(
            { actor: this._statusDot }, "", this.orientation);

        let nProjects = this.controller.state.projectCount();
        for (let i = 0; i < nProjects; i++) {
            let p = this.controller.state.getProject(i);
            let btn = new St.Button({
                style_class: 'better-workspaces-project',
                reactive: true,
            });
            btn._projectIdx = i;

            // Icon child (emoji/image/fallback). If it's an image that needs
            // downloading, swap it in when the download completes.
            btn.set_child(this._makeIcon(p, i));

            btn.connect('clicked', Lang.bind(this, function (b) {
                this.controller.goToProject(b._projectIdx);
                this.update();
            }));
            // Hover tooltip with the project name. PanelItemTooltip is panel-
            // aware, so it positions relative to the panel (above, when the
            // panel is at the bottom) instead of always dropping downward.
            btn._bwTooltip = new Tooltips.PanelItemTooltip(
                { actor: btn }, p.name, this.orientation);

            // Draggable to reorder (see _installDropTarget). Plain clicks still
            // switch projects; drag only starts past the move threshold.
            this._makeButtonDraggable(btn, p, i);

            this.actor.add(btn, { y_align: St.Align.MIDDLE, y_fill: false });
            this._buttons.push(btn);
        }

        this._posLabel = new St.Label({
            style_class: 'better-workspaces-position',
            text: '',
        });
        this.actor.add(this._posLabel, { y_align: St.Align.MIDDLE, y_fill: false });

        // Manage affordance (⋯) at the RIGHT end, after the position label.
        if (this._opts.onManage) {
            let manage = new St.Button({
                style_class: 'better-workspaces-manage',
                reactive: true,
            });
            manage.set_child(new St.Label({
                style_class: 'better-workspaces-manage-glyph',
                text: "⋯",
            }));
            manage.connect('clicked', Lang.bind(this, function () {
                try { this._opts.onManage(); } catch (e) { log("onManage: " + e.toString()); }
            }));
            manage._bwManageTip = new Tooltips.PanelItemTooltip(
                { actor: manage }, "Manage workspace projects", this.orientation);
            this.actor.add(manage, { y_align: St.Align.MIDDLE, y_fill: false });
        }

        this.update();
        this.setStatus(this._status); // re-apply after rebuild recreates the dot
    },

    _makeIcon: function (project, idx) {
        return IconRenderer.makeActor(
            project.icon, project.name, ICON_SIZE,
            Lang.bind(this, function () {
                // Download finished: rebuild just this button's child.
                let btn = this._buttons[idx];
                if (btn) {
                    try { btn.set_child(this._makeIcon(project, idx)); }
                    catch (e) { log("icon swap failed: " + e.toString()); }
                }
            }));
    },

    // Make a panel project button draggable for reorder. It's its own DnD
    // delegate: getDragActor provides a floating icon clone. The actual reorder
    // happens in the row's acceptDrop (_installDropTarget).
    _makeButtonDraggable: function (btn, project, idx) {
        let self = this;
        btn._bwIdx = idx;
        btn._delegate = btn;
        btn.getDragActor = function () {
            return IconRenderer.makeActor(project.icon, project.name, ICON_SIZE);
        };
        btn.getDragActorSource = function () { return btn; };
        try {
            let draggable = DND.makeDraggable(btn);
            draggable.connect('drag-end', function () { self._clearDropHint(); });
            draggable.connect('drag-cancelled', function () { self._clearDropHint(); });
        } catch (e) {
            log("makeButtonDraggable: " + e.toString());
        }
    },

    // Lightweight refresh: highlight active project, update position label.
    update: function () {
        let loc = this.controller.currentLocation();
        let activeProjectIdx = loc ? loc.projectIdx : this.controller.state.activeProjectIdx;

        for (let i = 0; i < this._buttons.length; i++) {
            if (i === activeProjectIdx)
                this._buttons[i].add_style_pseudo_class('active');
            else
                this._buttons[i].remove_style_pseudo_class('active');
        }

        if (this._posLabel) {
            this._posLabel.set_text(loc ? this._dotsFor(loc) : "");
        }
    },

    // Carousel dots for the current project's strip: the active workspace is a
    // large filled dot, the others small dots — e.g. "· ● ·". Hidden entirely
    // when the project has only one workspace (a bare "1/1" carries no info).
    // Falls back to compact text if the strip is very long.
    _dotsFor: function (loc) {
        let p = this.controller.state.getProject(loc.projectIdx);
        if (!p || p.wsCount <= 1) return "";           // single workspace -> nothing
        if (p.wsCount > 12) {                          // too many for dots
            return "  " + (loc.localIdx + 1) + "/" + p.wsCount;
        }
        let parts = [];
        for (let i = 0; i < p.wsCount; i++) {
            parts.push(i === loc.localIdx ? "●" : "·");
        }
        return "  " + parts.join(" ");
    },

    destroy: function () {
        for (let i = 0; i < this._buttons.length; i++) {
            let t = this._buttons[i]._bwTooltip;
            if (t && t.destroy) { try { t.destroy(); } catch (e) {} }
        }
        if (this.actor) this.actor.destroy_all_children();
        this._buttons = [];
        this._posLabel = null;
    },
};
