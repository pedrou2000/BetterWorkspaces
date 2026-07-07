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

const AppletDir = imports.ui.appletManager.applets["better-workspaces@pedrou2000"];
const IconRenderer = AppletDir.ui.IconRenderer.IconRenderer;

const UUID = "better-workspaces@pedrou2000";
function log(msg) { global.log(UUID + " [panel]: " + msg); }

const ICON_SIZE = 22;

function PanelIndicator(appletActor, controller, orientation) {
    this._init(appletActor, controller, orientation);
}

PanelIndicator.prototype = {

    _init: function (appletActor, controller, orientation) {
        this.actor = appletActor;
        this.controller = controller;
        this.orientation = orientation;
        this._buttons = [];
        this._posLabel = null;
        this.rebuild();
    },

    // Full rebuild: one icon button per project + a trailing position label.
    rebuild: function () {
        for (let i = 0; i < this._buttons.length; i++) {
            let t = this._buttons[i]._bwTooltip;
            if (t && t.destroy) { try { t.destroy(); } catch (e) {} }
        }
        this.actor.destroy_all_children();
        this._buttons = [];

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

            this.actor.add(btn, { y_align: St.Align.MIDDLE, y_fill: false });
            this._buttons.push(btn);
        }

        this._posLabel = new St.Label({
            style_class: 'better-workspaces-position',
            text: '',
        });
        this.actor.add(this._posLabel, { y_align: St.Align.MIDDLE, y_fill: false });

        this.update();
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
            if (loc) {
                let p = this.controller.state.getProject(loc.projectIdx);
                this._posLabel.set_text(" " + (loc.localIdx + 1) + "/" + p.wsCount);
            } else {
                this._posLabel.set_text(" ?");
            }
        }
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
