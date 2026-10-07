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

## Behaviour lock (roadmap 38, R1)

The UI redesign (cloud `docs/design/redesign/SPEC.md` §0) may change how everything LOOKS and
must not change what anything DOES. `npm run e2e:lock` (= `npm run e2e -- @lock`) runs the
lock: the suites listed in `tests/e2e/lock.json`. Every roadmap-38 PR keeps it green.

| Suite | Locks |
|---|---|
| `lock-settings` | every settings row of the handoff's `settings-inventory.json`: its storage key, default, scope (device vs shared = does it broadcast), side effects (stores, `<html>` attributes, dialogs, downloads), and that it reads its default again after being put back |
| `lock-dragrow` | the DragRow contract on every kind of scrub field (transforms + units, inspector values, shader vectors, Animation fields): scrub, Shift/Ctrl, dead zone, click-to-type live, Enter/Escape/Tab, arrows, wheel, undo steps, live broadcast, min/max clamp |
| `lock-dragrow-sync` | two peers (local signaling): a scrub reaches the peer WHILE dragging, typed values and undo replicate |
| `lock-shortcuts` | the keymap registry (= the `?` sheet), the sheet itself, and the FOCUS RULES as a routing table: for each focus scope (viewport, node editor, UV, Animation, Shader, HUD, text field, open modal) which command every key fires |
| `lock-panels` | every window/drawer/dock view/modal/menu/Settings section opens, shows its content, and closes through its own control and Escape; the Properties pin; every toolbar cell's effect; dock tabs |
| `lock-search` | what Settings › search and the Inspector filter find, query by query |

The `adopted` suites in `lock.json` (dock-*, panel-*, settings-*, shortcut-rebind, …) already
covered parts of SPEC §0 and are part of the lock as they are.

**Recorded fixtures.** The `lock-*` suites compare against `tests/e2e/fixtures/lock/*.json`,
recorded on the pre-redesign UI with `LOCK_RECORD=1 node tests/e2e/lock-<name>.test.cjs`
(settings records two fresh passes and keeps only what both saw). A redesign PR NEVER
re-records them: a red lock check means behaviour changed, and SPEC §0 says to split that
change out. What a redesign MAY change is a locator — `ROW_SEL`/`NAME_SEL`/`CONTROL_SEL`/
`DRAG_WRAP` in `lockHelpers.cjs`, `shown`/`closer` in `lockSurfaces.cjs` — when a primitive
renames its classes or ids. Controls are found by ROLE (checkbox / switch / aria-pressed /
listbox / range …), so a checkbox becoming a Toggle or a select becoming Segmented needs no
edit at all.

**`KNOWN Qn` checks** assert today's behaviour where it differs from what SPEC §0 or DragRow's
own comment says (Escape after typing, stale fields after undo, per-change undo entries);
they are listed in the lane's QUESTIONS file and flip on purpose in the PR that fixes them.
Q1-Q3 (Escape after typing, stale transform rows after Ctrl+Z, more or fewer than one undo
step per scrub/typed edit) were fixed by roadmap 37 R26 (`feat/37-bugs`, release 1.27) and
`lock-dragrow` asserts the fixed behaviour since `feat/37-bugs-lock`; Q4 is still a note.

**Baselines.** `node tests/e2e/tools/lock-baselines.cjs` (with `APP_URL`, `SHOTS=<dir>`)
screenshots every surface of `lockSurfaces.cjs` at 1440×900 and 390×844 (touch) in the dark,
light and custom (`fixtures/lock/lock-custom.theme.json`) themes, named
`<surface>-<size>-<theme>-before.png`, plus an `index.html` contact sheet.

All lock suites launch on the GPU backend (`lockHelpers.launch`): on SwiftShader the 3D view
behind the panels starves the page (a CDP round trip measured 271 ms vs 2 ms).
