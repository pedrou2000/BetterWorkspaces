# Tests

Unit tests for the Cinnamon-free modules — the pure logic where index
arithmetic can silently regress:

- `mapping.test.js`, `dotWindow.test.js` — the index arithmetic (`core/mapping.js`, `core/dotWindow.js`)
- `state.test.js`, `controller.test.js` — the deck model and the operations on it, against a fake window manager
- `windowKeeper.test.js` — sending back a window that its own dialog dragged to the active workspace
- `deckCoordinator.test.js`, `projectStore.test.js`, `projectCreator.test.js` — toggling, syncing, creating and deleting projects, against fakes for Notion and the dialogs
- `projectMapper.test.js`, `syncService.test.js` — the Notion side: mapping pages to projects, the pull loop
- `contextMenu.test.js`, `dialogStyle.test.js`, `emojiImage.test.js` — the few UI pieces that have logic worth pinning down

## Running

Requires Node.js (≥ 18; uses the built-in `node:test` runner, no dependencies):

```sh
node --test tests/*.test.js
```

or `npm test` if npm is available.

## Manual check: a dialog must not drag its window over

The window manager side of `core/WindowKeeper.js` can only be seen in a running
Cinnamon. With the applet loaded:

```sh
python3 tests/manual/dialog-pull.py
```

It opens a test window, sends it to another workspace and has it raise a
dialog the way VS Code does, then prints `STAYED` (exit 0) or `PULLED` (exit 1)
and closes everything. Without the applet, or with "Keep a window on its
workspace…" switched off, Cinnamon gives `PULLED`. Each time the applet sends a
window back it also logs a line: `grep keeper ~/.xsession-errors`.

## How the applet code is loaded

The applet is written for GJS (Cinnamon's JS runtime): modules import via a
global `imports` object and export via top-level `var`. The tests load the
applet source **verbatim** through `helpers/loadGjsModule.js`, which compiles
each file with a stubbed `imports` (just the logger) and returns the named
export. Only modules without Cinnamon dependencies can be loaded this way (a few get
small fakes injected); anything that draws with St needs real GJS.
