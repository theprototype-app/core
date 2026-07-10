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
  others just apply. References: physics (initiator → `move` at ~10 Hz per awake body,
  busy-guard message), pong (spawner owns the ball at ~12 Hz). Use when simulation
  can't be deterministic; guard against two authorities.

## Checklist for a new replicated feature

1. **State** in a store (`src/stores/*`) or module-level writable; uuid/id-keyed,
   plain-serializable (peerjs binarypack: ArrayBuffers OK — raw-bytes syncs like
   `objectfile` ride on this; no class instances/functions).
2. **Local mutation function** applies + broadcasts:
   `get(peers)?.send({ type: 'mything', ... })` (pattern: `annotationsHandler`).
3. **Receive case** in `peerHandler.svelte.js` `conn.on('data')` — applier does NOT
   re-broadcast.
4. **Late joiners**: `getmything` request in `sendHandshake()` + a full-state reply
   that retries until `conn.open` (`sendNodes`/`sendNodeDefs`/`sendModuleStates` —
   never bare `setTimeout` sends: peerjs silently drops pre-open messages). Singleton
   state (environment) instead pushes with a `changedAt` stamp, latest-wins — and any
   symmetric pull needs a deterministic direction (nodesync: lower count pulls,
   peer-id tiebreak) or drifted peers swap forever.
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

Throttle continuous streams (~10–20/s) with a final unthrottled send on gesture end
(`move`, `verts`, `flowcursor`, `drawlive` are references); temp visuals for other
peers get stale-expiry cleanup (`drawlive` 5s, ping 4s).

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
(renders on the module's manager card), accessors `scene() objectsGroup() peerId()
toast() now() THREE assetUrl(path)`.

Version trust: peers exchange `[{id, version}]` on connect and toast on mismatch
(advisory). Module viewport content = scene-root group rebuilt from state (see rule 5);
prefer storing module state in nodes/objects (sync already done) over side-channels.

**Script/code nodes** exist (`scriptRuntime`, Script node + replicated custom node
defs via `customNodes` + `getnodedefs` handshake): `data.code` replicates like any
node data; execution is a deterministic pure function of `(object, base, data, time)`
per peer — never stream script outputs; errors badge the node and toast once.
