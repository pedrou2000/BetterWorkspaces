/* ui/ProjectTogglePanel.js — modal searchable list toggling projects on/off. */

// Handlers are ID-KEYED, never row/deck positions (a background sync can refresh
// the list under the panel): onToggle(project, newValue)->Promise (reject reverts
// the switch), onReorder(movedId, toOnPos). refresh() re-renders while open.

const St = imports.gi.St;
const Clutter = imports.gi.Clutter;
const ModalDialog = imports.ui.modalDialog;

const AppletDir = imports.ui.appletManager.applets["better-workspaces@pedrou2000"];
const IconRenderer = AppletDir.ui.IconRenderer.IconRenderer;
const DndReorderHelper = AppletDir.ui.DndReorder.DndReorderHelper;
const L = AppletDir.lib.logger.Logger.makeLogger("toggle-panel");

const ROW_ICON_SIZE = AppletDir.lib.constants.Constants.ROW_ICON_SIZE;

var ProjectTogglePanel = class ProjectTogglePanel {
    // getProjects() returns {id,name,icon,inWorkspace,...} with the ON projects
    // already in deck order.
    constructor(getProjects, onToggle, onReorder) {
        this._getProjects = getProjects;
        this._onToggle = onToggle;
        this._onReorder = onReorder;
        this._rows = [];
        this._filter = "";

        // DnD works in row positions; we translate the source position to the
        // project id at drop time so the applet never sees a drifted index.
        this._dnd = new DndReorderHelper({
            axis: "y",
            getItems: () => this._onRowActors || [],
            onReorder: (from, to) => {
                const row = (this._onRowActors || [])[from];
                if (row && row._bwProjectId) this._onReorder(row._bwProjectId, to);
                this._renderRows();
            },
        });
    }

    refresh() {
        if (this._dialog) this._renderRows();
    }

    open() {
        this._dialog = new ModalDialog.ModalDialog();

        const box = new St.BoxLayout({
            vertical: true,
            style_class: "better-workspaces-toggle-panel",
        });
        this._dialog.contentLayout.add(box);

        box.add(
            new St.Label({
                style_class: "better-workspaces-toggle-title",
                text: "Workspace projects",
            }),
        );

        // Leading space in the hint so the placeholder clears the caret.
        this._search = new St.Entry({
            style_class: "better-workspaces-toggle-search",
            hint_text: " Search projects…",
            can_focus: true,
        });
        try {
            this._search.set_primary_icon(
                new St.Icon({
                    icon_name: "edit-find-symbolic",
                    icon_size: 14,
                    style_class: "better-workspaces-search-icon",
                }),
            );
        } catch (e) {}
        this._search.clutter_text.connect("text-changed", () => {
            this._filter = this._search.get_text().toLowerCase();
            this._renderRows();
        });
        box.add(this._search);

        this._scroll = new St.ScrollView({ style_class: "better-workspaces-toggle-scroll" });
        this._scroll.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);
        this._listBox = new St.BoxLayout({ vertical: true });
        this._scroll.add_actor(this._listBox);
        box.add(this._scroll, { expand: true });

        this._dnd.attachTo(this._listBox);

        this._renderRows();

        this._dialog.setButtons([
            {
                label: "Close",
                action: () => this.close(),
                key: Clutter.KEY_Escape,
            },
        ]);

        this._dialog.open();
        global.stage.set_key_focus(this._search);
    }

    _renderRows() {
        this._listBox.destroy_all_children();
        this._rows = [];
        this._onRowActors = []; // ON rows in display order, for drop hit-testing

        const projects = this._getProjects() || [];
        const matches = (p) => !this._filter || p.name.toLowerCase().indexOf(this._filter) !== -1;

        const onProjects = projects.filter((p) => p.inWorkspace);
        const offProjects = projects.filter((p) => !p.inWorkspace);

        this._listBox.add(this._sectionHeader("In workspaces — drag to reorder"));
        let shownOn = 0;
        for (let i = 0; i < onProjects.length; i++) {
            if (!matches(onProjects[i])) continue;
            this._addRow(onProjects[i], i);
            shownOn++;
        }
        if (shownOn === 0) {
            this._listBox.add(
                new St.Label({
                    style_class: "better-workspaces-toggle-empty",
                    text: this._filter
                        ? "No matching active projects"
                        : "None yet — toggle some on below",
                }),
            );
        }

        this._listBox.add(this._sectionHeader("Other projects"));
        let shownOff = 0;
        for (let i = 0; i < offProjects.length; i++) {
            if (!matches(offProjects[i])) continue;
            this._addRow(offProjects[i], -1);
            shownOff++;
        }
        if (shownOff === 0) {
            this._listBox.add(
                new St.Label({
                    style_class: "better-workspaces-toggle-empty",
                    text: this._filter ? "No matching projects" : "—",
                }),
            );
        }
    }

    _sectionHeader(text) {
        return new St.Label({ style_class: "better-workspaces-toggle-section", text: text });
    }

    // onIdx: position among ON projects if this is an ON row, else -1.
    _addRow(project, onIdx) {
        const row = new St.BoxLayout({
            style_class: "better-workspaces-toggle-row",
            vertical: false,
            reactive: true, // needed for DnD to receive button-press
        });

        row.add(
            new St.Label({
                style_class: "better-workspaces-drag-handle",
                text: onIdx >= 0 ? "⋮⋮" : "",
            }),
            { y_align: St.Align.MIDDLE, y_fill: false },
        );

        row.add(IconRenderer.makeActor(project.icon, project.name, ROW_ICON_SIZE), {
            y_align: St.Align.MIDDLE,
            y_fill: false,
        });

        row.add(
            new St.Label({
                style_class: "better-workspaces-toggle-name",
                text: project.name,
            }),
            { expand: true, y_align: St.Align.MIDDLE, y_fill: false },
        );

        const toggle = new St.Button({
            style_class: "better-workspaces-toggle-switch",
            reactive: true,
            toggle_mode: true,
        });
        toggle.set_checked(!!project.inWorkspace);
        this._paintToggle(toggle);
        toggle.connect("clicked", (btn) => this._onRowToggled(project, btn));
        row.add(toggle, { y_align: St.Align.MIDDLE, y_fill: false });

        this._listBox.add(row);
        this._rows.push({ project: project, toggle: toggle });

        // Row carries its project id so the drop handler reports ids, not positions.
        if (onIdx >= 0) {
            row._bwProjectId = project.id;
            this._onRowActors.push(row);
            this._dnd.makeDraggable(
                row,
                onIdx,
                () =>
                    new St.Label({
                        style_class: "better-workspaces-drag-actor",
                        text: project.name,
                    }),
            );
        }
    }

    _paintToggle(toggle) {
        toggle.set_label(toggle.get_checked() ? "ON" : "OFF");
        if (toggle.get_checked()) toggle.add_style_pseudo_class("checked");
        else toggle.remove_style_pseudo_class("checked");
    }

    _onRowToggled(project, toggle) {
        const newValue = toggle.get_checked();
        this._paintToggle(toggle);
        toggle.reactive = false; // lock while the change is in flight

        this._onToggle(project, newValue)
            .then(() => {
                toggle.reactive = true;
                this._renderRows(); // re-read the store: the row moves between sections
            })
            .catch((e) => {
                toggle.reactive = true;
                L.log(
                    "toggle for '" +
                        project.name +
                        "' failed (" +
                        (e && e.message ? e.message : e) +
                        "), reverting",
                );
                toggle.set_checked(!newValue);
                this._paintToggle(toggle);
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
