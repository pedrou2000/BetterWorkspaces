# BetterWorkspaces

A Cinnamon (Linux Mint) applet that organizes virtual workspaces by Notion
project instead of a flat grid. Each project owns a contiguous strip of
workspaces; the deck of projects is sourced from the user's Notion Projects DB.

## Layout

- `better-workspaces@pedrou2000/` — the shipped applet (GJS). This is the only
  code that goes in the Cinnamon Spices package.
- `tests/` — Node test harness (`node --test`) for the Cinnamon-free modules.
- Repo root (`package.json`, `eslint.config.js`, `.prettierrc.json`,
  `node_modules/`) — dev tooling only, NOT shipped.

## GJS constraints (important)

The applet runs under GJS, not Node. Two rules the tooling must respect:

- **Module exports must be top-level `var`** (`var Foo = class ... {}`), read by
  Cinnamon's `imports` machinery. Never convert these to `const`/`let` — the
  applet would fail to load. `no-var` is intentionally OFF in the lint config.
- Files are GJS **scripts**, not ES modules — no `import`/`export`, no `require`.

## Dev workflow

Node ≥ 18. If `npm` isn't on PATH, use `corepack pnpm@9` in its place.

- `npm test` — run the test suite
- `npm run lint` — ESLint (strict; GJS globals configured)
- `npm run format` — Prettier (4-space, 100 col, double quotes)
- `npm run check` — format-check + lint + test (run before committing)

## Comment style

Minimal, why-only: one-line file headers, no milestone/Design-Doc refs, no
per-file license (top-level LICENSE covers GPLv2), no section-divider banners.
Delete comments that restate code; keep only non-obvious rationale, invariants,
and external-API (Soup/Muffin/Notion/GTK) gotchas.
