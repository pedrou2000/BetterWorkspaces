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
const DND = imports.ui.dnd;

const AppletDir = imports.ui.appletManager.applets["better-workspaces@pedrou2000"];
const IconRenderer = AppletDir.ui.IconRenderer.IconRenderer;
const L = AppletDir.lib.logger.Logger.makeLogger("toggle-panel");

const ROW_ICON_SIZE = 20;

function ProjectTogglePanel(getProjects, onToggle, onReorder) {
    this._init(getProjects, onToggle, onReorder);
}

ProjectTogglePanel.prototype = {

    // getProjects(): returns the current array of {id,name,icon,inWorkspace,...},
    //   with the ON (inWorkspace) projects already in deck order.
    // onToggle(project, newValue, doneCb): performs the change; doneCb(err).
    // onReorder(fromOnIdx, toOnIdx): reorder among the ON projects (deck order).
    _init: function (getProjects, onToggle, onReorder) {
        this._getProjects = getProjects;
        this._onToggle = onToggle;
        this._onReorder = onReorder;
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

        // Search box: a magnifier icon on the left (reads as a search field),
        // plus a couple of leading spaces in the hint so the placeholder text
        // clears the caret (caret + hint share the text origin while empty).
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

        // Make the list a DnD drop target so dragged ON rows can be reordered.
        this._installDropTarget();

        this._renderRows();

        this._dialog.setButtons([{
            label: "Close",
            action: Lang.bind(this, this.close),
            key: Clutter.KEY_Escape,
        }]);

        this._dialog.open();
        global.stage.set_key_focus(this._search);
    },

    // Make the list box a Cinnamon DnD drop target. handleDragOver shows a drop
    // hint and reports MOVE_DROP; acceptDrop computes the target slot from the
    // pointer y (relative to ON-row centers) and calls onReorder.
    _installDropTarget: function () {
        let self = this;
        this._listBox._delegate = {
            handleDragOver: function (source, actor, x, y, time) {
                let slot = self._dropSlotForY(y);
                self._showDropHint(slot);
                return DND.DragMotionResult.MOVE_DROP;
            },
            handleDragOut: function () { self._clearDropHint(); },
            acceptDrop: function (source, actor, x, y, time) {
                let from = (source && source._bwOnIdx !== undefined) ? source._bwOnIdx : -1;
                let slot = self._dropSlotForY(y);
                self._clearDropHint();
                if (from < 0) return false;
                // slot is an insertion point 0..count. After removing `from`,
                // the insertion index shifts down by one if slot was past it.
                let target = slot;
                if (target > from) target -= 1;
                if (target !== from && target >= 0) {
                    self._onReorder(from, target);
                    self._renderRows();
                }
                return true;
            },
        };
    },

    // Given a y (in listBox local coords), return the insertion slot 0..onCount
    // by comparing against ON-row vertical centers.
    _dropSlotForY: function (y) {
        let rows = this._onRowActors || [];
        for (let i = 0; i < rows.length; i++) {
            let box = rows[i].get_allocation_box();
            let center = (box.y1 + box.y2) / 2;
            if (y < center) return i;
        }
        return rows.length;
    },

    _showDropHint: function (slot) {
        // Lightweight hint: highlight the row currently at the target slot.
        this._clearDropHint();
        let rows = this._onRowActors || [];
        let idx = Math.min(slot, rows.length - 1);
        if (idx >= 0 && rows[idx]) {
            rows[idx].add_style_pseudo_class('drop-target');
            this._hintedRow = rows[idx];
        }
    },

    _clearDropHint: function () {
        if (this._hintedRow) {
            try { this._hintedRow.remove_style_pseudo_class('drop-target'); } catch (e) {}
            this._hintedRow = null;
        }
    },

    _renderRows: function () {
        this._listBox.destroy_all_children();
        this._rows = [];
        this._onRowActors = []; // ON rows in display order, for drop hit-testing

        let projects = this._getProjects() || [];
        let matches = Lang.bind(this, function (p) {
            return !this._filter || p.name.toLowerCase().indexOf(this._filter) !== -1;
        });

        // ON projects in deck order (getProjects returns them sorted); an ON
        // project's position here == its deck index.
        let onProjects = projects.filter(function (p) { return p.inWorkspace; });
        let offProjects = projects.filter(function (p) { return !p.inWorkspace; });

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
    },

    _sectionHeader: function (text) {
        return new St.Label({ style_class: 'better-workspaces-toggle-section', text: text });
    },

    // onIdx: index among ON projects (deck index) if this is an ON row, else -1.
    _addRow: function (project, onIdx) {
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

        let icon = IconRenderer.makeActor(project.icon, project.name, ROW_ICON_SIZE);
        row.add(icon, { y_align: St.Align.MIDDLE, y_fill: false });

        let name = new St.Label({
            style_class: 'better-workspaces-toggle-name',
            text: project.name,
        });
        row.add(name, { expand: true, y_align: St.Align.MIDDLE, y_fill: false });

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

        // Make ON rows draggable to reorder, using Cinnamon's DnD protocol.
        if (onIdx >= 0) {
            row._bwOnIdx = onIdx;
            this._onRowActors.push(row);
            this._makeRowDraggable(row);
        }
    },

    // Attach drag behavior to an ON row. The row is its own DnD delegate: it
    // provides a drag actor (a labeled clone) and, on a successful drop handled
    // by the list's drop target, the reorder happens there.
    _makeRowDraggable: function (row) {
        let self = this;
        row._delegate = row;
        row.getDragActor = function () {
            let clone = new St.Label({
                style_class: 'better-workspaces-drag-actor',
                text: row.get_children ? self._rowLabelText(row) : "project",
            });
            return clone;
        };
        row.getDragActorSource = function () { return row; };

        let draggable = DND.makeDraggable(row);
        draggable.connect('drag-begin', function () { self._dragActive = true; });
        draggable.connect('drag-end', function () { self._dragActive = false; self._clearDropHint(); });
        draggable.connect('drag-cancelled', function () { self._dragActive = false; self._clearDropHint(); });
    },

    _rowLabelText: function (row) {
        // Best-effort: pull the project name label out of the row's children.
        try {
            let kids = row.get_children();
            for (let i = 0; i < kids.length; i++) {
                if (kids[i].style_class === 'better-workspaces-toggle-name')
                    return kids[i].get_text();
            }
        } catch (e) {}
        return "project";
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
                // Membership changed — re-render so the row moves between the
                // "In workspaces" and "Other projects" sections.
                project.inWorkspace = newValue;
                this._renderRows();
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
