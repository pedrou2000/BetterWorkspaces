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

test("a background tone adds one more class to every Notion-look surface", () => {
    const DialogStyle = load();
    DialogStyle.setTone("darker");
    assert.deepEqual(DialogStyle.dialogParams(), {
        styleClass: "better-workspaces-dialog-notion better-workspaces-tone-darker",
    });
    assert.equal(
        DialogStyle.className("better-workspaces-osd"),
        "better-workspaces-osd-notion better-workspaces-tone-darker",
    );

    DialogStyle.setTone("gray"); // the default needs no extra class
    assert.deepEqual(DialogStyle.dialogParams(), { styleClass: "better-workspaces-dialog-notion" });
});

test("tones are ignored by the classic look, and unknown tones fall back to gray", () => {
    const DialogStyle = load();
    DialogStyle.setTone("blue");
    DialogStyle.set("classic");
    assert.deepEqual(DialogStyle.dialogParams(), {});
    assert.equal(DialogStyle.className("better-workspaces-osd"), "better-workspaces-osd");

    DialogStyle.set("notion");
    for (const bad of ["neon", "", null, undefined, "toString"]) {
        DialogStyle.setTone(bad);
        assert.equal(
            DialogStyle.className("better-workspaces-osd"),
            "better-workspaces-osd-notion",
            String(bad),
        );
    }
});
