# e2e suite

Plain-node Playwright scripts (no test framework) against a running dev server:

```
npm run dev          # terminal 1 (HTTPS on 5173)
npm run e2e          # terminal 2 — all suites, sequential
npm run e2e -- ping drawing   # subset by name
```

## Recipe (hard-won — see CLAUDE.md too)

- Tests hit `https://theprototype.app:5173/` — map that host to `127.0.0.1` in
  `C:\Windows\System32\drivers\etc\hosts`. Two-peer tests connect through the **public
  PeerJS cloud**, so they need internet and ~30-60 s per connection handshake.
  Override the URL with `APP_URL=https://localhost:5173/` for single-page suites.
- `localStorage.debugStores = 'true'` (set by helpers) exposes `window.__stores`
  (all stores + key modules) — the only sanctioned test API.
- First run after new dependencies: vite re-optimizes and reloads once — rerun.
- Never run suites in parallel (shared dev server + HMR) and never edit source files
  while a suite is running (HMR reloads the pages mid-test).
- Suites must exit 0/1 via `helpers.finish()`; the runner just aggregates.

## Suites

ping, flow-runtime, undo, module-sdk, button, script-nodes, dungeon, piano-pong,
drawing, path-node — one per shipped feature phase (27-36). When a phase changes UI a
suite depends on (e.g. the modules manager moving module menu actions), update the suite
in the same commit.

Files are `.cjs` because the package is `"type": "module"` and the suite uses
CommonJS `require`.
