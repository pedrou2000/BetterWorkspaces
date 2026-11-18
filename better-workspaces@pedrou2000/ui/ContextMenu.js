/* ui/ContextMenu.js — the applet's right-click menu, retargeted to what was clicked. */

// A project icon gets that project's actions; anywhere else gets the general
// ones. Every item is created ONCE and only shown/hidden and relabelled per
// right-click: Cinnamon's PopupMenu keeps a signal-manager entry (and so the
// item itself) for every item ever added, even after the item is destroyed, so
// building items per click would leak each one. Actions address the project by
// id, resolved when activated, so they can't go stale when the deck changes.
// Cinnamon appends its own About/Configure/Remove entries after ours.

const PopupMenu = imports.ui.popupMenu;

const AppletDir = imports.ui.appletManager.applets["better-workspaces@pedrou2000"];
const L = AppletDir.lib.logger.Logger.makeLogger("menu");

var ContextMenu = class ContextMenu {
    // deps: {
    //   menu: the applet's context menu,
    //   controller,
    //   onManage(), onSync(), onRemoveProject(projectId),
    //   onNewProject(parentProjectId | null), onDeleteProject(projectId),
    //   shortcutHint(settingKey) -> "Super+P" | "",
    //   afterAction(),
    // }
    constructor(deps) {
        this._menu = deps.menu;
        this._controller = deps.controller;
        this._deps = deps;
        this._targetId = null; // the project the project items act on
        this._items = [];

        const c = this._controller;
        this._header = this._add(new PopupMenu.PopupMenuItem("", { reactive: false }));
        this._openNotion = this._action("Open Notion page", (i) => {
            this._goTo(i);
            c.openActiveProjectHome();
        });
        this._moveHere = this._action("Move focused window here", (i) => c.moveWindowToProject(i));
        this._newSub = this._action("New sub-project…", () =>
            this._deps.onNewProject(this._targetId),
        );
        this._separator = this._add(new PopupMenu.PopupSeparatorMenuItem());
        this._remove = this._action("Remove from workspaces", () =>
            this._deps.onRemoveProject(this._targetId),
        );
        this._delete = this._action("Delete in Notion…", () =>
            this._deps.onDeleteProject(this._targetId),
        );
        this._projectItems = this._items.slice();

        this._manage = this._action(
            "Manage workspace projects…",
            () => this._deps.onManage(),
            true,
        );
        this._newProject = this._action("New project…", () => this._deps.onNewProject(null), true);
        this._sync = this._action("Sync with Notion now", () => this._deps.onSync(), true);

        this.populate(null);
    }

    // projectId: the deck project that was right-clicked, or null for the general menu.
    populate(projectId) {
        const state = this._controller.state;
        const idx = projectId ? state.indexOfProjectId(projectId) : -1;
        const forProject = idx >= 0;
        this._targetId = forProject ? projectId : null;

        for (let i = 0; i < this._projectItems.length; i++) {
            this._projectItems[i].actor.visible = forProject;
        }
        this._manage.actor.visible = !forProject;
        this._newProject.actor.visible = !forProject;
        this._sync.actor.visible = !forProject;
        this._manage.label.set_text(this._withHint("Manage workspace projects…", "kbTogglePanel"));
        this._newProject.label.set_text(this._withHint("New project…", "kbNewProject"));
        this._sync.label.set_text(this._withHint("Sync with Notion now", "kbSyncNow"));
        if (!forProject) return;

        const p = state.getProject(idx);
        const here = this._isAt(idx);
        this._header.label.set_text(p.name);
        this._openNotion.actor.visible = !!p.notionUrl;
        // Shortcut hints show on every project's menu, to make the shortcuts
        // discoverable — though a shortcut acts on the project you are ON, while
        // the menu entry acts on the one you right-clicked.
        this._openNotion.label.set_text(this._withHint("Open Notion page", "kbOpenNotion"));
        this._moveHere.actor.visible = !here;
        this._newSub.label.set_text(this._withHint("New sub-project…", "kbNewSubProject"));
        this._remove.label.set_text(this._withHint("Remove from workspaces", "kbRemoveProject"));
        this._delete.label.set_text(this._withHint("Delete in Notion…", "kbDeleteProject"));
    }

    // Insert at our own running index so we stay above Cinnamon's entries.
    _add(item) {
        this._menu.addMenuItem(item, this._items.length);
        this._items.push(item);
        return item;
    }

    // Project actions get the target's CURRENT deck index (the deck can change
    // while the menu is open) and are skipped if it has left the deck.
    _action(label, fn, general) {
        const item = new PopupMenu.PopupMenuItem(label);
        item.connect("activate", () => {
            try {
                if (general) {
                    fn();
                } else {
                    const idx = this._controller.state.indexOfProjectId(this._targetId);
                    if (idx >= 0) fn(idx);
                }
            } catch (e) {
                L.error("'" + label + "': " + e.toString());
            }
            if (this._deps.afterAction) this._deps.afterAction();
        });
        return this._add(item);
    }

    _withHint(label, settingKey) {
        const hint = this._deps.shortcutHint ? this._deps.shortcutHint(settingKey) : "";
        return hint ? label + "  (" + hint + ")" : label;
    }

    _isAt(idx) {
        const loc = this._controller.currentLocation();
        return !!loc && loc.projectIdx === idx;
    }

    // "Open Notion page" opens the ACTIVE project's page, so make `idx` active.
    // Already there: only sync the model (goToProject would jump to its last-used
    // workspace, which external navigation can leave stale).
    _goTo(idx) {
        if (this._isAt(idx)) this._controller.state.setActiveProject(idx);
        else this._controller.goToProject(idx);
    }

    destroy() {
        for (let i = 0; i < this._items.length; i++) this._items[i].destroy();
        this._items = [];
        this._projectItems = [];
    }
};
