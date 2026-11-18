"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadGjsModule } = require("./helpers/loadGjsModule");

// A fresh module per test: the look is module-level state.
const load = () => loadGjsModule("ui/DialogStyle.js", "DialogStyle");

test("the Notion look is the default: a style class for dialogs, a suffix for our own surfaces", () => {
    const DialogStyle = load();
    assert.equal(DialogStyle.is("notion"), true);
    assert.deepEqual(DialogStyle.dialogParams(), { styleClass: "better-workspaces-dialog-notion" });
    assert.equal(DialogStyle.className("better-workspaces-osd"), "better-workspaces-osd-notion");
});

test("the classic look adds nothing, so the original styling applies untouched", () => {
    const DialogStyle = load();
    DialogStyle.set("classic");
    assert.equal(DialogStyle.is("classic"), true);
    assert.deepEqual(DialogStyle.dialogParams(), {});
    assert.equal(DialogStyle.className("better-workspaces-osd"), "better-workspaces-osd");
});

test("an unknown or missing setting value falls back to the default look", () => {
    const DialogStyle = load();
    DialogStyle.set("classic");
    for (const bad of ["glass", "", null, undefined, "constructor"]) {
        DialogStyle.set(bad);
        assert.equal(DialogStyle.is("notion"), true, String(bad));
    }
});
