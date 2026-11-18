"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadGjsModule } = require("./helpers/loadGjsModule");

const TokenVault = loadGjsModule("core/TokenVault.js", "TokenVault");
const MARKER = TokenVault.MARKER;

// A keyring holding at most one token. opts: available, failSave, failLoad,
// corrupt (returns something other than what was saved).
function makeKeyring(initial, opts) {
    opts = opts || {};
    const k = {
        stored: initial === undefined ? null : initial,
        calls: [],
        available: () => opts.available !== false,
        async load() {
            k.calls.push("load");
            if (opts.failLoad) throw new Error("locked");
            return opts.corrupt && k.stored !== null ? k.stored + "x" : k.stored;
        },
        async save(token) {
            k.calls.push("save");
            if (opts.failSave) throw new Error("no keyring daemon");
            k.stored = token;
            return true;
        },
        async clear() {
            k.calls.push("clear");
            const had = k.stored !== null;
            k.stored = null;
            return had;
        },
    };
    return k;
}

function makeVault(settingValue, keyring) {
    const setting = { value: settingValue, writes: [] };
    const vault = new TokenVault({
        keyring: keyring,
        getSetting: () => setting.value,
        setSetting: (v) => {
            setting.value = v;
            setting.writes.push(v);
        },
    });
    return { vault, setting };
}

test("a token typed into the field moves to the keyring and the field keeps only the marker", async () => {
    const keyring = makeKeyring();
    const { vault, setting } = makeVault("  secret_abc  ", keyring);

    assert.equal(await vault.resolve(true), "secret_abc");
    assert.equal(keyring.stored, "secret_abc");
    assert.equal(setting.value, MARKER);
});

test("the marker means: use the keyring's token", async () => {
    const { vault, setting } = makeVault(MARKER, makeKeyring("secret_abc"));
    assert.equal(await vault.resolve(false), "secret_abc");
    assert.deepEqual(setting.writes, []); // nothing rewritten
});

test("a token already in the settings file is migrated at startup too", async () => {
    const keyring = makeKeyring();
    const { vault, setting } = makeVault("secret_old", keyring);
    assert.equal(await vault.resolve(false), "secret_old");
    assert.equal(keyring.stored, "secret_old");
    assert.equal(setting.value, MARKER);
});

test("pasting a new token replaces the stored one", async () => {
    const keyring = makeKeyring("secret_old");
    const { vault, setting } = makeVault("secret_new", keyring);
    assert.equal(await vault.resolve(true), "secret_new");
    assert.equal(keyring.stored, "secret_new");
    assert.equal(setting.value, MARKER);
});

test("if the keyring can't store the token, it stays in the field and still works", async () => {
    const { vault, setting } = makeVault("secret_abc", makeKeyring(null, { failSave: true }));
    assert.equal(await vault.resolve(true), "secret_abc");
    assert.equal(setting.value, "secret_abc"); // not replaced: nothing can be lost
});

test("the field is not replaced unless the keyring reads back exactly that token", async () => {
    const corrupt = makeVault("secret_abc", makeKeyring(null, { corrupt: true }));
    assert.equal(await corrupt.vault.resolve(true), "secret_abc");
    assert.equal(corrupt.setting.value, "secret_abc");

    const unreadable = makeVault("secret_abc", makeKeyring(null, { failLoad: true }));
    assert.equal(await unreadable.vault.resolve(true), "secret_abc");
    assert.equal(unreadable.setting.value, "secret_abc");
});

test("a locked or failing keyring means not connected, without touching the field", async () => {
    const { vault, setting } = makeVault(MARKER, makeKeyring("secret_abc", { failLoad: true }));
    assert.equal(await vault.resolve(false), "");
    assert.equal(setting.value, MARKER);
});

test("clearing the field forgets the stored token; an empty field at startup does not", async () => {
    const atStartup = makeKeyring("secret_abc");
    assert.equal(await makeVault("", atStartup).vault.resolve(false), "");
    assert.equal(atStartup.stored, "secret_abc"); // e.g. the settings file was reset

    const byUser = makeKeyring("secret_abc");
    assert.equal(await makeVault("", byUser).vault.resolve(true), "");
    assert.equal(byUser.stored, null);
});

test("without a keyring the field is the token, as before", async () => {
    const keyring = makeKeyring(null, { available: false });
    const { vault, setting } = makeVault("secret_abc", keyring);
    assert.equal(await vault.resolve(true), "secret_abc");
    assert.equal(setting.value, "secret_abc");
    assert.deepEqual(keyring.calls, []);

    // A marker left over from a time when there was a keyring is not a token.
    assert.equal(await makeVault(MARKER, keyring).vault.resolve(false), "");
});
