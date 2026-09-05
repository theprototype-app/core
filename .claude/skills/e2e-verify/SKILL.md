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
UI changes break — in the same commit. The UV editor's are `uv-editor` (dock tab, UV
map, drag, multi-select, box/lasso), `uv-materials` (per-slot textures), `uv-paint`,
`uv-target` (which object the editor shows), `uv-dense` (models over the snapshot
cap), `uv-live-faces` (live paint preview + face scoping), `uv-texture-params`
(sampler state + the orientation arbiter), `uv-slots` + `uv-slots-persist` (UV4
slots, live and across a reload), plus `mesh-grab-uv` and `object-sync` — the first
coverage this repo has of the gizmo-grab uv path and of the late-joiner object sync.
The GAME line: `game-state`, `hud-actions`, `logic-nodes`, `collectibles-v2`,
`peer-variables`, `game-presence`, `scene-levels`, `project-manifest`, `project-file`,
`scene-folders` and the `game-loop-v2/v3/v4` acceptance suites, plus (R3a)
`sdk-game-seams` — the module-facing seams api.game/peerVars/flow/playerPosition, the
`{replicate:false}` local pulse, the round-aware `ctx.trigger`, and the counterfactual
that the migrated collectible pieces are GONE from core. `module-toolbox` covers the
toolbox seams incl. the `sidebar: false` opt-out and openToolbox/closeToolbox/
toggleToolbox. **`trigger-log-sync`** (56, three peers) covers DEVX #18 - the handshake
reply for the trigger log, and the epoch that keeps arriving history readable while making
it fire nothing; **`flow-spawner`** (43) covers B7, including the byte-identical
`physicsDebug` PARITY GOLDEN for the createBodyFor extraction (embedded with the recipe to
redo it - reuse that shape for any future body-construction change); **`palette-groups`**
(12) asserts the Input-vs-Triggers rule from the socket types the catalog already declares,
so a misfiled node cannot drift back. The collectible MODULE's own flight lives in the
modules repo (`tests/module-collectible.test.cjs`, 129 checks, three peers).
The mesh pro tools each have one: `mesh-edge-gizmo`, `mesh-bevel` (faces), `mesh-vertex-bevel`,
`mesh-edge-bevel`, `mesh-vertex-slide`, `mesh-proportional`, `mesh-knife`, `mesh-symmetrize`,
`mesh-bridge-normals`, `mesh-gizmo-modes` (the gizmo across element modes, driven by REAL mouse
clicks) and `uv-unwrap-module` (a module supplying an unwrap backend, and wasm from a blob URL).
Roadmap #20 added seven: `duplicate-parity` (what a copy carries, incl. two peers),
`node-drag-fields` (DragRow inside xyflow cards, real mouse), `units` (the pure
parse/convert table plus an Inspector row that must NOT move the object when the unit
changes), `touch-tools` (the cluster, mobile multi-select, mesh-element BOX SELECT, the
measured placement, and the SettingRow prose guard), `post-backends` (the registry
fallback + both module seams, via an INLINE module), `workspace-restore` (layout local,
selection + edit mode in the file) and `graph-tree` (the navigator + its resize grip).
The size ceilings are `mesh-budget` (commit vs live-PREVIEW vs undo-byte budget,
with the counterfactual against the old 45000 cap); selection is `selection-extras`
(Ctrl+A + the configurable double-click, both through real input); the edit-overlay
save paths are `edit-overlay-gaps`; the animation look channels and the loop-pause
transport are `animation-look-channels` and `animation-loop-pause`.
The shader graph editor has eight (all of them are the gate for any shader change, and
two-peer `shader-sync` needs PEER_CONFIG): `shader-inspector` (the shader-driven
Material section + its guards + the context-menu entry), `shader-module-flow` (the
module backend seam via `moduleSDK.initModules` with an INLINE module — the real api
path, no zip needed — plus the Set Shader Uniform node), `shader-node-docs` (no
browser: every node has a manual line, none merely restates its label, and the
docs-site tables carry the SAME text), `shader-scene-default` (the SCENE graph over 24
objects — it also CARRIES THE MEASUREMENT that declined SH6b's compile-once
optimisation, so a change making scene-wide compiles expensive turns it red),
`shader-compile` (the graph->IR compiler, NO
browser — it imports the ESM directly), `shader-graph` (the store/compile/install
pipeline), `shader-sync` (replication + history, three peers), `shader-editor` (the
dock tab, driving the real UI) and `shader-persist` (all four save paths, including a
real save -> reload -> `restoreSnapshot()` cycle). Three premise traps this round paid
for, all in `shader-graph`: tiling or scrolling a SOLID-COLOUR texture cannot move a
pixel, so those checks were unfalsifiable until the fixture got structure (and the
metric became a count of CHANGED pixels, since a mean averages stripes away); with a
two-halves image any WHOLE tiling maps the sample point back onto the same colour
boundary, which is a property of the fixture and not of tiling (use 3.5); and texture
resolution is LAZY -- triggered when a compile fills the sampler uniform -- so polling
`shaderTextureFor` before anything asked for that hash waits forever. Only the premise
check `the structured texture decoded` separated the last one from a real failure.
Three more premise traps from the SH5-SH7 round: `buildObjectMenuItems` derives
`multi` from opts.SELECTION and IGNORES an opts.multi flag, so a hand-passed flag
makes the check vacuous; a WIRED flow input means editing that node's own `data` does
nothing (the upstream node decides, which is correct behaviour); and a SYNTHETIC
mousedown on an xyflow node card enters its drag handler, which reads `ownerDocument`
off the target and throws — select a node with a real `page.mouse.click`. Also: two
picks of the SAME bytes are the same content hash, so a second texture assignment is
silently a no-op (vary the image, or the check measures the first one twice).
21-C terrain and splines have three: `terrain-procedural` (noise determinism imported
DIRECTLY in node, plus two peers on a bit-identical position hash, the tiling seam and
the sculpt lock with its Regenerate escape), `terrain-carve` (the pure carve with no
browser, then both Flatten directions driven by real viewport clicks) and the ported
`spline-tool`. Their traps are below and they generalise: a projected world point may
not be ON the surface, a buffer-level metric cannot see a shattered mesh, and an
idempotent op leaves later sections nothing to measure.
Stored mesh topology is `topo-channel` (the partition's wire/undo/save round trips, the
operators that author it, two-peer delivery and an old-peer message), and
`mesh-loop-hardening` section 3b is where the twisted-band criterion lives.
The EXPLORER line is `explorer`, `explorer-views` (round 9's list view and bin),
`explorer-columns` (round 11: resize, reorder, the sideways scrollbar and the
`table-layout: fixed` counterfactual), `explorer-drag-fixes`, `explorer-multiselect`,
`explorer-delete-confirm` (round 11: the inline confirm strip and drop-to-Deleted),
`shared-library`, `prefab-explorer`, `packs`/`packs-explorer` and `sessions` — with
`sessions-packs` (round 11) covering the two-level file picker, the sessions list view,
the thumbnail path and packs you create yourself. `file-preview` covers the preview
window's four faces, its folder walk and the passthrough overlay; `save-as-formats` covers
the Save as… catalog and a prefab that carries a format and bytes.

helpers.cjs exports: `launch(options)` (pass
`{args:[...]}` for fake media), `setupPage(browser, name)` (init script + hydration +
peer id), `connect(from, to, settleMs=9000)`, `check(ok, label)`,
`eventually(fn, predicate, label, timeout)`, `projectPoint(page, [x,y,z])` (world →
screen pixel for real clicks), `finish(browser)` (exit code), `run(body)`,
`freshReload(peer)`, `pageErrors(peer)`, `installModule(peer, id)` +
`moduleZipPath(id)`, the pixel four (`grabFrame`/`centeredClip`/`frameDelta`/
`framePixelsOffColor`), `URL`, and **`GPU_ARGS`**.

**`GPU_ARGS` is not only for pixels — it is required for anything TIME-based.** A
software-rendered headless page runs at about **2.5 fps** (measured 2026-08-18 by
counting `requestAnimationFrame` callbacks over a 2s window: 5 frames). Any per-frame
runtime is therefore ticking ~24x slower than a user's, so a throttle in the 10Hz range
CANNOT ENGAGE and reads as "throttled" while doing nothing at all — a HUD store capped
at 100ms measured 5-6 writes/2s either way, which passed a ceiling assertion vacuously.
With `h.launch({ args: h.GPU_ARGS })` the same page runs **120 frames / 2s** and the cap
shows as **19 writes against 120 frames**, which is the throttle actually being proven.
Corollary for the assertion itself: state a rate claim RELATIVE to a frame count
measured in the SAME window, never as an absolute Hz — an absolute floor is asserting
the host's rAF cadence, not your code.

Rules: never run suites in parallel AGAINST THE SAME dev server, never edit sources
while one runs (HMR reloads the pages mid-test — see "HMR churn makes runs LIE").

## Assertion discipline (a check that cannot fail is not a check)

- **A REPRO THAT DOES NOT REPRODUCE gives the most confidently wrong answer there is.**
  Rebuilding a user's "pressing R does nothing" graph, the Key Press node was seeded
  with `key: 'r'` — its field is `code: 'KeyR'` — so it never pulsed and the probe
  reported "the node never fires". One field wrong turned a UX problem into a phantom
  runtime bug. Before believing a repro, assert the FIRST link fired (here: the
  trigger stamp / the override map), not just the last effect.
- **Distinguish "did not fire" from "fired and did nothing".** They have completely
  different fixes, and only one of them is a bug. The cheap way is to read the
  smallest piece of state the action writes — the override map showed the node firing
  perfectly while the screen stayed identical, which pointed straight at the design
  rather than the wiring.
- **Opening the Flow pane needs the REAL opener**: `p[title="Node editor (N)"]`.
  `bottomDock.activateDock('flow')` alone leaves `.svelte-flow` unmounted, so a
  pane-geometry or node-card check silently has nothing to look at. And the pane's
  scope FOLLOWS THE SELECTION — creating an object selects it, so a suite that seeds
  the SCENE graph then opens the pane sees that object's object-flow instead.
  Deselect first.
- **`centeredClip` falls back to the viewport centre** because a world point BEHIND the
  active camera projects non-finite, and NaN survives a Math.min/max clamp —
  Playwright then rejects the clip as "empty or outside the resulting image", which
  reads as a broken feature rather than a bad measurement.
PIXEL features have their own helpers now: `grabFrame`/`centeredClip`/`frameDelta`/
`framePixelsOffColor` (screenshot -> back INTO the page -> 2D canvas -> RGBA, compared
in the page so only metrics cross the bridge). Four rules came out of building them:

- **A BUFFER-LEVEL metric cannot see a shattered mesh, and one shipped.** The carve
  suite asserted the vertex count was "unchanged", both peers agreed, one message, one
  undo entry — all green over a terrain that drew 208 arbitrary triangles plus a
  fragment, because `applyMeshGeo` builds a NON-indexed geometry and it had been handed
  an indexed terrain's 625 positions (not divisible by 3). The count being unchanged
  WAS the symptom, and the assertion said so in as many words. For anything that
  rebuilds geometry, assert the TRIANGLES: count divisible by 3, and no edge longer
  than the lattice it came from (24.04m on a 1m grid with the bug in, 1.62m with it
  out). Watertightness is the same rule for closed meshes.
- **A projected world point is not necessarily ON the surface you meant to click.**
  `projectPoint([-7, 0, -7])` over a hilly terrain gives a pixel whose ray the app
  resolves to NOTHING (measured: `hits []`), because y=0 is underneath the hills — so
  every click-driven check of an armed pick mode failed while the feature was perfect.
  Cast DOWN onto the target first, project the SURFACE point, and verify both that
  `elementFromPoint` is the canvas and that the app resolves that pixel to the intended
  object. The second half matters just as much: selecting anything opens the properties
  drawer over the right of the viewport, and the first round of aims landed on a drawer
  DIV. `aimAtSurfaceOf` in terrain-carve is the reusable shape.
- **An IDEMPOTENT operation leaves later sections nothing to measure.** Three checks in
  the carve suite read a legitimate zero because earlier sections had already flattened
  the bed. Re-seed the input at the top of each section that measures CHANGE, and take
  the undo-depth baseline immediately BEFORE the gesture rather than before setup that
  also records entries (that read +3 for one click).
- **Measure both sides of a comparison in the SAME unit.** "A repeat carve converges"
  compared 251 COLUMNS (before the commit expanded the mesh) against a toast's 876
  VERTICES (after), and read as divergence when nothing had diverged. The same class of
  mistake as the bug it was testing, one layer up: when a commit changes the mesh
  REPRESENTATION, compare a representation-independent quantity (the (x,z)->y height
  field, or a canonical soup) instead of buffer indices.
- **Scan the WHOLE toast stack, never just the last entry.** This box emits peer-server
  toasts ("Lost connection… reconnecting") throughout a run, so the newest toast is
  regularly not the one your click produced — and clear the stack before the gesture,
  or an earlier identical message satisfies the wait without anything having run.
- **Assert the CHANGED PIXEL COUNT, not a mean.** A mean is blind to a thin edge — a
  one-pixel outline over 1280x720 moves it by ~0.1. But keep both metrics: AO on a lone
  convex box is a small contact BAND with a large delta, where a count alone reads as
  failure. Pick the threshold per effect: measured, SMAA moves 1351 px where a dot
  screen moves all 129600, and one shared number would pass vacuously for the strong
  ones and fail the subtle ones.
- **`locator('canvas').first()` matches DungeonMinimap's HIDDEN canvas** (it renders
  before threlte's `<Canvas>` in App.svelte) and waits 30s on an invisible element — the
  same trap as never `waitForSelector('canvas')`, one tool over. `grabFrame` derives its
  rect from the renderer's own `domElement`. And any COLOUR metric needs a chrome-free
  clip: the Connect bar and the Controls HUD are composited over the canvas and land in
  an element screenshot too.
- **A "nothing is selected" CONTROL frame must deselect EXPLICITLY.** Creation paths
  populate the selection SET (15-K), so the baseline carried the very outline it was the
  baseline for and read 1880 px against 1880. With the deselect it is 0 vs 1880.
- **A leftover portaled dropdown can cover the thing under test.** ThemedSelect closes on
  POINTERDOWN, so `document.body.click()` leaves `.ts-list` mounted; harmless at three
  menu entries and fatal at thirteen, when it covered the rows two later sections
  dragged and both real-mouse checks reported broken features. Dismiss with a real
  pointerdown and assert `elementFromPoint` is the intended target before any
  synthesized drag.

- **"One entry per gesture" needs BOTH halves asserted.** "One undo reverts the whole
  drag" PASSES with the collapse removed, because the gesture's entry still sits on top
  of the per-pointermove ones. Only the MESSAGE COUNT (12 instead of 0) and a check that
  a SECOND undo skips PAST the drag catch it.
- **An async pull that arrives later can be masked by any rebuild.** A check that a peer
  applies a pulled asset passed with the retry logic REMOVED, because it flipped that
  peer's view mode after the pull and the rebuild loaded the file anyway. Take the
  baseline BEFORE the state arrives, and do not touch anything that would recompile.
- **Never run `npm run build` while the lane's dev server watches the same worktree** —
  it rewrites `.svelte-kit/output` under the server and kills it; the next ten suites
  all report `ERR_CONNECTION_REFUSED`, which looks like a mass regression.
The expensive failures in #16 were not broken code — they were assertions that
passed while the user watched the feature misbehave:

- **A pixel threshold measured against "the base" is a bet on which object the run
  produced.** `palette.js` derives every object's colour from its uuid, so the same
  red-multiply read r:g 1.42->1.52 on one cube and 0.86->1.09 on the next, and a
  shadow check that let each material pick its own dominant channel compared a base's
  BLUE against a shader's RED. Three fixes, in order of preference: control the input
  (neutralise the base colour at setup), compare two of YOUR values on the same object
  rather than against the base, and compare like with like. That took one metric from
  a 20-38 spread to a stable 82.3 across three consecutive runs.
- **A feature with no ENTRY POINT is invisible to a suite that supplies its own.** The
  Shader tab passed 20 checks while no user could open it, because the suite set the
  store directly. Same family as the mount-crash trap, one step earlier: drive the
  real opener (click the panel, click "+", click the item), not the state it sets.
- **After installing a material, RENDER TWICE before sampling.** The first render is
  where three builds the program, so a probe reads the pre-injection picture —
  intermittently, which reads as a flaky feature rather than a flaky measurement.
- **An AGGREGATE health check cannot see a LOCAL loss.** `mesh-uv-preserve` asserted
  the uv attribute exists, `uv.count === position.count`, and a healthy global
  spread — all three stayed green while six corners of ONE face sat on texel (0,0)
  and the user watched that face's texture vanish. An earlier investigation used
  those same aggregates and concluded "visual artifact, the data is fine". Assert the
  PART the operation touched: capture the picked face's triangle indices first, then
  read those corners back (`mesh-grab-uv`). Sum/min/max/count over a whole mesh hides
  any localised defect.
- **Write the check BEFORE the fix when a design choice is genuinely ambiguous, and
  let it decide.** Whether a `flipY=false` texture wants canvas y = v·h or (1−v)·h had
  two confident, opposite answers. Painting a known UV quadrant and demanding the
  pixels land where that quadrant SAMPLES settled it in one run: tr=656/br=0 before,
  br=653/tr=0 after (`uv-texture-params`). Reasoning alone was a coin flip on a fix
  that would have looked plausible either way.
- **A GEOMETRIC assertion must measure the part that MOVES.** "How far does the mesh reach"
  reported the SAME number for a flat chamfer and a hollow one — a hollow moves the INTERIOR
  rings while the outer corners stay — and on a box it was reading a different corner entirely.
  This cost three wrong red/green readings across the two bevels before the metric was fixed to
  look inside the affected band and take the min or max according to which way the feature
  pushes. Before writing the number, ask which vertices the op is supposed to move.
- **WATERTIGHTNESS is the single best check for any op that rebuilds geometry.** Count the mesh
  edges shared by exactly two triangles; anything else is a crack or an overlap. It caught four
  separate defects in one batch that no visual check would have: the edge bevel leaving the
  third face at a corner on the old vertex (12 odd edges), a multi-segment bevel strip becoming
  a chain the endpoint face did not meet (2 per extra segment), the knife passing a
  single-crossing triangle through unchanged (10), and its quad decomposition pairing two
  corners the wrong way so the halves overlapped (8). Fifteen lines of helper, reusable in
  every mesh suite.
- **Drive the REAL input path, not the store, when the report is about input.** The first
  edge-gizmo suite called `pickEdge` directly: correct seating math, and it could not have
  caught a broken pick path — which is exactly what "edges still have no gizmo" would have
  meant. `mesh-gizmo-modes` and `mesh-knife` click the viewport with `page.mouse` through
  `h.projectPoint`, and the knife suite drives the whole two-click gesture including the
  rubber band and Escape.
- **An ASYNC seam hands back a promise: await it, do not sleep on it.** `uv-unwrap-module`
  first slept 200 ms for a module's backend registration and read the registry too early, then
  blamed a plausible-sounding second module instance under vite's HMR stamps. That hypothesis
  was TESTED and disproved; the actual answer was that `api.registerUnwrapBackend` returns the
  promise precisely so nobody has to guess. When a fixed sleep is load-bearing, look for the
  promise you were meant to await.
- **COMPUTE THE COUNTERFACTUAL in-test when a fix replaces an unreliable heuristic.**
  Stored mesh topology exists because deriving quads from coplanarity fails on a twisted
  band — but the first subdivide guard used a FLAT box face, where derivation produces
  the same answer, so it passed with the feature ripped out. The fix is not just a
  harder input: it is asserting the gap. Clear the stored data, re-run the derived path
  in the same evaluate, and compare (`derivation alone recovers 1 of the 4 sub-quads`,
  `10 quads kept where derived gives 6`). The check then carries its own proof that the
  scenario is adversarial, and a reader six months later can see WHY it matters.
- **A regression guard that RECORDS a limitation must be flipped, not deleted, when the
  limitation goes.** `mesh-loop-hardening` 3b asserted `paired === 0` — the number to
  beat. Landing stored topology made it assert `paired === wall` instead, keeping the
  twist MEASUREMENT (dot -0.07) that proves derivation could never have done it. Deleting
  the section would have thrown away the only evidence of why the feature exists.
- **A wire spy that does not CALL THROUGH makes delivery and loss identical.** Every
  existing spy in this repo replaces `send()` and drops the message. A probe built
  that way "proved" a late joiner got an empty scene, which aimed a whole planned
  send-channel rewrite at a non-bug; a pass-through wrapper
  (`const orig = conn.send.bind(conn); conn.send = m => { record(m); return orig(m) }`)
  showed the channel was fine. Spy the RIGHT object too: `sendObjects` uses
  `conn.send` on the raw DataConnection, not `peers.send`.
- **When the failure signature is SILENCE, instrument the silence.** Nothing threw,
  nothing logged, the scene was just empty. Add an `unhandledrejection` listener and
  the connection's own `error` event (neither appears anywhere else in the suite) and
  record what actually left the wire, or you are reading tea leaves (`object-sync`).
- **"It still looks right" is not "it survived".** A material array comes back from a
  GLTF round trip as a Group of single-material children that renders IDENTICAL
  pixels — that is why the reload bug reached a user. Assert the SHAPE (`type ===
  'Mesh'`, child-mesh count, slot count, group count, uuid), never the appearance
  (`uv-slots-persist`). Reload tests must also call `autosave.restoreSnapshot()`
  explicitly: the restore is offered as a sticky prompt, never applied automatically.
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
- **`h.eventually` returns the CHECK RESULT, not the value it polled.** Binding its
  return (`const seen = await h.eventually(...)`) gave `undefined` to four follow-up reads
  while delivery had actually worked — the poll passed and then everything downstream
  reported nothing. Await it for the wait, then read the state again separately.
- **A `boundingBox()` is not a hit test, and a pane's viewport is not yours to assume.**
  node-drag-fields placed nodes at flow y=60/240 and BOTH fields turned out covered — one
  by the 3D canvas (above the dock pane), one by the palette tab button — and one drag
  still "passed", because pressing the palette toggle reflowed the pane and the later moves
  landed on the real field. xyflow's `fitView` runs at MOUNT, so a suite that seeds nodes
  afterwards cannot know where they landed: measured, the mount fit left a card at screen
  x = -29.5 at zoom 0.5, and a real pane drag panned 3775px for a 200px gesture. Pin the
  viewport through the `window.__flowViewport` debug hook and `elementFromPoint`-check
  every synthesized grip.
- **A nav button TOGGLES.** `p[title="Node editor (N)"]` opened the pane in section 1 and
  CLOSED it in section 8, so the element under test was legitimately absent. Drive the
  stores (`flowGraphClose.set(false)` + `activateDock`) when a later section needs a panel
  that an earlier one already opened.
- **Some panels cannot coexist BY DESIGN.** `bottomDock` closes the Explorer whenever a
  Flow-family panel becomes the visible tab, so a check that opened both was measuring that
  rule instead of its own. Pick a control that shares nothing with the thing under test.
- **Rows only exist inside an EXPANDED accordion.** The Settings modal renders zero
  `.setting-row`s until `settingsSection` names the section — `settingsOpen.set(true)`
  alone finds nothing.
- **A store-level probe cannot test a handler.** `pickFaceUnit(tri)` takes NO additive
  argument (the additive path is `toggleFaceSelection`), so a probe passing one compared
  two identical replaces and read "2 tris vs 2". And even a corrected probe would only
  re-implement Scene's branch in the test, which cannot catch Scene failing to feed a flag
  into it. When the bug lives in a handler, drive the real mouse.
- **A fixture must be something the real code can consume.** post-backends registered a
  module effect whose `make` returned an object literal; the LIVE composer then crashed
  inside `EffectPass`, which looked like a broken feature and was a broken fixture — and
  in the process exposed a real hole (that construction was unguarded), so the fixture
  earned its keep. Build fixtures from the real types (`new Effect(...)`).
- **A fixture missing a PRECONDITION makes a working fix look broken.** Auto-key
  records INTO a clip: an object with none keys nothing, and `captureAutoKey`
  returns before doing anything. The first material-auto-key suite built a bare
  box, saw no channels, and read as a failed fix — the code was right and the
  fixture was not a scene anyone has. Give the fixture the state the report
  describes ("I had created a clip"), and say the precondition out loud in the
  suite so the next reader does not re-learn it.
- **When a third-party widget cannot be driven, test the SEAM you own.** Two runs
  went into trying to drive the colour picker from the DOM: it exposes no hex
  field to type into, and clicking the section header (already expanded) COLLAPSED
  it and removed the widget entirely. The behaviour under test was never the
  picker — it was "a material edit keys its channel", which is one exported
  function call away. Drive the real path when the bug is IN the input path;
  otherwise test where the logic lives.
- **TEST THE FLOW THE USER DESCRIBED, not the tidy one.** The relative-motion suite
  did move -> play and passed; the report was play -> stop -> MOVE -> play, which
  still reverted, because the cached base only refreshes when there ISN'T one. A
  suite that exercises the clean path proves the clean path. Write the user's
  sequence down verbatim and run THAT.
- **Sample the DOM to prove a panel updates.** "The properties panel follows
  playback" cannot be checked from stores — the store changed and the rows did not.
  Five reads of `.dn-input` across a running clip returned identical values, which
  is what settled it (and got the feature removed rather than shipped broken).
- **A flake accusation needs the same sample size on both sides.** `animation-markers`
  failed on a branch and passed once on the base, which looked like a regression;
  three runs each said 1/3 failing on the branch and **3/3 on the base** — machine
  saturation, not the diff. One run is not evidence either way.
- **When a visual bug is reported, measure the pixels' inputs before theorising.**
  "Onion skin shows the full object" sounded like a transparency bug; the ghost
  materials measured 0.28 and transparent in every case, which ruled out the whole
  family and pointed at geometry (the ghosts coincided with the object). Probe the
  values first, then form the theory.
- **A WALL-CLOCK sleep is a lottery on a throttled page, so drive the state
  instead.** `animation-loop-pause` needs a pause that lands MID-LAP. Sleeping
  2.6 s into a 1 s loop looked deterministic and was not: a headless page ticks at
  a few fps, so the same sleep produced 0.4, 0.17 and 0.005 on consecutive runs —
  one of which is legitimately at a lap boundary, where the "did not jump to an
  end" check must fail. Start the run at a known offset (`play(uuid, clip, {from:
  2.4})`) and act IMMEDIATELY: 2.4 s of a 1 s loop folds to exactly 0.400 every
  time. Same family as "measure the property, not the number" — if a check depends
  on WHEN it ran, it is measuring the scheduler.
- **A premise that silently fails makes every check after it pass VACUOUSLY.**
  `mesh-budget` opens a face session on a dense sphere and asserts no live preview
  is streamed. The first run reported a clean 0 previews — because `enterFaceEdit`
  had been refused by `vrFaceCap` (1000 triangles) and the gesture never started.
  The `beginFaceGrab` premise check is the only reason it was caught. Assert that
  the thing you are measuring actually HAPPENED, especially when the expected
  result is "nothing".
- **Craft fixtures out of what the loader can actually rebuild.** A stale
  edit-overlay fixture built with `WireframeGeometry` made `instantiatePrefab`
  return null — `ObjectLoader` has no factory for that type — so the check read
  -1 and looked like a broken fix. A plain `BufferGeometry` with a position
  attribute round-trips.
- **Prove a save-path guard by REMOVING one park.** Every check in
  `edit-overlay-gaps` has the same shape (live before / absent in what is written /
  still live after). Deleting `parkEditOverlays` from `savePrefab` turns exactly
  one of them red with the wireframe back in the entry — that is what makes the
  other five trustworthy. The same trick proved the mesh preview ceiling (6
  previews leak) and the transport fold (pausedAt reads 2.400).
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
  edges `#edge-move|bevel|dissolve` + `#edge-sel-count`; session cancel
  `#mesh-edit-cancel` with the inline `#mesh-cancel-confirm` / `#mesh-cancel-yes` /
  `#mesh-cancel-no`; the key list is its OWN window `#mesh-keys-popover` opened by
  `#mesh-keys-help`. Sculpt `#sculpt-toolbar` + `#sculpt-op-*`.
  **18-C reshaped this window** and several old anchors are gone: the modes are a
  TAB BAR (`.tbx-tabs`, still `#mesh-mode-*`) OUTSIDE `.toolbox-body`; the whole-mesh
  work lives in COLLAPSIBLE sections (`#mesh-sec-cleanup|symmetry|display|collider`,
  Cleanup and Symmetry CLOSED by default — their contents are not in the DOM until
  the header is clicked, and the open state persists in `tbx:sec:<key>`);
  `#mesh-keys-help` moved into the window HEADER; `#mesh-deselect`, `#edge-loop` and
  `#edge-clear` were retired for the word commands that duplicated them. Tool
  parameters are CONTEXTUAL now — `#mesh-op-params` (extrude/inset), `#bevel-params`,
  `#loopcut-params`, `#bridge-params` render only while that tool is selected, and
  every numeric field inside them is a DragRow (`.dn-input`), not a number input.
  **19-A P2 flipped the parameterized-op contract AGAIN** (deliberately): a grid
  click on Bevel / Loop cut / Bridge now APPLIES IMMEDIATELY when the op's
  precondition holds (bridge: two closed matching pieces; bevel: a bordered
  target) and the pane becomes a live ADJUST panel — label "Adjusting <op>",
  rows re-run the op on change, `#mesh-adjust-revert` (✕) reverts, scrub-end /
  a 300ms typed-input debounce settles. Precondition unmet → nothing applies and
  `#mesh-op-hint` names the reason with the old Apply button offered. Engine
  state is readable via `__stores.faceEdit.opAdjustState`; the header gained
  `#mesh-undo`/`#mesh-redo`. Consequences for suites: geometry equality must be
  compared as the CANONICAL SOUP (`trisToPositions(readTriangles(...))` — a
  fresh primitive is indexed, replays are soups); assert one-undo as a PROPERTY
  (Ctrl+Z returns the pre-op geometry), never stack depth; and `toolbox-window`
  drags `.toolbox-title`, not the header midpoint — the midpoint lands on the
  new header buttons, which rightly refuse to drag the window. Reference suite:
  `mesh-adjust.test.cjs` (26 checks incl. revert-retraction and two-peer settle
  parity).
  **Selection commands are TEXT buttons whose ids are PER MODE** — `#mesh-sel-all` in
  faces but `#mesh-sel-eall` / `#mesh-sel-vall` in edges / vertices (same for
  `invert`/`einvert`/`vinvert`), so a selector hardcoding the faces ids silently
  matches nothing in the other two modes.
