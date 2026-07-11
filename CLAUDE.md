# CLAUDE.md — theprototype.app

Collaborative peer-to-peer 3D prototyping app: SvelteKit (static adapter) + Svelte 5 +
Threlte 8 + three.js, peerjs mesh networking (no server beyond PeerJS signaling), a
node/flow editor (@xyflow/svelte 0.1.x) driving scene behavior, and a module SDK for
loadable play content. Everything a user does must be visible to connected peers.

## Architecture map

- `src/stores/` — `appStore` (UI panels, userdata, peers instance, toasts+action-toasts,
  modulesOpen), `sceneStore` (three refs: objectsGroup/TControls/camera/renderer,
  selection, locks, VR incl. vrFlying/vrSnapAngle), `flowStore` (nodes/edges/cursors/
  customNodeDefs/scriptErrors/sync flags).
- `src/lib/peerHandler.svelte.js` — PeerConnection class; **all incoming messages**
  dispatch in `conn.on('data')`; `sendHandshake` fires **on connection open** and pushes
  locked/hosts/userdata/module versions/environment + requests full-state syncs
  (`getobjects/getnodes/getannotations/getmodulestate/getnodedefs`).
- `src/lib/commandsHandler.svelte.js` — receive-side scene appliers + `sendObjects`
  (GLTF full sync; animated imports detour through `sendAnimatedImport` raw bytes).
