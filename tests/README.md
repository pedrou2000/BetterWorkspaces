# Tests

Unit tests for the Cinnamon-free modules — the pure logic where index
arithmetic can silently regress:

- `mapping.test.js` — `core/mapping.js` (strips ↔ flat-list mapping)
- `state.test.js` — `core/State.js` (deck model, MRU, reorder/remove fixups)
- `projectMapper.test.js` — `notion/ProjectMapper.js` (Notion page → project, sorting)

## Running

Requires Node.js (≥ 18; uses the built-in `node:test` runner, no dependencies):

```sh
node --test tests/*.test.js
```

or `npm test` if npm is available.

## How the applet code is loaded

The applet is written for GJS (Cinnamon's JS runtime): modules import via a
global `imports` object and export via top-level `var`. The tests load the
applet source **verbatim** through `helpers/loadGjsModule.js`, which compiles
each file with a stubbed `imports` (just the logger) and returns the named
export. Only the pure modules above can be loaded this way; anything touching
St/Gio/Main would need real GJS.
