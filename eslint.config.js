"use strict";

const js = require("@eslint/js");
const globals = require("globals");
const prettier = require("eslint-plugin-prettier");
const prettierConfig = require("eslint-config-prettier");

// GJS runtime globals available to a Cinnamon applet (module system + shell).
const gjsGlobals = {
    imports: "readonly",
    global: "readonly",
    log: "readonly",
    logError: "readonly",
    print: "readonly",
    printerr: "readonly",
    Promise: "readonly",
    // GJS exposes the standard ES built-ins; pull them from the browser set
    // (a superset that includes Uint8Array, Map, Set, etc.) without DOM churn.
    ...globals.es2022,
};

module.exports = [
    { ignores: ["node_modules/**", "_spices/**"] },

    // Applet source: GJS "scripts". Exports are top-level `var`/`function` read
    // by the imports machinery, so they read as unused inside their own file —
    // varsIgnorePattern exempts the PascalCase module singletons + SOUP3.
    {
        files: ["better-workspaces@pedrou2000/**/*.js"],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: "script",
            globals: gjsGlobals,
        },
        plugins: { prettier },
        rules: {
            ...js.configs.recommended.rules,
            ...prettierConfig.rules,
            "prettier/prettier": "error",

            "no-unused-vars": [
                "error",
                {
                    args: "after-used",
                    argsIgnorePattern: "^_",
                    caughtErrors: "none",
                    varsIgnorePattern: "^([A-Z]|SOUP3|main$)",
                },
            ],
            eqeqeq: ["error", "smart"],
            "prefer-const": "error",
            "no-throw-literal": "error",
            "no-empty": ["error", { allowEmptyCatch: true }],
            "no-var": "off", // GJS exports MUST be top-level `var`
            curly: ["error", "multi-line"],
            "no-shadow": "error",
            "no-implicit-coercion": ["error", { boolean: false }],
        },
    },

    // Node test harness: CommonJS.
    {
        files: ["tests/**/*.js", "eslint.config.js"],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: "commonjs",
            globals: { ...globals.node },
        },
        plugins: { prettier },
        rules: {
            ...js.configs.recommended.rules,
            ...prettierConfig.rules,
            "prettier/prettier": "error",
            "no-unused-vars": ["error", { argsIgnorePattern: "^_", caughtErrors: "none" }],
            eqeqeq: ["error", "smart"],
            "prefer-const": "error",
        },
    },
];
