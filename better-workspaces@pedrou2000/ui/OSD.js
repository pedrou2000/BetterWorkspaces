/* ui/OSD.js — transient project-aware workspace OSD, replacing Cinnamon's flat one. */

const St = imports.gi.St;
const Gio = imports.gi.Gio;
const Main = imports.ui.main;
const Mainloop = imports.mainloop;

const AppletDir = imports.ui.appletManager.applets["better-workspaces@pedrou2000"];
const OSD_HIDE_MS = AppletDir.lib.constants.Constants.OSD_HIDE_MS;
const DialogStyle = AppletDir.ui.DialogStyle.DialogStyle;

const L = AppletDir.lib.logger.Logger.makeLogger("osd");

var OSD = class OSD {
    constructor() {
        this._label = null;
        this._timer = 0;
        this._cinSettings = null;
        this._builtinWasVisible = undefined;
    }

    // Where the user is now: "Project  ·  2/3".
    show(controller) {
        const loc = controller.currentLocation();
        const p = loc ? controller.state.getProject(loc.projectIdx) : null;
        if (p) this.showText(p.name + "  ·  " + (loc.localIdx + 1) + "/" + p.wsCount);
    }

    // Timer resets on each call, so rapid navigation keeps one OSD alive.
    showText(text) {
        try {
            if (!this._label) {
                this._label = new St.Label();
                this._label.hide();
                Main.uiGroup.add_actor(this._label);
            }
            // Set each time: the label outlives a change of the look setting.
            this._label.style_class = DialogStyle.className("better-workspaces-osd");
            this._label.set_text(text);

            const mon = Main.layoutManager.primaryMonitor;
            this._label.show();
            const w = this._label.get_width();
            this._label.set_position(
                mon.x + Math.floor((mon.width - w) / 2),
                mon.y + Math.floor(mon.height * 0.78),
            );

            if (this._timer) Mainloop.source_remove(this._timer);
            this._timer = Mainloop.timeout_add(OSD_HIDE_MS, () => {
                this._timer = 0;
                if (this._label) this._label.hide();
                return false;
            });
        } catch (e) {
            L.error("showText: " + e.toString());
        }
    }

    // Toggle org.cinnamon's workspace-osd-visible off; original saved for restore.
    suppressBuiltin() {
        try {
            const src = Gio.SettingsSchemaSource.get_default();
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
        if (this._timer) {
            Mainloop.source_remove(this._timer);
            this._timer = 0;
        }
        if (this._label) {
            this._label.destroy();
            this._label = null;
        }
    }
};
