/*
 * BetterWorkspaces — ui/OSD.js
 *
 * The project-aware OSD (Design Doc §5): a transient centered label shown
 * after deliberate navigation, e.g. "Job 2026  ·  2/3", replacing Cinnamon's
 * flat "Workspace N" OSD. Owns both halves of that replacement:
 *
 *   - show(controller): render + auto-hide the project/workspace overlay
 *   - suppressBuiltin() / restoreBuiltin(): toggle org.cinnamon's
 *     workspace-osd-visible (saved on suppress, restored on unload)
 *
 * Pure UI — reads the controller for "where am I", owns no model state.
 *
 * Released under the GNU General Public License v2 (see LICENSE).
 */
const St = imports.gi.St;
const Gio = imports.gi.Gio;
const Main = imports.ui.main;
const Mainloop = imports.mainloop;

const AppletDir = imports.ui.appletManager.applets["better-workspaces@pedrou2000"];
const OSD_HIDE_MS = AppletDir.lib.constants.Constants.OSD_HIDE_MS;

const L = AppletDir.lib.logger.Logger.makeLogger("osd");

var OSD = class OSD {

    constructor() {
        this._label = null;
        this._timer = 0;
        this._cinSettings = null;
        this._builtinWasVisible = undefined;
    }

    // Show "<project>  ·  <local+1>/<count>" for the controller's current
    // location, centered near the bottom of the primary monitor, auto-hiding
    // after OSD_HIDE_MS (the timer resets on each call, so rapid navigation
    // keeps one OSD alive rather than flashing).
    show(controller) {
        try {
            let loc = controller.currentLocation();
            if (!loc) return;
            let p = controller.state.getProject(loc.projectIdx);
            if (!p) return;
            let text = p.name + "  ·  " + (loc.localIdx + 1) + "/" + p.wsCount;

            if (!this._label) {
                this._label = new St.Label({ style_class: 'better-workspaces-osd' });
                this._label.hide();
                Main.uiGroup.add_actor(this._label);
            }
            this._label.set_text(text);

            // Center on the primary monitor.
            let mon = Main.layoutManager.primaryMonitor;
            this._label.show();
            let w = this._label.get_width();
            this._label.set_position(
                mon.x + Math.floor((mon.width - w) / 2),
                mon.y + Math.floor(mon.height * 0.78));

            if (this._timer) Mainloop.source_remove(this._timer);
            this._timer = Mainloop.timeout_add(OSD_HIDE_MS, () => {
                this._timer = 0;
                if (this._label) this._label.hide();
                return false;
            });
        } catch (e) {
            L.error("show: " + e.toString());
        }
    }

    // Hide Cinnamon's built-in flat "Workspace N" OSD so only ours shows.
    // org.cinnamon has a boolean 'workspace-osd-visible'; the original value
    // is saved and restored by restoreBuiltin().
    suppressBuiltin() {
        try {
            let src = Gio.SettingsSchemaSource.get_default();
            if (!src || !src.lookup("org.cinnamon", true)) return;
            this._cinSettings = new Gio.Settings({ schema_id: "org.cinnamon" });
            if (this._cinSettings.list_keys().indexOf("workspace-osd-visible") === -1) {
                this._cinSettings = null;
                return;
            }
            this._builtinWasVisible = this._cinSettings.get_boolean("workspace-osd-visible");
            this._cinSettings.set_boolean("workspace-osd-visible", false);
            L.log("built-in workspace OSD suppressed (was " + this._builtinWasVisible + ")");
        } catch (e) {
            L.error("suppressBuiltin: " + e.toString());
        }
    }

    restoreBuiltin() {
        try {
            if (this._cinSettings && this._builtinWasVisible !== undefined) {
                this._cinSettings.set_boolean("workspace-osd-visible", this._builtinWasVisible);
            }
        } catch (e) {}
        this._cinSettings = null;
    }

    destroy() {
        this.restoreBuiltin();
        if (this._timer) { Mainloop.source_remove(this._timer); this._timer = 0; }
        if (this._label) { this._label.destroy(); this._label = null; }
    }
};