- Domain modules in `src/lib/`: `objectActions`, `geometries.svelte.js`,
  `materialsHandler`, `meshEdit`, `history` (kind registry: create/delete/group/material/
  props/transformSet/verts/animimport/geometry; recording auto-muted while applying; 5 MB
  snapshot cap), `snapping`, `shortcuts` (registry = bindings AND Settings list),
  `flowRuntime` (per-frame tick, baseState rebase, suspend/resume for gizmo drags,
  `parkAnimatedAtBase` for serializers, module effects, script + sound nodes),
  `soundRuntime` (sound-node panner chains, loop phase = synced clock), `scriptRuntime`
  + `customNodes` (replicated user node defs), `nodesHandler` + `nodeCatalog` (+nodesync
  drift heal), `moduleSDK` + `userModules` (zip/URL installs), `physics` (rapier,
  initiator-authoritative), `environment` (presets + scene-root rig, latest-wins sync,
  `passthroughActive` local sky lift), `animatedImports` (raw-bytes objectfile sync),
  `prefabs` (local IndexedDB library), `explorer` (LOCAL asset library: IndexedDB index
  + per-item blobs, content hashes, thumbnails) + `explorerDrop` (drag-out placement/
  texturing) + `assetShare` (assetfile/getasset hash push+pull → 'Shared' folder),
  `bottomDock` (Flow/Explorer tabbed dock), `lockControl` (request-control, peerColor),
  `drawMode`, `pathCapture`, `ping` + `pingAudio` (synth chimes, spatial), `voiceChat`
  (+spatial PannerNodes, VR PTT, setMicMode), `vrControls` (locomotion/teleport math,
  world pan, rigid grip grab, haptics, menu/panel raycasts) + `vrRadialMenu` (sector
  math, entry registry, controller-anchored pose), `dungeonPlay` (raster collision/
  spawns from the dungeon module's userData.play contract), `geometryEdit` +
  `geometryParams`, `lightParams` (+local shadow-quality caps), `themes` (data-theme
  token blocks, local-only), `windowTabs` + `windowFocus` + `docking` + `dragWindow` +
  `searchMenuUx` (floating-window system), `autosave` + `idb`, `annotationsHandler`,
  `sessions`, `measure`, `cameraBookmarks`, `editorNavigation`, `lightHelpers`.
- `src/modules/` — core modules (hello, button, dungeon, piano, pong) + `index.js`
  `coreModules` list; manager enables/disables (live enable, reload to disable).
- UI: `components/menu/*` (drawers/modals; visibility via stores + `hidePanels/
  restorePanels`), `components/editors/*` (flow editor + CodeMirror panels),
  `components/play/*` (player, avatars, VR), scene-overlay components
  (PingMarkers/PathWaypoints/LockHighlights), shared `ContextMenu.svelte`.
- `tests/e2e/` — committed Playwright suites (`npm run e2e`, subset by name);
  `.cjs` because the package is `"type": "module"`.
- `docs/sdk/` — SDK docs (kept **uncommitted**, like docs/plan). `MODULES.md` committed.

## Replication golden rules

1. Every mutation = apply locally + `$peers.send({type, ...})`; receivers apply WITHOUT
   re-broadcasting. Add the `type` case to `conn.on('data')`.
2. Never send on a timer after connecting — peerjs silently drops pre-open messages.
   Send in the connection `open` callback (`sendHandshake`) or retry-until-`conn.open`
   (`sendNodes`/`sendAnnotations`/`sendModuleStates` pattern).
3. Each domain needs a full-state reply for late joiners (`get<domain>` in
   `sendHandshake`) and cleanup in `handleDisconnected`.
4. Key everything by uuid; peers assume the **same app version** (catalogs/builders/
   modules execute identically — versions handshake toasts on mismatch).
5. **objectsGroup = replicated, scene root = local.** Helpers, the environment rig and
   module viewport content live at the scene root (fixed names), so they never enter
   GLTF sync or duplicate on connect; regenerating content rebuilds from module/env
   state instead. Scene-root groups need `registerInteractiveGroup` to be clickable.
6. Content that can't round-trip (skinned rigs) replicates as its **original file
   bytes** (`objectfile`), not through the per-node exporter (GLTFExporter is lossy and
   `sendObject` splits children, destroying rigs).
7. Singleton shared state (environment) syncs latest-wins via a `changedAt` stamp;
   symmetric pulls need a deterministic direction (nodesync: lower count pulls,
   peer-id tiebreak) or two drifted peers swap forever.
8. Two sync models: **deterministic** (seed/params + synced clock — dungeon, effects,
   scripts, sound loops; determinism IS the netcode) vs **authoritative** (initiator
   simulates and broadcasts — physics, pong ball). Pick one per feature; never mix.
9. Binary asset sharing = **content hash push+pull** (`assetfile`/`getasset`,
   assetShare.js): push once on assign, any peer missing a hash pulls it — covers late
   joiners/restores without handshake dumps. REPLY over your stable OUTGOING
   `peer.connections[peerId]`, never the incoming conn (it can be a stale duplicate
   from the connect dance). binarypack delivers Uint8Array **views** — slice
   byteOffset..byteLength before hashing.
10. Serializers (sendObjects, GLTF save, autosave, sessions) must
   `parkAnimatedAtBase()` first or receivers bake mid-swing poses as animation base;
   `restoreBase` calls `updateMatrix()` because toJSON/GLTFExporter read the matrix
   the last RENDER composed.

## Hard-won gotchas (do not rediscover)

- Svelte 5 forbids mixing `on:click` and `onclick` **per component** — match the file's
  existing style. Runes-mode files can't use `$:` — and adding ONE `$state` to a `$:`
  file flips it to runes mode and breaks the build. Never introduce `$state` into
  legacy-mode components.
- `$effect` tracks EVERY store read synchronously inside it — side reads (userdata,
  globalScene…) retrigger it and can hit `effect_update_depth_exceeded`, which
  UNMOUNTS the app. Wrap one-shot side work in `untrack(() => …)` so the effect only
  depends on its trigger.
- No `bind:value` ping-pong with store round-trips — widgets render from data and write
  via handlers (`setNodeData`).
- Media elements: `muted`/`volume` set as properties in an action, not attributes.
- The Threlte Canvas wrapper swallows **pointerup AND pointermove** mid-gesture —
  put both on `window`; only `pointerdown` belongs on the canvas.
- Shared THREE temp vectors corrupt values across helper calls — clone before reuse.
- Never write a store from inside its own subscriber (infinite flush loop) — read refs
  first, then mutate (also applies inside test `evaluate`).
- **Vite HMR module identity**: a page-side dynamic `import('/src/lib/x.js')` can bind a
  SECOND module instance once vite timestamps the app's copy (empty stores, false
  fails). Singletons are only reachable via the `window.__stores` debug hook — extend
  the hook in App.svelte when a test needs a new module.
- flowbite: Modal has no `onopen` (react to the bound store); Dropdown anchors to its
  previous sibling; toasts container keeps `pointer-events: none` (children re-enable).
- `event.code` (`Digit1`) for digit shortcuts — `event.key` breaks with Shift.
- Stores initialized `writable(null)`/`writable([])` infer `never` — annotate with
  JSDoc `Writable<any>`; keep NEW files clean (legacy implicit-any baseline stays).
