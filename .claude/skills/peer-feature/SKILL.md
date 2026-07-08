---
name: peer-feature
description: Checklist and patterns for adding a replicated feature or a loadable module/addon to theprototype.app — message types, handshake sync, catalogs as the plugin surface, and code-node scripting rules.
---

# Adding a replicated feature (or module) to theprototype.app

Everything users do must be visible to connected peers. Follow this checklist; every
pattern named here already exists in the codebase — copy the referenced implementation.

## Checklist for a new replicated feature

1. **State** in a store (`src/stores/*`) or module-level writable; keep entities
   uuid/id-keyed and plain-serializable (peerjs binarypack: no class instances, no
   functions, no undefined-heavy shapes).
2. **Local mutation function** that applies the change AND broadcasts:
   `get(peers)?.send({ type: 'mything', ... })` — pattern: `annotationsHandler.setAnnotation`.
3. **Receive case** in `peerHandler.svelte.js` `conn.on('data')` chain calling an applier
   that does NOT re-broadcast (no echo loops).
4. **Late joiners**: a `getmything` request added to `sendHandshake()` + a full-state reply
   that retries until `conn.open` — copy `sendNodes`/`sendAnnotations` (never bare
   `setTimeout` sends: peerjs silently drops pre-open messages).
5. **Cleanup** on peer loss in `commandsHandler.handleDisconnected`.
6. **Undo** (if it mutates the scene): register a kind via
   `history.registerHistoryKind(kind, apply)` — see `meshEdit`'s `verts` kind; the applier
   re-broadcasts so undo replicates.
7. **UI entry points**: viewport menu (`ViewportMenu.svelte` items array), object-list
   context menu (`Controls.svelte objectMenuItems`), shortcuts registry
   (`shortcuts.js` — one registry drives bindings AND the Settings list), VR quick-menu
   (`vrControls.executeVRMenuAction` + `VRMenu.svelte` tiles).
8. **Verify two-peer** per `.claude/skills/e2e-verify/SKILL.md`, then commit as one
   `[feat] ...` commit.

Throttle continuous streams (~10–20/s) with a final unthrottled state on gesture end
(`move` broadcasts, `verts`, `flowcursor` are the reference implementations).

## Modules / addons (the agreed direction)

Loadable "play" content — 3D instruments/synths, game prototypes, design/animation
examples — plus user scripting. Build on the existing plugin surfaces instead of new ones:

- **Manifest**: `{ id, name, version, entry }`, lazy `import()` on load. A module's entry
  registers into: `nodeCatalog` (new node types — the flow editor renders params via the
  generic AnimationNode pattern), `primitivesCatalog` (creatable objects; custom geometry
  builders go through `customGeometryBuilders` so the replicated `/create` string works on
  every peer), `flowRuntime` (per-frame behaviors reading the node graph), and menu items.
- **Version trust**: peers must run the same modules — advertise `[{id, version}]` in the
  connection handshake (extend `userdata` or a `modules` message) and toast on mismatch.
  This mirrors the existing same-app-version assumption of the node catalog.
- **Module state**: namespaced messages `{ type: 'module', moduleId, ... }` + a
  `getmodulestate` handshake reply, same rules as any feature above. Prefer storing module
  state IN nodes/objects (then sync is already done) over side-channels.
- **Code nodes / scripts**: a `script` node type whose `data.code` replicates through the
  existing `nodedata` path. Execution must be **deterministic per peer**: sandboxed
  `Function`/worker with a small safe API (object lookup by uuid, transforms, material
  params, the synced wall-clock time from `flowRuntime`) — every peer runs the same code
  over the same graph and converges; never stream script *outputs*. Editing the code is
  just editing node data, so peers see edits live like any slider.
- **Interactivity**: peers interact by manipulating the same replicated nodes/objects the
  module reads — if the module needs input, model it as a node or an object property.
