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
const Tooltips = imports.ui.tooltips;

const AppletDir = imports.ui.appletManager.applets["better-workspaces@pedrou2000"];
const IconRenderer = AppletDir.ui.IconRenderer.IconRenderer;
const DndReorderHelper = AppletDir.ui.DndReorder.DndReorderHelper;
const _L = AppletDir.lib.logger.Logger.makeLogger("panel");
function log(msg) { _L.log(msg); }

const ICON_SIZE = AppletDir.lib.constants.Constants.PANEL_ICON_SIZE;

var PanelIndicator = class PanelIndicator {

    constructor(appletActor, controller, orientation, opts) {
        this.actor = appletActor;
        this.controller = controller;
        this.orientation = orientation;
        this._opts = opts || {};
        this._buttons = [];
        this._posLabel = null;
        this._status = "ok";

        // Drag-to-reorder across the button row (shared ui/DndReorder helper).
        // onOrderChanged (applet) rebuilds the panel + persists the order.
        this._dnd = new DndReorderHelper({
            axis: 'x',
            getItems: () => this._buttons,
            onReorder: (from, to) => this.controller.reorderProject(from, to),
        });
        this._dnd.attachTo(this.actor);

        this.rebuild();
    }

    // Reflect Notion connection state: "unconfigured" | "loading" | "ok" |
    // "error". Shown as a small leading status dot with a tooltip.
    setStatus(status) {
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
    }

    // Destroy every tooltip created during the last rebuild (tooltips aren't
    // children of the actor, so destroy_all_children doesn't reach them).
    _destroyTooltips() {
        let tips = this._tooltips || [];
        for (let i = 0; i < tips.length; i++) {
            if (tips[i] && tips[i].destroy) { try { tips[i].destroy(); } catch (e) {} }
        }
        this._tooltips = [];
    }

    _addTooltip(actor, text) {
        let tip = new Tooltips.PanelItemTooltip({ actor: actor }, text, this.orientation);
        this._tooltips.push(tip);
        return tip;
    }

    // Full rebuild: one icon button per project + a trailing position label.
    rebuild() {
        this._destroyTooltips();
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
        this._statusTip = this._addTooltip(this._statusDot, "");

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
            btn.set_child(this._makeIcon(p, btn));

            btn.connect('clicked', (b) => {
                this.controller.goToProject(b._projectIdx);
                this.update();
            });
            // Hover tooltip with the project name. PanelItemTooltip is panel-
            // aware, so it positions relative to the panel (above, when the
            // panel is at the bottom) instead of always dropping downward.
            this._addTooltip(btn, p.name);

            // Draggable to reorder; the floating drag actor is an icon clone.
            // Plain clicks still switch projects; drag starts past the move
            // threshold.
            this._dnd.makeDraggable(btn, i,
                () => IconRenderer.makeActor(p.icon, p.name, ICON_SIZE));

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
            manage.connect('clicked', () => {
                try { this._opts.onManage(); } catch (e) { log("onManage: " + e.toString()); }
            });
            this._addTooltip(manage, "Manage workspace projects");
            this.actor.add(manage, { y_align: St.Align.MIDDLE, y_fill: false });
        }

        this.update();
        this.setStatus(this._status); // re-apply after rebuild recreates the dot
    }

    // Icon actor for a button. The download-finished callback captures the
    // BUTTON (not its index), so a reorder while the download is in flight
    // can't write the icon onto whichever button now sits at that index; a
    // rebuild orphans the old button harmlessly (it's no longer in _buttons).
    _makeIcon(project, btn) {
        return IconRenderer.makeActor(
            project.icon, project.name, ICON_SIZE,
            () => {
                if (this._buttons.indexOf(btn) === -1) return; // rebuilt since
                try { btn.set_child(this._makeIcon(project, btn)); }
                catch (e) { log("icon swap failed: " + e.toString()); }
            });
    }

    // Lightweight refresh: highlight active project, update position label.
    update() {
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
    }

    // Carousel dots for the current project's strip: the active workspace is a
    // large filled dot, the others small dots — e.g. "· ● ·". Hidden entirely
    // when the project has only one workspace (a bare "1/1" carries no info).
    // Falls back to compact text if the strip is very long.
    _dotsFor(loc) {
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
    }

    destroy() {
        this._destroyTooltips();
        if (this.actor) this.actor.destroy_all_children();
        this._buttons = [];
        this._posLabel = null;
        this._statusDot = null;
        this._statusTip = null;
    }
};
