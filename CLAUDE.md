# CLAUDE.md — theprototype.app

Collaborative peer-to-peer 3D prototyping app: SvelteKit (static adapter) + Svelte 5 +
Threlte 8 + three.js, peerjs mesh networking (no server beyond PeerJS signaling), a
node/flow editor (@xyflow/svelte 0.1.x) driving scene behavior, and a module SDK for
loadable play content. Everything a user does must be visible to connected peers.

## Architecture map

- `src/stores/` — `appStore` (UI panels, userdata, peers instance, toasts+action-toasts
  + notification center stores, modulesOpen), `sceneStore` (three refs: objectsGroup/
  TControls/camera/renderer, selection, locks, VR incl. vrFlying/vrSnapAngle),
  `flowStore` (#13-H flow v2: **`flowGraphs` keyed `'scene'|objectUuid` is the source
  of truth**; the legacy `flowNodes`/`flowEdges` are the ACTIVE graph's editor VIEW,
  kept in sync by the mirror that lives HERE in the leaf store — `history.js` imports
  `flowRuntime`, so the mirror can't sit behind a history-importing module; also
  `activeGraphId`, whole-world reads `allNodes()`/`allEdges()` (nodes get a
  runtime-only `__graph` tag), `findNodeAnyGraph`, `updateGraph`, restore/clear;
  plus cursors/customNodeDefs/scriptErrors/sync flags).
- `src/lib/peerHandler.svelte.js` — PeerConnection class; **all incoming messages**
  dispatch in `conn.on('data')`; `sendHandshake` fires **on connection open** and pushes
  locked/hosts/userdata/module versions/environment + requests full-state syncs
  (`getobjects/getnodes/getannotations/getmodulestate/getnodedefs`). #14 CN: the
  FIRST dispatch line is the open-core capability gate (`if (!canApply(...)) return`);
  `leaveSession()` closes every conn with explicit teardown (no `peer.destroy()` — the
  invite id stays valid); the constructor parses an invite `~srv` tail BEFORE creating
  the Peer (`applyInviteServerOverride`); `markPeerJoined`/`sessionHost` set on
  approval. `peer.connect()` returns undefined when the signaling link is down — all
  call sites guard it (dialing used to throw + strand the request).