- **19-A P5 suites + anchors**: `mesh-edge-vertex-ops` (P5a: `#edge-delete`,
  `#mesh-delete-verts`, `#mesh-fix-triangulate`, `#mesh-fix-quads`; the
  undo-restores-the-quad-partition counterfactual lives here) and `mesh-ops-p5b`
  (`#edge-subdivide`, `#edge-extrude` + `#edge-extrude-params`,
  `#mesh-op-duplicate`, `#mesh-smooth` + `#smooth-params`). P5b test techniques
  worth reusing: prove a welded chain by UNIQUE CORNER COUNT (6 welded vs 7 =
  torn); derive extrude offsets in-test from the documented chain-normal rule
  at TWO distances; Jacobi smoothing (pre-pass reads) so factor-1 results are
  derivable exactly; a real-gizmo "peel" asserts sources byte-unchanged while
  copies move. Edge extrude needs an OPEN surface — a box has no border edges
  (delete a face first).
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

**17-A moved dungeon/piano/avatar/essentials/car OUT of core**, so several core
suites now depend on installing a module from the sibling checkout. Use the
committed helper rather than hand-rolling it:

```js
if (!require('fs').existsSync(h.moduleZipPath('dungeon'))) {
	console.log('SKIP: ../theprototype.app-modules zips not built');   // never FAIL
	await h.finish(browser); return;                                    // a fresh clone has none
}
await h.installModule(A, 'dungeon');
await h.installModule(B, 'dungeon');   // EVERY peer — see below
```

