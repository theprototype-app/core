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
the LOCAL-prefs modules (themes, cameraClip + orbit feel, gridSettings, WindowShell
`ws:*`, remembered menu sizes `ctx:searchHeight:<kind>`), and the whole camera
PREVIEW/PiP layer (#16: the camera OBJECT is shared scene content, but looking
through it, the picture-in-picture window and the frustum wireframes are yours
alone — only "X is previewing camera Y" goes on the wire, as presence). Rule of thumb:
if two peers would independently compute the same value, or it's a personal setting,
keep it off the wire.

## The cheapest replicated feature: put it on `userData`

Before designing messages, ask whether the feature is really "extra settings on an
object". If so, store them on `userData.<feature>` and you inherit replication,
sessions, autosave, prefabs and GLTF extras for FREE — `userData.physics`,
`userData.particles`, `userData.terrain`, `userData.camera` (#16-P5 scene cameras)
and the `__localOnly`/`__uuid` markers all ride this. The recipe:

1. Creation stamps deterministic defaults in the same place the object is built
   (`geometries.svelte.js` — every peer runs the same `/create`, so no message is
   needed for the initial state). Keep that literal INLINE if the settings module
   would close an import cycle (cameraObjects reaches history; geometries sits in
   history's subtree — the camera defaults are duplicated on purpose, commented).
2. ONE write path — `setPhysicsFor(uuid, patch)` / `setCameraFor(uuid, patch)`:
   mutate userData, `recordEntry({kind:'props', before, after})`, send
   `{type:'objectParameters', parameter:'<feature>', uuid, <feature>}`, then poke
   `objectsGroup.update(v => v)` (THREE trees are not reactive — the poke is what
   the UI, the viz and any derived store actually see).
3. Add the `parameter` case to `commandsHandler.objectParameters` AND the key to the
   `'props'` history applier in objectActions, so remote writes and undo/redo both
   land. **Verify the applier with a two-peer suite**: a missing case is invisible
   locally (a #16 edit to that file silently never hit disk — the peer test caught
   it when the message provably arrived but nothing changed).
4. Anything VISUAL built from that data (frustum wireframes, collider proxies)
   belongs at the SCENE ROOT keyed by uuid, rebuilt from the userData and following
   the object per frame — never as a child of the object (rule 5 below).

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
   state (environment, sceneMusic, scenePhysics/gravity) instead pushes with a `changedAt` stamp,
   latest-wins — each singleton gets its OWN message type (music deliberately does
   NOT piggyback on `environment` because env state round-trips through preset
   export/import and would leak the track into presets) — and any symmetric pull
   needs a deterministic direction (nodesync: lower count pulls, peer-id tiebreak)
   or drifted peers swap forever. A replicated LIST of small defs (joints) copies
   the annotations pattern: create/delete messages + full-list handshake reply +
   sender-side delete-cascade + a presence-style history kind. Per-peer IDENTITY
   choices (avatar photo, hand model) broadcast a content HASH with presence/
   userdata and receivers pull the bytes via assetShare (`handModels.js`).
   **GROWING an existing replicated record** (annotations gained name/color/shape/
   label/authorKey/camera/follow in 15-H) needs NO new message type and NO handshake
   change: keep the message carrying the whole object, put ONE `normalize*()` at
   every store boundary (local set, remote apply, snapshot, autosave restore) so old
   payloads gain defaults for free, and make editors SPREAD the base record so a
   field a newer peer added survives a save by an older one.
   Distinguish REPLICATED authorship data from a LOCAL view of it: 'Me' is a display
   mapping over a stored nickname (never store 'me'), and "did I write this?" needs a
   stable per-DEVICE key — peer ids are re-issued on reconnect and nicknames change,
   so neither survives a rename or a reload. Anything the viewer alone should feel
   (a camera follow session, a marker overlay, click-mode prefs) stays LOCAL: the
   editor camera belongs to whoever is driving it, and a peer's data must never yank
   another viewer's viewpoint.
5. **Where does it live in the scene?** `objectsGroup` children = replicated, listed,
   GLTF-synced, anyone edits. Scene-root groups (fixed `name`) = local/derived —
   helpers, env rig, module content; rebuild them from state; they need
   `registerInteractiveGroup(name)` to receive viewport clicks. Content that can't
   round-trip (skinned rigs) syncs as original file bytes (`animatedImports`).
   **FOUR paths carry per-object state and they do NOT share a serializer** — the peer
   object sync (GLTF for leaf meshes, toJSON for lights/parents/multi-material),
   autosave (ONE GLTF export of the whole group), sessions/`.tpscene` (toJSON), and
   undo (per-kind snapshots). Adding state means asking which of the four keep it.
   Anything GLTF cannot round-trip must ride BESIDE the autosave snapshot and REPLACE
   its GLTF twin on restore, keyed by the `__uuid` stamp (`animated` for rigs,
   `multiMaterial` for slot arrays) — and the failure is quiet: a material array comes
   back as a Group of single-material children that renders IDENTICAL pixels, so only
   a per-object shape assertion catches it.
   **A MATERIAL ARRAY cannot cross GLTF at all**: the exporter splits
   `geometry.groups` into one primitive per material, the loader reassembles them as
   separate meshes, and an array material with NO groups exports nothing. Use
   `serializeMeshWithGroups` (materialsHandler) — and note it flattens a PARAMETRIC
   geometry into a plain BufferGeometry first, because `{type:'BoxGeometry', …}` makes
   ObjectLoader re-run the generator and silently discard custom groups.
   **State with two halves must travel in ONE message**: slots are
   `object.material` (the array) *plus* `geometry.groups` (which face uses which),
   and an array material with no groups draws NOTHING — so the `materials` message
   carries both, and a groups-only send would land on a receiver that cannot use it.
   **State DERIVED from geometry can become stored DATA, and then it needs all four
   paths too.** Stored face topology (P9, `meshTopology.js`) is the worked example:
   optional CSR Int32 raw-BUFFER siblings on `meshgeo` (never nested arrays), read off
   the object the sender just committed to so no call site threads them through; the
   partition INSIDE the history state object (compaction drops sibling fields on the
   entry); `geometry.userData` for toJSON/sessions; and GLTF autosave simply losing it,
   which is fine ONLY because absence means "re-derive". That is the design rule for an
   optional channel: absent must be a LESS CAPABLE result, never a wrong one — and a
   payload that does not fit the mesh it arrives with is DROPPED, not trusted. Also
   check every geometry-swap site, not just the commit: a live gesture rebuilds the
   geometry per frame (`liveGeometryUpdate`), so a channel that only survives commits
   is already gone by the time the commit runs.
6. **Cleanup** on peer loss in `commandsHandler.handleDisconnected` — and if you keep
   a per-peer map of your own, clear it in BOTH teardown paths in
   `peerHandler`: `onConnClose` AND `leaveSession` (they are separate call sites;
   `cameraPreviews` needed the entry removed in both, #16-P5).
   **PRESENCE-style state** (who is previewing which camera, who is watching whom)
   is the lightest replicated shape there is: one message on change
   (`{type:'campreview', peerId, uuid|null}`), a `Record<peerId, value>` store,
   cleanup on disconnect, and for late joiners piggyback an EXISTING handshake
   request instead of inventing a `get*` round trip (`sendCameraPreviewState()`
   rides the `getmodulestate` reply). No history, no undo — presence is not scene
   content.
   **Selection LOCKS need an explicit RELEASE**: a `{type:'lock', uuids}` message
   only ever REPLACES the sender's set (`lockGeometry` ignores an empty list), so
   dropping a selection must send one `{type:'unlock', peerId, uuid}` per released
   uuid — otherwise peers keep the object highlighted and "locked by X" forever
   (#16-P6; `broadcastSelectionRelease` covers deselect, `applySelectionSet([])`
   and switching to a locked-VIEW).
7. **Undo** (if it mutates the scene): `history.registerHistoryKind(kind, apply)` —
   the applier replays the normal replicated action; `recordEntry` is auto-muted while
   history applies, so replays can't re-record. Object presence uses
   `recordObjectPresence('create'|'delete', object)` (ObjectLoader snapshot, 5 MB cap);
   batches use `recordTransformSet(items)`; bytes-backed content has its own kind
   (`animimport`). An entry whose replay RE-BROADCASTS content that peers hash for
   drift detection (flow nodes/edges → nodesync) must store SERIALIZED copies
   (`serializeNode`/`serializeEdge` shapes), never live editor objects — runtime-only
   fields would make the replayed broadcast hash differently (`'flownodes'` kind,
   PR #76, is the reference).
8. **UI entry points**: viewport menu (`ViewportMenu.svelte` items), object context
   menu (`Controls.svelte objectMenuItems`), shortcuts registry (`shortcuts.js` — one
   registry drives bindings AND the Settings list), VR quick-menu
   (`vrControls.executeVRMenuAction` + `VRMenu.svelte` tiles), action toasts
   (`showToast(message, [{label, action}])` — 15s, auto-expires; a decision the
   user MUST answer takes `showInfoToast(id, text, actions, onDismiss)` instead:
   sticky, never folded by the "+N more" cap, removed via `dismissToastById(id)`;
   make the ✕/onDismiss path take the SAFE default — the share-or-stash gate in
   sessions.js is the reference, #15-P2).
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
the private `theprototype-app/cloud` plugin (see its `CLAUDE.md`). #14: roles, rooms,
and room thumbnails are ALL cloud-plugin concerns — the plugin gates via `canApply`,
publishes `rolesInfo` to core (per-peer role UI + viewer object gates in
`objectPermissions.js`), authorizes/dials back joiners via `authProvider`, and pulls a
`captureThumbnail(maxW)` JPEG. Core just exposes the seams; it ships no role/room type.

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
enables/disables. **17-A: USER modules install/update/disable/remove and
dev-reload LIVE** (a per-module teardown journal + `deactivateModule`); CORE
modules still need a reload to disable. User modules install from zip/URL or the
manager's **Browse** gallery (`moduleGallery.js` off the modules repo's
index.json) and must be self-contained (no imports; `api.THREE`,
`api.assetUrl`). Core keeps only hello/button/pong/vrsleeve — dungeon, piano,
avatar, essentials and car live in `theprototype-app/modules`. Full guide:
`MODULES.md` (committed) + the docs site.

## Module SDK — the world api (17-A)

A module no longer has to reach into app internals to build shared content.
Everything below is on the `api` object; the first group REPLICATES, the second
is deliberately per-viewer:

```js
const [uuid] = await api.create('/create Box 1 1 1');   // the replicated /create
await api.create('/create Box 1 1 1', { at: [x, y, z] });
api.moveObject(uuid, { pos, rot, scale });              // the editor's replicated move
api.physics.set(uuid, { mode: 'dynamic', mass: 30 });   // setPhysicsFor write path
api.physics.createJoint('revolute', a, b, 'x', { vel: 0, maxForce: 120 });
api.physics.running();  api.isPlaying();  api.peerIds();
api.fireObjectClick(uuid);   // pulse On Click flow nodes (replicated nodetrigger)

api.flyTo(pos, lookAt);  api.playSound('pluck', pos);   // LOCAL — never replicated
api.followCam(uuid) / api.stopFollowCam();
api.isVR();  api.vrHand('left');  api.haptic(0.6, 60, 'right');
api.possess(uuid, { camera: 'first', eyeHeight: 1.7, mouseLook: true });
api.possessModes;   // capability probe — an unknown camera value degrades silently
```

Rules that fall out of it:

- **A peer's module must never move another peer's camera.** flyTo/followCam/
  playSound are local by design; if peers should agree, broadcast your own op.
- New api surface reaches app libs through **primed dynamic imports** in
  moduleSDK (addObjects/joints/objectActions/pingAudio join inputRuntime/physics/
  possess/vrControls) — a static edge closes a cycle back into history and
  TDZ-crashes the vite-dev SSR pass.
- **`userData.play` is a PUBLIC contract**, not dungeon-private: publish
  `{grid, width, height, minX, minY, rooms, floorValue}` on a scene-root group
  and core's `dungeonPlay.js` gives you play-mode collision, seed-deterministic
  spawns and the minimap for free.
- User modules **install, update, disable, remove and dev-reload LIVE**: every
  `api.register*` records an undo thunk and `deactivateModule(id)` runs the
  journal in reverse. If you add a register* surface, **add its disposal in the
  same edit** or a dev reload leaks it.

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
