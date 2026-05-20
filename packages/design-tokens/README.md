# @flowlens/design-tokens

Single source of truth for Flowlens visual tokens. Used by both the extension and the web app.

- `src/index.ts` — TS object for programmatic access (e.g. inline styles in canvases).
- `src/tokens.css` — Tailwind v4 `@theme` block used by both apps' `globals.css`.

To add a new token, update both files together. Otherwise the apps drift.
