/*
 * BetterWorkspaces — ui/ProjectSwitcher.js
 *
 * The Super+Tab MRU overlay (Design Doc §5.2). A transient centered popup
 * listing projects in recency order; each Tab advances the selection, and on
 * trigger it commits by switching to the selected project. M3 uses a simple
 * "show briefly, advance, auto-commit" model rather than a full modal key-grab
 * (that refinement is noted for later): every Super+Tab advances the highlight
 * and resets a short timer; when the timer fires, we switch.
 *
 * Released under the GNU General Public License v2 (see LICENSE).
 */
const St = imports.gi.St;
const Main = imports.ui.main;
const Lang = imports.lang;
const Mainloop = imports.mainloop;

const AppletDir = imports.ui.appletManager.applets["better-workspaces@pedrou2000"];
const IconRenderer = AppletDir.ui.IconRenderer.IconRenderer;
const _L = AppletDir.lib.logger.Logger.makeLogger("switcher");
function log(msg) { _L.log(msg); }

const COMMIT_DELAY_MS = 600; // after the last Tab, commit to the selection

function ProjectSwitcher(controller) {
    this._init(controller);
}

ProjectSwitcher.prototype = {

    _init: function (controller) {
        this.controller = controller;
        this._overlay = null;
        this._order = [];        // project indices in MRU order (this cycle)
        this._selection = 0;     // index into _order
        this._commitTimer = 0;
        this._onCommit = null;   // optional callback() after committing
    },

    onCommit: function (cb) { this._onCommit = cb; },

    // Called on each Super+Tab press. Opens the overlay on first press, then
    // advances the highlighted selection and (re)arms the commit timer.
    cycle: function () {
        if (!this._overlay) {
            this._order = this.controller.state.mruOrder();
            // Start the highlight on the *second* entry (Alt-Tab feel: first
            // press targets the previous project, not the current one).
            this._selection = this._order.length > 1 ? 1 : 0;
            this._buildOverlay();
        } else {
            this._selection = (this._selection + 1) % this._order.length;
        }
        this._renderSelection();
        this._armCommit();
    },

    _armCommit: function () {
        if (this._commitTimer) Mainloop.source_remove(this._commitTimer);
        this._commitTimer = Mainloop.timeout_add(
            COMMIT_DELAY_MS, Lang.bind(this, this._commit));
    },

    _commit: function () {
        this._commitTimer = 0;
        let projectIdx = this._order[this._selection];
        this._close();
        this.controller.goToProject(projectIdx);
        log("committed to project " + projectIdx);
        if (this._onCommit) { try { this._onCommit(); } catch (e) {} }
        return false; // don't repeat the timeout
    },

    _buildOverlay: function () {
        let monitor = Main.layoutManager.primaryMonitor;

        // Vertical list: one row per project (icon + name), so long names fit
        // and it reads like the panel. Scrollable if the list is very tall.
        this._overlay = new St.BoxLayout({
            style_class: 'better-workspaces-switcher',
            vertical: true,
        });

        this._cards = [];
        for (let i = 0; i < this._order.length; i++) {
            let p = this.controller.state.getProject(this._order[i]);
            let card = new St.BoxLayout({
                style_class: 'better-workspaces-switcher-card',
                vertical: false,
            });
            let icon = IconRenderer.makeActor(p ? p.icon : null, p ? p.name : "?", 20);
            card.add(icon, { y_align: St.Align.MIDDLE, y_fill: false });
            card.add(new St.Label({
                style_class: 'better-workspaces-switcher-name',
                text: p ? p.name : "?",
            }), { y_align: St.Align.MIDDLE, y_fill: false });
            this._overlay.add(card);
            this._cards.push(card);
        }

        Main.uiGroup.add_actor(this._overlay);

        // Center on the primary monitor.
        let [w, h] = this._overlay.get_size();
        this._overlay.set_position(
            monitor.x + Math.floor((monitor.width - w) / 2),
            monitor.y + Math.floor((monitor.height - h) / 2));
    },

    _renderSelection: function () {
        for (let i = 0; i < this._cards.length; i++) {
            if (i === this._selection)
                this._cards[i].add_style_pseudo_class('selected');
            else
                this._cards[i].remove_style_pseudo_class('selected');
        }
    },

    _close: function () {
        if (this._overlay) {
            Main.uiGroup.remove_actor(this._overlay);
            this._overlay.destroy();
            this._overlay = null;
            this._cards = [];
        }
    },

    destroy: function () {
        if (this._commitTimer) {
            Mainloop.source_remove(this._commitTimer);
            this._commitTimer = 0;
        }
        this._close();
        this.controller = null;
    },
};
