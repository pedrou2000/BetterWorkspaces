"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadGjsModule } = require("./helpers/loadGjsModule");

const EmojiImage = loadGjsModule("lib/emojiImage.js", "EmojiImage");

test("a single emoji maps to its code point in lowercase hex", () => {
    assert.equal(EmojiImage.codePoints("🪢"), "1faa2");
    assert.equal(EmojiImage.codePoints("🏦"), "1f3e6");
});

test("the variation selector is dropped when there is no ZWJ", () => {
    assert.equal(EmojiImage.codePoints("🗝️"), "1f5dd"); // U+1F5DD U+FE0F
    assert.equal(EmojiImage.codePoints("🗂️"), "1f5c2");
});

test("a ZWJ sequence keeps every code point, variation selector included", () => {
    assert.equal(EmojiImage.codePoints("🏋🏼‍♂️"), "1f3cb-1f3fc-200d-2642-fe0f");
    assert.equal(EmojiImage.codePoints("🧑‍🤝‍🧑"), "1f9d1-200d-1f91d-200d-1f9d1");
});

test("skin-tone and flag sequences join their code points", () => {
    assert.equal(EmojiImage.codePoints("👍🏽"), "1f44d-1f3fd");
    assert.equal(EmojiImage.codePoints("🇮🇪"), "1f1ee-1f1ea");
});

test("urlFor builds an .svg URL, or null when there is nothing to draw", () => {
    assert.match(EmojiImage.urlFor("🪢"), /^https:\/\/.+\/assets\/svg\/1faa2\.svg$/);
    assert.equal(EmojiImage.urlFor(""), null);
    assert.equal(EmojiImage.urlFor(null), null);
});
