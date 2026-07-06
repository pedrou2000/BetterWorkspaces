/*
 * BetterWorkspaces — ui/PanelIndicator.js
 *
 * Always-on panel surface (Design Doc §5.1). Renders one clickable button per
 * project (M3: name labels; Notion icons arrive in M6), highlights the active
 * project, and appends a compact within-project position label ("2/3"). Reads
 * Controller state; emits intents by calling Controller methods. Left-click a
 * project button -> switch to that project.
 *
 * Released under the GNU General Public License v2 (see LICENSE).
 */
const St = imports.gi.St;
const Lang = imports.lang;
const Clutter = imports.gi.Clutter;

const UUID = "better-workspaces@pedrou2000";
function log(msg) { global.log(UUID + " [panel]: " + msg); }

function PanelIndicator(appletActor, controller) {
    this._init(appletActor, controller);
}

PanelIndicator.prototype = {

    _init: function (appletActor, controller) {
        this.actor = appletActor;      // the applet's own St.BoxLayout
        this.controller = controller;
        this._buttons = [];
        this._posLabel = null;
        this.rebuild();
    },

    // Full rebuild: one button per project + a trailing position label.
    rebuild: function () {
        this.actor.destroy_all_children();
        this._buttons = [];

        let nProjects = this.controller.state.projectCount();
        for (let i = 0; i < nProjects; i++) {
            let p = this.controller.state.getProject(i);
            let btn = new St.Button({
                style_class: 'better-workspaces-project',
                reactive: true,
                label: p.name,
            });
            btn._projectIdx = i;
            btn.connect('clicked', Lang.bind(this, function (b) {
                this.controller.goToProject(b._projectIdx);
                this.update();
            }));
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
        if (this.actor) this.actor.destroy_all_children();
        this._buttons = [];
        this._posLabel = null;
    },
};
