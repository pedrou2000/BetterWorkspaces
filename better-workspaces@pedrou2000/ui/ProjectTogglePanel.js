/* ui/ProjectTogglePanel.js — modal searchable project list: go to one, or switch it on/off. */

// Handlers are ID-KEYED, never row/deck positions (a background sync can refresh
// the list under the panel): onToggle(project, newValue)->Promise (reject reverts
// the switch), onReorder(movedId, toOnPos), onGo(project). refresh() re-renders
// while open.
//
// Two verbs. GO (Enter, or a click on the row) takes the user to the project,
// turning it on first if needed, and closes the panel: type a name, Enter. FLIP
// (Ctrl+Enter, or a click on the switch) turns it on/off and stays open. Turning
// off closes windows unconfirmed, which is why it is the one that needs the
// modifier and why Enter is safe to aim at an auto-selected first match.
//
// Key focus never leaves the search entry (typing always filters); Tab/Down and
// Shift+Tab/Up move a highlight over the rows and then the Close button (as Tab
// would in any dialog).
//
// When a search matches no project, a "Create project …" row appears. It is
// never auto-highlighted (Tab reaches it) and only opens the name dialog via
// onCreate(text), so a typo plus Enter can't create anything.

const St = imports.gi.St;
const Clutter = imports.gi.Clutter;
const Mainloop = imports.mainloop;
const ModalDialog = imports.ui.modalDialog;

const AppletDir = imports.ui.appletManager.applets["better-workspaces@pedrou2000"];
const IconRenderer = AppletDir.ui.IconRenderer.IconRenderer;
const DndReorderHelper = AppletDir.ui.DndReorder.DndReorderHelper;
const DialogStyle = AppletDir.ui.DialogStyle.DialogStyle;
const L = AppletDir.lib.logger.Logger.makeLogger("toggle-panel");

const ROW_ICON_SIZE = AppletDir.lib.constants.Constants.ROW_ICON_SIZE;

// _selectedId values for the non-project stops; can't collide, project ids are UUIDs.
const CLOSE_STOP = "__close__";
const CREATE_STOP = "__create__";

