/*
 * BetterWorkspaces — Cinnamon applet
 *
 * Skeleton: puts a label in the panel and logs on load, so we can confirm the
 * whole install -> reload -> enable loop works end to end before building the
 * real project/sub-workspace logic on top.
 *
 * Released under the GNU General Public License v2 (see LICENSE).
 */
const Applet = imports.ui.applet;

function MyApplet(orientation, panel_height, instanceId) {
    this._init(orientation, panel_height, instanceId);
}

MyApplet.prototype = {
    __proto__: Applet.TextApplet.prototype,

    _init: function (orientation, panel_height, instanceId) {
        Applet.TextApplet.prototype._init.call(this, orientation, panel_height, instanceId);

        try {
            global.log("better-workspaces@pedrou2000: loaded (skeleton v0.0.1)");
            this.set_applet_label("BetterWS");
            this.set_applet_tooltip("BetterWorkspaces — skeleton");
        } catch (e) {
            global.logError("better-workspaces@pedrou2000 init exception: " + e.toString());
        }
    },

    on_applet_clicked: function () {
        global.log("better-workspaces@pedrou2000: clicked");
    },
};

function main(metadata, orientation, panel_height, instanceId) {
    return new MyApplet(orientation, panel_height, instanceId);
}
