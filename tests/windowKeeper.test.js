"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadGjsModule } = require("./helpers/loadGjsModule");
const { FakeWm, makeFakeMainloop } = require("./helpers/fakeWm");

// Three workspaces; the user is on the last one. An editor with an open
// dialog sits on workspace 0, next to a terminal.
function setup(opts) {
    const mainloop = makeFakeMainloop();
    const WindowKeeper = loadGjsModule("core/WindowKeeper.js", "WindowKeeper", {
        extraImports: { mainloop: mainloop },
    });
    const wm = new FakeWm(3);
    wm.activeIndex = 2;
    const editor = wm.addWindow(0, "editor");
    wm.addWindow(0, "terminal");
    wm.addWindow(2, "browser");
    const dialog = wm.addDialog(editor, "reload?");
    const keeper = new WindowKeeper(wm, opts);
    keeper.start();
    return { wm, mainloop, keeper, editor, dialog };
}

// Which windows are on which workspace; the order inside one is incidental.
function placed(wm) {
    return wm.layout().map((titles) => titles.slice().sort());
}

const HOME = [["editor", "reload?", "terminal"], [], ["browser"]];
const PULLED = [["terminal"], [], ["browser", "editor", "reload?"]];

test("a dialog that asks for focus does not take its window to the active workspace", () => {
    const { wm, mainloop, dialog } = setup();

    assert.deepEqual(placed(wm), HOME);
    wm.dialogAsksForFocus(dialog);
    assert.deepEqual(placed(wm), PULLED);

    mainloop.flush();
    assert.deepEqual(placed(wm), HOME);
    assert.equal(mainloop.pendingCount(), 0);
});

test("the window goes back even when only it was moved, the dialog being here already", () => {
    const { wm, mainloop, editor, dialog } = setup();
    wm.moveWindowToWorkspace(dialog, 2);

    wm.externalMove(editor, 2);
    mainloop.flush();

    assert.deepEqual(placed(wm), HOME);
});

test("a dialog of a dialog takes the whole chain back", () => {
    const { wm, mainloop, dialog } = setup();
    const nested = wm.addDialog(dialog, "are you sure?");

    wm.dialogAsksForFocus(nested);
    mainloop.flush();

    assert.deepEqual(placed(wm), [
        ["are you sure?", "editor", "reload?", "terminal"],
        [],
        ["browser"],
    ]);
});

test("a window that arrives without a dialog stays", () => {
    const { wm, mainloop } = setup();
    const terminal = wm.listWindowsOnWorkspace(0)[1];

    wm.externalMove(terminal, 2);
    mainloop.flush();

    assert.deepEqual(placed(wm), [["editor", "reload?"], [], ["browser", "terminal"]]);
});

test("a window moved to a workspace other than the active one is not touched", () => {
    const { wm, mainloop, editor, dialog } = setup();

    wm.externalMove(dialog, 1);
    wm.externalMove(editor, 1);

    assert.equal(mainloop.pendingCount(), 0);
    assert.deepEqual(placed(wm), [["terminal"], ["editor", "reload?"], ["browser"]]);
});

test("windows dragged in Expo or the overview stay where the user put them", () => {
    const { wm, mainloop, dialog } = setup();
    wm.overviewOpen = true;

    wm.dialogAsksForFocus(dialog);
    mainloop.flush();

    assert.deepEqual(placed(wm), PULLED);
});

test("Cinnamon's 'bring windows to the current workspace' setting is respected", () => {
    const { wm, mainloop, dialog } = setup();
    wm.bringsWindows = true;

    wm.dialogAsksForFocus(dialog);
    mainloop.flush();

    assert.deepEqual(placed(wm), PULLED);
});

test("switched off, it does nothing", () => {
    const { wm, mainloop, dialog } = setup({ enabled: () => false });

    wm.dialogAsksForFocus(dialog);
    mainloop.flush();

    assert.deepEqual(placed(wm), PULLED);
});

test("a window whose workspace was removed meanwhile is left where it is", () => {
    const { wm, mainloop, editor, dialog } = setup();
    wm.moveAllWindows(0, 1); // the applet folds workspace 0 away...
    wm.dialogAsksForFocus(dialog);
    wm.removeWorkspace(1); // ...and the one the window came from goes before we look

    mainloop.flush();

    assert.equal(wm.workspaceIndexOfWindow(editor), wm.getActiveIndex());
});

test("a window the user moved on before we looked is not chased", () => {
    const { wm, mainloop, editor, dialog } = setup();

    wm.dialogAsksForFocus(dialog);
    wm.moveWindowToWorkspace(editor, 1);
    mainloop.flush();

    assert.deepEqual(placed(wm), [["terminal"], ["editor", "reload?"], ["browser"]]);
});

test("the applet's own moves are never undone", () => {
    const { wm, mainloop, editor } = setup();

    wm.moveWindowToWorkspace(editor, 2);

    assert.equal(mainloop.pendingCount(), 0);
    assert.deepEqual(placed(wm), PULLED);
});

test("destroy stops watching and drops a pending look", () => {
    const { wm, mainloop, keeper, dialog } = setup();

    wm.dialogAsksForFocus(dialog);
    keeper.destroy();
    mainloop.flush();
    wm.dialogAsksForFocus(dialog);

    assert.equal(mainloop.pendingCount(), 0);
    assert.deepEqual(placed(wm), PULLED);
});
