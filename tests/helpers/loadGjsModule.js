/*
 * Test loader: evaluate a GJS applet module under Node.
 *
 * The applet files are written for Cinnamon's GJS module system (a global
 * `imports` object; exports via top-level `var`/`function` declarations).
 * This loader fakes just enough of `imports` (the logger lookup) and runs the
 * file in a vm context, then hands back the named export. The applet source
 * is loaded verbatim — no test-only edits needed.
 *
 * Only works for the Cinnamon-free modules (core/mapping.js, core/State.js,
 * notion/ProjectMapper.js); anything touching St/Gio/Main needs more shims.
 */
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

// Load `relPath` (relative to the applet dir) and return its `exportName`
// top-level binding. The file is compiled as a function in THIS realm (not a
// separate vm context) so the objects it creates share our prototypes and
// deepStrictEqual works on them. GJS exports via top-level `var`, which
// inside a function becomes a local — so we append a return of the export.
function loadGjsModule(relPath, exportName) {
    const file = path.join(APPLET_DIR, relPath);
    const code = fs.readFileSync(file, "utf8");
    const fn = vm.compileFunction(
        `${code}\n;return typeof ${exportName} === "undefined" ? undefined : ${exportName};`,
        ["imports", "global"],
        { filename: file });
    const exported = fn(makeImportsShim(), { log() {}, logError() {} });
    if (exported === undefined) {
        throw new Error(`${relPath} did not export '${exportName}'`);
    }
    return exported;
}

module.exports = { loadGjsModule, UUID };
