/*
 * BetterWorkspaces — ui/ProjectTogglePanel.js
 *
 * The Project Toggle Panel (Design Doc §9). A modal, searchable, scrollable
 * list of ALL non-archived Notion projects, each with a toggle bound to its
 * Workspace checkbox. Flipping a toggle delegates to an onToggle handler
 * provided by the applet:
 *
 *   onToggle(project, newValue, doneCb)
 *       -> applet writes to Notion + adds/removes the project from the live
 *          deck (with confirmation on destructive removal), then calls
 *          doneCb(err). On err the panel reverts the toggle's visual state.
 *
 * The panel is pure UI: it renders rows and reflects state; it owns none of the
 * Notion/WM logic.
 *
 * Released under the GNU General Public License v2 (see LICENSE).
 */
const St = imports.gi.St;
const Lang = imports.lang;
const Clutter = imports.gi.Clutter;
const ModalDialog = imports.ui.modalDialog;

const AppletDir = imports.ui.appletManager.applets["better-workspaces@pedrou2000"];
const IconRenderer = AppletDir.ui.IconRenderer.IconRenderer;
const L = AppletDir.lib.logger.Logger.makeLogger("toggle-panel");

const ROW_ICON_SIZE = 20;

function ProjectTogglePanel(getProjects, onToggle) {
    this._init(getProjects, onToggle);
}

ProjectTogglePanel.prototype = {

    // getProjects(): returns the current array of {id,name,icon,inWorkspace,...}
    // onToggle(project, newValue, doneCb): performs the change; doneCb(err).
    _init: function (getProjects, onToggle) {
        this._getProjects = getProjects;
        this._onToggle = onToggle;
        this._rows = [];
        this._filter = "";
    },

    open: function () {
        this._dialog = new ModalDialog.ModalDialog();

        let box = new St.BoxLayout({
            vertical: true,
            style_class: 'better-workspaces-toggle-panel',
        });
        this._dialog.contentLayout.add(box);

        let title = new St.Label({
            style_class: 'better-workspaces-toggle-title',
            text: "Workspace projects",
        });
        box.add(title);

        // Search box.
        this._search = new St.Entry({
            style_class: 'better-workspaces-toggle-search',
            hint_text: "Search projects…",
            can_focus: true,
        });
        this._search.clutter_text.connect('text-changed', Lang.bind(this, function () {
            this._filter = this._search.get_text().toLowerCase();
            this._renderRows();
        }));
        box.add(this._search);

        // Scrollable list.
        this._scroll = new St.ScrollView({
            style_class: 'better-workspaces-toggle-scroll',
        });
        this._scroll.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);
        this._listBox = new St.BoxLayout({ vertical: true });
        this._scroll.add_actor(this._listBox);
        box.add(this._scroll, { expand: true });

        this._renderRows();

        this._dialog.setButtons([{
            label: "Close",
            action: Lang.bind(this, this.close),
            key: Clutter.KEY_Escape,
        }]);

        this._dialog.open();
        global.stage.set_key_focus(this._search);
    },

    _renderRows: function () {
        this._listBox.destroy_all_children();
        this._rows = [];

        let projects = this._getProjects() || [];
        for (let i = 0; i < projects.length; i++) {
            let p = projects[i];
            if (this._filter && p.name.toLowerCase().indexOf(this._filter) === -1)
                continue;
            this._addRow(p);
        }

        if (this._listBox.get_n_children() === 0) {
            this._listBox.add(new St.Label({
                style_class: 'better-workspaces-toggle-empty',
                text: this._filter ? "No matching projects" : "No projects cached yet",
            }));
        }
    },

    _addRow: function (project) {
        let row = new St.BoxLayout({
            style_class: 'better-workspaces-toggle-row',
            vertical: false,
        });

        let icon = IconRenderer.makeActor(project.icon, project.name, ROW_ICON_SIZE);
        row.add(icon, { y_align: St.Align.MIDDLE, y_fill: false });

        let name = new St.Label({
            style_class: 'better-workspaces-toggle-name',
            text: project.name,
        });
        row.add(name, { expand: true, y_align: St.Align.MIDDLE, y_fill: false });

        // Toggle as a reactive button showing on/off state.
        let toggle = new St.Button({
            style_class: 'better-workspaces-toggle-switch',
            reactive: true,
            toggle_mode: true,
        });
        toggle.set_checked(!!project.inWorkspace);
        this._paintToggle(toggle);
        toggle.connect('clicked', Lang.bind(this, function (btn) {
            this._onRowToggled(project, btn);
        }));
        row.add(toggle, { y_align: St.Align.MIDDLE, y_fill: false });

        this._listBox.add(row);
        this._rows.push({ project: project, toggle: toggle });
    },

    _paintToggle: function (toggle) {
        toggle.set_label(toggle.get_checked() ? "ON" : "OFF");
        if (toggle.get_checked()) toggle.add_style_pseudo_class('checked');
        else toggle.remove_style_pseudo_class('checked');
    },

    _onRowToggled: function (project, toggle) {
        let newValue = toggle.get_checked();
        this._paintToggle(toggle);
        toggle.reactive = false; // lock while the change is in flight

        this._onToggle(project, newValue, Lang.bind(this, function (err) {
            toggle.reactive = true;
            if (err) {
                // Revert on failure.
                L.log("toggle for '" + project.name + "' failed (" + err + "), reverting");
                toggle.set_checked(!newValue);
                this._paintToggle(toggle);
            } else {
                // Keep our cached view in sync so re-filtering shows the truth.
                project.inWorkspace = newValue;
            }
        }));
    },

    close: function () {
        if (this._dialog) {
            this._dialog.close();
            this._dialog = null;
        }
    },

    destroy: function () {
        this.close();
        this._rows = [];
    },
};

var ProjectTogglePanelModule = { ProjectTogglePanel: ProjectTogglePanel };
