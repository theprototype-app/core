---
name: e2e-verify
description: Verify theprototype.app changes end-to-end with Playwright — the committed tests/e2e suite, single-page and two-peer (PeerJS cloud) recipes, the debugStores hook, and known flakes. Use before committing any feature.
---

# E2E verification recipe for theprototype.app

## The committed suite (start here)

`tests/e2e/*.test.cjs` + `helpers.cjs` (`.cjs` — the package is `"type": "module"`).
Run with the dev server up (`npm run dev`, https on 5173 via the repo certs/ —
vite-plugin-mkcert is gone; node >= 24 required, engines-gated):

```
npm run e2e                      # all suites (~80), sequential, ~25-30 min
npm run e2e -- ping drawing      # subset by name (normal during development)
```

**Every feature phase adds a suite here** (not in scratchpad) and updates any suite its
UI changes break — in the same commit. helpers.cjs exports: `launch(options)` (pass
`{args:[...]}` for fake media), `setupPage(browser, name)` (init script + hydration +
peer id), `connect(from, to, settleMs=9000)`, `check(ok, label)`,
`eventually(fn, predicate, label, timeout)`, `projectPoint(page, [x,y,z])` (world →
screen pixel for real clicks), `finish(browser)` (exit code), `run(body)`.

Rules: never run suites in parallel AGAINST THE SAME dev server, never edit sources
while one runs (HMR reloads the pages mid-test).

**Parallel lanes (multi-session work, 2026-07-21):** each session works in its own
`git worktree` (e.g. `../theprototype-lane-flow`) with its OWN dev server on its own
port, and points the suite at it via the `APP_URL` env override (helpers.cjs reads it):

```powershell
npx vite dev --port 5177 --strictPort --host   # from the worktree, background
$env:APP_URL='https://theprototype.app:5177/'; npm run e2e -- <name>
```

(`npx vite dev` directly — `npm run dev -- --port N` does NOT pass the flags
through on this npm version: it parses them as npm config, vite gets `dev 5177`
as a positional and binds a random free port over plain http.)