var ProjectTogglePanel = class ProjectTogglePanel {
    // getProjects() returns {id,name,icon,inWorkspace,...} in display order: the
    // ON projects in deck order, the others as they should be listed.
    constructor(getProjects, onToggle, onReorder, onGo, onCreate) {
        this._getProjects = getProjects;
        this._onToggle = onToggle;
        this._onReorder = onReorder;
        this._onGo = onGo;
        this._onCreate = onCreate;
        this._createRow = null; // the "Create project …" row, when shown
        this._rows = [];
        this._filter = "";
        // Highlighted row, by project id so it survives re-renders and follows a
        // project across sections (or CLOSE_STOP). Empty until the user types or
        // moves; while searching it falls to the first match.
        this._selectedId = null;
        this._closeButton = null;
        this._pressedRow = null; // row under the last button press, to tell a click

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
        this._dialog = new ModalDialog.ModalDialog(DialogStyle.dialogParams());

        const box = new St.BoxLayout({
            vertical: true,
            style_class: "better-workspaces-toggle-panel better-workspaces-project-panel",
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
            // Like any search box: each new query highlights its first match.
            this._selectedId = null;
            this._renderRows();
        });
        this._search.clutter_text.connect("key-press-event", (actor, event) =>
            this._onKeyPress(event),
        );
        box.add(this._search);

        this._scroll = new St.ScrollView({ style_class: "better-workspaces-toggle-scroll" });
        this._scroll.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);
        this._listBox = new St.BoxLayout({ vertical: true });
        this._scroll.add_actor(this._listBox);
        box.add(this._scroll, { expand: true });

        box.add(this._makeHint());

        this._dnd.attachTo(this._listBox);

        this._renderRows();

        // ModalDialog hands the St.Button back on the info object.
        const closeInfo = {
            label: "Close",
            action: () => this.close(),
            key: Clutter.KEY_Escape,
        };
        this._dialog.setButtons([closeInfo]);
        this._closeButton = closeInfo.button || null;

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

        this._createRow = null;
        const typed = this._search.get_text().trim();
        if (typed && shownOn + shownOff === 0 && this._onCreate) {
            this._createRow = new St.Button({
                style_class: "better-workspaces-toggle-create",
                label: "+ Create project “" + typed + "”…",
                x_align: St.Align.START,
                reactive: true,
            });
            this._createRow.connect("clicked", () => this._create());
            this._listBox.add(this._createRow);
        }

        if (this._selectedIndex() < 0) {
            // Nothing (valid) highlighted: the first match while searching, else
            // none — never the Create row, which must be reached on purpose.
            this._selectedId = this._filter && this._rows.length ? this._rows[0].project.id : null;
        }
        this._paintSelection();
        // The new rows aren't allocated until the next frame.
        Mainloop.idle_add(() => {
            this._scrollToSelection();
            return false;
        });
    }

    // Stop order: the rows top to bottom, the Create row if shown, then Close.
    _stops() {
        const stops = this._rows.map((row) => row.project.id);
        if (this._createRow) stops.push(CREATE_STOP);
        if (this._closeButton) stops.push(CLOSE_STOP);
        return stops;
    }

    _selectedIndex() {
        return this._selectedId === null ? -1 : this._stops().indexOf(this._selectedId);
    }

    _paintSelection() {
        for (let i = 0; i < this._rows.length; i++) {
            const row = this._rows[i];
            if (row.project.id === this._selectedId) row.actor.add_style_pseudo_class("selected");
            else row.actor.remove_style_pseudo_class("selected");
        }
        if (this._createRow) {
            const picked = this._selectedId === CREATE_STOP;
            if (picked) this._createRow.add_style_pseudo_class("selected");
            else this._createRow.remove_style_pseudo_class("selected");
        }
        // The theme's own focus look, without giving up the entry's key focus.
        if (this._closeButton) {
            if (this._selectedId === CLOSE_STOP) this._closeButton.add_style_pseudo_class("focus");
            else this._closeButton.remove_style_pseudo_class("focus");
        }
    }

    // Wraps; from no selection, forward lands on the first stop and back on the last.
    _moveSelection(delta) {
        const stops = this._stops();
        const n = stops.length;
        if (n === 0) return;
        const cur = this._selectedIndex();
        const next = cur < 0 ? (delta > 0 ? 0 : n - 1) : (cur + delta + n) % n;
        this._selectedId = stops[next];
        this._paintSelection();
        this._scrollToSelection();
    }

    _scrollToSelection() {
        try {
            if (!this._dialog) return;
            const row = this._rows[this._selectedIndex()];
            if (!row) return;
            const adj = this._scroll.get_vscroll_bar().get_adjustment();
            const box = row.actor.get_allocation_box();
            const top = adj.get_value();
            if (box.y1 < top) adj.set_value(box.y1);
            else if (box.y2 > top + adj.page_size) adj.set_value(box.y2 - adj.page_size);
        } catch (e) {
            L.log("scrollToSelection: " + e.toString());
        }
    }

    _goSelection() {
        if (this._selectedId === CLOSE_STOP) {
            this.close();
            return;
        }
        if (this._selectedId === CREATE_STOP) {
            this._create();
            return;
        }
        const row = this._rows[this._selectedIndex()];
        if (row) this._go(row.project);
    }

    // Hands the typed text to the name dialog; nothing is created here.
    _create() {
        const typed = this._search.get_text().trim();
        this.close();
        try {
            if (this._onCreate) this._onCreate(typed);
        } catch (e) {
            L.error("create '" + typed + "': " + e.toString());
        }
    }

    _go(project) {
        this.close();
        try {
            if (this._onGo) this._onGo(project);
        } catch (e) {
            L.error("go to '" + project.name + "': " + e.toString());
        }
    }

    _flipSelection() {
        if (this._selectedId === CLOSE_STOP || this._selectedId === CREATE_STOP) return;
        const row = this._rows[this._selectedIndex()];
        if (!row || !row.toggle.reactive) return; // nothing picked, or change in flight
        row.toggle.set_checked(!row.toggle.get_checked()); // what a click does itself
        this._onRowToggled(row.project, row.toggle);
    }

    // Handled keys stop here so Tab doesn't also walk St's focus chain.
    _onKeyPress(event) {
        const sym = event.get_key_symbol();
        const shift = (event.get_state() & Clutter.ModifierType.SHIFT_MASK) !== 0;
        if (sym === Clutter.KEY_Down || (sym === Clutter.KEY_Tab && !shift)) {
            this._moveSelection(1);
        } else if (
            sym === Clutter.KEY_Up ||
            sym === Clutter.KEY_ISO_Left_Tab ||
            (sym === Clutter.KEY_Tab && shift)
        ) {
            this._moveSelection(-1);
        } else if (sym === Clutter.KEY_Return || sym === Clutter.KEY_KP_Enter) {
            if (event.get_state() & Clutter.ModifierType.CONTROL_MASK) this._flipSelection();
            else this._goSelection();
        } else {
            return Clutter.EVENT_PROPAGATE;
        }
        return Clutter.EVENT_STOP;
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
        // Notion look: a knob that slides, in place of the ON/OFF text.
        if (DialogStyle.is("notion")) {
            toggle._bwKnob = new St.Bin({ style_class: "better-workspaces-toggle-knob" });
            toggle.set_child(toggle._bwKnob);
        }
        toggle.set_checked(!!project.inWorkspace);
        this._paintToggle(toggle);
        toggle.connect("clicked", (btn) => this._onRowToggled(project, btn));
        row.add(toggle, { y_align: St.Align.MIDDLE, y_fill: false });

        // A plain click on the row goes there, like Enter. The switch swallows its
        // own clicks, and a drag's release is consumed by DnD, so a release that
        // reaches us after a press on this same row is a click.
        row.connect("button-press-event", (actor, event) => {
            if (event.get_button() === 1) this._pressedRow = row;
            return Clutter.EVENT_PROPAGATE;
        });
        row.connect("button-release-event", (actor, event) => {
            const clicked = this._pressedRow === row && event.get_button() === 1;
            this._pressedRow = null;
            if (!clicked) return Clutter.EVENT_PROPAGATE;
            this._go(project);
            return Clutter.EVENT_STOP;
        });

        this._listBox.add(row);
        this._rows.push({ project: project, toggle: toggle, actor: row });

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
        const on = toggle.get_checked();
        if (toggle._bwKnob) {
            toggle.set_alignment(on ? St.Align.END : St.Align.START, St.Align.MIDDLE);
        } else {
            toggle.set_label(on ? "ON" : "OFF");
        }
        if (on) toggle.add_style_pseudo_class("checked");
        else toggle.remove_style_pseudo_class("checked");
    }

    // The key hints: one line of text in the classic look; key caps with their
    // meanings, above a hairline, in the Notion look.
    _makeHint() {
        const keys = [
            ["↵", "Go"],
            ["Ctrl ↵", "On / Off"],
            ["Tab", "Move"],
            ["Esc", "Close"],
        ];
        if (!DialogStyle.is("notion")) {
            return new St.Label({
                style_class: "better-workspaces-toggle-hint",
                text: "Enter go · Ctrl+Enter turn on/off · Tab / ↑↓ move · Esc close",
            });
        }
        const footer = new St.BoxLayout({ style_class: "better-workspaces-toggle-footer" });
        const place = { y_align: St.Align.MIDDLE, y_fill: false };
        for (let i = 0; i < keys.length; i++) {
            footer.add(
                new St.Label({ style_class: "better-workspaces-key", text: keys[i][0] }),
                place,
            );
            footer.add(
                new St.Label({ style_class: "better-workspaces-key-label", text: keys[i][1] }),
                place,
            );
        }
        return footer;
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
            this._closeButton = null;
            this._createRow = null;
        }
    }

    destroy() {
        this.close();
        this._rows = [];
    }
};
