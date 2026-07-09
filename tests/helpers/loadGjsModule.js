/* Test loader: evaluate a GJS applet module under Node with a faked `imports`. */

// Only for Cinnamon-free modules; anything touching St/Gio/Main needs more shims.
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const UUID = "better-workspaces@pedrou2000";
const APPLET_DIR = path.join(__dirname, "..", "..", UUID);

function makeImportsShim() {
    const noopLogger = { log() {}, error() {} };
    return {
        ui: {
            appletManager: {
                applets: {
                    [UUID]: {
                        lib: {
                            logger: { Logger: { makeLogger: () => noopLogger } },
                        },
                    },
                },
            },
        },
    };
}

// Second-level entries are assigned per key so lib.logger survives a lib merge.
function mergeShims(shim, applet, extraImports) {
    const appletDir = shim.ui.appletManager.applets[UUID];
    for (const top of Object.keys(applet || {})) {
        appletDir[top] = Object.assign(appletDir[top] || {}, applet[top]);
    }
    Object.assign(shim, extraImports || {});
    return shim;
}

// Compiled in THIS realm (not a separate vm context) so created objects share
// our prototypes and deepStrictEqual works. GJS's top-level `var` export becomes
// a function local, so we append a `return` of it.
// opts: {applet: shim tree the file imports, extraImports: top-level GJS imports}.
function loadGjsModule(relPath, exportName, opts) {
    opts = opts || {};
    const file = path.join(APPLET_DIR, relPath);
    const code = fs.readFileSync(file, "utf8");
    const fn = vm.compileFunction(
        `${code}\n;return typeof ${exportName} === "undefined" ? undefined : ${exportName};`,
        ["imports", "global"],
        { filename: file });
    const shim = mergeShims(makeImportsShim(), opts.applet, opts.extraImports);
    const exported = fn(shim, { log() {}, logError() {} });
    if (exported === undefined) {
        throw new Error(`${relPath} did not export '${exportName}'`);
    }
    return exported;
}

module.exports = { loadGjsModule, UUID };
