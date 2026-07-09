/* ui/ProjectSwitcher.js — the Super+Tab MRU overlay. */

// No modal key-grab: each press advances the highlight and resets a short timer;
// when it fires, we commit the switch.

const St = imports.gi.St;
const Main = imports.ui.main;
const Mainloop = imports.mainloop;

const AppletDir = imports.ui.appletManager.applets["better-workspaces@pedrou2000"];
const IconRenderer = AppletDir.ui.IconRenderer.IconRenderer;
const L = AppletDir.lib.logger.Logger.makeLogger("switcher");

const COMMIT_DELAY_MS = AppletDir.lib.constants.Constants.COMMIT_DELAY_MS;
const CARD_ICON_SIZE = AppletDir.lib.constants.Constants.ROW_ICON_SIZE;

var ProjectSwitcher = class ProjectSwitcher {

    constructor(controller) {
        this.controller = controller;
        this._overlay = null;
        this._order = [];        // project indices in MRU order (this cycle)
        this._selection = 0;     // index into _order
        this._commitTimer = 0;
        this._onCommit = null;   // optional callback() after committing
    }

    onCommit(cb) { this._onCommit = cb; }

    cycle() {
        if (!this._overlay) {
            this._order = this.controller.state.mruOrder();
            // Start on the 2nd entry (Alt-Tab feel: first press = previous project).
            this._selection = this._order.length > 1 ? 1 : 0;
            this._buildOverlay();
        } else {
            this._selection = (this._selection + 1) % this._order.length;
        }
        this._renderSelection();
        this._armCommit();
    }

    _armCommit() {
        if (this._commitTimer) Mainloop.source_remove(this._commitTimer);
        this._commitTimer = Mainloop.timeout_add(COMMIT_DELAY_MS, () => this._commit());
    }

    _commit() {
        this._commitTimer = 0;
        let projectIdx = this._order[this._selection];
        this._close();
        this.controller.goToProject(projectIdx);
        L.log("committed to project " + projectIdx);
        if (this._onCommit) { try { this._onCommit(); } catch (e) {} }
        return false; // don't repeat the timeout
    }

    _buildOverlay() {
        let monitor = Main.layoutManager.primaryMonitor;

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
            card.add(IconRenderer.makeActor(p ? p.icon : null, p ? p.name : "?", CARD_ICON_SIZE),
                { y_align: St.Align.MIDDLE, y_fill: false });
            card.add(new St.Label({
                style_class: 'better-workspaces-switcher-name',
                text: p ? p.name : "?",
            }), { y_align: St.Align.MIDDLE, y_fill: false });
            this._overlay.add(card);
            this._cards.push(card);
        }

        Main.uiGroup.add_actor(this._overlay);

        let [w, h] = this._overlay.get_size();
        this._overlay.set_position(
            monitor.x + Math.floor((monitor.width - w) / 2),
            monitor.y + Math.floor((monitor.height - h) / 2));
    }

    _renderSelection() {
        for (let i = 0; i < this._cards.length; i++) {
            if (i === this._selection)
                this._cards[i].add_style_pseudo_class('selected');
            else
                this._cards[i].remove_style_pseudo_class('selected');
        }
    }

    _close() {
        if (this._overlay) {
            Main.uiGroup.remove_actor(this._overlay);
            this._overlay.destroy();
            this._overlay = null;
            this._cards = [];
        }
    }

    destroy() {
        if (this._commitTimer) {
            Mainloop.source_remove(this._commitTimer);
            this._commitTimer = 0;
        }
        this._close();
        this.controller = null;
    }
};