- **Every peer needs it, including the late joiner.** A peer without the module
  cannot rebuild from the replicated `{seed, params}` — determinism IS the
  netcode, so the state sync alone is not enough. Forgetting peer C is the
  failure mode (`dungeon.test`/`dungeon-play` both hit it).
- `npm run pack -- --all` in the modules repo builds the zips the helper reads.
- The **User tab's accessible name carries a count** ('User (3)') since 17-A —
  match it as `getByRole('tab', { name: /^User/ })`, never `exact: true`. The
  tabs are `role="tab"`, not buttons (a button-role query silently never
  matches — that was the long-standing user-modules failure).
- flowbite `Toggle` renders an **sr-only** checkbox: click the wrapping
  `label`, and give the toggle an id when a card carries more than one.

**Two ways a lane server lies about which code it serves, both hit in one session.**
`vite dev --port N` has no `--strictPort`, so a lane started while N is busy silently
binds N+1 — and a later lane can then answer on the port you meant for a third. A suite
pointed at it verifies committed HEAD with none of the edits under test. Separately,
`TaskStop` on a backgrounded `npm run dev` reaps npm and leaves the vite CHILD listening,
so the port answers 200 after a "successful" kill and the build that follows runs against
a live server. Before trusting a lane: `netstat -ano | grep :PORT` to map port -> pid, and
`curl -sk https://localhost:PORT/src/lib/<file>.js | grep <your new symbol>` to prove it
serves YOUR code. Kill with `taskkill //PID n //F`.

