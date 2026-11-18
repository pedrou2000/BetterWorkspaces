"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadGjsModule } = require("./helpers/loadGjsModule");

// Fake PopupMenu that counts every item ever constructed or destroyed: Cinnamon's
// real menu retains each item added to it forever, so the menu must never create
// items after construction.
function makePopupMenu() {
    const stats = { created: 0, destroyed: 0 };
    class Item {
        constructor(text, params) {
            stats.created++;
            this.reactive = !params || params.reactive !== false;
            this.actor = { visible: true };
            const label = { text: text || "" };
            label.set_text = (t) => {
                label.text = t;
            };
            this.label = label;
            this._handlers = [];
        }
        connect(signal, fn) {
            if (signal === "activate") this._handlers.push(fn);
        }
        activate() {
            this._handlers.forEach((fn) => fn());
        }
        destroy() {
            stats.destroyed++;
        }
    }
    class PopupMenuItem extends Item {}
    class PopupSeparatorMenuItem extends Item {
        constructor() {
            super("—");
            this.separator = true;
        }
    }
    return { stats, PopupMenuItem, PopupSeparatorMenuItem };
}

function makeMenu() {
    return {
        items: [],
        addMenuItem(item, position) {
            this.items.splice(position, 0, item);
        },
    };
}

// Deck a, b (b has no Notion URL); the user is on `at`.
function makeController(at) {
    const projects = [
        { id: "a", name: "Alpha", notionUrl: "https://notion.so/a" },
        { id: "b", name: "Beta", notionUrl: null },
    ];
    const calls = [];
    const state = {
        projects,
        indexOfProjectId: (id) => projects.findIndex((p) => p.id === id),
        getProject: (i) => projects[i] || null,
        setActiveProject: (i) => calls.push("setActive:" + i),
    };
    return {
        calls,
        state,
        at,
        currentLocation() {
            return { projectIdx: this.at, localIdx: 0 };
        },
        goToProject: (i) => calls.push("goTo:" + i),
        openActiveProjectHome: () => calls.push("openHome"),
        moveWindowToProject: (i) => calls.push("moveWindow:" + i),
    };
}

function makeContextMenu(at) {
    const popupMenu = makePopupMenu();
    const ContextMenu = loadGjsModule("ui/ContextMenu.js", "ContextMenu", {
        extraImports: { ui: { popupMenu: popupMenu } },
    });
    const menu = makeMenu();
    const controller = makeController(at || 0);
    const removed = [];
    const other = [];
    const created = [];
    const deleted = [];
    const cm = new ContextMenu({
        menu,
        controller,
        onManage: () => other.push("manage"),
        onSync: () => other.push("sync"),
        onRemoveProject: (id) => removed.push(id),
        onNewProject: (parentId) => created.push(parentId),
        onDeleteProject: (id) => deleted.push(id),
        shortcutHint: (key) =>
            ({
                kbTogglePanel: "Super+P",
                kbRemoveProject: "Super+Q",
                kbNewSubProject: "Super+S",
                kbNewProject: "Super+A",
                kbSyncNow: "Super+R",
                kbOpenNotion: "Super+N",
                kbDeleteProject: "Shift+Super+Q",
            })[key] || "",
        afterAction: () => other.push("after"),
    });
    const visible = () =>
        menu.items.filter((i) => i.actor.visible && !i.separator).map((i) => i.label.text);
    const item = (prefix) => menu.items.find((i) => i.label.text.indexOf(prefix) === 0);
    return {
        cm,
        menu,
        controller,
        removed,
        other,
        created,
        deleted,
        visible,
        item,
        stats: popupMenu.stats,
    };
}

test("no item is created or destroyed after construction, however often it retargets", () => {
    const { cm, menu, stats } = makeContextMenu();
    const created = stats.created;
    assert.equal(menu.items.length, created);

    for (let i = 0; i < 500; i++) {
        cm.populate("a");
        cm.populate("b");
        cm.populate(null);
        cm.populate("gone");
    }
    assert.equal(stats.created, created);
    assert.equal(stats.destroyed, 0);
    assert.equal(menu.items.length, created);
});

test("the general menu shows only the general actions", () => {
    const { visible } = makeContextMenu();
    assert.deepEqual(visible(), [
        "Manage workspace projects…  (Super+P)",
        "New project…  (Super+A)",
        "Sync with Notion now  (Super+R)",
    ]);
});

test("a project the user is NOT on: its actions, with 'Move focused window here' and shortcut hints", () => {
    const { cm, visible } = makeContextMenu(1);
    cm.populate("a");
    assert.deepEqual(visible(), [
        "Alpha",
        "Open Notion page  (Super+N)",
        "Move focused window here",
        "New sub-project…  (Super+S)",
        "Remove from workspaces  (Super+Q)",
        "Delete in Notion…  (Shift+Super+Q)",
    ]);
});

test("the project the user is on: no 'move here', no Notion entry without a URL", () => {
    const { cm, visible } = makeContextMenu(1);
    cm.populate("b");
    assert.deepEqual(visible(), [
        "Beta",
        "New sub-project…  (Super+S)",
        "Remove from workspaces  (Super+Q)",
        "Delete in Notion…  (Shift+Super+Q)",
    ]);
});

test("an unknown project id, then null, both fall back to the general menu", () => {
    const { cm, visible } = makeContextMenu();
    cm.populate("a");
    cm.populate("gone");
    assert.equal(visible().length, 3);
    cm.populate("a");
    cm.populate(null);
    assert.equal(visible().length, 3);
});

test("actions hit the project the menu was last opened for", () => {
    const { cm, controller, removed, item } = makeContextMenu(1);
    cm.populate("a");
    cm.populate("b");
    cm.populate("a"); // retargeted back
    item("Move focused window here").activate();
    item("Open Notion page").activate();
    item("Remove from workspaces").activate();
    assert.deepEqual(controller.calls, ["moveWindow:0", "goTo:0", "openHome"]);
    assert.deepEqual(removed, ["a"]);
});

test("a project action follows the project if the deck is reordered while the menu is open", () => {
    const { cm, controller, item } = makeContextMenu(1);
    cm.populate("a");
    controller.state.projects.reverse(); // a is now index 1
    controller.at = 0;
    item("Move focused window here").activate();
    assert.deepEqual(controller.calls, ["moveWindow:1"]);
});

test("a project action is skipped if the project left the deck while the menu was open", () => {
    const { cm, controller, item } = makeContextMenu(1);
    cm.populate("a");
    controller.state.projects.shift();
    item("Move focused window here").activate();
    assert.deepEqual(controller.calls, []);
});

test("general actions run and every action reports afterAction", () => {
    const { other, item } = makeContextMenu();
    item("Manage workspace projects").activate();
    item("Sync with Notion now").activate();
    assert.deepEqual(other, ["manage", "after", "sync", "after"]);
});

test("'New sub-project' passes the right-clicked project; 'New project' passes no parent", () => {
    const { cm, created, item } = makeContextMenu(1);
    cm.populate("a");
    item("New sub-project").activate();
    cm.populate(null);
    item("New project").activate();
    assert.deepEqual(created, ["a", null]);
});

test("'Delete in Notion' passes the right-clicked project", () => {
    const { cm, deleted, item } = makeContextMenu(1);
    cm.populate("a");
    item("Delete in Notion").activate();
    assert.deepEqual(deleted, ["a"]);
});
