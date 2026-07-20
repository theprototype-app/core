---
name: e2e-verify
description: Verify theprototype.app changes end-to-end with Playwright — the committed tests/e2e suite, single-page and two-peer (PeerJS cloud) recipes, the debugStores hook, and known flakes. Use before committing any feature.
---

# E2E verification recipe for theprototype.app

## The committed suite (start here)

`tests/e2e/*.test.cjs` + `helpers.cjs` (`.cjs` — the package is `"type": "module"`).
Run with the dev server up (`npm run dev`, https on 5173):

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

Rules: never run suites in parallel (shared dev server), never edit sources while one
runs (HMR reloads the pages mid-test).

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
nodesHandler, nodeCatalog, objectMenu`. Naming trap: `__stores.viewMode` is the
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
  play `i.fa-play`; object rows `#object-list p[id]`; search `#object-search`;
  modules manager via `#open-modules-manager` (drawer: `closeMenu.set(false)` first)
  or `modulesOpen.set(true)`; module cards `#module-card-<id>`; draw `#draw-toolbar`;
  dungeon `#dungeon-panel`; script editor close `#script-panel-close`.
- Programmatic scene setup: `__stores.commandsHandler.sceneCommand('/create box')`
  (geometry names are capitalized THREE types — box/sphere/Button…, NOT "cube").
- Flow graphs: set `flowNodes`/`flowEdges` locally **and broadcast** `nodecreate`/
  `edgecreate` per node/edge like the UI does — relying on the 10s nodesync heal is
  slow and rate-limited (30s) → flaky.
- Viewport clicks: `helpers.projectPoint` a REAL object/point position, then
  `mouse.click` — fixed pixel guesses miss thin/overlapping geometry (the piano
  black-key lesson). Right-click must be a real `mouse.click(x,y,{button:'right'})`.
- Context menus render `role="menuitem"`; group items CONTAIN submenu text — anchored
  regex `/^Exact label$/` + `.last()` if needed.
- Action toasts have buttons now — `getByRole('button', { name: 'Approve' })` etc.

## Two-peer flow (real replication)

Use `https://theprototype.app:5173/` — hosts-mapped to 127.0.0.1; the `.app` hostname
makes peerjs use the **public cloud** (localhost tries ws://localhost:9001 and fails).
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
  add-menu search-Enter, sound-node Play overlap, connect-overlay querySelector,
  scene-music byte-push timing. To PROVE a failure is pre-existing:
  `git stash push -u`, run the suite on HEAD, `git stash pop`.
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
  Explorer, themes).
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
  screenshot). Layout gated by `@media (pointer:coarse),(max-width:…)` won't show on the
  default 1280 desktop context — resize first. Custom-chrome context menus can't be
  right-clicked via Playwright actionability — dispatch it in page context:
  `el.dispatchEvent(new MouseEvent('contextmenu',{clientX,clientY,bubbles:true}))`
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
  baseline 2026-07-19 = **501 errors / 77 warnings** (drifts down as flowbite/typed
  code is removed — hold whatever it currently is; add no NEW). Note: in the big
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
