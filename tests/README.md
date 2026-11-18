# Tests

Unit tests for the Cinnamon-free modules — the pure logic where index
arithmetic can silently regress:

- `mapping.test.js`, `dotWindow.test.js` — the index arithmetic (`core/mapping.js`, `core/dotWindow.js`)
- `state.test.js`, `controller.test.js` — the deck model and the operations on it, against a fake window manager
- `deckCoordinator.test.js`, `projectStore.test.js`, `projectCreator.test.js` — toggling, syncing, creating and deleting projects, against fakes for Notion and the dialogs
- `projectMapper.test.js`, `syncService.test.js` — the Notion side: mapping pages to projects, the pull loop
- `contextMenu.test.js`, `dialogStyle.test.js`, `emojiImage.test.js` — the few UI pieces that have logic worth pinning down

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
export. Only modules without Cinnamon dependencies can be loaded this way (a few get
small fakes injected); anything that draws with St needs real GJS.