- `npm i` needs `--legacy-peer-deps` (three vs postprocessing peer conflict).
- PowerShell mangles emoji AND em-dashes when rewriting files, and inline `node -e`
  quoting breaks — write a scratch `.cjs` and run it with node for any file rewrite
  containing non-ASCII. Commit messages: no embedded double quotes in here-strings.
- Reference-space convention in vrControls: `getOffsetReferenceSpace` offset =
  **-(viewer displacement)**; snap-turn/teleport/world-pan math builds on it.
- Locks: `lockedObjects` holds REMOTE locks only — "we hold X" = X is our selection;
  one lock per peer (a new lock replaces the old one); `unlock` message exists.
- vite re-optimizes new deps on first page load (one reload) — rerun once; lazy wasm
  (rapier) needs a throwaway prewarm page in tests.
- Postprocessing composers (Outline) do NOT render in WebXR — VR indicators are
  scene-root shell/wireframe meshes that copy the selection's world transform per
  frame (never children of the object: they'd leak into GLTF sync).
- Module cycles: a static import that closes a loop back into `history` (via
  materialsHandler etc.) TDZ-crashes the SSR prerender — moduleSDK reaches optional
  libs (vrRadialMenu) via dynamic `import()` instead.
- `selectedObject` is `writable([])` and KEEPS the last object after deselect (the
  desktop outline relies on it) — "has selection" checks need `?.uuid`, and the
  init value is a truthy empty array.
- The Bash tool's `cd` leaks into the shared shell cwd — `Set-Location` back to the
  repo root before PowerShell git/npm calls.
- The dungeon module publishes gameplay data on its group's `userData.play`
  (grid/rooms/floorValue) — `dungeonPlay.js` consumes it; keep that contract stable.

## Verification (mandatory before commit)

Follow `.claude/skills/e2e-verify/SKILL.md`. Short version: the suite lives in
`tests/e2e/` — `npm run e2e -- <name>` for the feature suite you add/update (every
feature phase ships one; update suites broken by UI changes in the same commit).
Two-peer tests run over the public PeerJS cloud via `https://theprototype.app:5173`
(hosts-mapped). `npm run build` must pass; `npx svelte-check` must add no NEW errors.

## Workflow preferences (user)

- One commit per phase/feature; message style: `[feat]/[fix] lowercase summary` + body
  bullets + `Co-Authored-By: Claude ... <noreply@anthropic.com>`.
- Plan documents live in `docs/plan/` (**never commit them**; `docs/sdk/` is also
  uncommitted for now — the user moves them). Postponed phases → `docs/plan/pending/`;
  future ideas → `docs/plan/backlog.md`; open design questions → `docs/plan/quiz.md`.
  Keep `00-overview.md` tables in sync with every scope change.
- Roadmap ritual: user drops notes → ask 3-4 targeted AskUserQuestion forks (offer a
  recommended option — they usually take it) → write plan files → present the batch
  table (sizes S/M/L/XL, riskiest last) → they pick what executes.
- Design work: screenshot-driven; **keep the current designs of Users.svelte,
  Toasts.svelte, Connect.svelte and Controls.svelte**.
- VR phases: verify math/state headlessly, state clearly that on-device feel is the
  user's manual check.
- Batches 1-12 shipped (phases 1-54 minus skips); current roadmap = batches 13-18
  (design overhaul, environment manager, restored 13/25/50/55/56/57/58, VR world grab).

## Module SDK (implemented — extend, don't fork)

`src/modules/<id>/module.js` default-exports `{id, name, version, description,
register(api)}`. api surface: registerNodeGroup (+custom components), registerEffect
(base-managed per-frame), registerPrimitive (replicated `/create`), registerClickHandler
(desktop+VR), registerInteractiveGroup (scene-root click targets), registerFrameTask,
send/onMessage (namespaced `{type:'module', moduleId}`), registerStateSync (late-joiner
handshake), registerMenu (manager card buttons), scene/objectsGroup/peerId/toast/now/
THREE/assetUrl. User modules (zip/URL via the manager) must be self-contained — no
imports; guide in `MODULES.md` + `docs/sdk/`. Script nodes run arbitrary replicated
code deterministically (pure function of object/base/data/time) — never stream outputs.