**Flipping a check that RECORDED a limitation is where wrong premises hide.** When core
fixed DEVX #18, three collectible checks had to invert — and the first attempt went red
for reasons unrelated to the feature: an asserted `=== 1` collided with whatever earlier
sections had left collected and with where the round clock was, and a "shared collect"
check picked a gem an earlier section had put on `scope: player`, where the pulse staying
local IS the feature. Two rules came out of it: assert the PROPERTY (the joiner agrees
with the HOST) and read the reference value at run time rather than pinning a literal, and
SELECT a fixture by reading its state rather than by guessing which one it is. Flip, never
delete — a deleted section is a silent regression, an inverted one fails loudly if the
limitation comes back.

**R3a: a MECHANIC that leaves core takes its suite coverage with it, and the split is
not at the click.** When collectibles v3 became a module, the collectible RECIPE went
with it — but the chain it built stood on core PRIMITIVES (perRound/whilePlaying/
perPlayer/respawn) that still need covering, so the 7-node builder survives as
`h.makeCollectibleChains(peer, uuids, opts)` in helpers.cjs: same nodes, same
handle-qualified edge ids, ONE `flownodes` entry per batch, returning the old
`{built, skipped, variable, respawn, perPlayer, entries}` plus `chains[].ids` so a
check can read latch state straight out of `flowValues`. Three rules learned doing it:

- **Derive counts from the LATCHES, and filter their ids against the LIVE graph.** With
  `collectcount` gone, total/collected/left comes from each chain's Latch value — and a
  `wipe()` or a scene TRAVEL must drop those chains from the total, or a later section
  inflates. game-presence/peer-variables/game-loop-v3 all do the filter.
- **Flip a removed UI to its COUNTERFACTUAL rather than deleting the section.** The old
  recipe-menu/dialog checks now assert core exposes no `gameRecipes`/`recipeDialog` and
  that `addBinding(el, 'showleft')` answers `{ok:false, reason:'unknown action'}`. A
  deleted section is a silent regression; an inverted one fails loudly if the thing
  comes back.
- **Assert the module-facing seam in CORE, the real click in the MODULE repo.** The
  Modules manager renders cards only for core modules and installed USER records, so an
  inline `initModules` module has NO card — a `getByRole('button')` for its
  `registerMenu` entry waits the full 30s. Core drives the registered entry's own
  action (the same function the card calls); the module's own flight clicks the button.

