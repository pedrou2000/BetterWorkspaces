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
const Clutter = imports.gi.Clutter;
const ModalDialog = imports.ui.modalDialog;

const AppletDir = imports.ui.appletManager.applets["better-workspaces@pedrou2000"];
const IconRenderer = AppletDir.ui.IconRenderer.IconRenderer;
const DndReorderHelper = AppletDir.ui.DndReorder.DndReorderHelper;
const L = AppletDir.lib.logger.Logger.makeLogger("toggle-panel");

const ROW_ICON_SIZE = AppletDir.lib.constants.Constants.ROW_ICON_SIZE;

var ProjectTogglePanel = class ProjectTogglePanel {

    // getProjects(): returns the current array of {id,name,icon,inWorkspace,...},
    //   with the ON (inWorkspace) projects already in deck order.
    // onToggle(project, newValue, doneCb): performs the change; doneCb(err).
    // onReorder(fromOnIdx, toOnIdx): reorder among the ON projects (deck order).
    constructor(getProjects, onToggle, onReorder) {
        this._getProjects = getProjects;
        this._onToggle = onToggle;
        this._onReorder = onReorder;
        this._rows = [];
        this._filter = "";

        // Drag-to-reorder for the ON rows (shared ui/DndReorder helper).
        this._dnd = new DndReorderHelper({
            axis: 'y',
            getItems: () => this._onRowActors || [],
            onReorder: (from, to) => {
                this._onReorder(from, to);
                this._renderRows();
            },
        });
    }

    open() {
        this._dialog = new ModalDialog.ModalDialog();

        let box = new St.BoxLayout({
            vertical: true,
            style_class: 'better-workspaces-toggle-panel',
        });
        this._dialog.contentLayout.add(box);

        box.add(new St.Label({
            style_class: 'better-workspaces-toggle-title',
            text: "Workspace projects",
        }));

        // Search box: a magnifier icon on the left (reads as a search field),
        // plus a leading space in the hint so the placeholder text clears the
        // caret (caret + hint share the text origin while empty).
        this._search = new St.Entry({
            style_class: 'better-workspaces-toggle-search',
            hint_text: " Search projects…",
            can_focus: true,
        });
        try {
            this._search.set_primary_icon(new St.Icon({
                icon_name: "edit-find-symbolic",
                icon_size: 14,
                style_class: 'better-workspaces-search-icon',
            }));
        } catch (e) {}
        this._search.clutter_text.connect('text-changed', () => {
            this._filter = this._search.get_text().toLowerCase();
            this._renderRows();
        });
        box.add(this._search);

        // Scrollable list.
        this._scroll = new St.ScrollView({ style_class: 'better-workspaces-toggle-scroll' });
        this._scroll.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);
        this._listBox = new St.BoxLayout({ vertical: true });
        this._scroll.add_actor(this._listBox);
        box.add(this._scroll, { expand: true });

        // Make the list a DnD drop target so dragged ON rows can be reordered.
        this._dnd.attachTo(this._listBox);

        this._renderRows();

        this._dialog.setButtons([{
            label: "Close",
            action: () => this.close(),
            key: Clutter.KEY_Escape,
        }]);

        this._dialog.open();
        global.stage.set_key_focus(this._search);
    }

    _renderRows() {
        this._listBox.destroy_all_children();
        this._rows = [];
        this._onRowActors = []; // ON rows in display order, for drop hit-testing

        let projects = this._getProjects() || [];
        let matches = (p) => !this._filter || p.name.toLowerCase().indexOf(this._filter) !== -1;

        // ON projects in deck order (getProjects returns them sorted); an ON
        // project's position here == its deck index.
        let onProjects = projects.filter((p) => p.inWorkspace);
        let offProjects = projects.filter((p) => !p.inWorkspace);

        // --- Active section: draggable to reorder ---
        this._listBox.add(this._sectionHeader("In workspaces — drag to reorder"));
        let shownOn = 0;
        for (let i = 0; i < onProjects.length; i++) {
            if (!matches(onProjects[i])) continue;
            this._addRow(onProjects[i], i);
            shownOn++;
        }
        if (shownOn === 0) {
            this._listBox.add(new St.Label({
                style_class: 'better-workspaces-toggle-empty',
                text: this._filter ? "No matching active projects" : "None yet — toggle some on below",
            }));
        }

        // --- Other projects section ---
        this._listBox.add(this._sectionHeader("Other projects"));
        let shownOff = 0;
        for (let i = 0; i < offProjects.length; i++) {
            if (!matches(offProjects[i])) continue;
            this._addRow(offProjects[i], -1);
            shownOff++;
        }
        if (shownOff === 0) {
            this._listBox.add(new St.Label({
                style_class: 'better-workspaces-toggle-empty',
                text: this._filter ? "No matching projects" : "—",
            }));
        }
    }

    _sectionHeader(text) {
        return new St.Label({ style_class: 'better-workspaces-toggle-section', text: text });
    }

    // onIdx: index among ON projects (deck index) if this is an ON row, else -1.
    _addRow(project, onIdx) {
        let row = new St.BoxLayout({
            style_class: 'better-workspaces-toggle-row',
            vertical: false,
            reactive: true, // needed for DnD to receive button-press
        });

        // Drag handle glyph (ON rows only) as an affordance.
        row.add(new St.Label({
            style_class: 'better-workspaces-drag-handle',
            text: onIdx >= 0 ? "⋮⋮" : "",
        }), { y_align: St.Align.MIDDLE, y_fill: false });

        row.add(IconRenderer.makeActor(project.icon, project.name, ROW_ICON_SIZE),
            { y_align: St.Align.MIDDLE, y_fill: false });

        row.add(new St.Label({
            style_class: 'better-workspaces-toggle-name',
            text: project.name,
        }), { expand: true, y_align: St.Align.MIDDLE, y_fill: false });

        let toggle = new St.Button({
            style_class: 'better-workspaces-toggle-switch',
            reactive: true,
            toggle_mode: true,
        });
        toggle.set_checked(!!project.inWorkspace);
        this._paintToggle(toggle);
        toggle.connect('clicked', (btn) => this._onRowToggled(project, btn));
        row.add(toggle, { y_align: St.Align.MIDDLE, y_fill: false });

        this._listBox.add(row);
        this._rows.push({ project: project, toggle: toggle });

        // Make ON rows draggable to reorder; the floating drag actor is a
        // label with the project name.
        if (onIdx >= 0) {
            this._onRowActors.push(row);
            this._dnd.makeDraggable(row, onIdx, () => new St.Label({
                style_class: 'better-workspaces-drag-actor',
                text: project.name,
            }));
        }
    }

    _paintToggle(toggle) {
        toggle.set_label(toggle.get_checked() ? "ON" : "OFF");
        if (toggle.get_checked()) toggle.add_style_pseudo_class('checked');
        else toggle.remove_style_pseudo_class('checked');
    }

    _onRowToggled(project, toggle) {
        let newValue = toggle.get_checked();
        this._paintToggle(toggle);
        toggle.reactive = false; // lock while the change is in flight

        this._onToggle(project, newValue, (err) => {
            toggle.reactive = true;
            if (err) {
                // Revert on failure.
                L.log("toggle for '" + project.name + "' failed (" + err + "), reverting");
                toggle.set_checked(!newValue);
                this._paintToggle(toggle);
            } else {
                // Membership changed — re-render so the row moves between the
                // "In workspaces" and "Other projects" sections.
                project.inWorkspace = newValue;
                this._renderRows();
            }
        });
    }

    close() {
        if (this._dialog) {
            this._dialog.close();
            this._dialog = null;
        }
    }

    destroy() {
        this.close();
        this._rows = [];
    }
};
