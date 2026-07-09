/* ui/ProjectSwitcher.js — the Super+Tab MRU overlay. */

// Real Alt-Tab feel: hold the modifier, Tab cycles the highlight, releasing the
// modifier commits. We take a modal grab so every Tab/arrow/release routes here
// (the keybinding manager only fires the FIRST press). Commit is driven purely by
// modifier release — no timeout.

const Clutter = imports.gi.Clutter;
const St = imports.gi.St;
const Main = imports.ui.main;

const AppletDir = imports.ui.appletManager.applets["better-workspaces@pedrou2000"];
const IconRenderer = AppletDir.ui.IconRenderer.IconRenderer;
const L = AppletDir.lib.logger.Logger.makeLogger("switcher");

const CARD_ICON_SIZE = AppletDir.lib.constants.Constants.ROW_ICON_SIZE;

// The single highest modifier bit — the launching modifier (Super), ignoring
// lower bits like numlock/capslock so they can't stop the release from committing.
function _primaryModifier(mask) {
    if (mask === 0) return 0;
    let bit = 1;
    while (mask > 1) {
        mask >>= 1;
        bit <<= 1;
    }
    return bit;
}

var ProjectSwitcher = class ProjectSwitcher {
    constructor(controller) {
        this.controller = controller;
        this._overlay = null;
        this._order = []; // project indices in MRU order (this cycle)
        this._selection = 0; // index into _order
        this._modMask = 0; // launching modifier bit; commit when it releases
        this._grabbed = false;
        this._onCommit = null; // optional callback() after committing
    }

    onCommit(cb) {
        this._onCommit = cb;
    }

    // First Super+Tab opens + grabs; later presses arrive via _keyPressEvent.
    cycle() {
        if (this._overlay) return;
        this._order = this.controller.state.mruOrder();
        if (this._order.length === 0) return;
        // Start on the 2nd entry (Alt-Tab feel: first press = previous project).
        this._selection = this._order.length > 1 ? 1 : 0;

        const [, , mods] = global.get_pointer();
        this._modMask = _primaryModifier(mods & Clutter.ModifierType.MODIFIER_MASK);

        // No modifier held (e.g. rebound to a modifier-less key): there's nothing
        // to release, so just switch to the selection without an overlay.
        if (this._modMask === 0) {
            this.controller.goToProject(this._order[this._selection]);
            this._fireCommit();
            return;
        }

        this._buildOverlay();
        if (!this._grab()) {
            // Grab unavailable (another modal up): commit immediately, no overlay.
            this._close();
            this.controller.goToProject(this._order[this._selection]);
            this._fireCommit();
        }
    }

    _grab() {
        if (!Main.pushModal(this._overlay)) return false;
        this._grabbed = true;
        this._keyPressId = this._overlay.connect("key-press-event", (a, e) => this._onKeyPress(e));
        this._keyReleaseId = this._overlay.connect("key-release-event", () => this._onKeyRelease());
        global.stage.set_key_focus(this._overlay);
        return true;
    }

    _onKeyPress(event) {
        const sym = event.get_key_symbol();
        if (sym === Clutter.KEY_Escape) {
            this._cancel();
        } else if (
            sym === Clutter.KEY_ISO_Left_Tab ||
            sym === Clutter.KEY_Up ||
            sym === Clutter.KEY_Left
        ) {
            this._advance(-1);
        } else if (
            sym === Clutter.KEY_Tab ||
            sym === Clutter.KEY_Down ||
            sym === Clutter.KEY_Right
        ) {
            this._advance(1);
        }
        return Clutter.EVENT_STOP;
    }

    // Live modifier state (not the release event's own, which still shows the key
    // as held); commit once the launching modifier is up.
    _onKeyRelease() {
        const [, , mods] = global.get_pointer();
        if ((mods & this._modMask) === 0) this._commit();
        return Clutter.EVENT_STOP;
    }

    _advance(delta) {
        const n = this._order.length;
        this._selection = (this._selection + delta + n) % n;
        this._renderSelection();
    }

    _commit() {
        const projectIdx = this._order[this._selection];
        this._close();
        this.controller.goToProject(projectIdx);
        L.log("committed to project " + projectIdx);
        this._fireCommit();
    }

    _cancel() {
        this._close();
        L.log("cancelled");
    }

    _fireCommit() {
        if (this._onCommit) {
            try {
                this._onCommit();
            } catch (e) {}
        }
    }

    _buildOverlay() {
        const monitor = Main.layoutManager.primaryMonitor;

        this._overlay = new St.BoxLayout({
            style_class: "better-workspaces-switcher",
            vertical: true,
            reactive: true,
            can_focus: true,
        });

        this._cards = [];
        for (let i = 0; i < this._order.length; i++) {
            const p = this.controller.state.getProject(this._order[i]);
            const card = new St.BoxLayout({
                style_class: "better-workspaces-switcher-card",
                vertical: false,
            });
            card.add(IconRenderer.makeActor(p ? p.icon : null, p ? p.name : "?", CARD_ICON_SIZE), {
                y_align: St.Align.MIDDLE,
                y_fill: false,
            });
            card.add(
                new St.Label({
                    style_class: "better-workspaces-switcher-name",
                    text: p ? p.name : "?",
                }),
                { y_align: St.Align.MIDDLE, y_fill: false },
            );
            this._overlay.add(card);
            this._cards.push(card);
        }

        Main.uiGroup.add_actor(this._overlay);
        this._renderSelection();

        const [w, h] = this._overlay.get_size();
        this._overlay.set_position(
            monitor.x + Math.floor((monitor.width - w) / 2),
            monitor.y + Math.floor((monitor.height - h) / 2),
        );
    }

    _renderSelection() {
        for (let i = 0; i < this._cards.length; i++) {
            if (i === this._selection) this._cards[i].add_style_pseudo_class("selected");
            else this._cards[i].remove_style_pseudo_class("selected");
        }
    }

    _close() {
        if (this._grabbed) {
            if (this._keyPressId) this._overlay.disconnect(this._keyPressId);
            if (this._keyReleaseId) this._overlay.disconnect(this._keyReleaseId);
            try {
                Main.popModal(this._overlay);
            } catch (e) {}
            this._grabbed = false;
            this._keyPressId = 0;
            this._keyReleaseId = 0;
        }
        if (this._overlay) {
            Main.uiGroup.remove_actor(this._overlay);
            this._overlay.destroy();
            this._overlay = null;
            this._cards = [];
        }
    }

    destroy() {
        this._close();
        this.controller = null;
    }
};
