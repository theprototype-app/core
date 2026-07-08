# CLAUDE.md — theprototype.app

Collaborative peer-to-peer 3D prototyping app: SvelteKit (static adapter) + Svelte 5 +
Threlte 8 + three.js, peerjs mesh networking (no server beyond PeerJS signaling), and a
node/flow editor (@xyflow/svelte 0.1.x) that drives scene behavior. Everything a user does
must be visible to connected peers.

## Architecture map

- `src/stores/` — `appStore` (UI panels, userdata, peers instance, toasts),
  `sceneStore` (three refs: objectsGroup/TControls/camera/renderer, selection, locks, VR),
  `flowStore` (nodes/edges/cursors/mute/sync).
- `src/lib/peerHandler.svelte.js` — PeerConnection class; **all incoming messages** dispatch
  in `conn.on('data')`; the handshake (`sendHandshake`) fires **on connection open** and
  requests full-state syncs (`getobjects`, `getnodes`, `getannotations`).
- `src/lib/commandsHandler.svelte.js` — receive-side appliers for scene ops + `sendObjects`
  (GLTF-based full object sync; late joiners get geometry/textures through this for free).
- Domain modules in `src/lib/`: `objectActions` (select/duplicate/group/focus/flyTo),
  `geometries.svelte.js` (create via replicated `/create` commands; custom builders in
  `customGeometries.js`), `materialsHandler`, `meshEdit` (vertex editing), `history`
  (undo with pluggable kinds via `registerHistoryKind`), `snapping`, `shortcuts` (single
  registry = key bindings AND the Settings list), `flowRuntime` (node-graph animations),
  `nodesHandler` + `nodeCatalog`, `vrControls` + VRMenu, `voiceChat` (MediaConnection),
  `autosave` + `idb`, `annotationsHandler`, `measure`, `cameraBookmarks`,
  `editorNavigation`, `lightHelpers`.
- UI: `components/menu/*` (flowbite drawers/modals; visibility via stores +
  `hidePanels/restorePanels`), `components/editors/*` (flow editor), `components/play/*`
  (player, avatars, VR), shared `ContextMenu.svelte`.

## Replication golden rules

1. Every mutation = apply locally + `$peers.send({type, ...})`; receivers apply WITHOUT
   re-broadcasting (no echo loops). Add the `type` case to `conn.on('data')`.
2. Never send on a timer after connecting — peerjs silently drops pre-open messages. Send in
   the connection `open` callback (see `sendHandshake`) or retry-until-`conn.open`
   (see `sendNodes`/`sendAnnotations`).
3. Each domain needs a full-state reply for late joiners (`get<domain>` message) hooked into
   `sendHandshake`, and cleanup in `handleDisconnected`.
4. Key everything by uuid; peers assume the **same app version** (catalogs/builders execute
   identically on all clients).
5. Objects with children must never gain helper/proxy children — helpers live at scene root,
   or they leak into GLTF saves and peer syncs.

## Hard-won gotchas (do not rediscover)

- Svelte 5 forbids mixing `on:click` and `onclick` **per component** — match the file's
  existing style before adding handlers.
- No `bind:value` ping-pong with store round-trips (reactive statements run in dependency
  order; the "pull" clobbers input). Widgets render from data and write via handlers
  (see flow node components).
- Media elements: `muted` must be set as a property (action), not an attribute binding.
- The Threlte Canvas wrapper swallows `pointerup` mid-gesture — canvas `pointerdown` +
  window-capture `pointerup` (Scene.svelte selection).
- Shared THREE temp vectors corrupt values across helper calls — capture plain arrays
  before calling anything else that reuses them (meshEdit world/local bug).
- flowbite Modal has no working `onopen` prop — react to the bound store instead.
- The toasts container must keep `pointer-events: none` (children re-enable) or it blocks
  clicks under it.
- Stores initialized `writable(null)`/`writable([])` infer `never` — annotate with JSDoc
  `Writable<any>`; keep NEW files clean (repo has a legacy implicit-any baseline; don't
  add to it, don't fix unrelated files).
- `event.key` for digits breaks with Shift (layout chars) — use `event.code` (`Digit1`).
- vite re-optimizes new deps on first page load (test flake: one reload) — rerun once.

## Verification (mandatory before commit)

Follow `.claude/skills/e2e-verify/SKILL.md`. Short version: Playwright headless against
`https://localhost:5173` (single page) or `https://theprototype.app:5173` (hosts-mapped;
use for **two-peer tests over the public PeerJS cloud** — connect → Approve toast → 8s).
`localStorage.debugStores=true` exposes `window.__stores` (all stores + key modules).
`npm run build` must pass; `npx svelte-check` must add no NEW errors.

## Workflow preferences (user)

- One commit per phase/feature; message style: `[feat]/[fix] lowercase summary` + body
  bullets + `Co-Authored-By: Claude ... <noreply@anthropic.com>`. PowerShell here-strings
  break on embedded double quotes — avoid them in messages.
- Plan documents live in `docs/plan/` (**never commit them** — the user moves them);
  postponed phases go to `docs/plan/pending/`. Keep `00-overview.md` tables in sync.
- Sort plans by dependency/risk (S/M/L/XL effort tags), put the riskiest last, ask 2–3
  targeted questions when a feature has real design forks, and offer to postpone
  hard/low-value pieces explicitly.
- Undo/redo currently covers transforms + vertex edits only (full undo = pending phase 23).
  Multi-select (13), flow undock (14), physics (24) and topology editing (25) are pending.

## Modules / addons direction (agreed baseline)

Future loadable modules ("play" content: 3D instruments/synths, game prototypes,
design/animation examples) and user scripting via editable **code nodes**. Baseline:

- A module = manifest `{ id, name, version, entry }` lazy-imported; on load it registers
  into the existing extension points: `nodeCatalog` (node types), `primitivesCatalog`
  (objects), `flowRuntime` (per-frame behaviors), menus. These catalogs are already the
  plugin surface — extend them, don't fork them.
- Module state replicates through namespaced messages `{type:'module', moduleId, ...}` and
  a `getmodulestate` handshake; peers compare module id+version lists on connect (extend
  userdata) and toast on mismatch — same "same version" trust model as the node catalog.
- Code nodes: a `script` node whose `data.code` replicates like any node data (the
  `nodedata` path already syncs it). Execution is deterministic per peer: run in a
  sandboxed Function/worker with a small safe API (scene object lookups, transforms,
  material params, time from the synced wall clock) so every peer computes the same result
  from the same graph — do NOT stream script outputs.
- Interactivity for peers comes free if module state lives in nodes/objects; avoid module
  side-channels.
