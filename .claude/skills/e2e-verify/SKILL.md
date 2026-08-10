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
while one runs (HMR reloads the pages mid-test — see "HMR churn makes runs LIE").

## Assertion discipline (a check that cannot fail is not a check)

The expensive failures in #16 were not broken code — they were assertions that
passed while the user watched the feature misbehave:

- **Position/layout asserts need a TIGHT BAND and a forcing start state.** "the
  section label is somewhere below the sticky header" is true when NO scrolling
  happened at all (short panel = most sections collapsed), so a deep-link check
  green-lit a link that never scrolled. The fix: expand every section, scroll the
  panel to the BOTTOM first, then demand `0 <= gap <= 40px` (panel-deeplinks).
- **Isolate a REGRESSION with an A/B, not an absolute.** "dragging the gizmo must
  not rotate the view" can pass vacuously (the drag missed the gizmo) or fail
  innocently (left-drag on empty space orbits BY DESIGN). Measure the same gesture
  before and after the suspect sequence and compare — plus assert the gesture did
  its job (the object moved), so a no-op can never look like a pass
  (gizmo-orbit-leak).
- **Match the metric to the gesture**: in OrbitControls LEFT-drag rotates and
  RIGHT-drag PANS — a right-drag "orbit works" check that compares quaternions
  reads 0.0000 forever. Compare `camera.position` for pans, `quaternion` for
  rotation.
- When a check reports success but the user reports failure, re-read the check
  before re-reading the code: ask what state would make it fail.
- **A failing check is as often a wrong PREMISE as a wrong fix — verify which before
  changing code.** Every red in the M1-M6 batch was the test, not the feature: an
  indexed BoxGeometry counted as 8 triangles; a smooth-shading check used a SPHERE,
  whose geometry already ships smooth normals, so it could never have failed; a
  merge-by-distance check expected BOTH near-coincident corners to vanish when only one
  had a partner; a dissolve check expected 2 triangles where the merged patch's
  boundary legitimately fans into 4. Re-derive what the code SHOULD do, then fix the
  assertion — and say so in the commit, because a "fixed" test that was never broken is
  a lie in the history.
- **Changing a DEFAULT turns every suite that silently relied on it red.** Making Move
  the default armed op (so a click stops committing an extrude) broke
  `faces-nested-toolbar`, whose premise was "Extrude is the default, so the params row
  is showing". The fix is to ARM the op explicitly in the test, never to weaken the
  check — and the same batch's `mesh-edge-mode` needed the same treatment when LOOP and
  RING became different commands. Both belong to the "asserting the OLD contract"
  family: when a deliberate behaviour change makes a suite red, update the contract it
  encodes and say so in the commit.
- **A store-level repro must replay the FULL handler sequence, or it proves nothing.**
  `autoApplyFaceOp()` returns false unless the highlight was set first, so a probe that
  called only `pickFaceUnit` + `autoApplyFaceOp` reported "nothing happens" for a path
  that fires every time in the app. Replicate what the component does — for a face
  click that is `highlightFaceByTriangle` → `pickFaceUnit` → `autoApplyFaceOp` — or read
  the handler and mirror it exactly.
- **`innerText` reflects CSS `text-transform`.** A cheat-sheet check comparing `'Faces'`
  failed against text CSS had uppercased to `FACES`, while the UI was perfectly correct.
  Compare case-insensitively, or read `textContent` off the source element.
- **When a report says "X selects everything" / "the wrong thing happened", check the
  UI before the algorithm.** Two such reports in this batch reproduced as CORRECT at
  the store level: six near-identical 18px icon buttons in a row had Select-linked next
  to Loop and Select-all next to Invert, and Select-linked really does select every
  face of a one-piece mesh. The fix was making commands read as words, not touching the
  logic. Reproduce at the STORE level first — if it is right there, the bug is in what
  the user could see or press.
- **Prove a regression guard by BREAKING the code**: EDIT the fix out (put the old line
  back), run the suite, confirm the new check goes red, then restore. Both
  release-blocking fixes in 1.2.0 were validated this way (shift-select: 8 page errors
  and the set stuck at 1; the mesh gizmo: 0/15 vertices moved). A guard you have never
  seen fail is a guess. Do NOT use `git stash push -- <file>` for this: if that file is
  already committed the push saves nothing and the later `pop` takes an unrelated
  ancestor entry off the stack (it landed a `feature/specator-mode` stash in
  Controls.svelte as a conflict). Copy to the scratchpad + `git checkout HEAD --` when
  you need several files reverted at once.
