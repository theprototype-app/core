---
name: peer-feature
description: Checklist and patterns for adding a replicated feature or a module to theprototype.app — message types, handshake sync, the implemented module SDK, sync-model choice (deterministic vs authoritative), and history kinds.
---

# Adding a replicated feature (or module) to theprototype.app

Everything users do must be visible to connected peers. Every pattern named here exists
in the codebase — copy the referenced implementation.

## First decision: which sync model?

- **Deterministic** — peers compute identical results from replicated inputs + the
  synced clock (`moduleSDK.runtimeNow()`; wall clock % day). Only inputs travel (node
  data, a seed, a press timestamp). References: flow effects, script nodes, dungeon
  (`{op:'generate', seed}` — determinism IS the netcode), button door (pressed+at),
  animated-import mixers. Seeded randomness only (`mulberry32`); no accumulation in
  effects (compute from `base` + `time`); no `Math.random()` in anything replicated.
- **Authoritative** — one peer simulates and broadcasts results as plain messages;
  others just apply. References: physics (initiator steps the world, movement-gated
  `move` broadcasts, busy-guard message), pong (spawner owns the ball at ~12 Hz), the
  car module (the blessed INPUT-FORWARDING recipe: every peer sends its inputs
  `{op:'drive', throttle, steer}` at ~20 Hz, only the `api.physics.isInitiator()`
  peer applies motors — result replicates as plain moves). Use when simulation can't
  be deterministic; guard against two authorities.

## Not everything replicates — some state is deliberately LOCAL

Resist the "every mutation broadcasts" instinct for state that is DERIVED or per-viewer:
do NOT add a message type or `$peers.send`, just a local writable + local updater, and
prune it in `handleDisconnected` (or derive the UI from live peers so stale entries
can't render). References: `networkQuality.js` (per-peer RTT/relay from `getStats()`,
polled locally), the Explorer **pack library** (imported packs stay local until an
explicit future "Share"; only a *placed* object replicates through the normal import
path), input claims (`inputRuntime.claimInput` — a claim only pauses THIS peer's own
input consumers, nothing on the wire), view mode/shadow quality/sculpt brush prefs,
and the LOCAL-prefs modules (themes, cameraClip, WindowShell `ws:*`). Rule of thumb:
if two peers would independently compute the same value, or it's a personal setting,
keep it off the wire.

## Checklist for a new replicated feature

1. **State** in a store (`src/stores/*`) or module-level writable; uuid/id-keyed,
   plain-serializable (peerjs binarypack: ArrayBuffers OK — raw-bytes syncs like
   `objectfile` ride on this; no class instances/functions). **Large numeric payloads
   MUST go as raw bytes**: a plain array of ~40k numbers makes binarypack recurse to
   "Maximum call stack size exceeded" — and `broadcast()`'s try/catch swallows it, so
   the send silently vanishes. Send `new Float32Array(arr).buffer` and normalize
   array/ArrayBuffer/typed-view on receive (meshgeo is the reference).
2. **Local mutation function** applies + broadcasts:
   `get(peers)?.send({ type: 'mything', ... })` (pattern: `annotationsHandler`).
3. **Receive case** in `peerHandler.svelte.js` `conn.on('data')` — applier does NOT
   re-broadcast.
4. **Late joiners**: `getmything` request in `sendHandshake()` + a full-state reply
   that retries until `conn.open` (`sendNodes`/`sendJoints`/`sendModuleStates` —
   never bare `setTimeout` sends: peerjs silently drops pre-open messages). Singleton
   state (environment, sceneMusic) instead pushes with a `changedAt` stamp,
   latest-wins — each singleton gets its OWN message type (music deliberately does
   NOT piggyback on `environment` because env state round-trips through preset
   export/import and would leak the track into presets) — and any symmetric pull
   needs a deterministic direction (nodesync: lower count pulls, peer-id tiebreak)
   or drifted peers swap forever. A replicated LIST of small defs (joints) copies
   the annotations pattern: create/delete messages + full-list handshake reply +
   sender-side delete-cascade + a presence-style history kind. Per-peer IDENTITY
   choices (avatar photo, hand model) broadcast a content HASH with presence/
   userdata and receivers pull the bytes via assetShare (`handModels.js`).
5. **Where does it live in the scene?** `objectsGroup` children = replicated, listed,
   GLTF-synced, anyone edits. Scene-root groups (fixed `name`) = local/derived —
   helpers, env rig, module content; rebuild them from state; they need
   `registerInteractiveGroup(name)` to receive viewport clicks. Content that can't
   round-trip (skinned rigs) syncs as original file bytes (`animatedImports`).