Assigned ports: main checkout 5173 (the user's), lane-c 5174, lane-vr 5175,
lane-ui 5176, lane-flow 5177, lane-aiphys 5178, lane-editmesh 5183. Two-peer suites still meet on the signaling server
(now the self-hosted peerjs.theprototype.app box), so concurrent lanes' test peers
never collide (random ids). PORT-SHADOW TRAP: another process holding only
`[::1]:PORT` does NOT trip `--strictPort` (vite binds 0.0.0.0) — but
curl/playwright resolve localhost to ::1 and hit the STALE server (symptom: new
modules 404 to index.html, `__stores` missing new keys). `netstat -ano` and
check BOTH stacks before blaming your build.

## The debugStores hook — the ONLY sanctioned test API

The init script (helpers does it) sets `localStorage.debugStores='true'` +
`hasSeenDisclaimer='true'`. App.svelte then publishes `window.__stores` = all stores
spread + modules: `meshEdit, vrControls, autosave, voiceChat, annotationsHandler,
flowRuntime, history, materialsHandler, objectActions, commandsHandler, moduleSDK,
drawMode, pathCapture, lockControl, prefabs, physics, joints, possess, handModels,
terrainSculpt, userModules, environment, sceneMusic, animatedImports, fileHandler,
sceneBounds, cameraClip, ping, sessions, geometryEdit, lightParams, shadowDefaults,
palette, viewModeCtl, inputRuntime, shortcutsRegistry, themes, vrRadialMenu,
vrPalette, vrWindowPoses, vrKeyboard, faceEdit, avatarModel, explorer, bottomDock,
explorerDrop, assetShare, soundRuntime, dungeonPlay, sceneAssets, THREE,
GLTFExporterModule, snapping, flowSockets, networkQuality, packs, customNodes,
nodesHandler, nodeCatalog, objectMenu, flowGraphsCtl, objectFlow, vrSleeve` (+ from the
flowStore spread: `flowGraphs, activeGraphId, setActiveGraph, allNodes, allEdges,
findNodeAnyGraph, SCENE_GRAPH`; `moduleSDK.pointerRayNow()` = the api.pointerRay
internals, `moduleSDK.applyModuleMessage(msg)` = simulate a PEER's module message
through the real applier path). Naming trap: `__stores.viewMode` is the
STORE (from the sceneStore spread); the viewMode MODULE is `viewModeCtl` — a module
key that shadows a same-named store silently breaks tests (#12 lesson). Also on the
stores spread: `viewportMenuOpener` (Scene registers its context-menu opener here —
call `$viewportMenuOpener(x,y,forceEmpty)` to open the viewport/create menu without
a right-click).

**Never dynamic-import `/src/lib/x.js` from page code to reach a singleton** — once
vite HMR-timestamps the app's copy you get a SECOND module instance (empty stores,
false FAILs; this bit us twice). If a module you need isn't in `__stores`, add it to
the App.svelte debug hook as part of your change.

Read a store (and never write a store inside its own subscriber — read refs first,
then mutate):

```js
const value = await page.evaluate(() =>
  new Promise((r) => window.__stores.objectsGroup.subscribe((g) => r(g?.children.length))()));
```

## Single-page flow

- `goto(url, { waitUntil: 'domcontentloaded' })` (NOT networkidle — peerjs sockets never
  idle), ~4s wait, then `waitForFunction(() => window.__stores?.moduleSDK)`.
- UI anchors: bottom nav `p[title="Object list (O)"]` / `p[title="Node editor (N)"]`;
  play `#play-button`; object rows `#object-list p[id]`; search `#object-search`;
  modules manager via `#open-modules-manager` (drawer: `closeMenu.set(false)` first)
  or `modulesOpen.set(true)`; module cards `#module-card-<id>`; draw `#draw-toolbar`;
  dungeon `#dungeon-panel`; script editor close `#script-panel-close`.
- Programmatic scene setup: `__stores.commandsHandler.sceneCommand('/create box')`
  (geometry names are capitalized THREE types — box/sphere/Button…, NOT "cube").
- Icons are `@lucide/svelte` `<svg>` components (Font Awesome removed): select
  `svg` not `i`, and read classes via `getAttribute('class')` — svg `className`
  is an SVGAnimatedString object, `.includes()` on it throws/fails silently.
- Flow graphs: set `flowNodes`/`flowEdges` locally **and broadcast** `nodecreate`/
  `edgecreate` per node/edge like the UI does — relying on the 10s nodesync heal is
  slow and rate-limited (30s) → flaky.
- Viewport clicks: `helpers.projectPoint` a REAL object/point position, then
  `mouse.click` — fixed pixel guesses miss thin/overlapping geometry (the piano
  black-key lesson). Right-click must be a real `mouse.click(x,y,{button:'right'})`.
- Context menus render `role="menuitem"`; group items CONTAIN submenu text — anchored
  regex `/^Exact label$/` + `.last()` if needed.
- Action toasts have buttons now — `getByRole('button', { name: 'Approve' })` etc.

## Repo-external modules (theprototype-app/modules)

Modules in the SEPARATE modules repo have no committed suite here (the suite must
not depend on a sibling checkout) — verify them with a SCRATCH playwright script
through the REAL install path (the untangle test-flight is the reference):

```js
await page.evaluate(() => window.__stores.modulesOpen.set(true));
await page.getByRole('button', { name: 'User', exact: true }).click(); // the User tab
await page.locator('#install-module-zip').setInputFiles(ZIP_PATH);     // hidden input — fine
```

Then assert the module's scene-root group / behavior, and simulate a PEER's ops via
`__stores.moduleSDK.applyModuleMessage({type:'module', moduleId, ...})` (the real
applier path, no cloud dependency). Fresh browser CONTEXT per run — installed user
modules persist in storage.

## Two-peer flow (real replication)

Use `https://theprototype.app:5173/` — hosts-mapped to 127.0.0.1; the `.app` hostname
makes peerjs use the **public cloud** (localhost tries ws://localhost:9001 and fails).
**NOTE (2026-07-24)**: the `theprototype.app` hosts mapping is currently COMMENTED
OUT in `etc/hosts`, so two-peer suites are env-gated locally — re-enable the mapping
(or gate the block behind an env flag, as `connect-states.test.cjs` does with
`TWO_PEER=1`) to run them.
`helpers.connect(B, A)` does: fill peer id → Connect → Approve on A → ~9s settle.
Late joiners: connect a third context AFTER mutations, assert handshake state arrived
(objects/nodes/annotations/joints/module state/env/music/handmodel/custom defs).
Voice: launch with `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream`.
**B→A messaging works** since #12 (the adopted-inbound-conn fix) — tests may drive
mutations FROM the joiner (peer move streams, claims). When a suite needs the
dual-module-instance split collapsed, `freshReload(peer)` BEFORE `connect` and
re-read the id (`peer.id = await …peers.subscribe…peer.id`) — a reload mid-mesh
drops the P2P session.

## Known flakes / traps

- **Connect / open-core (#14)**: `connect-states.test.cjs` drives the pill state
  machine single-page by STUBBING the dead-signaling peer (`peer.open=true` +
  `peer.connect=(id)=>({peer:id,open:false,on(){},close(){},send(){}})`) so a dial
  flows without a server. `open-core-m1.test.cjs` loads the reference plugin
  (`static/cloud-plugin-example.js`) via `localStorage.cloudPluginUrl='/cloud-plugin.js'`
  + `freshReload`, then asserts the seams (`window.__stores.cloudHooks.canApply`,
  `profileSlot`/`drawerSlot` are functions, mounted DOM). The flowbite avatar Dropdown
  is flaky to open headlessly — assert profile mounts at the STORE level, not by
  clicking `#avatar-menu`. A `transition:slide` element stays in the DOM through the
  ~200ms out-transition — poll with `eventually`, don't assert `count===0` immediately.
- First run after adding a dependency: vite re-optimizes and reloads mid-test — rerun.
  Lazy wasm (rapier) needs a throwaway prewarm page first (see physics.test.cjs).
  Physics sims run REAL-time since #12 (fixed-timestep accumulator) — falls/settles
  take wall-clock seconds even under a throttled rAF; don't compensate with huge waits.
- **Machine saturation**: headless pages can run at ~4fps with timers ~1.8x slow when
  the host is loaded (dozens of user Chrome processes — do NOT kill them). Symptoms:
  timeouts on waits that "always worked", missed one-shot flag reads. Cures: generous
  `eventually` windows, BEHAVIORAL asserts (did the box move) over one-shot state
  reads, and for flags that flicker (hold/claim booleans) an IN-PAGE sampling loop
  (`setInterval` 50ms inside one `evaluate`) instead of round-trip polling.
- **Large plain-number arrays blow binarypack**: `conn.send` with a ~40k-element plain
  array throws "Maximum call stack size exceeded" — and `broadcast()`'s try/catch
  SWALLOWS it, so the message silently never leaves. Send raw bytes instead
  (`new Float32Array(arr).buffer`) and normalize on receive (meshgeo/terrain do this).
  If a big payload "never arrives" in a test, suspect this before the network.
- Pre-existing flakes (reproduce on a clean base — don't chase them into your diff):
  add-menu search-Enter + right-tap, sound-node Play overlap, connect-overlay
  querySelector, scene-music byte-push timing. To PROVE a failure is pre-existing:
  `git stash push -u`, run the suite on HEAD, `git stash pop`.
- KNOWN failing suites in the localhost env (2026-07-28, proven identical across a
  full old-deps/new-deps baseline comparison — treat as the dirty baseline, not
  regressions): the drag-drop-SIMULATION cluster (explorer-drop, explorer,
  packs-drop) + user-modules (setup crash), open-core-m1 (1 drawer check),
  dock-sidebar-inset, layout, node-search, panels, script-nodes, and a few
  two-peer timing suites (module-sdk, scene-music, physics-kinematic,
  physics-discoverability, roadmap-13-notifications-notes, scene-assets,
  view-mode, vr-passthrough).
- Long full-suite runs: the Bash tool caps at 10 min — launch the runner DETACHED
  (PowerShell `Start-Process node -ArgumentList 'tests\e2e\run.cjs ...'` with
  output redirects) and poll/Monitor the log. A dev server started via the Bash
  tool DIES with the session — start it detached the same way.
- Phase-comparison asserts between two peers: two sequential evaluates skew ~150ms —
  tolerances ≥0.6 for fast oscillations, or compare Promise.all-sampled values.
- Overlays intercept clicks (properties drawer covers right ~320px; modals block all;
  the hud pill floats over the flow drawer's bottom-center; an open floating window
  can cover another window's resize corner — close it first).
- `requestPointerLock` rejects in headless — code catches it; play mode still toggles
  (`isLocked.set(true)` drives play-mode logic incl. the dungeon spawn + minimap).
- PowerShell mangles emoji AND em-dashes rewriting files; inline `node -e` quoting
  breaks in PS — write scratch `.cjs` files and run them with node. The Bash tool's
  `cd` leaks into the SHARED shell cwd — `Set-Location` back to the repo root before
  git/npm in PowerShell.
- Suites assume a clean session per context (fresh IndexedDB/localStorage); reloading a
  page keeps them — used deliberately for persistence tests (prefabs, user modules,
  Explorer, themes). Two idb traps in persistence tests: fire-and-forget idb writes
  (sleeve slot capture) are ABORTED by an immediate reload — settle ~800ms before
  `freshReload`; and a store gated behind a "loaded once" flag never fills on the
  debug-hook's SECOND module instance — call its loader explicitly after the reload
  (idempotent on the single-instance path; vr-sleeve.test does both).
- Flowbite Toggle inputs are `sr-only` — click the wrapping `label`, not the input.
- File drops: build a `DataTransfer` in `evaluate` and `dispatchEvent(new DragEvent('drop', …))`;
  a known-good 1×1 PNG base64 is in explorer-drop.test.cjs (Image tolerates broken
  PNGs but `createImageBitmap` does not). For an OS FILE drop (not an internal payload),
  `dt.items.add(new File([bytes], name, {type}))` populates `dt.files` (packs-drop.test).
- **Downloads**: capture an `a.click()`/blob download with
  `const [dl] = await Promise.all([page.waitForEvent('download'), <trigger>]); const p =
  await dl.path();` then read/parse `p` (gltf-export-selection, modules-manager). Works
  headless; `dl.suggestedFilename()` gives the extension.
- **Responsive / mobile**: `page.setViewportSize({width,height})` per test (or a
  `browser.newContext({viewport, hasTouch:true, isMobile:true})` for a throwaway
  screenshot). Layout gated by `@media (max-width:…)` shows once you resize — but
  `@media (pointer: coarse)` and any JS `window.matchMedia('(pointer: coarse)')` gate
  (force-dock, undock-hide, side-dock disable, the mobile drag-to-place path) **cannot be
  emulated** on a desktop headless browser (`hasTouch` sets `maxTouchPoints`, not the
  primary-pointer media). So width-based responsive CSS is testable; coarse-pointer /
  touch-gesture behavior is an **on-device manual check** (state it clearly, like VR).
  You CAN still measure width-gated CSS vars (`getComputedStyle(document.documentElement)
  .getPropertyValue('--connect-bottom'|'--controls-inset'|'--dock-inset')`) and element
  geometry (`getBoundingClientRect`) to verify docking/sheet math at a given width. Custom-
  chrome context menus can't be right-clicked via Playwright actionability — dispatch it in
  page context: `el.dispatchEvent(new MouseEvent('contextmenu',{clientX,clientY,bubbles:true}))`
  (packs-explorer); a menu opened this way replaces any prior one.
- **Exact svelte-check delta**: `git stash push -u` (includes new files), run
  `npx svelte-check` for the true HEAD baseline, `git stash pop` — the machine output
  DOUBLE-escapes path separators (`src\\lib\\…`), so filter with `\\\\` in the regex.
- Audio suites work headless (launch args allow autoplay); `soundEntries()` exposes the
  live chains — `playing` is source-state, no audible check possible.
- After a reload, NEVER `waitForSelector('canvas')` — it matches the HIDDEN
  `#dungeon-minimap` canvas and times out. Wait on the hook instead:
  `waitForFunction(() => !!window.__stores?.<someLib>, { timeout: 20000 })`.
- Custom-chrome buttons (mesh popup mode switch, peers trigger…) can fail Playwright's
  actionability checks under overlapping fixed layers — click in page context:
  `page.evaluate(() => document.querySelector('#x').click())`.
- "Did it broadcast?" asserts don't need a second peer (the public cloud is the
  slowest, flakiest layer): swap the peers store with a capture stub —
  `peers.set({ ...original, send: (m) => captured.push(m) })` — and RESTORE the
  original after. Never `peers.set(null)`: Player.svelte reads `$peers.peer` and
  throws. Reserve real two-peer runs for receive-path/handshake coverage.
- `objectActions.selectObject(uuid)` takes a **UUID** — passing the object no-ops
  silently and the previous selection stays.
- VR follower panels early-return their POSE task when `!renderer.xr.isPresenting` (so
  they sit at the origin), but they still MOUNT: set the panel's open store, wait a
  tick, and traverse its registered group (`__stores.vrControls.vrEditGroup` /
  `vrSettingsGroup`, or a globalScene traverse) for the named `vr<x>-*` control meshes;
  drive actions via `vrControls.executeVRMenuAction(...)`, not controller rays.
  Controller-by-handedness resolves via `controller.userData.handedness` — a test fakes
  a hands↔controllers reorder by setting `getController(0/1).userData.handedness` (reach
  the renderer via the `globalRenderer` store) then asserting `controllerIndexFor`
  follows the hand, not the slot.
- A **bare module specifier** (`await import('fflate')`) does NOT resolve inside
  `page.evaluate` — the page has no vite resolver there. Build such artifacts in the
  Node side of the `.cjs` test (it can `require('fflate')`) and pass bytes in via an
  `evaluate` arg (e.g. generate a glb in the page → return `Array.from(bytes)` → zip in
  Node → pass the zip array back → reconstruct a `File`). See packs.test.cjs.
- WebXR hand JOINTS are not on `renderer.xr.getHand(slot).joints` by app slot reliably —
  read via threlte `useHand('left'/'right').current?.hand.joints` (keyed by handedness).
  Cross-peer hand presence: send a real `{type:'vrhands', left:{pos,rot,joints:[75]}}`
  from A over the mesh and assert B renders A's `<peerId>-hand-<side>` group (25 joint
  spheres) — a manual send bypasses the on-device capture CI can't do (vr-peer-hands-net).
- Pure helpers (no DOM) unit-test headless WITHOUT a browser — a `.test.cjs` can
  `await import(pathToFileURL('src/lib/x.js').href)` the ESM module directly and assert
  (the runner just `node`s each file; see net-backoff.test.cjs). Track PASS/FAIL locally
  and `process.exit(1)` on failure (helpers.finish needs a browser).
- svelte-check delta hunting: `npx svelte-check --output machine | grep <yourfile>`;
  baseline 2026-08-01 = **435 errors / 62 warnings** (node 24, all A-D migrations in) (drifts down as flowbite/typed
  code is removed — hold whatever it currently is; add no NEW; the release.yml gate
  hardcodes the numbers — update it when the baseline moves). Note: in the big
  JS-mode `.svelte` files (Scene.svelte) `@param {T}` JSDoc on a function is NOT honored —
  give the param a default (`slot = 0`) to force the type, and prefer explicit locals
  over dynamic string-indexing of a typed object (both tripped the baseline in N5). Runes-mode `.svelte` files
  (any `$state`) must use `onclick`/`oninput` — the `on:` directive adds deprecation
  WARNINGS that count against the baseline. a11y warnings count too: focusable divs use
  `tabindex="-1"` + `.focus()`; click/drag containers take a targeted `svelte-ignore`.
- Screenshot-driven design checks reuse the harness: a throwaway `_shot.test.cjs` does
  `setupPage`, seeds state via `window.__stores` (e.g. `explorer.createFolder`,
  `explorer.importFiles([new File([...],'a.txt')])`), opens the panel, then
  `page.locator('#explorer-list').screenshot({ path: <scratchpad>/x.png })`. Read the PNG
  to eyeball it, then DELETE the throwaway (never commit a machine-specific scratchpad
  path). The runner only matches `*.test.cjs`.

## Definition of done

Feature suite green (+ any suites your UI changes touched) + `npm run build` passes +
`npx svelte-check` adds no NEW errors (baseline is legacy noise; grep the output for
your files). Two-peer verification is required for anything touching replication.
VR features: cover the extracted math/state headlessly (computeMoveOffset,
computeTeleportArc pattern) and note that on-device feel is the user's manual check.
