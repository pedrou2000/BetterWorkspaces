/* ui/PanelIndicator.js — the always-on panel: one icon button per project. */

const St = imports.gi.St;
const Tooltips = imports.ui.tooltips;

const AppletDir = imports.ui.appletManager.applets["better-workspaces@pedrou2000"];
const IconRenderer = AppletDir.ui.IconRenderer.IconRenderer;
const DndReorderHelper = AppletDir.ui.DndReorder.DndReorderHelper;
const L = AppletDir.lib.logger.Logger.makeLogger("panel");

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

        // Reorder handled by the controller; onOrderChanged rebuilds + persists.
        this._dnd = new DndReorderHelper({
            axis: "x",
            getItems: () => this._buttons,
            onReorder: (from, to) => this.controller.reorderProject(from, to),
        });
        this._dnd.attachTo(this.actor);

        this.rebuild();
    }

    // Status glyph + tooltip: "unconfigured" | "loading" | "ok" | "error".
    setStatus(status) {
        this._status = status;
        if (!this._statusDot) return;
        const map = {
            unconfigured: {
                text: "⛓",
                tip: "Notion not connected — open settings to add your token",
            },
            loading: { text: "⟳", tip: "Syncing with Notion…" },
            ok: { text: "", tip: "" },
            // "⇄" + U+0338 combining slash = sync broken; fall back to "↯" if a font renders it badly.
            error: { text: "⇄̸", tip: "Notion sync failed — showing cached projects" },
        };
        const s = map[status] || map.ok;
        this._statusDot.set_text(s.text);
        this._statusDot.visible = s.text.length > 0;
        if (this._statusTip) this._statusTip.set_text(s.tip);
    }

    // Tooltips aren't actor children, so destroy_all_children doesn't reach them.
    _destroyTooltips() {
        const tips = this._tooltips || [];
        for (let i = 0; i < tips.length; i++) {
            if (tips[i] && tips[i].destroy) {
                try {
                    tips[i].destroy();
                } catch (e) {}
            }
        }
        this._tooltips = [];
    }

    _addTooltip(actor, text) {
        const tip = new Tooltips.PanelItemTooltip({ actor: actor }, text, this.orientation);
        this._tooltips.push(tip);
        return tip;
    }

    // Row order: project icons, position dots, then meta zone (status glyph + ⋯).
    // Icons stay hard-left so the transient status glyph never shifts click targets.
    rebuild() {
        this._destroyTooltips();
        this.actor.destroy_all_children();
        this._buttons = [];

        const nProjects = this.controller.state.projectCount();
        for (let i = 0; i < nProjects; i++) {
            const p = this.controller.state.getProject(i);
            const btn = new St.Button({
                style_class: "better-workspaces-project",
                reactive: true,
            });
            btn._projectIdx = i;

            btn.set_child(this._makeIcon(p, btn));

            btn.connect("clicked", (b) => {
                this.controller.goToProject(b._projectIdx);
                this.update();
            });
            // PanelItemTooltip is panel-aware (positions above when the panel's at
            // the bottom, not always downward).
            this._addTooltip(btn, p.name);

            // Draggable to reorder; plain clicks still switch (drag starts past threshold).
            this._dnd.makeDraggable(btn, i, () =>
                IconRenderer.makeActor(p.icon, p.name, ICON_SIZE),
            );

            this.actor.add(btn, { y_align: St.Align.MIDDLE, y_fill: false });
            this._buttons.push(btn);
        }

        this._posLabel = new St.Label({
            style_class: "better-workspaces-position",
            text: "",
        });
        this.actor.add(this._posLabel, { y_align: St.Align.MIDDLE, y_fill: false });

        this._statusDot = new St.Label({
            style_class: "better-workspaces-status",
            text: "",
            reactive: true, // labels aren't reactive by default; needed for hover tooltips
        });
        this._statusDot.visible = false;
        this.actor.add(this._statusDot, { y_align: St.Align.MIDDLE, y_fill: false });
        this._statusTip = this._addTooltip(this._statusDot, "");

        if (this._opts.onManage) {
            const manage = new St.Button({
                style_class: "better-workspaces-manage",
                reactive: true,
            });
            manage.set_child(
                new St.Label({
                    style_class: "better-workspaces-manage-glyph",
                    text: "⋯",
                }),
            );
            manage.connect("clicked", () => {
                try {
                    this._opts.onManage();
                } catch (e) {
                    L.log("onManage: " + e.toString());
                }
            });
            this._addTooltip(manage, "Manage workspace projects");
            this.actor.add(manage, { y_align: St.Align.MIDDLE, y_fill: false });
        }

        this.update();
        this.setStatus(this._status); // re-apply after rebuild recreates the dot
    }

    // Capture the BUTTON, not its index: a reorder mid-download must not paint
    // the icon onto whatever button now sits at that index.
    _makeIcon(project, btn) {
        return IconRenderer.makeActor(project.icon, project.name, ICON_SIZE, () => {
            if (this._buttons.indexOf(btn) === -1) return; // rebuilt since
            try {
                btn.set_child(this._makeIcon(project, btn));
            } catch (e) {
                L.log("icon swap failed: " + e.toString());
            }
        });
    }

    // Highlight the active project, update the position dots.
    update() {
        const loc = this.controller.currentLocation();
        const activeProjectIdx = loc ? loc.projectIdx : this.controller.state.activeProjectIdx;

        for (let i = 0; i < this._buttons.length; i++) {
            if (i === activeProjectIdx) this._buttons[i].add_style_pseudo_class("active");
            else this._buttons[i].remove_style_pseudo_class("active");
        }

        if (this._posLabel) {
            const dots = loc ? this._dotsFor(loc) : "";
            this._posLabel.set_text(dots);
            // Hide when empty: an empty St.Label still occupies its CSS padding.
            this._posLabel.visible = dots.length > 0;
        }
    }

    // Carousel dots "· ● ·" for the strip; nothing for a 1-workspace project,
    // compact "n/m" when the strip is too long for dots.
    _dotsFor(loc) {
        const p = this.controller.state.getProject(loc.projectIdx);
        if (!p || p.wsCount <= 1) return "";
        if (p.wsCount > 12) {
            return "  " + (loc.localIdx + 1) + "/" + p.wsCount;
        }
        const parts = [];
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