- **Add a PREMISE check whenever the gesture can miss.** A drag of the object-list
  window took four attempts to actually move it — the top chrome covers that header at
  430px so every real-mouse grab hit a BUTTON, and synthesized `pointermove`/`pointerup`
  default `clientX` to 0, which docking.js reads as the left dock zone (it also PERSISTS
  that dock, so the next run starts wrong). The three real assertions passed the whole
  time; only `postDrag.left > preDrag.left + 100` exposed it. If a check depends on a
  gesture having landed, assert that it landed.
- **Drive the real INPUT PATH when the bug lives in a handler.** Shift-click
  multi-select broke inside `onPointerUp`; every store-level `selectObject` test
  stayed green. Project the object's world position (`helpers.projectPoint`) and use
  `page.mouse.click` with `keyboard.down('Shift')`, and count `pageerror` events
  while you do it — a swallowed exception is exactly what a store-level test misses.
- Some behaviour is genuinely NOT testable here and must be labelled an on-device
  check rather than faked: `(pointer: coarse)` (so the mobile view-mode default),
  GPU/driver bugs, and VR feel. Say so in the commit instead of writing a check that
  can only pass.

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

Assigned ports: main checkout 5173 (the user's), lane-c 5174 (mesh work 2026-08-09+
uses **5182** on that same worktree), lane-vr 5175,
lane-ui 5176 (SHADOWED 2026-08-02 — moved to 5186), lane-flow 5177, lane-aiphys 5178, lane-editmesh 5183. A fresh worktree has NO `certs/`, so vite serves plain
http until you run `npm run certs` — the suite's https URL then fails to connect.
Two-peer suites still meet on the signaling server
(now the self-hosted peerjs.theprototype.app box), so concurrent lanes' test peers
never collide (random ids). PORT-SHADOW TRAP: another process holding only
`[::1]:PORT` does NOT trip `--strictPort` (vite binds 0.0.0.0) — but
curl/playwright resolve localhost to ::1 and hit the STALE server (symptom: new
modules 404 to index.html, `__stores` missing new keys, or your edits "not
applying" while the suite runs old code). `netstat -ano` and check BOTH stacks
before blaming your build — and before trusting ANY lane server, prove it
serves YOUR code: `curl -sk https://localhost:PORT/src/lib/<file>.js | grep
<your-new-symbol>` (a stale pre-PATH-flip node-20 vite on [::1] burned a full
debug cycle in #15). Remember two-peer runs ALWAYS need the PEER_CONFIG env on
a localhost APP_URL — `helpers.connect` times out on the Approve button
otherwise (the app dials the local :9001 server that isn't running).

**This is the #1 false regression in a lane, so learn its shape (17-D, cost a
bisect): SEVERAL unrelated suites fail AT ONCE, every one of them on
`locator.click: Timeout … waiting for getByRole('button', { name: 'Approve' })`.**
That is not your diff — it is every TWO-PEER suite (undo, multi-select,
physics-joints, animated-models, module-sdk, scene-music …) dying inside
`helpers.connect` because nothing is listening on :9001. Check
`Test-NetConnection -ComputerName localhost -Port 9001 -InformationLevel Quiet`
BEFORE bisecting, then re-run with the self-hosted box:

```powershell
$env:PEER_CONFIG='{"mode":"custom","custom":{"host":"peerjs.theprototype.app","port":443,"path":"/peerjs","secure":true}}'
```

Starting a fresh dev server on another port is the cheap way to rule out server
degradation first; if the failures survive that AND cluster on Approve, it is the
signaling server every time.

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
nodesHandler, nodeCatalog, objectMenu, flowGraphsCtl, objectFlow, vrSleeve,
gridSettings, cameraBookmarks, cameraObjects, cameraHelpers, cameraPreview,
cameraPip, addObjects, multiTransform, objectOrigin, bvhPicking` (+ from the
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
- **Real-mouse GIZMO drags**: never guess a pixel offset from the object — find the
  actual picker and project it. `const helper = controls.getHelper?.() ?? controls;`
  then `helper.traverse(n => { if (n.isMesh && n.name === 'X') pick = n })`,
  `pick.getWorldPosition(v).project(cam)` → screen px (gizmo-orbit-leak). three keeps
  the gizmo VISUALS in that helper object, so `controls.visible = false` hides
  nothing — hide the helper.
- **Panels scroll**: a field can be off-screen (`y: -664`) after an earlier
  deep-link/scroll in the same suite — `await locator.scrollIntoViewIfNeeded()`
  before `boundingBox()`/mouse work, or the events land nowhere and the failure
  looks like broken behaviour.
- Inspector section HEADERS are `<button class="ui-section-label">` containing the
  label AND a `−`/`+` glyph — match with `startsWith`, never `===`. A collapsed
  section renders no children, so query its contents only after expanding
  (`localStorage["inspector:sec:<label>"] = "open"` before load, or the deep-link
  store `inspectorScrollTo`).
- The numeric field is `.dn-wrap` (wrapper, carries `.dn-scrub`/`.dn-focus`) with
  `.dn-input` inside — the old `.drag-number` button is gone. It is always a real
  input: typing applies LIVE, ↑/↓ step one minor unit (Ctrl ×10, Shift ×100), a
  drag scrubs, Esc reverts.
- Context menus: `.ctx-filter-input` (always mounted, focused, collapsed until you
  type), `.ctx-match` rows in search mode, `[data-ctx-active="true"]` = the keyboard
  cursor, `.ctx-grip` = the search-list resize handle, and a SUBMENU is a fixed div
  with NO role attribute (several suites locate them that way — do not add one).
- **MESH tests: a fresh `BoxGeometry` is INDEXED.** `position.count / 3` is **8**, not
  12, and reading a triangle's corners as `position[ti*3 + k]` reads unrelated vertices
  and invents diagonal normals. This bit FOUR separate premise checks across 15-G and
  M1-M6 — always `geo.index ? geo.index.count : geo.attributes.position.count`, and
  index corners through `geo.index.getX(...)`. Anything that has been through
  `convertToMesh` / `applyMeshGeo` / a face op IS non-indexed, which is why the same
  helper passes in one suite and lies in the next.
- **Assert the COMPUTED style, not the class string**, whenever a component's scoped
  CSS could beat a utility (it is unlayered, so it does). The armed toolbox button
  carried `bg-primary-600` in `className` while rendering fully transparent in the dark
  theme; only `getComputedStyle(el).backgroundColor` caught it. Same shape as the
  global-`.hidden` trap, one scope down.
- **Render-count checks: calibrate the passes, don't assume one.** Each mesh is drawn
  once per pass (shadow map + colour = 2 here), so isolate an object by toggling
  `visible` across two `renderer.render` calls and derive the multiplier from a
  known-good state (`drawn / tris`) instead of hardcoding it. `renderer.info.render
  .triangles` after `reset()` is the measurement — it is how "the merged mesh renders 0
  of its 28 triangles" was proven.
- Mesh-edit anchors: toolbox root `#mesh-edit-popup` (a `ToolboxWindow`: header
  `.toolbox-header.move-handle`, body `.toolbox-body`, footer `.toolbox-status`, grip
  `.dw-resize`); modes `#mesh-mode-vertices|edges|faces`; granularity
  `#mesh-gran-quad|face|triangle|shell|object`; ops `#mesh-op-<op>` (armed carries
  `mesh-op-active` + `tbx-on`); cleanup `#mesh-fix-normals|merge` + `#mesh-shading`;
  edges `#edge-loop|dissolve|clear` + `#edge-sel-count`; session cancel
  `#mesh-edit-cancel` with the inline `#mesh-cancel-confirm` / `#mesh-cancel-yes` /
  `#mesh-cancel-no`; the key list is its OWN window `#mesh-keys-popover` opened by
  `#mesh-keys-help`. Sculpt `#sculpt-toolbar` + `#sculpt-op-*`.
  **Selection commands are TEXT buttons whose ids are PER MODE** — `#mesh-sel-all` in
  faces but `#mesh-sel-eall` / `#mesh-sel-vall` in edges / vertices (same for
  `invert`/`einvert`/`vinvert`), so a selector hardcoding the faces ids silently
  matches nothing in the other two modes.
- The face highlight is TWO meshes: `face-edit-overlay` = the SELECTION (opacity ~0.45)
  and `face-edit-hover` = the cursor wash (~0.14). A check for "is this face
  highlighted" has to say WHICH — they were one mesh until a deselected face kept
  looking selected under the cursor.
- `objectActions.flyTo(pos, target, duration)` divides by `duration` — passing **0**
  makes the first frame `NaN`, which NaNs the camera and then the spatial-audio panner
  (`Failed to set the 'value' property on 'AudioParam'`). Use a real duration and wait.
- Synthetic `pointerdown/up` on a `dragWindow` header logs harmless
  `setPointerCapture: No active pointer` page errors — expected for synthesized events;
  don't count them in a pageerror guard for drag tests.
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
  Toast entries may be STICKY (`{id, sticky:true, kind:'info'}` — restore-session,
  first-run notice, share-or-stash): they never auto-expire and never fold into
  "+N more", so don't wait them out — click an action or `dismissToastById(id)`.
  State that lives INSIDE a component (not a store) needs its own opt-in hook,
  gated on `debugStores` — the pattern is one `$effect` publishing a getter:
  `window.__outlineDebug()` → `{selected, locked}` mesh counts,
  `window.__cameraPreviewDebug()` → `{preview, hasObject, cameraMounted,
  controlsMounted, defaultCamera, defaultIsMine}` (this is what settled the "is the
  camera swap broken?" question: the component said `defaultIsMine: true` while a
  stale page said otherwise). Module-level probes are plain exports:
  `cameraHelpers.cameraHelpersDebug()`, `cameraPip.pipDebug()`,
  `colliderHelpers.colliderHelpersDebug()`.
  The outline effect isn't in `__stores` (it lives in Outline.svelte) — read it via
  `window.__outlineDebug()` → `{selected, locked}` mesh counts (debugStores-gated).
- **Scene notes (15-H)**: the desktop marker is a screen-space DOM badge, so read it
  from the DOM (`.marker-badge` + `.marker-num`, leader lines in `.marker-lines`),
  not from `pinsGroup` — the in-scene meshes only render in VR now (the pin GROUPS
  stay live as anchors, which is why `annotation-anchor` is unaffected). App chrome
  (Connect bar, z 300) sits ABOVE the marker layer (z 28), so a badge under it fails
  Playwright's actionability check — click it in page context. Markers CLUSTER at
  34px, so from a distance there is no `#1` to click: frame the note from its own
  pin (`annotationWorldPosition` → `flyTo`) first. `notes-v2` also carries a
  frame-lag guard (spin the camera, compare each badge against the pin projected
  with the live camera) — it was verified to FAIL when a one-frame lag is
  reintroduced, which is the only reason to trust it.
- **Camera assertions**: never assert the pose you *asked* for —
  `OrbitControls.update()` re-derives the camera position from its spherical state.
  Park the camera, READ the resulting pose, compare against that. And a synthetic
  click races Svelte's binding: to assert a control's ON styling, reopen the panel
  so the state comes from STORED data instead of measuring right after the click.

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
- **HMR churn makes runs LIE** (cost ~4 cycles in #16-Q5): a page that loads while
  vite is still re-transforming just-edited modules gets a half-mounted app —
  components that exist in the source simply are not there, so a WORKING feature
  reports broken (three runs "proved" the camera preview dead; a fresh run passed
  untouched). Let the server settle a couple of seconds after your last edit, never
  edit during a run, and treat a red run that started right after a save as
  unproven. When store reads disagree with what you see, add a COMPONENT-side debug
  hook and compare the two (below).
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
  dock-sidebar-inset, layout, panels, script-nodes, and a few
  two-peer timing suites (module-sdk, scene-music, physics-kinematic,
  physics-discoverability, roadmap-13-notifications-notes, scene-assets,
  view-mode, vr-passthrough). `node-search` came OFF this list in #16-P2 — two of
  its assertions were stale (they demanded menus never scroll and are never
  height-capped, which a later change deliberately reversed). When a "known
  failing" suite blocks you, check whether it is asserting the OLD contract. That
  includes assertions YOU wrote earlier in the same session: 17-D's "no hinge
  button until vertices are picked" went red the moment the fix deliberately made
  that button always-visible. Fix the assertion, not the code — and replace it with
  one that still bites (there: pressing the button with nothing picked must change
  no origin).
- `add-menu` documents its own flake in a comment at the failing line (a right-tap
  that does not open the viewport menu) — the fastest proof that a failure is not
  yours is still `git stash push -u` → run → `git stash pop`.
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
  baseline 2026-08-02 = **419 errors / 62 warnings** (node 24; #15-C's one-way
  pickers dropped 14, #15-K's outline rework 2 more) (drifts down as flowbite/typed
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
