/* ui/ContextMenu.js — the applet's right-click menu, rebuilt for what was clicked. */

// A project icon gets that project's actions; anywhere else gets the general
// ones. Items are rebuilt on every right-click and address projects by id, so
// they can't go stale when the deck changes. Cinnamon appends its own
// About/Configure/Remove entries after ours; we only ever touch our own.

const PopupMenu = imports.ui.popupMenu;

const AppletDir = imports.ui.appletManager.applets["better-workspaces@pedrou2000"];
const L = AppletDir.lib.logger.Logger.makeLogger("menu");

var ContextMenu = class ContextMenu {
    // deps: {
    //   menu: the applet's context menu,
    //   controller,
    //   onManage(), onSync(), onRemoveProject(projectId),
    //   shortcutHint(settingKey) -> "Super+P" | "",
    //   afterAction(),
    // }
    constructor(deps) {
        this._menu = deps.menu;
        this._controller = deps.controller;
        this._deps = deps;
        this._items = [];
        this.populate(null);
    }

    // projectId: the deck project that was right-clicked, or null for the general menu.
    populate(projectId) {
        for (let i = 0; i < this._items.length; i++) this._items[i].destroy();
        this._items = [];

        const idx = projectId ? this._controller.state.indexOfProjectId(projectId) : -1;
        if (idx >= 0) this._addProjectItems(projectId, idx);
        else this._addGeneralItems();
    }

    // Insert at our own running index so we stay above Cinnamon's entries.
    _add(item) {
        this._menu.addMenuItem(item, this._items.length);
        this._items.push(item);
    }

    _action(label, fn) {
        const item = new PopupMenu.PopupMenuItem(label);
        item.connect("activate", () => {
            try {
                fn();
            } catch (e) {
                L.error("'" + label + "': " + e.toString());
            }
            if (this._deps.afterAction) this._deps.afterAction();
        });
        this._add(item);
    }

    _withHint(label, settingKey) {
        const hint = this._deps.shortcutHint ? this._deps.shortcutHint(settingKey) : "";
        return hint ? label + "  (" + hint + ")" : label;
    }

    _isAt(idx) {
        const loc = this._controller.currentLocation();
        return !!loc && loc.projectIdx === idx;
    }

    // The strip actions below work on the active project, so make `idx` active.
    // Already there: only sync the model (goToProject would jump to its last-used
    // workspace, which external navigation can leave stale).
    _goTo(idx) {
        if (this._isAt(idx)) this._controller.state.setActiveProject(idx);
        else this._controller.goToProject(idx);
    }

    _addProjectItems(projectId, idx) {
        const c = this._controller;
        const p = c.state.getProject(idx);
        const here = this._isAt(idx);
        // Re-resolve at activation: the deck can change while the menu is open.
        const forProject = (fn) => () => {
            const now = c.state.indexOfProjectId(projectId);
            if (now >= 0) fn(now);
        };

        this._add(new PopupMenu.PopupMenuItem(p.name, { reactive: false }));
        if (p.notionUrl) {
            this._action(
                here ? this._withHint("Open Notion page", "kbOpenNotion") : "Open Notion page",
                forProject((i) => {
                    this._goTo(i);
                    c.openActiveProjectHome();
                }),
            );
        }
        if (!here) {
            this._action(
                "Move focused window here",
                forProject((i) => c.moveWindowToProject(i)),
            );
        }
        this._action(
            "Add workspace",
            forProject((i) => {
                this._goTo(i);
                c.addWorkspaceToActiveProject();
            }),
        );
        this._action(
            "Remove empty workspaces",
            forProject((i) => {
                this._goTo(i);
                c.removeEmptyWorkspacesOfActiveProject();
            }),
        );
        this._add(new PopupMenu.PopupSeparatorMenuItem());
        this._action("Remove from workspaces", () => this._deps.onRemoveProject(projectId));
    }

    _addGeneralItems() {
        this._action(this._withHint("Manage workspace projects…", "kbTogglePanel"), () =>
            this._deps.onManage(),
        );
        this._action("Sync with Notion now", () => this._deps.onSync());
    }

    destroy() {
        for (let i = 0; i < this._items.length; i++) this._items[i].destroy();
        this._items = [];
    }
};