- Open-core seams (#13 M1 + #14 PM, contract in committed `OPEN-CORE.md`): a closed
  cloud plugin loads via `VITE_CLOUD_PLUGIN`/`localStorage.cloudPluginUrl`
  (`cloudPlugin.js` → `register(cloudApi)`). `cloudHooks.js` (store-only, no cycles) =
  the seams: `canApply` capability gate (default allow; `ALWAYS_ALLOWED` protocol
  floor incl. `cloud`), `authProvider`, `sendCloud`/`onCloudMessage` (`{type:'cloud'}`
  channel), and mount stores `connectSlot`/`usersSlot`/`profileSlot`/`drawerSlot`
  rendered via `CloudSlot.svelte` (a `(el)=>cleanup` mount fn). cloudApi **v2**:
  +`mountProfile`/`mountConnectDrawer`/`connectToPeer`. Everything is INERT with no
  plugin — OSS behaves byte-identical. #14 cloudApi **v2.2** additions: `canApply`
  keeps an `ALWAYS_ALLOWED` FLOOR (hosts/userdata/cloud/locked/get*); `authProvider`
  autoaccept path now WHITELISTS + broadcasts the roster + DIALS BACK the joiner via
  `get(peers).connectToPeer` (a joiner only leaves "waiting for approval" on an
  INCOMING conn from the host — manual approve already dialed back, autoaccept did not
  → the join-stuck bug); `rolesInfo` store BRIDGE (the plugin publishes
  `{myId,myRole,amAdmin,order,roleOf(id),setRole(id,role)}` so CORE renders per-peer
  role controls + gates viewer actions) + `setRolesInfo`; `sessionHost()` accessor;
  `captureThumbnail(maxW)` (renders a fresh frame + reads the canvas synchronously →
  downscaled JPEG blob, null in VR — for cloud room thumbnails).
- `src/lib/objectPermissions.js` (#14, store-only) — viewer object permissions, ONLY
  active when a roles plugin publishes `rolesInfo` (OSS byte-unchanged): `canEditObject`
  (a viewer edits ONLY their own `__localOnly` objects), `markLocalOnly`/`clearLocalOnly`,
  `gateCreationBroadcast`, `isViewer`. GIZMO gate in `objectActions.applySelectionSet`
  (a viewer can select/inspect but not attach the transform gizmo to SHARED objects).
  `PeerConnection.send` runs `gateCreationBroadcast` — a viewer's object-CREATION
  broadcasts (create/light/group/object/objectfile/duplicate) mark the object
  `__localOnly` + skip the send (peers drop them anyway); `sendObject` handshake filters
  `__localOnly`. The `__localOnly` marker rides toJSON/GLTF extras like the existing
  `__uuid` marker. `LocalObjects.svelte` = a "Local objects" list section rendering local
  objects through the SAME recursive `Objects.svelte` tree (groups + drag); `showLocalObjects`
  store OFF by default + toggle under the object-list filter cog + auto-on via
  `markLocalOnly`; Share/Share-all broadcast toJSON + clear the flag; drop-to-local =
  viewer local COPY / editor delete-for-peers. `Objects.svelte` gained a local badge + Share.
- `src/lib/connectionState.js` (store-only) — `sessionHost` (peer that approved OUR
  outbound request; null = we host), `peerJoinedAt`, `resetSession`. Connect state
  derives from `$peers.openedPeers`, **NEVER `userdata.length`** (the roster is
  populated at DIAL time — trap). `peerApproval.js` = `requestConnect` (shared dial),
  `cancelOutboundRequest`, `approvePeer`/`denyPeer` (store-only so VR + cloudApi reach
  them without a peerHandler cycle).
- `src/components/menu/Connect.svelte` — a 3-state pill (`data-state`
  idle/pending/connected): idle dial + blue Connect; pending amber Cancel; connected
  green `Connected · <host>` + red Disconnect. A chevron toggles `ConnectInfoDrawer`
  (slide-down: Session/Server-with-ping+discovery/`drawerSlot` cloud mount). The
  always-on server indicator was removed (moved into the drawer; amber dot on the
  chevron when `peerServerStatus.didFallback`). `peerServer.js` also carries the
  invite `~srv` param helpers (`inviteServerParam`/`parseInviteHash`/
  `applyInviteServerOverride`, session-only, never falls back). #14 Connect UX
  redesign (`Connect.svelte`/`ConnectInfoDrawer.svelte`/`Toasts.svelte`): the chevron
  opens ONE tabbed drawer (Info/Rooms/Toasts) flush under the pill (pill squares its
  bottom corners when open), PINNABLE (`connectDrawerPinned` — tab bar stays when the
  body is collapsed); connection STATUS lives in the drawer tab-header, not the pill;
  the pill keeps a stable width via a gray disabled input showing the host
  ("Connected to <host>"/"Hosting"). Stores: `connectDrawerOpen`/`connectDrawerTab`/
  `connectDrawerPinned`/`toastsInDrawerOnly`/`showRoomsButton`/`showLocalObjects`.
  Toast ROUTING: viewport toasts hidden via CSS (timers keep running) when the drawer
  is open or `toastsInDrawerOnly`; the Toasts tab shows LIVE toasts; the bell keeps
  history. Toasts redesigned to `.tp-toast` professional cards (dark, close ✕,
  underline link actions, `autoDismiss` action). Roles UI: a per-peer role DROPDOWN in
  the Users popover next to Watch (via `rolesInfo`) + name tooltip + scrollable list;
  the connection-request toast is an on-scheme card (View only / Editor access / Reject).
- `src/lib/commandsHandler.svelte.js` — receive-side scene appliers + `sendObjects`
  (GLTF full sync; animated imports detour through `sendAnimatedImport` raw bytes).
- Domain modules in `src/lib/`: `objectActions`, `geometries.svelte.js`,
  `materialsHandler`, `meshEdit` (+VR handle drag; `tickMeshEdit` re-poses the WORLD-space
  handles when the object moves — scene-root handles don't follow for free), `faceEdit`
  (topology core: coplanar+adjacent tris = logical faces; extrude/inset/move/delete with
  OUTWARD-wound stitching; `meshgeo` full-geometry snapshots; VR rigid face-grab + live
  extrude adjust; 300-tri VR cap; desktop UI = MeshEditPopup), `history` (kind registry:
  create/delete/group/material/props/transformSet/verts/animimport/geometry/meshgeo;
  recording auto-muted while applying; 5 MB snapshot cap), `snapping`, `shortcuts`
  (registry = bindings AND Settings list),
  `flowRuntime` (per-frame tick over ALL graph documents; #13-H: an effect/physics/
  sound/onclick node inside an OBJECT graph with no Object Selector implicitly targets
  the graph's OWNER (explicit wiring wins); `graphInputs`/`graphOutputs` plumb embedded
  Object Flow nodes — scene values inject same-tick, outputs harvest at tick end for
  the NEXT tick (1-frame latency by design); multi-output values travel as a
  `__handles` map unwrapped by `sourceHandle`; `keypress` nodes pulse via replicated
  triggers (held keys re-stamp ~3/s); baseState rebase, suspend/resume for gizmo
  drags, `parkAnimatedAtBase` for serializers, module effects, script + sound nodes),
  `flowGraphs.js` (#13-H: object-flow LIFECYCLE — create/delete replicated as
  `graphcreate`/`graphdelete`, the `'flowgraph'` history kind restores a deleted
  document wholesale, `serializeGraphs` prunes orphans at SERIALIZATION ONLY so
  undoing an object delete finds its flow intact) + `objectFlow.js` (#13-H5:
  `interfaceOf` derives an embed's sockets from its Flow Input/Output nodes,
  `pruneObjectFlowEdges` = the applier-side invariant on interface changes,
  `removeEmbedsOf` on flow deletion, `addObjectFlowToScene` for the context menu),
  `soundRuntime` (sound-node panner chains, loop phase = synced clock), `scriptRuntime`
  + `customNodes` (replicated user node defs; #9: def range-params get input sockets,
  `pruneCustomNodeEdges` prunes across EVERY graph deterministically), `nodesHandler`
  + `nodeCatalog` (#13-H: every applier/sender takes the target `graphId` — absent =
  scene, legacy compat; the full-state `nodes` message carries a `graphs` map;
  hash/nodesync cover all graphs), `flowSockets` (typed socket coercion + colors;
  #9 `Socket.svelte` wraps the xyflow Handle and paints `typeColor` by socket type,
  `forceType` for data-declared types; #13-H: `resolvedInputType` folds in the H5
  cases — flow outputs are gray 'any', embed inputs take the referenced flow's
  declared vtype; `replaceableInputEdges` = single-connection VALUE inputs, a new
  wire replaces the old; effect/event inputs keep multi fan-in;
  audit + verdicts in committed `NODES.md`), `objectMenu` (#9: `buildObjectMenuItems` —
  ONE object context menu shared by Controls' direct menu + ViewportMenu's "Selected"
  submenu; #12: selection-aware — counted labels act on the SET, Group selection,
  Physics ▸ Weld/Hinge, Sculpt terrain), `moduleSDK` + `userModules` (zip/URL installs),
  `physics` (#12 rework: rapier steps as a flowRuntime **post-tick hook** —
  flow poses → kinematic targets → step → write-back; fixed-timestep accumulator
  (1/60, ≤8 substeps) so sim time tracks REAL time under throttled rAF; flow-animated
  objects = KINEMATIC bodies w/ slerp-interpolated substep targets; dynamics have
  sleep OFF + movement-gated broadcasts; drag/throw via holdBody/releaseBody; external
  writes detected by write-back DEVIATION → 250ms kinematic hold; hull colliders
  opt-in via userData.physics; Inspector Physics section; SimControls HUD + `P`) +
  `joints` (#12: replicated sceneJoints defs — weld/revolute+motor, OBJECT-local
  anchors → body-local at sim start, jointcreate/delete + getjoints handshake,
  'joint' history kind, sender-side delete cascade, sessions persist),
  `inputRuntime` (#12: store-only SDK input — key codes + VR axes published by
  vrControls, claims 'keys'/'locomotion' gate PointerLockControls/editorNavigation/
  VR stick; module bindings list in Settings), `possess` (#12: tank-controls drive of
  any object + chase/orbit camera; possessing = selecting; ONE undo per ride),
  `handModels` (#12: custom hand GLB = IDENTITY — hash on `handmodel` msg + handshake,
  assetShare pull, rigid-at-wrist render), `terrainSculpt` (#12: brush raise/lower/
  smooth/flatten over the meshgeo channel; weld by quantized (x,z) COLUMNS, rebuilt in
  the applyMeshGeo hook; one snapshot+undo per stroke; SculptToolbar pill),
  `sceneMusic` (#12: ONE shared background track, latest-wins `music` singleton —
  NOT piggybacked on environment; synced-clock loop offset; LOCAL volume/mute overlay),
  `shadowDefaults` (#12: objectsGroup-sweep sets cast/receiveShadow on every mesh;
  opt-out = userData.shadow=false) + `palette` (#12: paletteColorFor(uuid) deterministic
  default colors) + `viewMode` (#12: LOCAL Shaded/Shaded+AO/Wireframe;
  wireframe = scene.overrideMaterial, never per-material),
  `environment` (presets + scene-root rig, latest-wins sync,
  `passthroughActive` local sky lift; #12: sun casts w/ scene-fit frustum +
  env-shadow-catcher ShadowMaterial disc), `animatedImports` (raw-bytes objectfile sync),
  `prefabs` (local IndexedDB library), `explorer` (LOCAL asset library: IndexedDB index
  + per-item blobs, content hashes, thumbnails) + `explorerDrop` (drag-out placement/
  texturing) + `assetShare` (assetfile/getasset hash push+pull → 'Shared' folder) +
  `packs` (N6: Explorer Packs — libraryList defaults + manifest.json .zip imports,
  normalized; LOCAL library, only PLACED objects replicate; PACKS_BASE off-bundle CDN
  const; PACKS.md committed format) + `ModelPreview`/`ModelPreviewWindow` (N4: standalone
  three.js preview canvas + popup, `enable3dPreview`),
  `bottomDock` (Flow/Explorer tabbed dock), `lockControl` (request-control, peerColor),
  `networkQuality` (N6/D3: LOCAL per-peer getStats RTT + relay dot, median, NOT replicated),
  `drawMode`, `pathCapture`, `ping` + `pingAudio` (synth chimes, spatial), `voiceChat`
  (+spatial PannerNodes, VR PTT, setMicMode), `vrControls` (locomotion/teleport math,
  world pan, rigid grip grab, haptics, panel raycasts + the `executeVRMenuAction`
  dispatcher — namespaces panel:/props:/prefabs:/chat:/kbd:/face:) + `vrRadialMenu`
  (sector math, entry registry, ring nav STACK, controller-anchored pose) +
  `vrWindowPoses` (grip-hold window grab: anchor-relative persisted offsets; every VR
  follower panel poses through `applyWindowPose(group, id, anchor)`) + `vrPalette`
  (sRGB hue/sat disc math) + `vrKeyboard` (native key grid, one-shot shift buffer,
  `openVRKeyboard({initial, onCommit})` targets — reused by rename + chat),
  `dungeonPlay` (raster collision/spawns from the dungeon module's userData.play
  contract), `geometryEdit` + `geometryParams`, `lightParams` (+local shadow-quality
  caps), `cameraClip` (LOCAL near/far prefs; far pairs with orbit maxDistance so
  zooming out can't pass the far plane) + `sceneBounds` (radius sweep feeding it),
  `sceneAssets` (derived Scene manifest: audio/config/textures in use), `avatarModel`
  (avatar defaults, photo-card rule, per-shape hat anchors), `themes` (data-theme
  token blocks, local-only), `windowTabs` (+`closeGroup` = tab ✕ closes ALL members) +
  `windowFocus` + `docking` + `dragWindow` + `searchMenuUx` (floating-window system),
  `fileWindows` (floating text/image editor windows), `autosave` + `idb`,
  `annotationsHandler`, `sessions` (+ .zip export/import bundling scene assets via
  fflate; #9: the SAME bundle is the first-class **.tpscene** format — `exportSessionZip`
  takes `{assets,packs,flow}` include-opts, adds a `packs/` section; `fileHandler` saves/
  loads it, Sidebar Files = [GLTF | Scene | ⚙cog]), `measure`, `cameraBookmarks`,
  `editorNavigation`, `lightHelpers`.
- `src/modules/` — core modules (hello, button, dungeon, piano, pong; #12: avatar =
  possess-selected, essentials = 6 clickable interactables whose KIND derives from the
  replicated object NAME, car = jointed drivable demo w/ click-claim + drive-op
  forwarding) + `index.js` `coreModules` list; manager enables/disables (live enable,
  reload to disable).
- UI: `components/menu/*` (drawers/modals; visibility via stores + `hidePanels/
  restorePanels`), `components/editors/*` (flow editor + CodeMirror panels),
  `components/play/*` (player, avatars — photo = billboard card; the VR follower
  panels: Menu/ObjectsPanel/PropertiesPanel/ColorPalette/PrefabsPanel/Keyboard/
  ChatPanel/Stats — named `vr<x>-*` control meshes, all grip-grabbable),
  scene-overlay components (PingMarkers/PingHighlights (#12: uuid-carrying pings flash
  an object box)/PathWaypoints/LockHighlights), `SimControls`/`SculptToolbar` (#12:
  runes-mode HUD pills — the MobileAddButton "own file so onclick doesn't mix with
  on:" precedent), shared
  `ContextMenu.svelte` (caps to viewport + scrolls vertically when tall, never
  horizontally; per-submenu flip via left/right/top/bottom — no transform),
  `components/shared/WindowShell.svelte` (197: reusable window CHROME — collapsible/
  resizable/side-switchable primary sidebar + a multi-mode secondary panel that
  reflows opposite it; snippet slots topbar/primary/main/secondary; chrome-only,
  LOCAL prefs keyed `ws:<key>:*`; the Explorer is built on it, Flow is NOT — parity
  deferred).
- `tests/e2e/` — committed Playwright suites (`npm run e2e`, subset by name);
  `.cjs` because the package is `"type": "module"`.
- Docs (2026-07-24 split): SDK authoring docs live on the PUBLIC docs site
  (theprototype-docs: module-sdk.md + module-package.md); `MODULES.md` committed here.
  ALL planning docs live in the PRIVATE cloud repo (`theprototype-app/cloud` →
  `docs/plans-core/`, local `../theprototype.app-cloud`). This repo's `/docs` is
  gitignored scratch space (pointer READMEs inside).

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
   `sendObject` splits children, destroying rigs). Topology edits snapshot the FULL
   geometry (`meshgeo`, size-capped 45k floats) — receivers swap it wholesale, and
   the applier must REBUILD any live edit-session caches (applyMeshGeo re-derives face
   groups + the sculpt weld map; a stale cache after undo/remote swap bit us). Live
   gestures stream throttled previews (~5/s) and commit ONE final snapshot + undo entry.
   **Big numeric payloads travel as RAW BYTES** (`new Float32Array(arr).buffer`), never
   plain number arrays: binarypack recurses per element and a ~40k-number array throws
   "Maximum call stack size exceeded" — which `broadcast()`'s catch SWALLOWS, so the
   message silently never leaves (#12; large face-edits never replicated). applyMeshGeo
   normalizes plain array / ArrayBuffer / typed-array view.
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
   byteOffset..byteLength before hashing. #12: `connections[peerId]` may legitimately
   BE an adopted inbound conn (see the connect-dance gotcha) — it's still the stable
   channel; DataConnections are bidirectional and OUTGOING conns are wireData'd too.
10. Serializers (sendObjects, GLTF save, autosave, sessions) must
   `parkAnimatedAtBase()` first or receivers bake mid-swing poses as animation base;
   `restoreBase` calls `updateMatrix()` because toJSON/GLTF read the matrix
   the last RENDER composed.
11. **Viewer object permissions** (#14, cloud-roles only) go through
   `objectPermissions.js` — INERT unless a plugin publishes `rolesInfo`. A viewer's
   object-creation is not sent; the object is marked `__localOnly` (rides toJSON/GLTF
   extras like `__uuid`) and stays local until Share broadcasts its toJSON + clears the
   flag. Enforcement is send-side (`gateCreationBroadcast` in `PeerConnection.send` +
   `sendObject` handshake filter) AND a gizmo gate in `applySelectionSet` — never trust
   a viewer's bytes; peers also drop gated types via `canApply`.

## Hard-won gotchas (do not rediscover)

- **#14 file-shape traps**: many core files are **CRLF + tabs** — a node-script rewrite
  must DETECT the newline and match the exact tab depth (a wrong-depth "match" silently
  MISSES). Some components are `lang="ts"` (use TS param types), others are plain
  `<script>` (JSDoc `@param` — never TS syntax); any NEW .js/.ts must be clean
  (noImplicitAny). Icon-only buttons need `aria-label` (an a11y warning counts against
  the baseline). THREE object trees are **NOT reactive**: mutating `.children`/`.userData`
  needs `objectsGroup.update(v=>v)` to poke, AND rendered components must derive from
  `$objectsGroup` (or a keyed-each on the same ref won't re-render). svelte-check
  baseline is **485 errors / 72 warnings** — hold it.
- **Connection "connected" state = `$peers.openedPeers`, NOT `userdata.length`**:
  dialing whitelists the target in `userdata` at DIAL time (before approval), so a
  roster-length check shows a phantom peer while pending. `$peers` ticks
  (`peers.update`) on every open/close, so derive from `openedPeers` (#14 CN; the
  Users peers-trigger had this bug too).
- A fixed overlay anchored under the Connect pill can't use a `position:fixed`
  click-catcher sized to the viewport — `.connect-wrap`'s `translateX(-50%)` makes it
  the containing block for fixed descendants (the transform gotcha). Close the
  ConnectInfoDrawer on an outside click via a `<svelte:window onpointerdown>` listener
  instead (excluding the toggle). Svelte's `slide` transition animates height, not
  transform, so the pill's centering survives the slide.
- Headless e2e can't reach a signaling server (peer.open stays false, `peer.connect`
  returns undefined). To drive the dial state machine, stub it:
  `Object.defineProperty(p.peer,'open',{value:true}); p.peer.connect = (id)=>({peer:id,open:false,on(){},close(){},send(){}})`.
- Svelte 5 forbids mixing `on:click` and `onclick` **per component** — match the file's
  existing style. In a RUNES-mode file (any `$state`/`$derived`/`$effect`) use the
  attribute form `onclick`/`oninput`; the `on:` directive is deprecated there and each
  use adds a svelte-check WARNING that counts against the baseline (bit the 203 sidebar
  rewrite). Runes-mode files can't use `$:` — and adding ONE `$state` to a `$:` file
  flips it to runes mode and breaks the build. Never introduce `$state` into
  legacy-mode components.
- a11y warnings count against the baseline too. A `<div>` you make keyboard-focusable
  should use `tabindex="-1"` + programmatic `.focus()` (the `a11y_no_noninteractive_tabindex`
  rule only fires for tabindex `>= 0`; `.focus()` still works at -1). A container that
  needs click/drag listeners (grid background, tree drop-row) takes a targeted
  `<!-- svelte-ignore a11y_no_noninteractive_element_interactions a11y_no_static_element_interactions -->`
  (add `a11y_click_events_have_key_events` if it has `onclick` and no key handler).
  Adding `role="treeitem"`/`role="button"` etc. to dodge one warning can ADD others
  (treeitem then demands `aria-selected` + a tabindex) — prefer the ignore.
- Editing svelte files by exact-match is whitespace-sensitive; the files use TABS.
  When an Edit "String not found" repeats, `sed -n 'A,Bp' file | cat -A` shows tabs as
  `^I` — copy the exact indentation. Bare single-line substrings (no leading tab) are
  the safest anchor.
- `$effect` tracks EVERY store read synchronously inside it — side reads (userdata,
  globalScene…) retrigger it and can hit `effect_update_depth_exceeded`, which
  UNMOUNTS the app. Wrap one-shot side work in `untrack(() => …)` so the effect only
  depends on its trigger.
- No `bind:value` ping-pong with store round-trips — widgets render from data and write
  via handlers (`setNodeData`).
- Media elements: `muted`/`volume` set as properties in an action, not attributes.
- The Threlte Canvas wrapper swallows **pointerup AND pointermove** mid-gesture —
  put both on `window`; only `pointerdown` belongs on the canvas.
- Threlte `<T>` `oncreate` passes the ref **DIRECTLY** (`CreateEvent<T> = (ref) => void`),
  NOT wrapped: `oncreate={(ref) => …}`, never `oncreate={({ref}) => …}` (the destructure
  silently captures `undefined` — this stranded every annotation pin at the origin +
  killed PingMarkers' animations, N1/roadmap-7).
- WebXR hand joints: read them from threlte's `useHand('left'/'right')` store
  (`.current?.hand.joints[name]` — the SAME XRHand space it renders), keyed by
  HANDEDNESS. Raw `renderer.xr.getHand(SLOT).joints` by app slot index is unreliable (the
  tracked hand isn't necessarily at that slot). VR presence broadcasts joints wrist-local
  (rig-independent) + the wrist in the content frame; peers branch on `joints.length`
  (spheres vs the controller box).
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
  containing non-ASCII. Commit messages: **ASCII only** — a `▸`/em-dash inside a
  here-string can split it into a bogus git pathspec; no embedded double quotes either.
- CSS `transform` makes an element the containing block for `position: fixed`
  descendants — flipping the context menu with a transform mis-placed its fixed
  submenus. Menus/popovers that host fixed children flip with left/right/top/bottom
  only, never a transform. Context menus DO now cap to the viewport + scroll
  VERTICALLY (visible slim bar, `.ctx-scroll`) when too tall, but never horizontally
  (`overflow-x: hidden`); each submenu re-decides its flip locally in `openSubmenu`
  (not inherited from the root click) so deep chains stay on-screen. The fixed
  submenus escape the root's scroll box, so a scrolling root never grows an x-bar.
- `backdrop-filter`/`filter` ALSO make an element the containing block for
  `position: fixed` descendants (same trap as transform). A `fixed` popup rendered
  inside `.app-sidebar` (which has `backdrop-blur`) centered on the SIDEBAR and spilled
  off-screen — render such popups at the component ROOT, not inside a blurred/filtered
  ancestor (roadmap 9 export-settings bug).
- **z-index tiers** (`ui.css` `:root`): viewport 0 · drawer 30 · bottom 35 · window 40 ·
  hud 45 · **modal 1100 · toast 1200 · menu 1300**. The high modal/toast/menu values
  clear the ad-hoc persistent chrome that lives OUTSIDE the scale — Users (avatar/peers)
  ~996-998, Connect 300, ContextMenu 999-1001, ThemedSelect 9999. flowbite Modal
  hardcodes its dialog z-50 + backdrop z-40, remapped onto `--z-modal` by an UNLAYERED
  `[role='dialog'][aria-modal='true']` rule (unlayered beats Tailwind's layered utility
  without !important). The logo/burger menu sits at `--z-menu` (top-most); opening a
  modal from it calls `closeMenu.set(true)` so the menu can't cover the modal.
- **Mobile/touch** (roadmap 9): there is no `isMobile` store — gate with CSS
  `@media (pointer: coarse), (max-width: …)`. Touch has NO right-click and NO HTML5
  drag-and-drop: the canvas long-press opens the viewport menu (Scene) and a `+` HUD
  button (`MobileAddButton`, via the `viewportMenuOpener` store) does the same; the node
  palette adds on TAP (a real drag fires no click, so desktop drag is unaffected). Window
  drag/resize must use POINTER events, not mouse (object-list `dragMe` was the last mouse
  holdout). Floating windows clamp width/height to the viewport on load + on `resize`
  (Flow window) or their header buttons land off a narrow screen. Drag/resize handles
  need `touch-action: none`.
- **Responsive layout CSS-var bus (`fix/ui-polish-connect-settings`)** — chrome/drawers
  coordinate through custom props on `:root`, NOT hard-coded offsets: `--connect-bottom`
  (docked Connect bar height, published by Connect.svelte; side drawers tuck under it),
  `--controls-inset` (bottom Controls-HUD footprint on narrow; settings sheets bottom-clear
  it), `--dock-inset` (= `--controls-inset` only `≤500px`, else 0; docked Flow/Explorer
  content shrinks by it so its bg fills BEHIND the Controls while items stay above),
  `--bottom-inset` (docked Flow/Explorer height, for edge-docked windows). Plus a
  `.connect-docked` root CLASS (Connect toggles it) — side drawers cover the top-right
  chrome ONLY when set, else sit below the profile. Connect "docked" is JS-MEASURED (does
  the centred pill overlap the corner chrome?), not a fixed breakpoint — see
  `measureDock()`. Bottom-sheet mode (Inspector/NotesDrawer) is `≤640px` and its slide-UP
  transition must gate on that EXACT breakpoint, NOT the `≤820` `narrowDrawer` used for the
  floating-corner rounding, or the 641–820 side drawer wrongly slides up.
- **A floating/absolute element off the RIGHT or BOTTOM edge grows the document (scrollbars
  + shifts the centred Connect pill); off the LEFT/TOP does not** — hence `body,html {
  overflow:hidden }` in `routes/+page.svelte` (full-viewport app; panels/modals scroll
  internally). Do NOT also clip the canvas-wrapper `div` — it risked the WebXR canvas.
  dragWindow lets a window go partly off (keeps a ~52px grabbable strip, top never above
  its header) and re-clamps FULLY on-screen via an IntersectionObserver "reveal" when it's
  shown again (the object-list's own `dragMe` mirrors this).
- **`@threlte/xr` 1.0.0-next.15 crashes on XR session end/inputsourceschange** —
  `setup{Controllers,Hands}.js` read `data.handedness` / index `stores[handedness]`
  unguarded in BOTH the `dispatch` helper AND the connect/disconnect store writes (four
  sites). A Cardboard/gaze input's handedness isn't in `{left,right,none}` and the
  session-end disconnect has `event.data === undefined` → `Cannot read properties of
  undefined` aborts the WebXR teardown (dark-blue viewport, re-entry locked). Fix = the
  **`guardThrelteXr` Vite transform plugin in vite.config.ts** (guards all four accesses
  with `?.` at load time, dev + build). Do NOT patch node_modules for this: Vite caches
  the transformed module and a node_modules edit alone keeps serving the stale crashing
  copy (only a vite.config change forces the dev restart). The plugin also needs
  `optimizeDeps.exclude:['@threlte/xr']` so the dep is served as SOURCE (not esbuild
  pre-bundled, which the Rollup-style transform hook wouldn't touch). SEPARATELY, the
  dark viewport itself is Outline.svelte driving ALL rendering through the EffectComposer
  (autoRender off) — its passes target canvas-sized buffers, not the XR framebuffer, so
  in WebXR it must `renderer.render(scene, camera.current)` directly (composer resumes on
  desktop).
- THREE color management: `setHSL()` works in the LINEAR working space — pass
  `THREE.SRGBColorSpace` or lightness 0.5 hex-round-trips to `#bcbcbc`. Canvas
  ImageData palettes: write bytes straight from the sRGB hex (round-tripping through
  `Color` re-linearizes and darkens).
- Reference-space convention in vrControls: `getOffsetReferenceSpace` offset =
  **-(viewer displacement)**; snap-turn/teleport/world-pan math builds on it.
- Resolve a VR controller BY HANDEDNESS via `controllerIndexFor` (reads
  `controller.userData.handedness`, stamped from each `connected` event), NEVER the raw
  `session.inputSources` index — the slot↔handedness mapping flips on hands↔controllers
  and put the radial on the wrong hand (194). three's `getController(i)` slot order and
  the `inputSources` order DIVERGE after a swap (in-headset: slot0 in:right stamp:left):
  pose/ray/grabs resolve the slot by handedness, while buttons/axes read from the acting
  inputSource (`axesForSlot`). The squeeze loop, ALL follower panels, fly-aim and the
  peer-hand broadcast route through it (210). The trigger path is safe because it uses the
  firing controller (`event.target`); the reorder also drops in-progress grabs
  (`onInputSourcesChange`, 188).
- VR presence broadcasts in the shared CONTENT frame (worldRig-local, `worldToContentPose`)
  and peer avatars render back through the viewer's own rig (Player `peerFrame` mirrors
  worldRig) — so two-grip world-grab (which bends worldRig, not the camera) repositions you
  for peers (195). NO-OP when the rig is unbent, so desktop + normal-VR presence is
  byte-unchanged; change-detection also runs in the content frame (a grab leaves
  `camera.position` untouched). Reposition only — no scale on the wire.
- VR live face-adjust amount clamps are PER-OP: inset `[0.02,0.9]` (a signed `[-5,5]`
  let controller motion collapse it to ~0 and the confirm looked like a cancel, 192);
  extrude/move keep the signed range. A VR-created face winds toward a `viewerPos`
  (`createFaceFromVerts` — else it faces away and you see nothing, 191). VR Stretch =
  per-axis infinite sliders in the Edit▸Stretch menu (grab a `vrstretch-<axis>` handle,
  horizontal controller motion scales that axis), NOT a spatial gesture (193).
- Locks: `lockedObjects` holds REMOTE locks only — "we hold X" = X is our selection;
  one lock per peer (a new lock replaces the old one); `unlock` message exists.
- vite re-optimizes new deps on first page load (one reload) — rerun once; lazy wasm
  (rapier) needs a throwaway prewarm page in tests.
- Postprocessing composers (Outline) do NOT render in WebXR — VR indicators are
  scene-root shell/wireframe meshes that copy the selection's world transform per
  frame (never children of the object: they'd leak into GLTF sync).
- Module cycles: a static import that closes a loop back into `history` (via
  materialsHandler etc.) TDZ-crashes the SSR prerender — moduleSDK reaches optional
  libs (vrRadialMenu) via dynamic `import()` instead. `npm run build` (Rollup) can
  TOLERATE a cycle that `vite dev` (lazy ESM) TDZ-crashes — a green build ≠ a booting
  dev server; the dev 500 shows as the DOCUMENT returning 500 (stack only in the dev
  terminal). vrControls must NOT statically import peerHandler — put shared peer logic
  in a store-only module (peerApproval.js imports appStore only), 211.
- **The TDZ-cycle family around history.js**: `history.js` statically imports
  `flowRuntime`, so anything flowRuntime imports must not reach history/shortcuts
  statically — a flowRuntime → inputRuntime edge closed
  history→flowRuntime→inputRuntime→shortcuts→history and broke the SSR prerender
  with `Cannot access 'kindHandlers' before initialization` (#13-H3). Same cure as
  moduleSDK: PRIMED dynamic imports. Any module whose BODY calls
  `registerHistoryKind` (flowGraphs.js, joints.js) must never be reachable from
  history's own import subtree.
- **Node cards (flow editor)**: NodeWrapper's slot is a flex ROW — multiple sibling
  fields squeeze side-by-side into the ~150px card (three-letter inputs); wrap card
  content in ONE `flex w-full flex-col`. Its content div is also `relative p-3`, so
  absolutely-positioned Handles inside the slot anchor to the PADDED box, not the
  card edge — dynamic per-socket handles use per-ROW relative wrappers with `-mx-3
  px-3` (cancels the padding) + `style="top:50%"` so handles sit ON the card edge,
  centered on their label (ObjectFlowNode is the reference).
- **Autosave restore re-uuid'd every object** (GLTFLoader assigns new uuids on
  parse) — anything uuid-keyed silently orphaned (object flows, annotations).
  autosave now stamps `userData.__uuid` at export (GLTF extras round-trip it) and
  re-assigns originals in restoreSnapshot BEFORE adding/re-broadcasting. sessions.js
  never had this (toJSON/ObjectLoader keeps uuids). Any new GLTF round-trip needs
  the same stamp.
- `selectedObject` is `writable([])` and KEEPS the last object after deselect (the
  desktop outline relies on it) — "has selection" checks need `?.uuid`, and the
  init value is a truthy empty array. `deselectObject()` clears ONLY the
  `selectedObjects` SET — anything that must react to deselection (the flow editor's
  scope-follows-selection) watches the SET, never `selectedObject` (#13-H bit this).
- The Bash tool's `cd` leaks into the shared shell cwd — `Set-Location` back to the
  repo root before PowerShell git/npm calls.
- **Connect dance (#12 fix)**: the host CLOSES the joiner's original conn pre-approval;
  real WebRTC often never signals that close, and a fresh reopen can wedge mid-ICE —
  the JOINER could never send anything to the host. peerHandler now ADOPTS an open
  inbound conn as the send channel when the outgoing one is dead, wires the data
  dispatcher (`wireData`) on OUTGOING conns too (the remote may talk back over them),
  and `restoreConnection` retries with backoff after closing the stale conn first.
- **Physics ↔ rapier traps (#12)**: comparing quaternions with `dot()` reads |q|² —
  rapier's f32 components leave the norm ~1e-9 off unit, so "unchanged" looks like a
  deviation (compare COMPONENT-WISE). A kinematic platform moving UNDER a sleeping
  dynamic body never wakes it — dynamics run `setCanSleep(false)` + movement-gated
  broadcasts instead of `isSleeping()` gating. Kinematic substep targets must be
  SLERP-INTERPOLATED per substep: feeding only the end pose gives full velocity on
  substep 1 and zero after, so friction alternately drags and brakes (no net fling).
  Sim speed must come from a fixed-timestep ACCUMULATOR — a per-frame dt clamp runs
  slow-motion whenever rAF is throttled (background/headless tabs).
  #13-C3: rapier `JointData.revolute(a1, a2, axis)` takes ONE axis interpreted in
  BOTH bodies' LOCAL frames — every body must start WORLD-ALIGNED (identity rotation,
  initialQuat compensates) or a jointed rotated body hinges about the wrong axis and
  the solver LAUNCHES the assembly (the car's z-rotated wheel hulls, "car blows up").
  Hull colliders bake rotation into their vertices exactly like scale.
- Explorer `addItemFromBytes` TIME-BOXES its decorative thumbnail (Promise.race 4s) —
  a wedged/slow GLB parse on the receiver used to silently block storing SHARED bytes.
- Static-import cycle map grew in #12: objectActions now imports geometries
  (createGroup) and joints; multiTransform/objectMenu reach physics/terrainSculpt
  DYNAMICALLY; moduleSDK reaches inputRuntime/physics/possess via PRIMED dynamic
  imports (module-level refs resolved at boot). When adding an SDK capability, assume
  a static edge into moduleSDK's consumers closes a cycle (flowRuntime → moduleSDK).
- The dungeon module publishes gameplay data on its group's `userData.play`
  (grid/rooms/floorValue) — `dungeonPlay.js` consumes it; keep that contract stable.
- **Inspector.svelte is a plain `<script>` (NOT lang="ts")** — one TypeScript type
  annotation in it hard-breaks `npm run build` with a useless
  `error during build: undefined` (svelte-check never runs; vite dev 500s too).
  Same trap in any non-TS component: JSDoc for types, never TS syntax (#13-B3).

## Verification (mandatory before commit)

Follow `.claude/skills/e2e-verify/SKILL.md`. Short version: the suite lives in
`tests/e2e/` — `npm run e2e -- <name>` for the feature suite you add/update (every
feature phase ships one; update suites broken by UI changes in the same commit).
Two-peer tests meet on the SELF-HOSTED signaling box (peerjs.theprototype.app, the
docs/tf EC2 w/ discovery + /stats since #13-J) via `https://theprototype.app:5173`
(hosts-mapped). `npm run build` must pass; `npx svelte-check` must add no NEW errors.
**Parallel lanes**: concurrent sessions each use their own `git worktree`
(`../theprototype-lane-*`) + own dev server port (5174-5177) + `$env:APP_URL`
override for e2e — never share 5173 (the user's main-checkout server).

## Workflow preferences (user)

- One commit per phase/feature; message style: `[feat]/[fix] lowercase summary` + body
  bullets + `Co-Authored-By: Claude ... <noreply@anthropic.com>`.
- Plan documents live in the PRIVATE cloud repo: `../theprototype.app-cloud/docs/plans-core/`
  (versioned there — moved 2026-07-24; **never commit plans into THIS repo**).
  Postponed phases → `plans-core/pending/`; future ideas → `plans-core/backlog.md`;
  open design questions → `plans-core/quiz.md`. Keep `00-overview.md` tables in sync
  with every scope change. Historical `docs/plan/...` references below = the old
  in-repo path; those files are now under `plans-core/`.
- Roadmap ritual: user drops notes → ask 3-4 targeted AskUserQuestion forks (offer a
  recommended option — they usually take it) → write plan files → present the batch
  table (sizes S/M/L/XL, riskiest last) → they pick what executes.
- Design work: screenshot-driven. (Toasts/Connect/Controls were long "keep as-is" but
  roadmap #9 responsive/mobile work intentionally revised them — Connect is a
  pill on wide / full-width top bar on narrow, Controls corner buttons reflow, Toasts
  reposition on narrow; don't blanket-revert them anymore.)
- VR phases: verify math/state headlessly, state clearly that on-device feel is the
  user's manual check.
- Shipping flow (since 2026-07-20): branch-per-batch off `main` → one commit per
  phase → PR to main → MERGE-COMMIT merge (preserve phase history). Parallel batches
  run in git WORKTREES (`../theprototype-lane-*`, own dev-server port + APP_URL e2e).
- **Repos (org move 2026-07-21, github.com/theprototype-app)**: this repo =
  `theprototype-app/core` (origin updated); infra (the peerjs/TURN Terraform, was
  docs/tf) = `theprototype-app/infra` (own git repo, tfstate/tfvars/.env NEVER
  committed — state holds the TURN password); user docs = the theprototype-docs
  checkout; optional/community modules = `theprototype-app/modules` (local:
  `C:\Users\white\.code\AlexZ005\theprototype.app-modules` — one folder per module,
  zip-installable, flow-toolkit + untangle); PRIVATE cloud tier =
  `C:\Users\white\.code\AlexZ005\theprototype.app-cloud`
  (open-core: OSS ships only inert hooks — capability gate / auth hook /
  VITE_CLOUD_PLUGIN — cloud repo holds registration/rooms/roles; contract in its
  MAINTAINING.md).
- Status (2026-07-26): **Mobile/responsive UI polish — branch
  `fix/ui-polish-connect-settings` (off main, NOT PR'd yet).** A large ad-hoc pass, not a
  numbered roadmap batch. Landmarks: **Connect docking** — the centred pill MEASURES
  whether it would overlap the corner chrome (logo left / peers+profile right) and, when
  it would, snaps to a full-width top bar ("docked"); publishes `--connect-bottom` (bar
  height) + a `.connect-docked` root class + `connectDocked`/`connectBarHeight` stores;
  Rooms button hides when docked; the open drawer lifts above the chrome; the logo +
  top-right chrome drop below the docked bar. **Role pill** CSS was trapped inside a
  `@media(max-width:640)` block (unstyled at normal widths — the screenshot bug); moved
  out + the role menu is PORTALED to `<body>` (peers-list overflow clipped it).
  **Settings** = a `SettingRow` component: aligned 3-column grid **name | control |
  description** on wide (grid `order`/explicit column so the DOM order stays control-first
  for the mobile stack), centred stack on narrow, multi-input rows split per line. A
  SHARED `.tp-modal-*` treatment (ui.css) gives Settings/Sessions/Modules full-screen on
  narrow (fill BELOW Connect via `--connect-bottom`, header title padded 62px to clear the
  logo, SINGLE flowbite-body scroller — the old inner `modal-content` overflow was the
  double-scrollbar). **Bottom sheets**: scene notes (`NotesDrawer`) + object/mesh/scene
  properties (`Inspector`) become bottom sheets on `≤640` (slide UP, top drag-handle to
  resize, `max-height` keeps the top below Connect+chrome, bg extends behind the Controls
  HUD with content padded above it); ONE sheet open at a time (mutual close); as SIDE
  drawers they cover the top-right chrome ONLY when `.connect-docked` (else stay below the
  profile). **Floating windows** may be shoved partly off-screen (a grabbable strip stays)
  and snap fully on when reopened (dragWindow IntersectionObserver reveal + object-list
  dragMe); clamp below the Connect pill; `body,html { overflow:hidden }` stops an
  off-the-RIGHT window growing the document (left never did). **Docked Flow/Explorer**
  content insets above the Controls only on FOLDED screens (`--dock-inset` = full
  `--controls-inset` at `≤500`, else 0; Flow gated on `paletteOpen` via a bound prop).
  **Logo click** now closes any open modal AND opens the menu in one step (deferred past
  the modal's `restorePanels` with `tick()` so the menu no longer flickers). **Cardboard
  crash** — `@threlte/xr`'s controller/hand disconnect+connect handlers do
  `stores[handedness].set(...)` unguarded; a gaze/Cardboard handedness misses the
  {left,right,none} keys → `Cannot read properties of undefined (reading 'set')` aborts
  the XR teardown (dark-blue viewport, re-entry locked). Fixed by the `guardThrelteXr`
  Vite transform plugin (vite.config.ts) guarding all four `handedness` sites at load
  time + `optimizeDeps.exclude:['@threlte/xr']` (serve as source) + Outline.svelte
  rendering directly through the XR cameras (the composer can't target the XR
  framebuffer → `glBlitFramebuffer` / dark viewport). Also: Modules Core/User = real tabs,
  notifications panel pinned on narrow, CharacterModal/ThemedSelect dropdown alignment,
  ContextMenu raised above the toast tier, `mobileUndockAllowed` setting. svelte-check
  held **485/72** throughout.
- Status (2026-07-25): **Roadmap #14 continuing — open-core cloud MATURED.** cloudApi
  now **v2.2**: capability gate w/ `ALWAYS_ALLOWED` floor, autoaccept dial-back +
  roster broadcast (fixes join-stuck), `rolesInfo` bridge + `setRolesInfo`,
  `sessionHost()`, `captureThumbnail(maxW)`. NEW `objectPermissions.js` (viewer
  __localOnly objects, gizmo/creation gates, LocalObjects.svelte list) — INERT without
  a roles plugin. Connect UX redesign: one PINNABLE tabbed drawer (Info/Rooms/Toasts)
  flush under a stable-width pill; `.tp-toast` cards; per-peer role dropdown in Users.
  Cloud plugin (`theprototype-app/cloud`): PocketBase self-hosted at
  `pb.theprototype.app`, roles.js/rooms.js/account.js. svelte-check core **485/72**
  (new baseline — hold it).
- Status (2026-07-24): **Roadmap #14 (Connect UX + open-core cloud) IN FLIGHT.**
  MERGED to core main: #38 M1 open-core seams, #39 docs-migration pointers (plans →
  private cloud repo, SDK docs → public site), #40 **CN** (Connect 3-state pill +
  ConnectInfoDrawer chevron/slide + `sessionHost`/`leaveSession`/cancel + invite
  `~srv`). OPEN: core **PR #41 PM** (cloudApi v2 mountProfile/mountConnectDrawer/
  connectToPeer + `requestConnect` + Users dropdown restructure keeping the 1.5rem
  corner). Cloud repo (`theprototype-app/cloud`): #1-#4 merged (login/roles/deploy/
  docs), **PR #5 = PM-cloud + SUB + RM** (login → profile dropdown; feature-updates
  opt-in + `/privacy`; **rooms** — PocketBase `rooms`, opt-in listing, Browse +
  host-settings drawer, auto-accept-viewers). PocketBase = orange-room.pockethost.io
  (GitHub+Google OAuth confirmed working). PROD at **theprototype.pages.dev** (Cloudflare
  Pages; `npm run deploy` in the cloud repo, guide in its README). USER must add in PB
  admin: `rooms` collection + `users.featureUpdates`/`featureUpdatesConsentAt`.
  svelte-check core 495/76. NEXT: RM-2 room thumbnails; rooms-access-control
  (password/knock, plan written).
  --- Earlier — Status (2026-07-22): **Batch H (flow v2) MERGED to main = PR #36** — TRUE
  per-object graph documents (H1), object-flows-as-scene-nodes w/ Flow Input/Output
  declared sockets (H5), api.registerNodeDefs (H2), Key Press trigger node (H3), plus
  user-driven follow-ups: scope-follows-the-selectedObjects-SET deselect fix, the
  autosave uuid-preservation fix (pre-existing: GLTF restore re-uuid'd objects and
  orphaned annotations too), Object Flow card labeled stretching sockets +
  dblclick-opens-flow, FlowIONode column layout + type-aware fallbacks (type change
  resets fallback), gray any-type flow-output sockets, wired params render the LIVE
  incoming value instead of their slider (flowValues lookup — free), single-connection
  value inputs w/ replace-on-connect (effect/event inputs keep multi fan-in), and
  self-embed blocked in the Object Flow picker (cycles can't hang — 1-frame latency +
  path guards — but a self-feedback card is confusing). **PR #37 MERGED**:
  api.pointerRay. **190 untangle SHIPPED as-built** in theprototype-app/modules
  (plan → done/190, deps rewritten: no synth API needed — modules use WebAudio
  directly; the grab hook became pointerRay); verified via a scratch playwright
  test-flight ALL 8 PASS incl. REAL manager zip install (Modules ▸ User tab ▸
  `#install-module-zip` + setInputFiles) and real mouse pick/carry/drop. Suites:
  flow-object-graphs(20)/flow-object-embed(14)/flow-input-moddefs(7)/
  autosave-object-flows(6)/sdk-pointer-ray(4). svelte-check now **499/77** (new
  baseline — hold it). PRs OPEN (user checking): #33 I UI-fixes, #34 D VR-fix-pack.
  REMAINING in this lane: H4 car-as-nodes (after #33/#34 land, VR lane continues
  F → K). path-node's patrol-drift e2e failure is a PRE-EXISTING machine-saturation
  flake (reproduces on main).
  --- Earlier — Status (2026-07-21): **Roadmap #13 IN FLIGHT** — plan docs/plan/
  roadmap-13-rooms-graphs-polish.md. MERGED to main: #28 (roadmaps 10+11 AI),
  #29 (roadmap 12), #30 A UI-chrome, #31 B viewport/camera (default FOV 40, N8AO
  HiDPI ghost fix, grid fade scales), #32 E notification center (notifications/
  notificationsUnread/notificationCenterOpen stores + NotificationCenter.svelte,
  toast z-split: approvals ABOVE modals in .toasts-critical, info below at
  --z-toast-low) + notes drawer (notesDrawerOpen + NotesDrawer.svelte), #35 C
  physics/car (C1 listPhysicsObjects Inspector list, C2 angularvelocity/motor nodes
  + applyTorqueImpulse + LIVE mid-sim re-apply, C3 car play-gate + chase cam via
  possess startFollowCam + world-aligned-hull joint fix). PRs OPEN (user checking):
  #33 I UI-fixes, #34 D VR-fix-pack. J SHIPPED (self-hosted peerjs box: discovery +
  SQLite /stats). L done (docs repo). NEXT: batch H (flow v2 TRUE per-object graphs
  + H5 object-flows-as-scene-nodes, pending/flow-v2-object-graphs.md) in
  ../theprototype-lane-flow @5177; VR lane continues F (AI cockpit) → K (sleeve);
  M (open-core hooks) AFTER H (both touch the peerHandler dispatch).
  --- Earlier — Status (2026-07-20): **Roadmap #12 "playground & polish" SHIPPED — ALL 19 phases**
  on `feature/playground-polish` (off ai-scene-assistant; NOT merged). Opus set (11):
  V-1 shadows-by-default + catcher, V-3 palette (kills 0x00ff00) + look tune, T-1
  Add▸Terrain, U-2 multi-select menu (groupSelection one-undo, multi prefab/delete,
  desktop Ungroup), U-1 ping v2 (uuid object-highlight + radial Ping), R-2 VR
  snap-angle unify + live labels, R-1 VR beam+reticle+hover shell, M-2 audio-pack
  install + sound rolloff, M-1 sceneMusic singleton, V-2 N8AO + viewModes, U-3 toast
  dedupe/cap + settings search. Fable set (8): P-A physics rework (post-tick hook,
  kinematic flow bodies, accumulator, deviation holds, hulls, Inspector Physics,
  SimControls), K-C SDK inputRuntime + claims + api.physics, P-B joints
  (weld/hinge/motors + menu + sessions), K-D possess + avatar module, K-E essentials
  (6 interactables), R-3 hand models (capsule style + GLB identity), T-2 terrain
  sculpt (weld columns + smooth normals + SculptToolbar), K-F drivable car
  (click-claim + drive-op forwarding; ~14m in e2e). THREE deep pre-existing bugs
  fixed: joiner-cannot-send-to-host (adopted inbound conn), meshgeo big-array
  binarypack stack overflow (raw-bytes wire format), Explorer thumbnail hang blocking
  shared bytes. svelte-check ended **501/77** (new baseline — hold it). Plan:
  docs/plan/roadmap-12-playground-polish.md (per-phase hashes). Backlog'd: articulated
  hand retargeting, steered knuckles, VR sculpt, joint-clone-on-duplicate.
  --- Earlier — Status (2026-07-18): **Roadmap #9 SHIPPED** (release runway). B2 VR: 120Hz
  (session.updateTargetFrameRate off supportedFrameRates on session start; vrTargetHz
  setting) + hands↔controllers switch fix (shouldSendHands forces a send on rep-flip —
  the `!moved && !hasJoints` gate ate the switch-back) + cuboid peer hands
  (handBoneSegments; peerHandStyle LOCAL pref) + pinch-hold radial opener. B3 **.tpscene**
  = the session .zip promoted to a first-class Scene format (exportSessionZip gains
  {assets,packs,flow}; Sidebar Files = [GLTF | Scene | ⚙cog], JSON demoted behind the
  cog; fileHandler load/save). B4 **flow stage 1**: NODES.md audit (fixed edge-id
  divergence — ids now include handles; PATH-based cycle guard; event→effect drag;
  distance/proximity accept vector3 literals) + typed socket COLORS (Socket.svelte wraps
  Handle, paints flowSockets.typeColor) + ⓘ/⚙ panel tabs (ⓘ = selected node params, ⚙ =
  graph + node name/NOTE) + adjustable params (slider min/max, switcher items list +
  index output, number step) + custom-node input sockets w/ deterministic
  pruneCustomNodeEdges + new nodes maprange/select. B6 docs → theprototype-docs (MkDocs,
  local). **B1 (Opus)**: packs-view .zip drop (non-zip rejected), GLTF export
  selection-only + warning. **UI/mobile (Opus)**: z-tiers reworked (see gotcha), mobile
  "+" HUD + canvas long-press open the viewport menu (viewportMenuOpener), shared object
  menu (objectMenu.js buildObjectMenuItems used by Controls + ViewportMenu "Selected"
  submenu), Controls reflow, left-dock insets past the sidebar, top-bar responsive,
  context menus now cap+scroll vertically w/ per-submenu flip, Flow window clamps to
  viewport, node palette add-on-tap. **B5 network stress SKIPPED** (pending/). svelte-check
  502/77. Plans: docs/plan/roadmap-9-release-runway.md (+ pending/opus-b1, pending/b5).
  --- Earlier — Status (2026-07-15): **Roadmap #7 SHIPPED** (order N1→N3→N4→N6→N5): N1 notes-anchor
  fix (Threlte `oncreate` passes the ref DIRECTLY — `({ref})` captured undefined so NO
  annotation pin was ever positioned; fixed capture + owner-from-both-stores; same bug
  in PingMarkers), N3 per-peer network-quality dot (networkQuality.js, LOCAL getStats
  RTT+relay, median; Users popover + VR stats), N4 Explorer 3D model preview
  (enable3dPreview toggle; ModelPreview canvas inline + ModelPreviewWindow popup w/
  tris/verts), N6 packs off-bundle + Explorer UI (packs.js normalizes libraryList
  defaults + manifest.json .zip imports; LOCAL library; PACKS.md format; PACKS_BASE
  awaits real GitHub URLs), N5 articulated peer hands (read joints from threlte
  `useHand` spaces by handedness, broadcast wrist-local; box fallback — on-device hand
  capture still flaky, user debugging). N2 node-palette DROPPED. svelte-check ~501/77.
  Plan: docs/plan/roadmap-7-vr-explorer-net.md. --- Earlier: batches 1-61 SHIPPED
  (roadmaps #2/#3/#4 done); roadmap #5 —
  batch 63 (191/192/193) + 194+210 (controller handedness) + 195 (world-grab presence) +
  196 (noVR inset) + 203 (sidebar) + 197/198 (Explorer window v-next: WindowShell chrome).
  **Roadmap #6 (211-220) ALL SHIPPED**: 211 VR peer approve/deny (VRPeerApprove follower +
  peerApproval.js store-only to dodge a peerHandler import cycle), 212 face polygon-select +
  multiselect (faceEdit granularity/multi + opTargetFace synth; VR menu + desktop popup),
  213 VR mesh-edit undo (audit-only + regression test — already correct), 214 VR Tools radial
  submenu (Select/BoxSelect/Draw) + 3D box-select marquee (vrToolMode + selectObjectsInBox +
  scene-root visual), 215 VR objects-panel expandable groups (flattenPanelRows), 216 VR group
  Ungroup in Edit radial, 217-220 Explorer/editor polish. **Remaining: 199 Packs + 207-209
  (.tpscene/.tpmodule) POSTPONED (docs/plan/pending/).** Deferred → docs/plan/pending/: flow
  revamp (199-202/204-205), physics (206), module test-flight (189/190), Explorer tree v3
  (140-142). svelte-check baseline 502 errors / 77 warnings (hold it). Forks in quiz.md;
  per-phase plans in docs/plan/done/.

## Module SDK (implemented — extend, don't fork)

`src/modules/<id>/module.js` default-exports `{id, name, version, description,
register(api)}`. api surface: registerNodeGroup (+custom components), registerEffect
(base-managed per-frame), registerPrimitive (replicated `/create`), registerClickHandler
(desktop+VR), registerInteractiveGroup (scene-root click targets), registerFrameTask,
send/onMessage (namespaced `{type:'module', moduleId}`), registerStateSync (late-joiner
handshake), registerMenu (manager card buttons), registerVRMenuEntry,
scene/objectsGroup/peerId/toast/now/THREE/assetUrl/selectedUuid. #12 additions:
**input** — registerBindings (lists in Settings ▸ Shortcuts), input() per-frame
snapshot {codes, axes, vrButtons}, onInput down/up events, claimInput/releaseInput
('keys'|'locomotion' pause the host's own consumers); **physics** —
api.physics.{isInitiator, applyImpulse, setJointMotor, joints()} (mutations are
INITIATOR-ONLY: forward inputs via api.send and let the stepping peer apply — the car
module is the worked recipe, pong's paddle pattern); **possess/releasePossess**
(tank-controls drive + follow camera; possessing = selecting). #13 additions:
**registerNodeDefs(defs)** (H2) — ship CODE-EDITABLE nodes: each {key, name, params,
code} lands in the replicated customNodeDefs store as `mod-<moduleId>-<key>`
(NodeDesigner-editable; seeding is ABSENT-ONLY so user edits survive reloads);
**pointerRay()** (190/PR#37) — a world-space THREE.Raycaster for wherever the user
points (desktop mouse NDC / VR pointer hand via vrControls.pointerHandRay,
handedness-resolved; FRESH instance per call; null before the first pointer event);
the drag recipe = click to pick → follow pointerRay() in a frame task → click to
drop. A module KIND that must agree across peers derives from the replicated object
NAME, never locally-set userData (essentials + car). User modules (zip/URL via the
manager) must be self-contained — no imports; guide in `MODULES.md` + the public
docs site (module-sdk.md / module-package.md).
OPTIONAL/community modules live in the separate `theprototype-app/modules` monorepo
(local: `C:\Users\white\.code\AlexZ005\theprototype.app-modules`; one folder per
module + zip recipe; `flow-toolkit` = registerNodeDefs reference, `untangle` = the
190 game test-flight: seed-deterministic solvable puzzles, pointerRay drag, throttled
drag previews + authoritative move, LOCKSTEP win/level advance with NO win message —
same positions → same result on every peer). Script nodes run arbitrary replicated
code deterministically (pure function of object/base/data/time) — never stream
outputs.