6. **Cleanup** on peer loss in `commandsHandler.handleDisconnected`.
7. **Undo** (if it mutates the scene): `history.registerHistoryKind(kind, apply)` —
   the applier replays the normal replicated action; `recordEntry` is auto-muted while
   history applies, so replays can't re-record. Object presence uses
   `recordObjectPresence('create'|'delete', object)` (ObjectLoader snapshot, 5 MB cap);
   batches use `recordTransformSet(items)`; bytes-backed content has its own kind
   (`animimport`).
8. **UI entry points**: viewport menu (`ViewportMenu.svelte` items), object context
   menu (`Controls.svelte objectMenuItems`), shortcuts registry (`shortcuts.js` — one
   registry drives bindings AND the Settings list), VR quick-menu
   (`vrControls.executeVRMenuAction` + `VRMenu.svelte` tiles), action toasts
   (`showToast(message, [{label, action}])`).
9. **Verify two-peer** per `.claude/skills/e2e-verify/SKILL.md`; add a suite in
   `tests/e2e/`; expose new singletons via the App.svelte `__stores` hook; one
   `[feat] ...` commit.

**Open-core dispatch gate (#13 M1 / #14)**: the FIRST line of `conn.on('data')` is
`if (data && !canApply(conn.peer, data.type)) return;` (`cloudHooks.canApply`, default
allow). A NEW mutating message type is gate-able for free; if it is
connection/handshake-critical it MUST be added to `ALWAYS_ALLOWED` in `cloudHooks.js`
(alongside `hosts`/`userdata`/`cloud`/`get*`) so a cloud plugin's role gate can't drop
it and break the mesh. Cloud-plugin state (roles, rooms) replicates over the
`{type:'cloud', payload}` channel (`sendCloud`/`onCloudMessage`), NOT a new core type —
core only carries the seam. Never build cloud/roles features into core; they live in
the private `theprototype-app/cloud` plugin (see its `CLAUDE.md`).

Throttle continuous streams (~10–20/s) with a final unthrottled send on gesture end
(`move`, `verts`, `flowcursor`, `drawlive` are references); temp visuals for other
peers get stale-expiry cleanup (`drawlive` 5s, ping 4s).

**Geometry/topology changes** can't ride a per-vertex channel — snapshot the FULL
geometry (`meshgeo`: uuid + positions, size-capped ~45k floats, `faceEdit.js`; the
WIRE format is raw `Float32Array.buffer` bytes per the binarypack rule above).
Receivers swap the geometry wholesale, the history kind replays the same snapshot, and
the receive applier must REBUILD any live edit-session caches (applyMeshGeo re-derives
its face groups AND the terrain sculpt weld map — a stale cache after undo/remote swap
corrupted gestures once). Live reshape gestures stream throttled previews (~5/s) and
commit ONE snapshot + undo entry on release.

**Flow graphs are PER-OBJECT documents** (#13-H): `flowGraphs` keyed
`'scene' | objectUuid` is the source of truth; `flowNodes/flowEdges` are only the
ACTIVE graph's editor view. Anything touching nodes must (a) tag its messages with
`graphId` (absent = scene, legacy compat) and route appliers through
`updateGraph(graphId, fn)`, (b) READ the whole world via `allNodes()`/`allEdges()`
(nodes carry a runtime-only `__graph` tag) or `findNodeAnyGraph`, never
`get(flowNodes)`, and (c) keep the applier-side PRUNE INVARIANTS deterministic —
`pruneCustomNodeEdges` (def param removed) and `pruneObjectFlowEdges` (Flow
Input/Output renamed/deleted) run identically on every peer from converged state,
never broadcast. Graph lifecycle replicates as `graphcreate`/`graphdelete` +
the `'flowgraph'` history kind (undo of delete restores the whole document);
inside an object graph, effect/physics/sound/onclick nodes with no Object Selector
implicitly target the OWNER. Named VALUE inputs are single-connection (a new wire
replaces the old via `replaceableInputEdges`); effect/event inputs keep multi
fan-in; local input (keyboard) enters the graph ONLY as replicated trigger stamps
(`keypress` node = the button-module pattern, held keys re-stamp).

## Adding a VR panel (the follower-window pattern)

Copy VRSettingsPanel/VRPropertiesPanel/VRChatPanel: (a) a Svelte component with named
control meshes `vr<x>-*` that publishes its THREE group to a `vr<X>Group` writable and
poses through `applyWindowPose(group, '<id>', anchor)` (menuPoseFromController + optional
LIFT) so the 111 grip-grab + persisted offsets apply — the pose task must resolve the
menu-hand controller via `controllerIndexFor($vrMenuHand)`, never a raw `inputSources`
index (194); (b) a `raycast<X>(index)` in vrControls
returning `'<x>:action'`; (c) a `'<x>:'` namespace branch in `executeVRMenuAction`;
(d) mutual exclusion with the sibling menu-hand panels (each opener closes the others,
the B/Y menu-open handler closes yours); (e) add `!get(vr<X>Open)` to the
teleport/snap-turn modal gate + a hover/stick block; (f) register the window id in
`windowGroupFor`/`windowHitAt`; (g) route the trigger in Scene.svelte's `onXRSelect`.
Text input goes through `openVRKeyboard({title, initial, onCommit})` — the keyboard is
modal on top of every panel.

## Modules (SDK is implemented — extend it, don't fork)

`src/modules/<id>/module.js` default-exports `{id, name, version, description,
register(api)}`; core list in `src/modules/index.js` (`coreModules`); the manager
enables/disables (live enable, reload to disable — registries are additive). User
modules install from zip/URL (`userModules.js`) and must be self-contained (no imports;
`api.THREE`, `api.assetUrl`). Full guide: `MODULES.md` (committed) + `docs/sdk/`
(uncommitted).

api surface: `registerNodeGroup(group, components?)` (items with `params` render via
the generic AnimationNode), `registerEffect(type, fn(object, base, data, time))`
(base-managed, runs on edge → Object Selector), `registerPrimitive(name, builder,
entry)` (replicated `/create <Name>`), `registerClickHandler(fn(hitObject) => bool)`
(desktop + VR trigger), `registerInteractiveGroup(name)`, `registerFrameTask(fn(time))`,
`send(payload)`/`onMessage(fn)` (namespaced `{type:'module', moduleId}`),
`registerStateSync({getState, applyState})` (late joiners), `registerMenu(label, fn)`
(renders on the module's manager card), `registerVRMenuEntry({id, group, label,
action, closes})` (VR radial sector), accessors `scene() objectsGroup() peerId()
toast() now() THREE assetUrl(path) selectedUuid()`. #12 additions (reached via PRIMED
dynamic imports in moduleSDK — static edges close TDZ cycles): **input** —
`registerBindings` (Settings ▸ Shortcuts listing), `input()` snapshot
`{codes:Set, axes, vrButtons}`, `onInput(fn)`, `claimInput/releaseInput('keys'|
'locomotion')` (pauses the host's OWN consumers, LOCAL, always release); **physics**
— `api.physics.{isInitiator, applyImpulse, setJointMotor, joints()}` (mutations
initiator-only — forward inputs, see the authoritative car recipe above);
**possess** — `possess(uuid, {camera:'chase'|'orbit'|'none'})`/`releasePossess()`
(possessing = selecting = the lock; ONE undo per ride). #13 additions:
**registerNodeDefs(defs)** — code-editable nodes shipped with the module (land in
the replicated customNodeDefs as `mod-<moduleId>-<key>`, NodeDesigner-editable,
ABSENT-ONLY seeding so user edits survive reloads); **pointerRay()** — a FRESH
world-space Raycaster for wherever the user points (desktop mouse / VR pointer
hand); drag recipe: click to pick → follow pointerRay() in a frame task → click to
drop. A module KIND peers must agree on derives from the replicated object NAME
(car's 'Carbody'), never locally-set userData. Worked examples:
`src/modules/essentials/` (interactables), `src/modules/car/` (physics + input +
claims), and in the SEPARATE `theprototype-app/modules` repo: `flow-toolkit`
(registerNodeDefs) + **`untangle`** (a full GAME: seed-deterministic solvable
puzzles — determinism IS the netcode, pointerRay drag with throttled `drag`
previews + one authoritative `move`, LOCKSTEP win/level advance with NO win message
because every peer computes the same result, self-synthesized WebAudio).

Version trust: peers exchange `[{id, version}]` on connect and toast on mismatch
(advisory). Module viewport content = scene-root group rebuilt from state (see rule 5);
prefer storing module state in nodes/objects (sync already done) over side-channels.

**Script/code nodes** exist (`scriptRuntime`, Script node + replicated custom node
defs via `customNodes` + `getnodedefs` handshake): `data.code` replicates like any
node data; execution is a deterministic pure function of `(object, base, data, time)`
per peer — never stream script outputs; errors badge the node and toast once.