For a module with no committed suite, drive it through the REAL install path in a
scratch script, then assert its scene-root group / behavior, and simulate a
PEER's ops via `__stores.moduleSDK.applyModuleMessage({type:'module', moduleId,
...})` (the real applier path, no cloud dependency). Fresh browser CONTEXT per
run — installed user modules persist in storage.

## Two-peer flow (real replication)

Use `https://theprototype.app:5173/` — hosts-mapped to 127.0.0.1; the `.app` hostname
makes peerjs use the **public cloud** (localhost tries ws://localhost:9001 and fails).
**NOTE (2026-07-24)**: the `theprototype.app` hosts mapping is currently COMMENTED
OUT in `etc/hosts`, so two-peer suites are env-gated locally — re-enable the mapping
(or gate the block behind an env flag, as `connect-states.test.cjs` does with
`TWO_PEER=1`) to run them.
**Still commented out as of 2026-08-18, and you do not need it**: point `APP_URL` at
`https://localhost:PORT/` and pass `PEER_CONFIG` for the self-hosted box, and
three-peer suites connect fine. Reaching for the `.app` hostname while that line is
commented resolves the REAL public IP and every page load dies on
`net::ERR_CONNECTION_TIMED_OUT` — which looks like a dead dev server, not a DNS
answer, so check the hosts file before restarting anything:

```powershell
$env:APP_URL='https://localhost:5201/'
$env:PEER_CONFIG='{"mode":"custom","custom":{"host":"peerjs.theprototype.app","port":443,"path":"/peerjs","secure":true}}'
npm run e2e -- hud-sync
```
`helpers.connect(B, A)` does: fill peer id → Connect → Approve on A → ~9s settle.
Late joiners: connect a third context AFTER mutations, assert handshake state arrived
(objects/nodes/annotations/joints/module state/env/music/handmodel/custom defs).
Voice: launch with `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream`.
**B→A messaging works** since #12 (the adopted-inbound-conn fix) — tests may drive
mutations FROM the joiner (peer move streams, claims). When a suite needs the
dual-module-instance split collapsed, `freshReload(peer)` BEFORE `connect` and
re-read the id (`peer.id = await …peers.subscribe…peer.id`) — a reload mid-mesh
drops the P2P session.

## 21-B traps (2026-08-19)

- **A synthesized wheel dispatched ON `window` cannot test a capture-phase
  claim.** At the TARGET, capture and bubble listeners run in REGISTRATION
  order, so a handler that wins by being registered in the capture phase never
  gets to be first. Dispatch on the CANVAS, where a real wheel starts. Measured:
  41 events leaked into walking speed as a 6.4x faster walk when dispatched on
  window, and zero when dispatched on the canvas.
- **Author a graph through `flowGraphs` AND `flowNodes`.** They mirror both
  ways; writing one leaves the other stale and the stale side can be pushed back
  over it (an earlier section's nodes returned while the new edges stayed).
  Build edge ids the canonical way too —
  `e-<source>[.<sourceHandle>]-<target>[.<targetHandle>]` — or they do not
  survive a reconcile once a peer joins.
- **A BACKGROUND page is rAF-throttled to a few frames a second**, and
  `bringToFront()` does not always help with three contexts open (measured 5
  samples in 1.24 s either way). Anything that lives in the frame loop —
  interpolation, per-frame overlays — cannot be measured by sampling a watching
  peer. Assert the MECHANISM instead and leave the look to a real machine.
- **A fixed `waitForTimeout` after a key press is a race once a peer is
  connected**: the same read saw 0.50 at ~700 ms and 3.36 at ~850 ms. Wait for
  the thing.
- **Creating an object SELECTS it, and `selectedObject` is sticky**, so the
  handshake pushes it to a joiner as a LOCK — a fixture that then tries to grab
  it is correctly refused. Deselect AFTER connecting.
- **A two-peer suite cannot `h.connect(A, B2)` when A is already in a session**
  (its connect input is gone). Dial from the newcomer.

## Known flakes / traps

- **A trigger-edge action suite must SETTLE between "the peer holds the node" and the
  pulse** (21-F4). `actionSeenAt` records a node's first-seen at TICK time, so a stamp
  minted in the gap between the nodecreate landing and the peer's next tick is refused
  as stale AND consumed (measured: stamp 21618.485 vs seenAt 21618.489 — a 4ms race).
  Wait for the hold-premise, then `waitForTimeout(600)` before pulsing; a human press
  comes seconds after wiring, so the guard is correct and the suite adapts.
- **`h.connect(from, to)` dials FROM the first argument — and a connected peer's pill
  has no dial input** (it becomes the disabled "Connected to <host>" box). A late
  joiner must dial the host: `h.connect(C, A)`, never `h.connect(A, C)` — the wrong
  direction surfaces as `connect: could not fill the peer id`.
- **Who is the session host in a suite**: `h.connect(A, B)` has A dial and B approve,
  so B holds `sessionHost === null` — B is the writer/admin for anything host-gated
  (the abandon watch, Reset game). Assert gates against the right peer.
- **The shared game singleton can race a test's wipe** (21-F2's 1-in-3 flake): a stale
  `game` message landing after a reset changes what later checks MEAN. Pin the
  game-state premise (assert or explicitly set it) before any section whose
  assertions depend on it — the racing write must not be able to reinterpret them.
- **An assertion whose deadline is a `waitForTimeout` asserts the SCHEDULER as much
  as the feature — and that is what a "flaky suite" almost always turns out to be.**
  Every standing red cleared before the 1.5.0 tag (PR #142) was this one shape: a
  fixed sleep racing something asynchronous, never a code defect. `animation-markers`
  looked tick-rate sensitive for weeks; measured, the playhead tracks wall-clock TO
  THE MILLISECOND, and what lags is the pulse reaching its Counter on the NEXT flow
  tick — so a marker at 1.5s lands at ~1.59s and the suite read at a flat 1600ms,
  about 10ms of margin. `explorer` slept 1200ms while a per-file import landed at
  ~1.2s and ~2.0s. `view-mode` gave the shadow catcher 600ms when it comes back
  through a dynamic import costing ~1.2s cold in dev.
  The cure is never a bigger number. **Wait on the thing you actually mean** — the
  playhead, the stored IndexedDB record, the item count — and add a PREMISE CHECK
  pinning the window you waited into (`head >= 1.7 && head < 2`: past both markers,
  short of the wrap). The premise check is what keeps the loosened wait honest, and
  what tells you next time whether a failure is timing or behaviour.
  Two sub-rules that fell out of it: a negative assertion ("the unsupported file is
  skipped") still needs a bounded settle, so poll for ARRIVAL of what must appear and
  then assert the FULL set on a finished state; and when the app fires and forgets a
  write (`createFolder` does not await `persistIndex`), watch the RECORD rather than
  sleeping — it is the thing the reload actually reads.
- **A first click that loads its module dynamically pays ~1.2s in dev**, which is long
  enough to make a 900ms wait pass while nothing has happened — and long enough that a
  real user thinks the button is dead. Wait on the OUTCOME (the toast, the geometry,
  the store), and if the feature is user-facing consider PRIMING the import where the
  affordance appears (the Inspector does it while a spline is selected).
- **Before believing any standing red, restart the dev server.** Three suites
  (`prefabs`, `mesh-edit-materials`, `uv-materials`) were carried as a "known cluster"
  with a shared cause. The shared cause was real but external: none of them contains a
  `locator.click` of its own — their only clicks come from `h.connect` — and all three
  are green on a freshly restarted server. The A/B that "proved pre-existing" ran both
  sides against the same long-lived server, which lies identically to both.
  `h.connect` self-diagnoses now (the peer, its collected page errors, whether the
  connect chrome rendered) so this class names itself instead of surfacing as a bare
  30s timeout. When a suite that touches no UI dies on a `locator.click`, the click is
  in a HELPER — read the helper before reading your diff.
- **A suite can die two thirds of the way through and nobody notices.** `explorer`
  crashed on a null `#explorer-list` at its dock section; everything after it — folder
  CRUD, cascade delete, the sidebar splitter, persistence — had not run in a long
  time. A red you have learned to ignore is not one failing check, it is every check
  BELOW it silently not running. Read how far the output got, not just its last line.
- **A two-peer failure is signaling until proven otherwise.** The default PeerJS
  cloud goes flaky/rate-limited under a long verification run: `pong` failed
  with ZERO changes to it, then passed immediately under
  `PEER_CONFIG='{"mode":"custom","custom":{"host":"peerjs.theprototype.app","port":443,"path":"/peerjs","secure":true}}'`.
  Re-run with PEER_CONFIG before believing a two-peer red — and before blaming
  your diff.
- **Probing indices past the end of a collection can THROW, killing the whole evaluate.**
  `meshEdit.selectHandle(i)` for an out-of-range `i` dereferences `handles[index]`, so a search
  loop bounded by a guessed 400 died where one bounded by the vertex count did not. If a probe
  loop is how the test finds its target, bound it by something real.
- **A search that MUTATES cannot also build.** Finding handles by calling `selectHandle(i)` and
  watching the proxy REPLACES the selection on every step, so searching while building a
  multi-selection destroys what it just built (0 selected, silently). Find all the indices
  first, then select.
- **`PlaneGeometry` lies in XY, not XZ** — a flat test grid spans x/y and "out of plane" is z.
  Worth double-checking any axis assumption against the geometry three actually builds.
- **`highlightFaceByTriangle` HEALS a stale selection by clearing it** (`healStale`, default
  true): if the picked unit is not a subset of the current selection, the selection is emptied.
  Building a set with `faceEditSelectedTris.set(...)` and then highlighting one of its members
  therefore WIPES it whenever granularity resolves a bigger unit — an inset cap is coplanar
  with its ring, so Face granularity resolves all ten triangles and the heal fires. Pass
  `false` when the selection is the thing you mean.
- **Three peers is the practical ceiling on a loaded box**: `setupPage`'s
  `waitForFunction` waiting for `window.__stores` times out booting a THIRD
  page while suites run back to back (dungeon/dungeon-play stop there). Not a
  product bug; give the box a rest or run the suite alone.
- **Pointer Lock is DENIED in headless Chromium** ("Unable to use Pointer Lock
  API"), so anything gated on it (possess `mouseLook`, play-mode camera swap)
  cannot be proven here — say so and hand it to the user's manual check.

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
- **#20: the tell for a stale server is a change that "fixes" things for no reason.**
  Toggling a setting failed to render its component; adding an UNRELATED debug element
  to that component made it work. Nothing about that element could matter, and that is
  the signature — the edit forced a re-transform. On a freshly restarted server the
  original code was correct at every width from 1280 to 400. So when a symptom vanishes
  after a meaningless edit: do NOT commit the edit, restart, re-measure, and report
  honestly that you could not reproduce rather than claiming a fix you cannot show.
- **A DAY-LIVED server escalates that to stale DUAL MODULE INSTANCES** (19-A P0):
  `bind:checked={$faceAutoApply}` flipped the DOM checkbox while the app's real
  store never moved — the component was bound to a SECOND faceEdit instance from
  an older transform. The deterministic-looking probe signature (click reaches
  the element via `elementFromPoint`, DOM state flips, store frozen) is THIS, not
  a broken binding. Two rules: **restart the verification server after heavy
  editing and before the final battery** — kill by port
  (`Get-NetTCPConnection -LocalPort N … | Stop-Process`), relaunch DETACHED
  (`Start-Process cmd /c "npx vite dev --port N --strictPort --host > log 2>&1"`),
  wait ~14s, then curl-grep a NEW symbol off the served file to prove it serves
  your code; and **an A/B where both sides ran the same long-lived server proves
  nothing** — pristine HEAD fails identically for environmental reasons, so
  "reproduces on HEAD" only means "pre-existing" when the server was fresh for
  both sides.
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
- **A capability headless does not have is asserted by SPYing the browser API, not
  by skipping.** Pointer lock never engages in headless (requestPointerLock rejects,
  pointerlockchange never fires), so 21-E3 patched `HTMLCanvasElement.prototype
  .requestPointerLock` and `document.exitPointerLock` to COUNT calls: the machine is
  then asserted by its ATTEMPTS plus its store transitions. Two traps inside that:
  spy the PROTOTYPE, never `querySelector("canvas")` (DungeonMinimap renders a hidden
  canvas first — the grabFrame trap), and do not assert a call that cannot happen
  (with no lock ever HELD, a correct machine must NOT call exitPointerLock — the
  first version of that check asserted the opposite and went red on working code).
  Same recipe for gamepads: `Object.defineProperty(navigator, "getGamepads", …)`
  returning a fake pad the test mutates.
- **A svelte store emits its CURRENT value on subscribe**, so a log that means "what
  happened during the cycle" must subscribe AFTER the state that starts it. 21-E3's
  "isLocked never left true" check read `["null","true"]` and failed on correct code
  because the subscribe itself replayed the pre-play value.
- **A tolerance must be sized to the BUG, not to the noise.** The "resume does not
  jump the pause gap" check first used 0.35 rad, which 200ms of legitimate motion
  already exceeds; the bug it guards replays the whole ~1.5s span (~3 rad). Pick the
  band from the failure magnitude, then confirm a correct run sits well inside it.
- **A contract with two halves needs both pinned.** 21-E3 made Tab drive the HUD ring
  ONLY under a held lock; the suite asserts bare Tab does NOT cycle AND that it does
  with `document.pointerLockElement` stubbed to the renderer canvas. Pinning one half
  lets the other regress silently.
- **Clean a shared fixture on EVERY peer.** `flowNodes.set([])` does not broadcast, so
  nodesync sees the emptier peer and pulls the graph BACK a few seconds later — a
  section that wiped only peer A found C's old nodes reappearing mid-run (and with a
  guard removed, that alone reproduced the bug the section was built to test, from a
  route it never set up). Wipe every peer, push after each write, and assert the node
  list as a premise.
- **A held key keeps acting.** A `down`-edge keypress re-stamps ~3/s while held, so a
  synthesized keydown never released keeps re-applying its action (one un-released
  KeyP overwrote a Resume AND the game ending). Release what you press.
- **`/create box` re-seats the object after the call returns and stamps
  `userData.physics = {mode:"dynamic", mass:1}`** — a box used as a "floor" falls,
  which reads exactly like the feature under test being broken.
- **A peer cannot approve a connection request while in play mode** — the Approve
  button renders and the click times out. Approve first, then press play.
- **The definitive worktree A/B, when a red might be yours.** `git stash` is unsafe
  in this repo (see the never-stash-pop rule) and the same-server A/B lies. Instead:
  `git worktree add ../theprototype-ab origin/release/next --detach`, `npm install`,
  start it on a spare port, and run the suspect suite there. Two notes from doing it:
  the worktree has no `certs/` (gitignored), so it serves **http**, not https — use
  `APP_URL=http://localhost:<port>/`; and the FIRST run on a cold server can fail at
  `page.goto` for no other reason, so take a second reading before you conclude
  anything. Remove it with `rm -rf` + `git worktree prune` when done. Used 21-D to
  attribute `script-nodes` and `flow-object-embed` — both fail IDENTICALLY on base.
- **A suite that compares an editor against its RUNTIME breaks the day the runtime is
  deliberately hidden.** 21-D5 stopped painting the HUD in the viewport while the HUD
  editor is open, which invalidated `hud-editor`'s artboard-vs-live rect comparison
  and `hud-inputs`' control queries — neither was a regression, both were suites
  asserting the old contract. Reach the state you need through the USER's own control
  (there, `hudPreviewInViewport`, which the eye toggle writes), never a test-only door.
- **Check what your own earlier sections already did to the fixture.** Two 21-D reds
  were pure test premises: a "creates the reader" check failed because an earlier
  section had already created that reader (the refusal was CORRECT), and a "sets its
  value" check failed because an earlier section had already set it, so the press
  flipped it back. Assert the CHANGE, or use a fixture the earlier sections did not
  touch.
- Pre-existing flakes (reproduce on a clean base — don't chase them into your diff):
  add-menu search-Enter + right-tap, sound-node Play overlap, connect-overlay
  querySelector, scene-music byte-push timing. To PROVE a failure is pre-existing:
  `git stash push -u`, run the suite on HEAD, `git stash pop`.
- **`explorer-files` (2026-08-22): fails INSIDE A BATCH, passes ALONE.** "the editor is
  dark ()" then "Ctrl+S saves back" — a fixed 1200 ms wait where it should wait on
  `.cm-editor`, so a loaded machine misses CodeMirror's lazy load. A/B-proven on an
  untouched base by three independent runs. `explorer-drop`'s last check is the
  documented hidden-canvas trap (it aims a synthetic DragEvent at
  `document.querySelector('canvas')`, which is DungeonMinimap's hidden one) and comes
  and goes the same way. Neither belongs to your diff; both deserve their own ticket.
- **A lane worktree with an INCOMPLETE `node_modules` invalidates every number you
  measure there.** Missing `@shaderfrog/core` breaks import-analysis on
  `shaderBackends.js`, so the app never boots (every suite dies in setupPage's
  `waitForFunction`) and svelte-check reads **387/62 instead of 385/62 on BOTH base and
  branch** — an A/B run there "proves" nothing in either direction. `npm install` in the
  worktree and re-measure. Same family as the stale-dev-server rule above.
- **`--noproxy '*'` is REQUIRED for curl on this box**, and lane URLs are
  `https://localhost:<port>/` — a system proxy swallows loopback requests (they hang,
  then return nothing, which reads exactly like a dead server), and the
  `theprototype.app` hosts mapping is commented out.
- **A suite section that SAVES or ADDS OBJECTS perturbs its neighbours.** One guard
  inserted mid-file broke four later checks at once: its `/create box` broke a "four
  objects are open" premise, and its save moved `currentLevel` away from the scene a
  later restore section reasons about. Put such a section LAST, and give it its own
  fixture NAME — a sibling section built its own `Depot` and asserted a single-hash
  history that a second `Depot` would have poisoned.
- **A counterfactual can fail for a CORRECT implementation — check that first.** The
  guard for "version files are stamped with their own date, not the export moment" was
  first written as "no entry is dated near now", which goes red on correct code because
  the NEWEST version genuinely was saved seconds ago. What the bug actually produces is
  two entries sharing ONE date, so the check is that the two DIFFER. Measure the quantity
  the bug changes, never one it merely correlates with.
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
- **Added to the dirty baseline 2026-08-18** (21-A), each proven by running the SAME
  suite in a PRISTINE sibling worktree on its OWN freshly started server and diffing the
  PASS/FAIL lines — the only A/B that means anything (see the day-lived-server trap):
  `flow-customnode-io` (1 check — "a stale snapshot cannot resurrect the pruned edge"),
  `flow-object-embed` (`locator.dblclick` timeout). `open-core-m1`'s single drawer check
  was re-confirmed on that same pair: 18 identical PASS/FAIL lines both sides. Two
  worktrees is what makes this cheap — you never touch the tree under test, so there is
  no stash to pop and no chance of the "restart fixed it" confound.
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
  baseline 2026-08-18 = **388 errors / 62 warnings** (419 -> 417 at B5 -> 391 when 17-A
  moved the demo modules out -> 388 when #20 annotated Scene's `marqueeStart`) (drifts
  down as flowbite/typed code is removed — hold whatever it currently is, RATCHET IT
  DOWN when a change legitimately removes errors; add no NEW; the release.yml gate
  hardcodes the numbers — update it when the baseline moves). **RE-MEASURE ON A PRISTINE
  WORKTREE before gating anything on the number in a plan** — a plan written a week
  earlier said 391/62 while the tree was already at 388, and "held the baseline" would
  have been a lie in both directions. To attribute a delta, diff PER-FILE counts against
  a pristine sibling worktree rather than eyeballing the total:
  `npx svelte-check --output machine | grep 'ERROR "' | sed 's/.*ERROR "\([^"]*\)".*/\1/' |
  sort | uniq -c` on both, then `diff` — that is what found a +1 hiding inside a file
  that already had pre-existing errors. Note: in the big
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

- **A suite that BUILDS a graph with `flowNodes.set()` has not sent anything.** Only the
  `nodesHandler` entry points broadcast; the store mirror writes `flowGraphs` locally.
  The peer DOES catch up through nodesync's periodic hash compare, which is what makes
  this so nasty: the assertion fails by a LITTLE and intermittently (a Counter pulsed
  before the peer held the graph read 2 where the author read 3), so it reads as a real
  off-by-one in the feature. Push explicitly and WAIT for the peer to hold it:
  `sendNodes(peerId)`, then poll the peer's `flowNodes` for your ids before doing
  anything else, and keep that as a `premise:` check so the next reader sees why.
- **Do not drive a rate test with `setNodeData`.** It is not throttled, but the chain
  behind it (mirror -> flowGraphs -> autosave markDirty -> serializeGraphs) is heavy
  enough that only about **5 of 50 calls at 40ms** landed inside 2s. A "the store only
  wrote 5 times" reading was measuring setNodeData's cost, not the throttle under test.
  Drive something that changes ON ITS OWN every frame (a `time` node) instead.
- **`saveSnapshot` refuses to write an EMPTY snapshot** ("never overwrite a good
  snapshot with emptiness"), so on a scene with no objects and no nodes autosave never
  writes, `isDirty()` never settles, and a dirty-subscription test fails on its own
  premise. Create one real object first — that is the premise, not decoration. And
  `idbGet('latest')` returns the snapshot ITSELF, not a wrapper.
- **The node editor's scope FOLLOWS THE SELECTION, so creating an object before opening
  the dock shows that object's (empty) OBJECT graph.** Every DOM read then comes back
  empty and it looks like the editor failed to render. `deselectObject()` first and
  assert `activeGraphId === 'scene'` as a premise.
- **A window-level BUBBLE listener cannot observe an event your own handler
  `stopPropagation`'d** — and stopping it is often part of the contract, so the check
  "the browser menu was prevented" came back with an EMPTY event list while the feature
  worked perfectly. Register at window **CAPTURE**, keep the event OBJECT, and read
  `defaultPrevented` after the dispatch has finished (it is a live property, so a
  `preventDefault` called downstream still shows). Assert the propagation stop
  separately with a bubble-phase counter that must read 0.
- **`h.launch()` gives you a ~2.5fps page; `h.launch({ args: h.GPU_ARGS })` gives you 60.**
  See the GPU_ARGS note in the first section — anything asserting a rate, a throttle, an
  interval or "per frame" behaviour needs the GPU args or it measures nothing.

## Two ways a green suite lies (both cost a user-visible bug in 17-E)

- **A component that CRASHED on mount is invisible to store-reading checks.** A
  duplicate `{#each}` key threw inside the Animation window; the pane stopped opening
  for real users while eight suites stayed green, because every check around it read
  `window.__stores` rather than the DOM. `pageerror` was logged and ignored. helpers
  now COLLECT page errors and `finish` FAILS on a render crash (`each_key_duplicate`,
  `effect_update_depth_exceeded`, `store.set is not a function`, …); `h.pageErrors(peer)`
  exposes them to a suite. So: **assert something RENDERED**, not only that a store
  changed — and when a feature has a window, check it still OPENS after your edit.
- **A SYNTHETIC event does not travel the path a real one does.** "The browser context
  menu must not appear" was asserted by dispatching `new MouseEvent('contextmenu')` and
  reading `defaultPrevented`; it passed for two rounds while the native menu kept
  appearing for the user, because `contextmenu` is DELEGATED by svelte and panel chrome
  swallowed it before the app root. Drive real gestures (`page.mouse.click(x, y,
  {button:'right'})`, `mouse.down({button:'middle'})`) and observe the outcome from a
  window-level listener. Same family as the older note that synthetic events aimed at
  delegated handlers need `{bubbles: true}`.
- Corollary: **prove a new guard can fail.** Put the bug back, watch it go red, restore.
  Both fixes above were confirmed that way (4 failures, then 3 slipped through).

## Definition of done

Feature suite green (+ any suites your UI changes touched) + `npm run build` passes +
`npx svelte-check` adds no NEW errors (baseline is legacy noise; grep the output for
your files). Two-peer verification is required for anything touching replication.
VR features: cover the extracted math/state headlessly (computeMoveOffset,
computeTeleportArc pattern) and note that on-device feel is the user's manual check.

## Roadmap 22 round 30 — `scene-isolation` (72), and the rooms battery

- **PROVE A SEND GATE AND A RECEIVE GUARD INDEPENDENTLY.** They look like one mechanism
  and are two: disarm the RECEIVER (delete the type from its ROOM_SCOPED) and send a
  real replicated message — nothing arrives, the send gate held; then bypass the sender
  with a raw per-conn `connections[id].send(...)` — the receive guard held. ROOM_SCOPED
  is exported MUTABLE precisely so a suite can counterfactual each side in-page.
- **A SUITE'S CONNECT DIRECTION IS LOAD-BEARING once sends are role-scoped.**
  `h.connect(B, A)` makes A the session writer; after C4 a JOINER's raw manifest
  publishes no longer replicate (the feature), so two sections that published from the
  dialling peer saw nothing travel. Pick who dials by who must be allowed to publish.
- **TWO AGENTS IN ONE WORKTREE CONFOUND EACH OTHER'S A/Bs.** An agent's scene-rooms
  baseline aborted mid-run because the parallel agent was reverting its own files under
  the dev server (HMR churn); the numbers only counted once re-run on a settled tree.
  When parallelizing, keep file sets disjoint AND treat any A/B run during the other's
  counterfactual window as invalid.
- **A SESSION-LIMIT KILL LEAVES THE WORK ON DISK.** Both wave-2 agents died mid-task;
  `git status` + targeted greps told exactly where each stopped, and resuming the SAME
  agent (SendMessage) with the tree state spelled out lost nothing. Spell out which
  in-flight files are NOT theirs, or the resumed agent may "clean up" a peer's work.
- **PUBLIC-PEERJS SIGNALING FAILURES MIMIC ROOM GATING PRECISELY** (manifest never
  arrives, peerScenes empty, requestAsset false). Before blaming a gate, re-run with
  PEER_CONFIG at the self-hosted box — one wave-2 red was exactly this.
- **THE THREE-BUTTON TOAST IS THE FIRST OF ITS KIND** (Bring/Stash/Stay on one .tp-toast
  card) — headless cannot judge it at narrow widths or in non-dark themes; it is on the
  owed-on-device list, not the suite's.

## Roadmap 22 rounds 19-28 — `window-header-ranking` (30), `tab-group-stacking` (17)

- **MEASURE THE THING AGAINST WHAT IT IS SUPPOSED TO LINE UP WITH, not against itself.**
  Four rounds of tab-group checks asked whether a member's header overflowed, wrapped, kept
  its last button, or sat under the strip — all true of a window that is simply in the wrong
  PLACE. One comparison of the strip's rect against the active window's rect found it
  instantly (dx 40, dy 30). When a report says two things do not line up, subtract their
  rects.
- **A SUITE THAT LEANS ON LEFTOVER localStorage PASSES ON THE SECOND RUN AND FAILS ON A
  CLEAN ONE.** `flowDocked` is read at component INIT, so setting it on a live page does
  nothing — the first version of `tab-group-geometry` only worked because an earlier run had
  left the flag behind. Set the flag, RELOAD, then drive.
- **A SUITE'S OWN EARLIER SECTIONS CAN MAKE A LATER ONE UNSTAGEABLE.** `tab-group-stacking`
  merges, tears and re-merges windows, and by its fifth section it could not put a node
  editor on screen at all. That is a reason to SPLIT the file, not to fight it — and a
  three-tab group also raised the floor ~96px, hiding the two-member case under test.
- **WHEN THE NUMBERS SAY FINE AND THE REPORT SAYS BROKEN, TAKE THE SCREENSHOT.** The
  tab-group "header breaks" report survived four clean metrics — `scrollWidth` vs
  `clientWidth`, header height, flex-wrap, the last button's right edge, and the member
  header's position against the strip. A `page.screenshot` with a clip round the group
  showed it in one look: the node editor at 260px with its palette, toolbar and canvas
  overlapping. Pixels are not only for pixel features.
- **A CONTROL THAT TOGGLES IS NOT AN OPENER.** `#explorer-slot` toggles the dock, so
  clicking it blind made a suite pass and fail on alternate runs while nothing about the
  app changed — the dock's state on load is not something to assume. Read the state, act
  only if needed.
- **A FIXTURE CAN QUIETLY CONTAIN THE THING IT IS COMPARING AGAINST.** The first version of
  the strip-vs-window z check merged the object list INTO the group, so it compared a strip
  against one of its own members and passed for the wrong reason. When a check is about two
  things being distinct, assert that they are.
- **A THIRD TAB RAISES THE FLOOR BY ~96px, WHICH HID THE CASE UNDER TEST.** The user's repro
  is a TWO-member group; a leftover member from an earlier section made the group wide
  enough that nothing broke. Count the fixture's members when the thing being measured
  depends on how many there are.
- **A HIDDEN ELEMENT MEASURES ZERO**, so a suite that waits for things to settle can miss a
  transient break entirely — sample immediately after the state change as well. (Here even
  the 40ms sample came back clean, which is how I learned this was not the user's bug.)
- **A CHECK THAT PASSES WITH THE FIX REMOVED IS NOT A GUARD.** Two checks here survived
  their counterfactual, and they are LABELLED as pinning a property rather than deleted —
  the property is worth having, the claim is not.
- **CHECK THE LINE ENDINGS OF A FILE YOU CREATED.** The Write tool emits LF while the repo
  is CRLF, so several `\r\n`-based patches to a new suite matched nothing and reported
  success. `split('\r\n')` returning one element is the tell.

## Roadmap 22 rounds 15-18 — `preview-animation` (46)

- **A FIXTURE SHORTER THAN THE FIRST FAILING CASE PROVES NOTHING ABOUT IT.** The frame
  stepper was covered by a 60-frame clip and shipped a wedge at frame 123 — the first
  index where `n/fps*fps` rounds down. The regression carries a 180-frame clip for that
  reason alone. When a bug report names a NUMBER ("stops on frame 123"), the fixture has
  to be able to reach it.
- **REPRODUCE WITH THE USER'S OWN FILE BEFORE THEORISING.** A throwaway probe that read
  `Dancing Twerk.fbx` off disk, injected the bytes and hammered the key found the exact
  reported frame in one run — after a plausible wrong theory (end-of-clip dead end) had
  already been fixed and would have been reported as the answer.
- **`repeat: true` IS THE GESTURE.** Playwright's `keyboard.down` does not auto-repeat, so
  a held-key report is reproduced by dispatching KeyboardEvents carrying `repeat: true` —
  which is also what exposes a handler that computes from a value arriving through a
  callback it can outrun.
- **A BARE `#id` CAN RESOLVE TWICE.** `#audio-volume` matches the preview window's player
  AND the Properties pane's compact one; strict mode fails on the second. Scope by an
  ancestor that identifies the instance (`[data-preview-id]`, `#image-preview-window`).
- **PLAYWRIGHT'S "STABLE" HEURISTIC CAN REFUSE A PERFECTLY REACHABLE ELEMENT** in a
  cascade of overlapping windows. Measure the point, assert `elementFromPoint` lands on
  what you meant, and click with `page.mouse` — the documented pattern, and it also
  catches the real cause when the aim is genuinely wrong (a raised window's settings pane
  covering the next window's header, which is correct behaviour).
- **A "did the pose change" CHECK MUST NOT INCLUDE THE READOUT.** Screenshotting
  `#preview-body` put the transport's own frame counter in the picture, so two shots of
  the same pose could never match. Shoot the canvas. And compare with counted pixels
  (`h.frameDelta`), not byte equality: the mixer reaching t=2.0 by a different route than
  t=0 differs by a few edge pixels (measured 316 against 135178 for a real move).

## Roadmap 22 round 13 — `model-preview-controls` (24), and why it is its own file

- **A LONG SUITE EXHAUSTS WebGL CONTEXTS, AND THE BROWSER DOES NOT SAY SO.** Every
  `ModelPreview` takes its own context; by the end of `file-preview` a new one is refused,
  the component returns early, and a CORRECT build reports a blank frame with no page
  error. Measured: the identical open produced a 75KB frame on a fresh page and 6KB at the
  end of that suite. A longer wait does not fix it and `freshReload` did not either —
  splitting the pixel checks into their own file did. Suspect this whenever a pixel check
  fails late in a suite and passes in isolation.
- **A RATIO OVER TWO BLANK FRAMES PASSES.** "The frame did not collapse" written as
  `after > before * 0.5` went green comparing 6364 against 5376 — both blank, because the
  premise frame was already broken. Give such a check an ABSOLUTE floor as well (a real
  render of the fixture is ~60-70KB; anything under 20KB is nothing), and put the floor on
  the PREMISE too.
- **CHECKING THE ELEMENT IS NOT CHECKING THE RENDER.** A guard that a WebGL toggle "did
  not rebuild the context" compared `canvas.width` and the element count. Both survive a
  teardown — only the context dies — so it could never have failed while the bug it was
  written for sat in front of it. Ask for pixels.
- **A CANVAS READ IS BLANK WITHOUT `preserveDrawingBuffer`.** `drawImage` off the app's
  WebGL canvas into a 2D one returns nothing, which reported the model missing in BOTH
  states and looked like a much worse bug than the real one. Use
  `locator.screenshot()` — the compositor has the frame even when the drawing buffer does
  not.
- **A FIXTURE FOR "DID THE PICTURE CHANGE" NEEDS STRUCTURE FROM EVERY ANGLE.** A box's
  silhouette repeats every 90 degrees, so a rotation check on one can read "unchanged" at
  the wrong moment. A torus knot fills the frame from anywhere.
- **STATE THE ORDER GESTURES LEAVE THINGS IN.** Three checks in a row each toggled the
  same thing, so an extra "stop it first" click STARTED it and hid the element being
  measured. When a section is a chain of toggles, assert (or re-derive) the state you are
  in before measuring, rather than assuming the previous line left it where you think.

## Roadmap 22 round 12 — preview windows and the sessions picker

Suites GROWN, not multiplied: `file-preview` (71), `sessions-packs` (61),
`explorer-delete-confirm` (45), `save-as-formats` (34). Lessons that generalise:

- **THE CHECK THAT PASSES OVER THE BUG IS THE ONE THAT READS THE PROPERTY YOU STYLED.**
  Twice in one phase: `getComputedStyle(body).pointerEvents` reads a convincing `none`
  while the click still lands on the panel behind the hole, and `opacity` on the body
  reads 0.4 while nothing behind the window shows through. Both are answered by asking
  the OUTCOME instead — what does `elementFromPoint` name, what are the composited
  backgrounds — and both round-11 checks had to be CORRECTED rather than worked around,
  because they asserted the implementation that was the bug.
- **MOVING A PANEL INTO A DIALOG MAKES IT EVERYBODY'S PROBLEM.** Turning the sessions
  picker into its own dialog broke three later sections of a passing suite with click
  timeouts that named unrelated elements. Close it explicitly between sections. And
  ESCAPE NEEDS FOCUS INSIDE the dialog: after the button that had focus unmounts, focus
  falls to `<body>` and the keypress reaches no handler — click the real Close, and test
  Escape only where focus is still in.
- **A NON-MODAL `<dialog>` HAS NO `role` ATTRIBUTE.** `[role="dialog"]` matches nothing in
  this app except `ConfirmModal`, so a probe written that way reports an empty page and
  reads as a broken feature. Query `dialog[open]`.
- **PLAYWRIGHT CLICKS THE CENTRE, and a dense row's centre is a button.** Once a row is
  selectable AND carries actions, `row.click()` lands on whichever action sits in the
  middle — here Load, which replaced the scene and closed the dialog, making everything
  after it fail for reasons that looked unrelated. Aim at a neutral child, and give the
  row handler the `closest('button, input, a, label')` guard it needs anyway.
- **A FIXTURE HAS TO CONTAIN THE SHAPE THE FEATURE IS ABOUT.** "I do not see folder
  structure" cannot be tested against a fixture with one flat folder: the depth assertion
  had nothing to compare. Add the nesting, and assert the PROPERTY (three distinct
  indents, the deepest two levels in) rather than three specific rows, which the sort
  order can reshuffle.
- **A ROUND-TRIP IS THE ONLY HONEST TEST OF A SERIALIZER.** The measured bug (a Blob
  stringifies to `{}`, so every project download lost its files) is invisible to any
  check that reads the payload or counts the rows — both sides count 5. Write it, read it
  back, and assert the BYTES survived: `withBytes 5` against `5 -> 0` with the old write
  restored.

## Roadmap 22 round 13 — mounts, storage, sessions Open (and the harness itself)

- **The runner kills a suite at 8 minutes** (`run.cjs:26`), SILENTLY: no FAIL line, the
  summary reads "N suites in 480s" and the axe fell mid-check. Time the suite uncapped
  before believing the red (explorer-mounts read 117-PASS-then-dead when it was really
  137/137 in 708s). SPLIT on measured per-section runtime; never raise the shared budget.
  `npm run e2e -- explorer-mounts` matches BOTH split files (`explorer-mounts.test` +
  `explorer-mounts-edit`) — use the full filename stem for one.
- **Never pipe a run through grep.** It destroys the `FAIL <check>` lines that tell a
  dying suite from a disagreeing check — the summary says FAILED with no detail anywhere.
  Redirect to a file; grep the file.
- **A saturated box lies in both directions**: a 4-suite net at 8774s produced two
  "failures" that passed serially in 96s/106s. Re-run any red SERIALLY before reporting;
  treat an implausible duration as itself a reason to re-run. (67 chrome.exe processes on
  this box were the USER'S OWN browser — check `Get-Process chrome | Group-Object Path`
  before killing anything.)
- **Vite watches `tests/`** — editing or deleting ANY test file while a suite is in
  flight kills the run with `<vite-error-overlay> intercepts pointer events`. This also
  means an ORCHESTRATOR must not edit the worktree while a suite runs in it (an agent's
  comment-only edit took a run down at §16c with no error text).
- **A fresh worktree has no `certs/`** (gitignored): vite serves plain HTTP, every https
  curl reads 000, and it looks exactly like a dead server. Copy `localhost.crt`/`.key`
  from another checkout first.
- **SessionsManager hooks**: only LIST rows carry `.session-row` (grid cards are
  `.session-card` alone) and the view is a REMEMBERED pref — pin `#session-view-list`
  before locating rows. Fixed sleeps around `mountVolume` lose (it is three awaits deep;
  `h.eventually` on the volume list). An absence check (`count() === 0`) must be PAIRED
  with a presence check on the same element or it passes against a row that never
  rendered — this shipped once and was caught by the grid/list view split.
- **Store paths on the debug hook**: `bottomDockActive` is NAMESPACED
  (`__stores.bottomDock.bottomDockActive`), not spread like appStore's exports. The
  Explorer identity chip (`#explorer-scene`, `#explorer-save-scene`) exists only while
  the Explorer is MOUNTED — drive `explorerClose` + `bottomDock.bottomDockActive`, never
  a click on `#explorer-slot` (a toggle whose current state you do not know).
- **Movement checks HOLD keys, never tap** — movement accumulates per frame, so a settled
  read after `keyboard.press` sees nothing. And run a CONTROL LEG first (bare `e` MUST
  move the camera) or the "moves not at all" zeros pass with the camera dead.
- **A discriminating seed is what separates replace from merge**: every file the
  project-open section checked for existed in BOTH answers until it seeded a stray file
  first and asserted it GONE. When two behaviours differ only in what they do to
  pre-existing state, the test must create that state.
- **h.section() does not exist** — sections are numbered comments. A suite section that
  saves/mounts goes LAST under its own fixture names (the standing rule, re-proven twice
  this round).

## Roadmap 22 round 11 — the Explorer/preview/sessions batch

Five suites, one per phase: `explorer-delete-confirm` (39), `explorer-columns` (41),
`file-preview` (44), `save-as-formats` (30), `sessions-packs` (32), plus a section 6 in
`scene-open-guard` (11). Regression net for anything Explorer: `explorer-views`,
`explorer-drag-fixes`, `explorer-multiselect`, `explorer`, `prefab-explorer`, `sessions`,
`packs`. Lessons that generalise:

- **A CHECK CANNOT SEE A LEAK THE FIXTURE DOES NOT CONTAIN.** Tearing the pruning out of
  a new selection payload left BOTH "the payload holds the SELECTION and nothing else"
  and "NONE of the world" green — the test scene had no sky, no gravity and no
  scene-level flow node to exclude. Authoring those three in made the counterfactual bite
  AND immediately exposed a real leak (the SCENE's own flow graph, which `pruneMissing`
  cannot drop because it asks about an OBJECT and the scene graph has none). Build the
  world the guard is meant to exclude BEFORE trusting the guard.
- **THE LOAD-BEARING CHECK IS THE ONE THAT ASKS WHAT IS UNDERNEATH.** With click-through
  applied to the body instead of the panel, `getComputedStyle(body).pointerEvents` reads
  a convincing `none` and the check passes — while `elementFromPoint` in the middle of
  the content still names the window. Assert the OUTCOME (the click reaches the thing
  below), never the property that is supposed to produce it.
- **`h.eventually` RETURNS THE CHECK, NOT THE VALUE.** `const n = await h.eventually(fn,
  pred, label)` is `undefined`, so a follow-up assertion on `n` reads a phantom. Name the
  reader, `eventually` on it, then call it again for the value.
- **A "compact face" CHECK PASSES VACUOUSLY WHEN THE WHOLE COMPONENT IS ABSENT.**
  `locator('#inline-audio #audio-loop').count() === 0` is true when `#inline-audio` does not
  exist at all — which is exactly the state the section was failing in. Assert the premise
  in the same check (`the container exists AND the button does not`).
- **A CONTENT-HASH LIBRARY GIVES YOU ONE ITEM FOR TWO IDENTICAL FIXTURES.** Seeding a
  folder with a copy of the root's PNG left the folder EMPTY, and the feature that walks
  into it read as broken. Vary the bytes. (Same family as the shader suite's "two picks of
  the same bytes are the same texture".)
- **A DOUBLE-CLICK ON A TREE ROW ALSO FIRES TWO CLICKS**, so expanding `#packs-folder`
  navigates into the Packs view and takes the card the next step meant to drag. Expand,
  then put `activeFolder` back.
- **A TALLER WINDOW PUTS ITS OWN CONTROLS UNDER THE Controls HUD.** Resizing the preview
  window to 760px to prove the transport stays slim then made the transport unclickable —
  Playwright reported `<p title="Rotate (2)"> … intercepts pointer events`. The feature was
  fine, the aim was not: restore the height before clicking anything low in the window.
- **SVELTE HAS NOT FLUSHED INSIDE ONE `evaluate`.** A synthesized HTML5 drag whose target
  only EXISTS once `dragstart` re-rendered (a row that unhides for a drag) must be split
  into two evaluates with the `DataTransfer` stashed on `window` between them. A real drag
  never has this problem — the pointer reaches the row many frames after it appeared.
- **PROVE A "pre-existing red" ON A PRISTINE SERVER, WITH NUMBERS.** `packs-drop` read as
  2/3 on base and 3/3 on the branch, which looks exactly like one regression. Running the
  SAME instrumented copy against both (a second worktree on `origin/release/next` with its
  own port) printed `before=0 after=1` on each and 3/3 on each — the base's extra pass was
  a flake. A red that differs by one check is worth one more measurement, not a guess.
- **A SUITE THAT SEEDS A LOCAL PREF MUST NAME THE KEY THE STORE READS.** `explorer-views`
  seeded `shared:deleteWithoutConfirm` while `deleteWithoutConfirm` reads
  `shared:deleteNoConfirm` — a dead seed that had never done anything, and which only
  surfaced when a confirm finally stood in the way. Grep the store for the literal.

## Roadmap 22 round 10 — `peer-ice-config` (10) and `explorer-drag-fixes` (7)

- **A TWO-PEER FAILURE THAT `PEER_CONFIG` "FIXES" IS NOT ALWAYS SIGNALING FLAKINESS.**
  Round 9 hit exactly that on localhost, re-ran with PEER_CONFIG, went green and filed it
  as transient. It was a real bug: the env config carried a TURN entry with an empty
  credential, and Chromium THROWS constructing the RTCPeerConnection rather than degrading,
  so signaling worked (peer ids appeared) and every data channel died. PEER_CONFIG hid it
  because mode `custom` with blank TURN fields uses peerjs's own defaults. When the
  documented re-run makes a two-peer red disappear, note WHAT differs between the two
  configs before calling it environmental.
- **THE BROWSER CAN BE THE ORACLE.** `peer-ice-config` does not assert on the shape of
  our ICE array — it hands the options the app would use to a real `new
  RTCPeerConnection(...)` and asserts it constructs. That is the exact failure the user
  saw, it cannot pass vacuously, and restoring the old gate turns three checks red with
  the browser's own `InvalidAccessError`. Prefer a real API call over a shape assertion
  whenever the API is what rejected you.
- **A suite that runs against a `.app` hostname cannot see a localhost-only branch.**
  `peerServer`'s default mode asked `isLocalDev` first, so every suite took the other
  path. If a report only reproduces on a dev server, check whether the code branches on
  `location.hostname` before assuming the diff is at fault.
- **Synthesized HTML5 drag needs one `DataTransfer` across all three events.** Build it
  once and pass it to `dragstart`, `dragover` and `drop` on the real elements; the payload
  the app wrote is then readable back out of it, which is how `explorer-drag-fixes` proves
  the whole selection travelled rather than inferring it from the result.
- **A drop-band position check needs the scroll as its premise.** Assert the grid really
  is scrolled (`scrollTop > 100`) before asserting the band is inside the visible box —
  otherwise the check passes trivially at the top, which is the state the bug looks fine in.

## Roadmap 22 — the Explorer views (`explorer-views`, 71 checks)

Round 9's suite: the list view, its per-view columns and sort, and the bin (grouping,
sort-by-date, and the purge). Lessons that generalise:

- **Read both halves of a toggle at the SAME moment.** The armed-colour check first read
  Thumbnails while it was armed and List after switching — comparing the accent with
  itself, so it could never fail. Read the armed one and the idle one together.
- **A class with no CSS can still be load-bearing**, and finding out costs a red check
  that looks like a broken feature: a list row that did not carry `.explorer-card` was
  BACKGROUND to `#explorer-grid`'s three handlers, so the click selected it and
  `gridBackgroundClick` deselected it in the same gesture.
- **A right-click for the grid BACKGROUND menu has three ways to miss**: the Controls HUD
  intercepts the middle-bottom, the header row has its own menu, and a position past the
  grid's own height resolves to `<html>` ("element intercepts pointer events" for an
  element that is merely elsewhere). Aim below the last row, clear of the HUD, inside the
  measured box.
- **A bin fixture must stamp its own owner ids.** `meAsOwner` records whatever `peer.id`
  holds, so a suite seeding deletions milliseconds after load records UNATTRIBUTED rows —
  a real state, with its own section, but not the one a grouping check is about.
- **The counterfactual belongs IN the test when the bug was a DEPENDENCY, not a value.**
  For the purge, both the old and the new reading return `false` once the bytes are gone —
  the fault was that the old one sat in a derived nothing re-ran. So the suite computes
  both in-page and asserts they agree, and the real guards are the OBSERVABLE ones (the
  row dims; the menu stops offering Restore).

## Roadmap 22 — the shared library (`shared-library`, 194 checks, two peers)

One suite covers the whole batch: the document, both identities, adoption, the pull,
the concurrent-share reconcile, tombstones, delete/restore, the chunk protocol, the
ledger arithmetic and the whole UI half through REAL context menus. Lessons that
generalise:

- **A default that makes the app act faster invalidates every check written for the
  slower world.** Auto-download (on by default) fetches a shared file before an
  assertion can observe "the peer does not hold it" — three checks, then three more
  after the pull became structural. The fix is to reach the old state the way a USER
  would (park the setting), never a test-only door.
- **A ledger/aggregate check needs an EMPTY ledger.** Reading a percentage out of a
  ledger full of the run's own real transfers measured 63% where the maths says 13%.
- **An async MARK lands after the thing it marks.** The `'peer'` adoption flag is
  applied by a debounced sweep, so a synchronous read right after the item appears
  measured `null` while the feature was perfect. `h.eventually` on the mark.
- **A modal left open shields every later click** — `settingsOpen` cost a 30s timeout
  several sections later, reported as an Accordion header intercepting the press.
- **A toggle-shaped affordance must be opened idempotently.** Clicking "Show full log"
  blindly CLOSED what an earlier section had opened. Check for the pane first.
- **A card in a grid of two dozen lands under the Controls HUD.** Give a card you
  intend to click its own folder so it renders top-left, clear of the chrome.
- **`openedPeers` is a Set** — `.length` is undefined, so a "connected" premise built
  on it is silently always false.
- **A `$bindable` prop is only two-way for the caller that BINDS it.** A component
  rendered twice (an indicator and a pane) with `bind:` on only one instance leaves the
  other writing a local copy — its close button did nothing, and no store read could
  have shown it. Assert the OBSERVABLE outcome (the pane is gone), not the prop.
