# CLAUDE.md — theprototype.app

Collaborative peer-to-peer 3D prototyping app: SvelteKit (static adapter) + Svelte 5 +
Threlte 8 + three.js, peerjs mesh networking (no server beyond PeerJS signaling), a
node/flow editor (@xyflow/svelte 0.1.x) driving scene behavior, and a module SDK for
loadable play content. Everything a user does must be visible to connected peers.

## Architecture map

- `src/stores/` — `appStore` (UI panels + `openSceneSection(label)`/`inspectorScrollTo`
  = the Configure-Scene DEEP LINK seam, userdata, peers instance, toasts+action-toasts
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
  handles when the object moves — scene-root handles don't follow for free; CL-B Weld
  merges the ctrl-multi-selection to its centroid as ONE meshgeo undo entry — a 'verts'
  entry can't hold per-handle befores), `faceEdit`
  (topology core: coplanar+adjacent tris = logical faces; extrude/inset/move/delete with
  OUTWARD-wound stitching + CL-B subdivide/flip/BRIDGE (two multi-selected faces:
  ordered boundary loops, equal-count gate, closest-pair anchor + untwist direction
  pick, outward-wound walls); the MOVE gizmo
  seats ONLY while Move is the armed op — a seated gizmo intercepted the next click
  and rigid-moved the face instead of applying the armed inset (the CL-B inset fix);
  shared edit WIREFRAME overlay (`buildEditWireframe` + `meshEditWireframe` local
  pref, honored by BOTH modes, rebuilt on every geometry swap);
  `registerEditProxy`/`lookupEditable` let the edit tools run on a SCENE-ROOT proxy
  (collider editing — replicated edit messages no-op on peers); `meshgeo`
  full-geometry snapshots; VR rigid face-grab + live extrude adjust; user-editable VR
  caps.
  **The mesh is a triangle SOUP with no stored face topology** — everything below is
  DERIVED per rebuild (`rebuildFaces`), which is the root cause of several "bugs":
  an extrusion wall is coplanar+adjacent with the flat side beneath it so `groupFaces`
  MERGES them (Face granularity can't isolate the band — that is why Quad exists), and
  a quad's internal DIAGONAL is a triangulation artifact, not an edge of the model.
  Per-triangle tags ride as properties on the tri array (`withSlot`): `mi` = material
  SLOT (15-G) and `uv` = per-corner texture coords (M1); every op that clones/maps/
  splits tris must carry them, and `trisToGroups`/`trisToUVs` return NULL for the
  single-material / untextured case so it stays byte-identical.
  Granularity **Quad**(default)/Face/Triangle/Shell/Object — `pairQuads` pairs coplanar
  co-facing neighbours whose quad is CONVEX, greedy best-first by squareness with
  index tie-breaks (deterministic); legacy 'polygon' migrates to 'triangle', NOT quad.
  M2 loop select + grow/shrink + all/invert/linked (`buildQuadTopology` = each quad's 4
  edges in ring order + an edge→quads map; a quad lies on TWO loops so a repeat press
  cycles the axis). M3 `commitLoopCut` (the ring walk with direction — flanking quads
  keep their full edge, a T-junction, same tradeoff `subdivideFaceTris` documents).
  M4 EDGES are a SUB-MODE of the face session (`faceEditSubmode`), not a third session
  kind — lifecycle/undo barrier/wireframe/VR entry are all inherited; an edge is its
  canonical welded key pair; `pickEdgeAt` takes the NEAREST edge and SKIPS quad
  diagonals; `dissolveEdges` merges the two QUADS either side and fan-triangulates
  their boundary from a corner that isn't an endpoint (so the edge can't reappear).
  Edge **LOOP** (`edgeLoopChain`) and edge **RING** (`edgeLoopKeys`) are DIFFERENT
  commands and were originally conflated: LOOP is the chain walk (continue to the edge
  sharing no face with the current one, which only exists at a valence-4 vertex, so it
  stops at poles), RING is the parallel rungs a face loop crosses. On a bare cube every
  vertex is a pole, so Loop = the picked edge and Ring = the band; on a SUBDIVIDED face
  Ring is the INNER grid edges — which is what made the conflation look broken.
  The armed op DEFAULTS TO 'move': auto-apply commits the armed op on a plain click, so
  extrude-by-default turned every face click into an extrusion. Selection and HOVER are
  separate overlay meshes (`face-edit-overlay` / `face-edit-hover`) — one shared tint
  made a just-deselected face look selected while the cursor rested on it. Selection
  commands + Ctrl+A/Ctrl+I exist in ALL THREE modes (`selectAllEdges`/`selectAllVerts`
  and their inverts), and 1/2/3 switch element mode inside a session (outside one they
  stay the gizmo transform modes). `cancelEditSession` reverts the WHOLE session from an
  entry-time snapshot — `sealEditHistorySession('discard')` only drops undo entries and
  leaves the geometry edited. Bridge pairs its loops by ANGLE around their centres in
  one basis perpendicular to the tunnel axis (the old closest-vertex anchor + direction
  vote was tie-sensitive between aligned caps, and a one-step rotation = a skewed tunnel).
  M6 `recalculateNormals` (signed volume per shell), `mergeByDistance` (quantized-grid
  clusters, deterministic), `setShadingSmooth` (userData.shading, replicates as just
  the FLAG, re-applied by applyMeshGeo). A CLOSED region has no border, so extrude
  degenerates to a translate — refused with an explanation (that is also what
  Shell/Object granularity means for extrude). `stashSelections`/`restoreSelection`
  keep a per-mode pick across mode switches, invalidated by a geometry SIGNATURE.
  Desktop UI = MeshEditPopup on the shared `ToolboxWindow` shell (key `meshToolbox`),
  shortcuts E/I/G/S/B/F/X/C/L + Ctrl +/-/A/I, W in vertices), `history` (kind registry:
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
  undoing an object delete finds its flow intact; PR #76 adds the `'flownodes'`
  kind — node/edge create/data/delete inside one graph as ONE undo entry, storing
  SERIALIZED copies so replayed re-broadcasts hash identically for nodesync) +
  `objectFlow.js` (#13-H5:
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
  opt-in via userData.physics; Inspector Physics section; SimControls HUD + `P`;
  **CL-A colliders v2**: every shape is built from `colliderSpec.js` — ONE source of
  truth shared with the viz — RELATIVE to the CURRENT body pose, so
  `rebuildColliders`/`physicsShapeChanged` swap shapes MID-SIM (no restart;
  joints/velocity survive; `liveParamsJson` widened to collider/sensor/freeze/
  material/mass; Inspector setPhysics AND the remote objectParameters applier poke
  it); SENSORS = trigger volumes (pass-through; pairs collected BOTH directions,
  per-frame dedupe → `fireObjectEnter/Exit` replicated stamps); `PHYSICS_MATERIALS`
  presets (ice/rubber/wood/metal); freeze axes via setEnabledRotations/Translations;
  scene GRAVITY from `scenePhysics.js` (a sceneMusic-style latest-wins
  `scenephysics` singleton, applied at world create AND live); CUSTOM colliders are
  COMPOUND — one convexHull per SHELL, verts+pieces stored on userData.physics
  (1200-float cap), authored by `colliderEdit.js` (runs the REAL Edit Mesh tool on a
  scene-root proxy); **CL-C** collider node overrides the Inspector pick (shape
  'object' hulls the wired source object; sensor + scale) and the velocity node reads
  the LOCAL `objectSpeeds` feed — exact-ish on the initiator per-step, ~10Hz move
  deltas on peers) + `colliderHelpers` (CL-A viz: scene-root wireframe proxies from
  the SAME spec — green, amber sensors; `showColliders` local pref + per-object
  union; per-frame follow from Scene's useTask; hidden in wireframe view mode) +
  `joints` (#12: replicated sceneJoints defs — weld/revolute+motor, OBJECT-local
  anchors → body-local at sim start, jointcreate/delete + getjoints handshake,
  'joint' history kind, sender-side delete cascade, sessions persist),
  `inputRuntime` (#12: store-only SDK input — key codes + VR axes published by
  vrControls, claims 'keys'/'locomotion' gate PointerLockControls/editorNavigation/
  VR stick; module bindings list in Settings), `trackpadNav` (QW launch polish:
  window-capture wheel — two-finger trackpad swipes PAN via cloned-vector
  OrbitControls math with a STATEFUL 250ms gesture window (fast flicks stay pans);
  pinch/ctrl-wheel page-zoom guards (iOS gesturestart + body touch-action
  pan-x pan-y — the CANVAS gets touch-action:none or Chromium axis-latches pans);
  Settings: mode auto/on/off, reverse pan, pan + pinch-zoom enable toggles —
  all LOCAL prefs), `possess` (#12: tank-controls drive of
  any object + chase/orbit camera; possessing = selecting; ONE undo per ride),
  `handModels` (#12: custom hand GLB = IDENTITY — hash on `handmodel` msg + handshake,
  assetShare pull, rigid-at-wrist render), `terrainSculpt` (#12: brush raise/lower/
  smooth/flatten over the meshgeo channel; weld by quantized (x,z) COLUMNS, rebuilt in
  the applyMeshGeo hook (`rebuildSculptCaches`) AND guarded by position-ATTRIBUTE
  identity so a same-tick brush after a remote/undo swap never hits a stale cache;
  one snapshot+undo per stroke; CL-B follow-up MESH mode (`sculptMode`): the same
  brush on ANY mesh — weld by full xyz, displacement along averaged NORMALS, flatten
  = hit tangent plane, smooth = Laplacian relax, 45k-float entry cap, cursor ring
  hugs the surface; SculptToolbar is a FLOATING dragWindow toolbar now),
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
  `openVRKeyboard({initial, onCommit})` targets — reused by rename + chat) +
  `vrSleeve` (K, PR #75: forearm strip of ghost mini-primitives on the sleeve hand —
  left, mirrors right when `vrMenuHand==='left'`; trigger-drag a ghost into a held
  preview (rigid-follow, stick-Y scales 0.2–5), release creates at the preview pose
  with the grip-drop snap rules as ONE `aibatch` undo; K2 custom slots = grip-drop an
  object ONTO the strip → prefab snapshot in idb `vrsleeve-slots-v1` (LOCAL, cap 8,
  ✕ chips, spawn = replicated `instantiatePrefab`); gate = `vrSleeveEnabled`
  (Settings ▸ VR + `settings:sleeve` panel row, DEFAULT OFF); packaged as the
  `vrsleeve` core module — vrControls only carries GENERIC module-VR hook registries:
  `registerNavSuppressor` / `registerPanelGroupProvider` (beam/reticle family) /
  `registerVRTriggerHooks` (start/end/swallow, dispatched from Scene's
  select/selectstart/selectend) / `registerGripDropHook` (may consume a grab release;
  hook restores the pose, vrControls still releases the physics hold) /
  `registerVRFrameHook` — reuse these for future VR feature modules instead of
  hardwiring vrControls),
  `dungeonPlay` (raster collision/spawns from the dungeon module's userData.play
  contract), `geometryEdit` + `geometryParams`, `lightParams` (+local shadow-quality
  caps), `cameraClip` (LOCAL near/far prefs; far pairs with orbit maxDistance so
  zooming out can't pass the far plane; #16-P4 also holds `orbitPrefs` — rotate/
  zoom/pan speed, damping, invertY, re-applied whenever the controls remount) +
  `sceneBounds` (radius sweep feeding it), `cameraBookmarks` (#16-P4: unlimited
  NAMED views storing the LENS (fov+clip) and restoring it on recall; rename/
  overwrite/reorder/delete; legacy 5-slot payloads normalize at read),
  `cameraObjects` + `cameraHelpers` + `cameraPreview` (#16-P5 scene CAMERAS: a
  marker MESH carrying `userData.camera` — kind/fov/orthoSize/near/far/aspect/
  guide — so replication/undo/sessions/prefabs need NOTHING new; `setCameraFor`
  is the one write path (props history + objectParameters + poke, the
  setPhysicsFor precedent); scene-root frustum wireframes follow their markers
  (colliderHelpers pattern, `showCameraFrustums` local pref); PREVIEW mounts a
  REAL persp/ortho camera as threlte's default (CameraPreview.svelte) with
  Control = WASD/mouse flying that writes the pose back as ONE undo entry, a
  letterbox FramingGuide, Capture (offscreen render at the framing aspect), and
  replicated `campreview` presence + Join in Users), `gridSettings` (#16-P3 LOCAL
  grid look: cell size / match-snap-step / major lines / colours / fade / extent /
  follow / origin axes + #16-Q2 follow modes off/lookat/camera, cell-snapped, read
  by extensions/Grid.svelte), `cameraPip` (#16-Q4 the camera preview WINDOW: rect +
  target stores and the DOM→gl y-flip; CameraPipWindow.svelte is chrome only, the
  inset is drawn by Outline), `menuFilter` (#16-P1/P2
  the ONE context-menu flatten + ranking, shared by every menu incl. node search),
  `sceneAssets` (derived Scene manifest: audio/config/textures in use), `avatarModel`
  (avatar defaults, photo-card rule, per-shape hat anchors), `themes` (data-theme
  token blocks, local-only), `windowTabs` (+`closeGroup` = tab ✕ closes ALL members) +
  `windowFocus` + `docking` + `dragWindow` + `searchMenuUx` (floating-window system),
  `fileWindows` (floating text/image editor windows), `autosave` + `idb`,
  `annotationsHandler` (15-H scene notes v2/v3 — model
  `{id, objectUuid, objectName, offset, text, name, color, shape, label, author,
  authorKey, camera, follow, ts}`: `text` stays the DESCRIPTION and ONE
  `normalizeAnnotation()` runs at EVERY store boundary, so old autosaves/.tpscene/
  old peers load with defaults; the WIRE SHAPE IS UNCHANGED (`{type:'annotation',
  op:'set'}` carries the whole object and saves spread the base, so a newer peer's
  fields survive our edit). `authorKey` = a stable per-DEVICE key — 'Me' is
  DISPLAY-only (`displayAuthor`), a saved file always shows the owner's nickname,
  and renaming yourself re-stamps your own notes. `noteMarkers` = per-frame screen
  positions published from the RENDER stage for the DOM marker layer.
  `followingNote` + `startNoteFollow`/`tickNoteFollow` = the LOCAL follow session
  (translates camera AND orbit target by the pin delta, so the viewer's own orbit
  offset survives; handover via `cameraClaim`). `visitedNote` = where you are with
  no card open; `focusAnnotation` = go there WITHOUT opening (the
  `noteDoubleClickToOpen` pref); `sweepAnnotations` re-keys scene-root anchors by
  `objectName` and prunes orphans only after a 3s grace; annotation changes mark
  the autosave dirty via `markAnnotationsDirty`), `sessions` (+ .zip export/import bundling scene assets via
  fflate; #9: the SAME bundle is the first-class **.tpscene** format — `exportSessionZip`
  takes `{assets,packs,flow}` include-opts, adds a `packs/` section; `fileHandler` saves/
  loads it, Sidebar Files = [GLTF | Scene | ⚙cog]), `measure`, `cameraBookmarks`,
  `editorNavigation`, `lightHelpers`.
- `src/modules/` — core modules (hello, button, dungeon, piano, pong; #12: avatar =
  possess-selected, essentials = 6 clickable interactables whose KIND derives from the
  replicated object NAME, car = jointed drivable demo w/ click-claim + drive-op
  forwarding; K: vrsleeve = a thin shell over `$lib/vrSleeve` — LOCAL-only feature,
  register() just wires the vrControls hook registries, so disabling the module
  removes the sleeve entirely) + `index.js` `coreModules` list; manager
  enables/disables (live enable, reload to disable).
- UI: `components/menu/*` (drawers/modals; visibility via stores + `hidePanels/
  restorePanels`), `components/editors/*` (flow editor + CodeMirror panels),
  `components/play/*` (player, avatars — photo = billboard card; the VR follower
  panels: Menu/ObjectsPanel/PropertiesPanel/ColorPalette/PrefabsPanel/Keyboard/
  ChatPanel/Stats — named `vr<x>-*` control meshes, all grip-grabbable),
  scene-overlay components (PingMarkers/PingHighlights (#12: uuid-carrying pings flash
  an object box)/PathWaypoints/LockHighlights), scene NOTES (15-H:
  `menu/AnnotationMarkers.svelte` = the SCREEN-SPACE marker layer — a pill badge +
  leader line to the exact 3D point, PRESENTATION-ONLY off the `noteMarkers` store;
  occluded markers fade their FILL and dash the leader while the number stays
  readable; screen-space clustering collapses overlapping badges into one counted
  badge that fans out on click. `AnnotationPins.svelte` keeps the in-scene meshes as
  the VR path (DOM is invisible in a headset) and its GROUPS remain the anchors in
  every mode; per-note `shape` is a VR-only distinction.
  `menu/AnnotationPopover.svelte` = ONE card with view+edit faces anchored beside
  its pin; `menu/NotesDrawer.svelte` = label groups w/ ‹ › traversal + pins toggle),
  `SimControls`/`SculptToolbar`/`MeshEditPopup` (#12
  runes-mode HUD pills — the MobileAddButton "own file so onclick doesn't mix with
  on:" precedent; M0: the sculpt + mesh-edit toolbars are TOOLBOX WINDOWS on
  `components/ui/ToolboxWindow.svelte` — keys `meshToolbox`/`sculptToolbox`/
  `meshKeysCheatsheet`), `components/ui/ToolboxWindow.svelte` (M0: the shared
  tool-palette shell — header-only `.move-handle` drag + `focusStack`, dragWindow
  `axis:'x'` width-resize so the auto-fill grid of FIXED 36px square cells reflows
  the COLUMN count while the height hugs content, section labels, status footer.
  Content contract, all styled from the shell via `:global`: `.tbx-label` /
  `.tbx-row` / `.tbx-seg` / `.tbx-btn` (+`tbx-on` armed, `aria-pressed` toggle,
  `.tbx-danger`, `.tbx-flash` one-shot) / `.tbx-cmd` TEXT command / `.tbx-hbtn`
  header button. It owns its SURFACE from `var(--surface, …)` — see the ui-panel
  gotcha. **Icons are for TOOLS you arm; COMMANDS render as words** — six
  near-identical 18px glyphs in a row are indistinguishable, and that alone
  produced two "selects everything" bug reports (Linked next to Loop, All next to
  Invert)), `components/ui/ToolIcon.svelte` (the custom stroke set for glyphs
  lucide lacks — extrude/inset/bridge/flip-normals/create-face/wireframe/loop-cut
  + the sculpt brushes; 24px viewBox, stroke-width 2, `currentColor`, so every
  theme incl. unlimited custom ones tints them. NO per-theme icon assets, by
  design — custom themes are token-only, so per-theme artwork cannot scale), shared
  `ContextMenu.svelte` (caps to viewport + scrolls vertically when tall, never
  horizontally; per-submenu flip via left/right/top/bottom — no transform),
  `components/ui/DragRow.svelte` (#16-Q3: THE numeric field — drag to scrub, type
  with LIVE updates, ↑↓ step one minor unit with Ctrl ×10 / Shift ×100, Esc
  reverts; SliderRow's box and every Inspector number use it, and its key/pointer
  handlers are DIRECT listeners because panels swallow delegated ones),
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
   normalizes plain array / ArrayBuffer / typed-array view (`toFloats`).
   **Extra per-vertex channels ride the SAME message as OPTIONAL fields, absent when
   they don't apply** — `groups` (15-G material slots, a small plain array) and `uvs`
   (M1, raw bytes). Absent = "carry the previous attribute over", so an untextured
   single-material mesh is byte-identical to before and an older peer just ignores the
   field. The `meshgeo` HISTORY entry mirrors it: topology ops store
   `{positions, groups, uvs}` while sculpt/vertex/grab paths still store a bare
   positions array, and the applier discriminates on `state?.positions`. A geometry
   swap that changes the vertex count MUST recompute both, or a multi-material mesh
   renders NOTHING (three walks `geometry.groups` for an array material) and a
   textured one loses its mapping.
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
  `$objectsGroup` (or a keyed-each on the same ref won't re-render). Related #15-O1
  trap: **`$derived` compares with `===`**, so a derived returning the SAME
  (in-place-mutated) THREE object never propagates — return a fresh SNAPSHOT object
  per poke (the Inspector `material` derived is the reference; adding the store as a
  dependency alone does NOT fix it). svelte-check
  baseline is **419 errors / 62 warnings** (2026-08-02, after #15 C's one-way
  pickers −14 and K's outline rework −2) — hold it; the release.yml gate matches. Svelte 5.5x added `state_referenced_locally` (intentional one-time
  prop reads take a `// svelte-ignore state_referenced_locally` line — WindowShell is
  the reference) and deprecated `<svelte:self>` (use a self-import).
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
- Svelte 5.5x runes-mode: a MULTI-CODE `svelte-ignore` comment only honors the FIRST
  code when space-separated — use COMMAS (`<!-- svelte-ignore a, b -->`), which works
  in both modes. And synthetic DOM events aimed at delegated attribute-form handlers
  (`onchange`, `onclick`…) MUST be dispatched with `{ bubbles: true }` — a
  non-bubbling `new Event(...)` never reaches the delegation root (bit the
  adjustable-params e2e after the xyflow v1 runes flip; real user events bubble).
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
- Module-level `store.subscribe(cb)` runs cb SYNCHRONOUSLY at module eval — any
  `let` the callback reads must be DECLARED ABOVE the subscribe or the module
  TDZ-crashes the SSR eval ("Cannot access 'x' before initialization"; bit
  meshEdit/faceEdit twice in CL-B). Related svelte 5.56 strictness:
  `bind:X={undefined}` on a prop WITH a fallback hard-errors
  (props_invalid_value) — an uninitialized `let fogColor = $state()` bound via
  bind:hex CRASHED the whole scene inspector drawer; always initialize bound $state.
- **svelte-awesome-color-picker 4.x (runes rewrite, #15-C)**: it emits NO component
  events — `on:input` silently never fires; use the **`onInput` PROP** (payload is
  `{hsv,rgb,hex,color}` directly, not `event.detail`). And it writes its own snapshot
  back through `bind:hex`, CLOBBERING external writes (an env preset / selection
  change reverted while the picker was mounted) — all pickers pass `hex` ONE-WAY.
  Sky (background/fog) edits must go through `editEnvSky()` in environment.js:
  writing `scene.background`/`scene.fog` directly is reverted by the next
  `applyEnvironment()` (it re-applies the preset).
- **Toasts (#15-L/P)**: ONE system — `showToast(msg, actions?)` transient (5s/15s),
  `showInfoToast(id, text, actions?, onDismiss?)` STICKY info prompts (teal; never
  auto-dismissed, never folded by the "+N more" cap, removed via
  `dismissToastById(id)` — restore-session / first-run notice / share-or-stash are
  state-mirrored `$effect`s in Toasts.svelte). Both z-tiers live in one
  `.toasts-stack` wrapper (auto-margin centred — a transform would trap the
  children's z-index and break approvals-above-modals); connection requests are
  `.tp-toast--req` cards capped at 3 + a fold line; "Watching X" is a MODE BANNER
  pinned as the stack's first child, not a toast. `anyModalOpen` (appStore, derived)
  gates shortcuts.js + editorNavigation + inputRuntime behind the non-modal dialogs.
- **PWA (#15-N)**: `static/sw.js` is a deliberate NO-CACHE passthrough (install
  prompt without stale-build risk — `version.json` polling stays the update path).
  Never add caching without wiring skipWaiting to the version poll. Registered in
  App.svelte onMount, PROD only. `dragWindow` has an opt-in `resizable` option
  (persists `{w,h}` in the same `win:<key>` record) and an `axis: 'x'|'xy'` option
  (M0, default 'xy' so every existing consumer is byte-identical) — `'x'` is a
  WIDTH-only grip that persists just `w` and leaves the height `auto`, which is how
  a toolbox reflows its grid instead of growing a scrollbar.
- **A component's scoped `<style>` is UNLAYERED, so it beats EVERY Tailwind
  utility** — the flip side of the "unlayered global CSS beats utilities" trap, and
  it bites INSIDE a component too. `ToolboxWindow`'s `.tbx-btn { background:
  transparent }` silently beat the armed button's `bg-primary-600`, so the armed
  fill vanished **in the dark theme only** — every other theme's `theme.css` remap
  re-applies it with `!important` and therefore still won. The cure is a marker
  class the shell styles itself (`tbx-on`), and the LESSON for tests: assert the
  COMPUTED colour, never the class string, because the class string was right the
  whole time.
- **`@apply`-built utilities are compiled onto the CLASS, so the theme remap never
  sees them.** `ui-panel` is `@apply … bg-gray-800`, and `theme.css` remaps literal
  `.bg-gray-800` class NAMES — so a panel using `ui-panel` stays dark in every
  theme. Own the surface explicitly (`background: var(--surface, #1f2937)`) and keep
  `ui-panel` for radius/shadow + the bit8/contrast personality hooks.
- **An AUTO-APPLYING tool makes the DEFAULT armed op a behavioural decision.** When a
  plain click commits whatever is armed (the mesh editor's `faceAutoApply`), defaulting
  to a topological/destructive op turns every SELECTION click into an edit — the mesh
  session shipped with `extrude` armed, so clicking a face to look at it extruded it,
  reported as "clicking twice on a quad breaks the texture". Default to the
  non-destructive op (Move) and let the destructive ones be one key away.
- **`prefers-reduced-motion` suppresses `animationend`**, so any class cleared by
  that event sticks forever for those users. A CSS-animation-driven state class
  needs a `setTimeout` fallback alongside `onanimationend` (the toolbox one-shot
  flash).
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
- **svelte-awesome-color-picker v4 fires `onInput` ONCE ON MOUNT** (its
  `updateColor()` runs from an `$effect` and the first pass always differs from its
  own empty snapshot). A handler that mutates on every onInput therefore mutates
  when a PANEL MERELY OPENS: the Inspector's five pickers detached the environment
  preset to custom (opening Configure Scene relit the scene), broadcast light/object
  colour updates, and recorded undo entries for selecting a mesh. Every handler must
  ignore a value equal to the one it already holds (`sameHex()` — normalise, the
  picker round-trips through colord so case/#/alpha differ from `getHexString`).
  Suspect this for ANY third-party input component: "opening a panel changed my
  scene" is the signature.
- **Never write through a DERIVED store**: svelte compiles `$store.prop = value`
  into `store_mutate()` → `store.set()`, which a derived store does not have, so
  every such site throws `TypeError: store.set is not a function` AT RUNTIME while
  svelte-check and the build stay green. `$activeOrbit.enabled = x` (activeOrbit is
  derived over previewOrbit + orbitControls) threw inside `onPointerUp` and aborted
  the handler before `raycastSelect` — which killed SHIFT-click multi-select while a
  plain click still worked, because only the shift path enters the marquee branch.
  Mutate the RESOLVED object instead (`cameraPreview.setOrbitEnabled()`). That
  asymmetry is the tell: one gesture broken and its sibling fine means a throw
  partway through a shared handler.
- **The op TARGET in the mesh/face tools is `opTargetFace()`, never
  `faces[faceEditHighlight]`** — the latter is ONE coplanar group, so any path using
  it silently ignores Face/Triangle/Shell/Object granularity and the Multi set. The
  highlight and the toolbar ops always went through the target; the GIZMO drag did
  not, so a Shell pick lit up a whole island but dragged only the surface under the
  cursor (its weld-neighbour set stretching the shared corners = "some vertices are
  stuck"). `beginFaceGrab` accepts a synthesized target and carries its own
  `triIndices`; `attachFaceGizmo` STASHES that target, because once the pointer sits
  on a gizmo handle the live hover no longer describes the pick. 15-G hit the SAME
  anti-pattern in `bridgeFaces` (it expanded the pick to whole logical faces, so
  Triangle granularity was silently ignored) — the fix there is the general one:
  split the ACTUAL selection into its connected components (`componentsOfTris`).
- **Mesh ops must survive a CLOSED region and a MULTI-SHELL pick.** A closed
  selection has no boundary edges, so extrude's walls degenerate and every vertex
  just translates — Select-all/Shell/Object + Extrude slid the whole object sideways
  along whatever the averaged normal was. Refuse and explain. And a multi-selection
  spanning separate shells arrives as ONE synthetic face whose centroid sits in the
  gap between them, so ANY op that reasons from a face centroid is wrong there:
  derive wall directions LOCALLY (`edgeOutward` = edge × the owning triangle's
  normal) and shrink per CONNECTED COMPONENT (`insetFace`), never from the union.
- **New geometry needs its UVs authored, not copied.** `applyMeshGeo` rebuilt from
  positions alone until M1, which silently destroyed the mapping of any textured
  mesh. Carrying `uv` is only half of it: the first pass gave an extrude wall's far
  corners their BASE corner's uv, collapsing the wall's v range to zero and smearing
  one texel line up the side. Advance in uv space by (world distance × the base
  edge's uv-per-world-unit) so the aspect ratio holds. `preserveUVs` also reads
  through the PREVIOUS INDEX when the new count matches `index.count` — weld,
  entering sculpt and create-face all snapshot index-EXPANDED positions.
- **AO is a fullscreen pass and mobile GPUs mis-compile it**: `viewMode` defaults to
  `shaded-ao`, but `defaultViewMode()` starts coarse-pointer devices in plain
  `shaded`. The Chromium-151 gate in Outline.svelte came from DESKTOP ANGLE/D3D11
  evidence; on Android the same breakage still appears and the composer stops
  presenting, so the viewport keeps showing a STALE frame with nothing in the
  console. Symptom to recognise: visible viewport that never updates while you
  orbit, cured by switching to Shaded.
- **A DOM overlay that must AGREE with a threlte frame may not own a
  `requestAnimationFrame`** (15-H). threlte's OrbitControls calls
  `controls.update()` in a task in the MAIN stage; a private rAF is a different
  callback queue, so whenever it ran first it projected LAST frame's camera and the
  overlay trailed the geometry by one frame (the note-marker "jiggle"). Project
  INSIDE the scheduler — `useTask(fn, { stage: renderStage })` from `useScheduler()`,
  which runs after the main stage — and publish a store the DOM layer renders from.
  The tell-tale symptom: entering and leaving VR "fixes" it, because XR swaps the
  loop to `renderer.setAnimationLoop` and threlte re-registers its own rAF
  afterwards, flipping the callback order.
- **`OrbitControls.update()` re-derives the camera position from its own spherical
  state**, so a direct `camera.position.set(...)` is reverted on the next frame (it
  also means a *test* must never assert the numbers it asked for — park, READ the
  pose, compare with that). To move the editor camera, go through
  `objectActions.flyTo` (which also bumps `cameraClaim`, the explicit
  camera-handover signal in sceneStore) or write BOTH camera and `controls.target`.
  Continuous camera drivers translate both ends: deviation-watching cannot tell a
  user PAN from someone else grabbing the view (it would break every pan).
- An **`<svg>` is a REPLACED element**: `position: fixed; inset: 0` still leaves it
  at its 300×150 intrinsic box and silently CLIPS every child away — a full-viewport
  overlay needs explicit `width/height: 100%`.
- **flowbite's plugin emits `[type='checkbox']:checked { background-color:
  currentColor !important }`** — no background-color of yours can win the ON state
  of a custom switch at any specificity (it renders flowbite blue). Drive the fill
  through `color` instead of fighting it with `!important`.
- Anything drawn with **`depthWrite: false` loses the postprocessing passes**: the
  outline and N8AO effects read the depth buffer, so the AO and selection edges of
  whatever sits BEHIND a non-depth-writing sprite get painted across its face.
- Grid/pattern FOLLOW must snap by the **section period** (`cell × sectionEvery`),
  not by one cell: a cell-step translation maps the thin lines onto themselves but
  hops every THICK line one cell per step (15-H13).
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
- **Runtime = node >= 24** (engines-gated, engine-strict .npmrc; 2026-08-01). Plain
  `npm install` works — the old `--legacy-peer-deps` requirement died with three 0.185
  (postprocessing widened its peer range). Dev https uses the repo's own `certs/`
  files via `server.https` in vite.config (vite-plugin-mkcert was dropped). npm 11
  gates postinstall scripts (`allow-scripts` warning) — if a native dep misbehaves
  after install, check `npm approve-scripts`.
- **Release ritual (V6)**: `npm version minor|patch` + `git push origin main
  --follow-tags` — the v* tag triggers `.github/workflows/release.yml` (build +
  svelte-check baseline gate + GitHub Release; UPDATE the gate's hardcoded numbers
  when the baseline moves). Full doc: committed `RELEASING.md`. The version bump is
  the SINGLE source of truth (About / peer handshake / .tpscene+.tpmodule
  provenance / static/version.json all derive from it).
- **Deps policy (2026-08-01, post-migrations)**: the A-D migrations SHIPPED — three
  0.185 + threlte stable, @xyflow/svelte 1.6 (flow editor on runes), tailwind 4 +
  flowbite-svelte 1.x (NON-modal native dialogs — see the modal gotcha), vite 7 +
  node 24. Still frozen (dependabot ignores + `npm run deps:check` FROZEN list):
  TypeScript 7 (until svelte-check peers ^7) and rapier (solver behavior). Everything
  else takes normal grouped-monthly Dependabot PRs. A playwright bump needs
  `npx playwright install chromium` or every suite fails at launch. svelte-check
  baselines DRIFT with dep bumps — re-measure on a pristine worktree before gating.
- **Modal gotcha (flowbite 1.x)**: app modals (Settings/Modules/Sessions/Character/
  profile/Library) are NON-MODAL native dialogs (`modal={false}` → dialog.show()) so
  the z-tier chrome above --z-modal stays CLICKABLE (logo one-click close+menu,
  Connect bar, approval toasts, ThemedSelect body-portals). Never switch them to
  showModal(): the top layer makes everything else INERT — body-portaled menus and
  toasts go visible-but-dead, and top-layer popovers do NOT escape inertness. The
  ::before pseudo is the backdrop (non-modal dialogs have no ::backdrop); flowbite's
  outsideclose bbox math treats clicks on it as outside. ConfirmModal alone stays
  truly modal (blocking confirm). ESC = per-dialog onkeydown (no cancel event
  non-modal).
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
  16-Q5 PLACEMENT CONTRACT: open AT the cursor preferring DOWNWARD; when the content
  doesn't fit below, shift the WHOLE menu up so its bottom stays inside (never flip to
  the other side of the pointer); a scrollbar appears ONLY when the content is taller
  than the window; and while SEARCHING the menu keeps the top it opened with, caps the
  flat list to a bounded height, and offers a corner resize grip whose height is
  REMEMBERED per menu kind (`sizeKey` prop → `ctx:searchHeight:<viewport|nodes|
  object>`, a LOCAL pref). Menu rows can carry `revealFilter: true` (opens the
  search box without closing the menu — the node editor's "Search nodes…"; excluded
  from its own results).
- **Configure Scene DEEP LINKS** (`openSceneSection('Grid')`, or
  `'Camera:Saved views'` for a `data-anchor` sub-heading): never `showSidebar`,
  which TOGGLES and closed an already-open panel. Section.svelte expands the named
  section and lands it just under the sticky header by SCROLLING THE CONTAINER with
  the header height as an offset — plain `scrollIntoView` tucks the label underneath
  it. Do it as measure → scroll → re-measure → correct with an INSTANT scroll: a
  `smooth` one is cancelled by the reflow of the section it just expanded, and the
  scroller must be found by real SCROLLABILITY (computed overflow + scrollHeight),
  not class names.
- `backdrop-filter`/`filter` ALSO make an element the containing block for
  `position: fixed` descendants (same trap as transform). A `fixed` popup rendered
  inside `.app-sidebar` (which has `backdrop-blur`) centered on the SIDEBAR and spilled
  off-screen — render such popups at the component ROOT, not inside a blurred/filtered
  ancestor (roadmap 9 export-settings bug).
- The camera PiP frame deliberately sits BELOW the tiers (z-index 2): it is a
  viewport overlay whose picture is drawn by the render loop, so panels and HUD must
  cover it (16-Q6).
- **z-index tiers** (`ui.css` `:root`): viewport 0 · drawer 30 · bottom 35 · window 40 ·
  hud 45 · **modal 1100 · toast 1200 · menu 1300**. The high modal/toast/menu values
  clear the ad-hoc persistent chrome that lives OUTSIDE the scale — Users (avatar/peers)
  ~996-998, Connect 300, ContextMenu 999-1001, ThemedSelect 9999. flowbite Modal
  hardcodes its dialog z-50 + backdrop z-40, remapped onto `--z-modal` by an UNLAYERED
  `[role='dialog'][aria-modal='true']` rule (unlayered beats Tailwind's layered utility
  without !important). The logo/burger menu sits at `--z-menu` (top-most); opening a
  modal from it calls `closeMenu.set(true)` so the menu can't cover the modal.
- **flowbite 1.x Dropdowns are TOP-LAYER popovers** (`popover="manual"`, `:popover-open`)
  — they paint above the ENTIRE page whatever the z-index (measured: a panel at 996
  covered the profile avatar at 2000, in the same stacking context). No z-index on an
  outside element can ever sit over one; either render that element INSIDE the popover
  (the profile circle now lives in the panel's 1.5rem notch, so it rides the same layer)
  or accept the panel on top. Diagnose with `elementFromPoint` + a clipped screenshot,
  never by comparing z-index numbers. A Dropdown also anchors to its `triggeredBy`
  ELEMENT: pointing it at a wide invisible wrapper (`#avatar-menu`, 208x0) made the
  alignment an accident of two matching 20px insets, which broke on phones — anchor it
  to the visible control and offset with a negative `margin-top` if it must overlap.
  Worse, floating-ui's placement DRIFTS under a mobile viewport (page scale != 1): the
  profile panel landed exactly the trigger's 20px inset too far right on a real phone,
  flush with the window edge. Where the edge is fixed chrome geometry, PIN it in CSS
  (`#avatar-dropdown { left: auto !important; right: 20px !important }` — !important
  beats floating-ui's non-important inline `left`) and leave it only the vertical axis.
- **`(pointer: coarse)` CAN be emulated after all** — a Playwright context with
  `hasTouch: true` reports coarse. What a desktop context canNOT emulate is the mobile
  VIEWPORT: only `isMobile: true` (page scale, mobile meta-viewport handling) reproduced
  the profile-menu drift, while plain `hasTouch` measured clean at every width from 320
  to 1280. For layout bugs a user only sees on a phone, add a page with
  `{ hasTouch: true, isMobile: true, deviceScaleFactor: 2.7 }` before concluding
  "cannot reproduce headlessly".
- **Unlayered global CSS silently beats EVERY Tailwind utility** (the flip side of the
  modal trick above): a plain `.css` file imported from a component is unlayered, so one
  duplicated utility in it outranks all of `@layer utilities` regardless of specificity.
  A stray `.hidden { display: none }` in `styles/chat.css` killed every
  `group-hover/*:flex` reveal in the app (object-list row buttons, Library cards) — the
  named rule was generated AND matched, and still lost. Never redeclare a Tailwind
  utility name in global CSS; when a hover-reveal "does nothing", enumerate the matching
  rules in the CSSOM instead of re-reading the markup (the classes look right).
- A **`position: absolute`** floating window parked past the right/bottom edge joins the
  document's scroll overflow and GROWS the page, which slides the fixed chrome (Connect
  bar, profile, corner HUD) sideways as you drag; `position: fixed` never contributes to
  that overflow. Every window is fixed — dragWindow, docking, and now the object list's
  own `dragMe` (the last holdout). `html,body{overflow:hidden}` hides the scrollbars but
  does NOT stop the growth.
- **Menus opened by a LONG PRESS need press-and-click backdrops**: the finger is still
  down when the menu appears, so an outside-click backdrop mounts underneath it and the
  lift closes what it just opened. ContextMenu's backdrop requires the `pointerdown` too
  (`backdropPressed`). Synthetic e2e events never produce that lift, so a check has to
  dispatch the backdrop's own click explicitly.
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
- **Nothing in the app disables OrbitControls during a transform-gizmo drag** —
  threlte's `<TransformControls>` does it against ITS OWN context slot, so any
  churn in the default-controls slot (a camera preview unmounting + remounting the
  editor's OrbitControls) leaves the suppression pointing at an instance that no
  longer drives the view, and dragging an object ALSO orbits the camera. Scene's
  `dragging-changed` hook therefore suppresses orbiting itself through
  `activeOrbit` (16-Q5). Related: three keeps DOM listeners on a merely-dropped
  OrbitControls — dispose() it, or it goes on steering whatever camera threlte
  points it at. And its gizmo VISUALS live in a separate object (`getHelper()`),
  so `controls.visible = false` hides nothing.
- **A check that cannot fail is not a check** (16-Q6): the first deep-link
  assertion asked "is the section label somewhere below the sticky header" — true
  whenever no scrolling happens at all, so it passed while the feature was broken
  for the user. Assertions about POSITION need a tight band and a starting state
  that forces the behaviour (expand every section, scroll to the bottom first).
- **A threlte component that REMOUNTS comes back with its prop defaults** — the
  editor `<OrbitControls target.y={1.5}>` unmounts while a camera preview owns the
  view, so exiting threw the look-at point back to the origin. Snapshot such state
  at handover and copy it onto the FRESH instance (the store still holds the old
  one for a beat, so wait for a different object).
- **Mid-session HMR churn makes e2e runs LIE** (bit hard in 16-Q5): a suite that
  loads the page while vite is still re-transforming just-edited modules sees
  half-mounted components — three runs "proved" a working feature broken. Let the
  server settle (a couple of seconds) after the last edit before trusting red, and
  when store reads disagree with what you see, add a component-side debug hook
  (`window.__cameraPreviewDebug`, opt-in like `__outlineDebug`) to compare the
  COMPONENT's view with the store's.
- **Svelte 5 DELEGATES `onkeydown`/`onpointerdown`/`onclick` attributes** — the
  handler only runs once the event reaches the app root, so any ancestor that
  stops propagation on the way up silently kills it. Panel widgets are exactly
  where this bites: the drawer chrome swallows pointerdown and the flowbite
  dialog swallows Escape, so DragRow's Esc-to-revert did nothing and a drag whose
  pointerdown never arrived jumped the value by the pointer's ABSOLUTE x (+22
  instead of +2, 16-Q3). For keys and pointer gestures inside panels, attach
  DIRECT listeners via `use:action` + addEventListener.
- A `derived` store that reads anything off `userData` must list `objectsGroup` in
  its dependencies — THREE trees aren't reactive, so the post-write poke is the
  only signal it gets; and any "is something selected" check reads the SET, never
  the sticky `selectedObject` (the camera PiP hit both at once, 16-Q4).
- An INSET viewport (camera PiP) is `setScissorTest(true)` + `setScissor` +
  `setViewport` on the SAME renderer after the composer pass — no second WebGL
  context (which would duplicate every texture/geometry on the GPU). gl clears
  respect the scissor box, so the inset clears only itself; remember gl measures
  y from the BOTTOM (`glRect`) and restore the full viewport afterwards.
- **Threlte's `camera.current` is a PLAIN PROPERTY** on a CurrentWritable, so
  reading it inside `$effect` registers NO dependency — the effect runs exactly
  once. Track `$camera` (the store) when you must react to a camera SWAP. This
  bit the #16-P5 camera preview: the swap happened but Outline kept rendering the
  editor view. Related: postprocessing passes BAKE their camera at construction —
  `composer.setMainCamera(cam)` re-points the built-ins, and third-party passes
  (N8AO) keep their own `.camera` that must be set separately.
- `Object3D.lookAt` faces **+Z** for plain meshes but **-Z** for cameras/lights
  (three swaps the matrix args), so aiming a camera MARKER with `lookAt` points it
  backwards. Camera markers, their frustum viz and the preview camera all use the
  camera convention (-Z forward); aim via Set-from-view or the gizmo. And looking
  through a marker means standing INSIDE its body mesh — the preview hides it
  locally (spectator-mode precedent), restoring `visible` on exit, never replicated.
- A context menu RESIZES while open (#16-P1 filter row, #16-P2 match list), so its
  `place()` must re-run on size changes (ResizeObserver, guarded against the
  maxHeight write looping) — it used to place only on open + window resize, and a
  menu opened near the bottom edge grew straight off the screen while filtering.
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
  open inspector binds to it) — "has selection" checks need `?.uuid`, and the
  init value is a truthy empty array. `deselectObject()` clears ONLY the
  `selectedObjects` SET — anything that must react to deselection (the flow editor's
  scope-follows-selection, the desktop OUTLINE since #15-K) watches the SET, never
  `selectedObject` (#13-H bit this). Since #15-K the SET is authoritative: creation
  paths (createGeometry/Light/Group, addImported) populate it alongside the sticky
  primary, the outline traverses every set member's child MESHES (OutlineEffect
  renders meshes only — adding a Group outlines nothing), and `duplicateSelection`
  toasts on an empty set (the locked-VIEW state — set empty, primary = a peer-locked
  object — is the one deliberate fall-through). #15-O: a plain viewport click only
  SELECTS; properties open on double-click / the context-menu "Properties" entry /
  the object list, or always when `inspectorPinned` (pinned + deselect falls back to
  the Scene inspector via closeSelectionInspector).
- The Bash tool's `cd` leaks into the shared shell cwd — `Set-Location` back to the
  repo root before PowerShell git/npm calls.
- **Never `git stash pop` to undo a `git stash push -- <file>`**: if that file had no
  changes (already committed), push saves NOTHING and the pop takes an unrelated
  ANCESTOR entry off the stack — this repo's stash list still holds `feature/specator-mode`
  entries, one of which landed in Controls.svelte as a conflict. To A/B a fix, copy the
  files to the scratchpad, `git checkout HEAD -- <files>`, run, then copy back.
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
- **Local-model tool calls (AI assistant)**: a self-hosted OpenAI-compatible server
  often serves a tool-capable model with a MISMATCHED tool-call parser. vLLM 0.26 +
  Qwen3.5 with `--tool-call-parser hermes` is the worked case (Qwen3.5 emits
  `<function=X><parameter=k>` XML; hermes expects JSON — the fix is `qwen3_xml`): **unstreamed** it returns
  the call as plain CONTENT in Qwen XML (`<tool_call><function=NAME><parameter=K>…`) with
  `tool_calls` absent; **streamed** it swallows the call and emits ONE `tool_calls` delta
  whose name is an INVENTED string (the object's own name — "Cube", "campfire_flame")
  with EMPTY arguments, or nothing at all. Symptom: "Applied N action(s)" with an empty
  viewport. Hence `ai/toolCallText.js` (recover calls from text + hold streamed markup
  back from the transcript), `turnUnusable`→retry-unstreamed + a session `brokenStreaming`
  flag + a per-provider `stream`/`temperature` setting, and `repairToolCall` in tools.js
  (alias/case fixes, and an invented name with object-spec args becomes create_objects).
  Reasoning models also stream `delta.reasoning`/`reasoning_content` — never chat content,
  never in the transcript; it only feeds the `aiStatus` "Thinking…" line.
- **Inspector.svelte is a plain `<script>` (NOT lang="ts")** — one TypeScript type
  annotation in it hard-breaks `npm run build` with a useless
  `error during build: undefined` (svelte-check never runs; vite dev 500s too).
  Same trap in any non-TS component: JSDoc for types, never TS syntax (#13-B3).
- **Icons = `@lucide/svelte` SVG components** (Font Awesome fully REMOVED post-1.0.1
  — never add `fa-` classes). Static markup imports named components
  (`import { Play } from '@lucide/svelte'`; sizes 16 inline/menu, 18-20 toolbar/
  header, 24 the play FAB; `aria-hidden="true"` when decorative); DATA-DRIVEN icon
  names (Explorer KIND_ICONS, menu-item defs) render via `components/ui/Icon.svelte`
  (kebab lucide names). Icons inherit `currentColor` — never hardcode grays;
  semantic colors come from the `--icon-*` theme tokens. TWO TRAPS: a `class` passed
  to a lucide component lands on the CHILD-scope `<svg>`, so scoped CSS targeting it
  needs `:global(...)` (bit cx-chevron/tp-toast-icon/role-caret — silent style loss,
  sometimes without even an unused-selector warning); svg `className` is an
  SVGAnimatedString — e2e reads `getAttribute('class')` and selects `svg`, not `i`.

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
- Status (2026-08-10): **mesh-editing roadmap M0-M4 + M6 EXECUTED** (plan: cloud
  `plans-core/pending/mesh-editing-roadmap.md`, which also carries the M5 bevel design
  notes). Lane `../theprototype-lane-c` @ **port 5182**. Three stacked PRs off
  `release/next`: **#92** 15-G convert-to-mesh + quad granularity + the three mesh-edit
  defects it surfaced (multi-material meshes rendering NOTHING after an edit; wall
  winding from a union centroid; bridge ignoring the selection) → **#102** M0 toolbox
  windows (ToolboxWindow/ToolIcon, dragWindow `axis:'x'`) → **#103** M1 UV preservation,
  M2 loop select/grow/shrink/all/invert/linked, M3 loop cut, M4 edge sub-mode, M6
  recalc-normals/merge-by-distance/smooth-flat, plus a round-2 fix commit from real-use
  reports (extrude wall UVs, closed-region guard, quad diagonals unpickable, dissolve
  that really removes an edge, two-edge loop completion, per-mode selection memory,
  movable keys cheat sheet). Suites added: convert-to-mesh, mesh-edit-materials,
  mesh-multishell-ops, mesh-quad-select, toolbox-window, mesh-uv-preserve,
  mesh-loop-select, mesh-loop-cut, mesh-cleanup, mesh-edge-mode, mesh-fixes-round2.
  Baseline **419/62** held throughout. Then TWO fix rounds from real use: `dbbfc69`
  (extrude wall UVs, closed-region guard, quad diagonals unpickable, dissolve that
  really removes an edge, two-edge loop completion, per-mode selection memory, movable
  keys cheat sheet) and `4f5a804` (Move as the default op, selection vs hover overlays,
  session Cancel, Ctrl+A/I in all three modes, 1/2/3 element-mode keys, sectioned cheat
  sheet, LOOP split from RING, bridge pairing hardened). REMAINING: M5 bevel, M9 knife +
  vertex slide, **the M4 edge GIZMO** (edges select but cannot be dragged — deferred
  deliberately), M7 mirror, M8 proportional, and the deferred stored-face-topology item.
  Two reports ("loop selects everything", "invert selects everything") were CORRECT
  logic reported through a bad UI — six near-identical icon buttons — which is why
  selection commands are words now; check the UI before the algorithm when a report says
  "selects everything". Equally: every red in those rounds was a wrong TEST premise, not
  a wrong fix — re-derive what the code should do before changing it.
- Status (2026-08-06, release): **1.2.0 SHIPPED** — PR #88 (`release/next` → `main`)
  merged, `npm version minor` → tag `v1.2.0` → release.yml, cloud redeployed with
  `CORE_REF=v1.2.0` (now PINNED in the cloud repo's gitignored `.env.deploy`). Eight
  verification commits landed on top of the assembled branch, all from user reports on
  real hardware; the ones worth remembering as TRAPS are in the gotchas above:
  unlayered global CSS beating every Tailwind utility (a duplicate `.hidden` in
  `styles/chat.css` killed every `group-hover/*:flex` reveal app-wide), flowbite 1.x
  Dropdowns being TOP-LAYER popovers (no z-index can sit over one; the profile circle
  now lives INSIDE the panel), floating-ui drifting under a mobile viewport (pin the
  axis that is fixed chrome geometry), `position: absolute` floating windows growing the
  document and dragging the fixed chrome, long-press menus needing press-and-click
  backdrops, and `isMobile: true` being the ONLY way to reproduce phone-only layout bugs
  headlessly. Baseline held **419/62** throughout. Owed on-device checks: VR pins/sleeve
  feel, PWA install, live vLLM smoke.
- Status (2026-08-05, release): **`release/next` ASSEMBLED for 1.2.0** — PRs #86 →
  #85 → #84 (which auto-closed #82, stacked on it), #83, #81 and #87 (15-H notes)
  all merged, so the branch now carries roadmaps #15 + #16, colliders v2 + edit-mesh
  pro, the AI flow/physics tools, the VR sleeve and all four deps migrations. Three
  verification commits sit on top: the DERIVED-store shift-select fix, the
  gizmo-granularity + Object-granularity fix with the mobile-AO default, and the
  1.2.0 CHANGELOG + a foldable What's New (one `<details>` per release, newest open).
  Baseline **419/62** = the release.yml gate. `SESSION_FORMAT`/`MODULE_FORMAT` are
  still `1`, so 1.2.0 is a MINOR. Remaining ritual: merge to `main`,
  `npm version minor`, `git push origin main --follow-tags`, then redeploy the cloud
  with `CORE_REF=v1.2.0`. Do NOT rename `release/next` — the version lives in
  `npm version` on main, not in the branch name.
- Status (2026-08-05): **15-H scene notes v2/v3 COMPLETE** — branch
  `feat/roadmap15-h-notes-v2` (lane `../theprototype-lane-notes` @ port 5187,
  branched off `fix/roadmap16-menus-cameras`), 5 commits. (1) v2 model + anchored
  view/edit popover + drawer label groups w/ ‹ › traversal + pins toggle. (2)
  follow-ups: two-pass VR pins, per-note shapes, `authorKey` identity, the
  persistence fixes (annotations now mark the autosave DIRTY — the real "notes
  disappear on reload" cause — scene-root anchors re-key by name, orphan prune gets
  a 3s grace) + the grid look-at section-snap fix. (3) markers v3: SCREEN-SPACE
  badges with leader lines, ONE raycast occlusion verdict per marker with 8cm slack
  (occluded = dim fill + dashed leader, number stays readable), screen-space
  clustering, hover tooltip, selected ring, near-camera fade; in-scene meshes became
  the VR path only. (4) H11: saved camera FRAMING (`camera` on the note) that
  opening flies to, plus per-viewer follow SESSIONS that outlive the card (sticky
  indicator toast, Esc, `cameraClaim` handover). (5) follow-on-open switch,
  `noteDoubleClickToOpen` (single click / drawer arrows only FLY; dblclick opens) +
  `visitedNote`, and the Esc order (first stops following, second closes the card).
  Suite `notes-v2` = 90 checks incl. a PROVEN frame-lag guard; baseline 419/62 held
  throughout. Plan + as-built notes: cloud `plans-core/pending/15-h-notes-v2.md`.
  Backlog spinoff: a camera follow/look-at NODE for roadmap-16 camera OBJECTS.
- Status (2026-08-02): **Roadmap #15 in flight — A+J → PR #81, B+C → PR #82,
  second drop K/L/M/N/O + toast-system rework → PR #84 (stacked on #82), docs
  batch I → theprototype-docs.** Shipped in #84: properties-panel PIN +
  double-click/context-menu "Properties" (plain click only selects now), info
  toast kind + unified toast stack + spectator mode banner, sticky
  share-or-stash (no more 14s auto-share), progress-toast lifecycle fix,
  GitHub stars (Welcome + cloud profile — cloud repo carries its own copy),
  PWA manifest/icons/no-cache SW, outline-follows-the-selection-SET (K).
  Baseline 419/62. Plan + parked designs: cloud repo
  plans-core/roadmap-15-editmesh-notes-polish.md (mesh lane D→E→F, G, H notes
  v2 still pending there). Lane: ../theprototype-lane-ui @ port 5186 (5176 is
  shadowed by a stale [::1] server — the port-shadow trap; ALWAYS curl a source
  file and grep your new symbol before trusting a lane server).
- Status (2026-08-04, drop 3): **#16 Q5 on the SAME PR #86** — the reported
  "gizmo drags also rotate the camera" bug fixed AT THE ROOT (nothing ever
  disabled OrbitControls during a gizmo drag; threlte's TransformControls does it
  against its own context slot, which a camera preview leaves stale — Scene's
  `dragging-changed` hook now suppresses through `activeOrbit`, and the preview's
  controls are disposed). Proven by an A/B real-mouse drag on the real gizmo arrow
  (0.21 rotation before, 0.00000 after, object moves the same 1.04 either way).
  Plus: menu placement contract (cursor-anchored, shift-up, scroll only past the
  window, sticky top + bounded + resizable while searching) · grid 'camera' follow
  via threlte's own followCamera (smooth pans; only look-at snaps) · deep links
  offset by the sticky header + a `data-anchor` for SAVED VIEWS · snap steps
  quantized and printed through one formatter · PiP left-drag on the title bar,
  gizmo hidden for the inset draw, parked clear of the HUD. New suite
  gizmo-orbit-leak(9); 419/62 held.
- Status (2026-08-04, drop 2): **#16 follow-ups on the SAME PR #86** — [fix] camera
  Control (no view jump: OrbitControls is seated behind the camera and the pose
  re-synced from the marker, because its constructor already ran one update(); no
  more orbit-controls leak: the preview owns `previewOrbit`, a derived `activeOrbit`
  drives Scene's suppression + navigation) · [feat] menu (per-level cursor memory,
  STICKY search mode, one-time side decision so a growing list keeps the anchor,
  revealFilter rows excluded from their own results) · [feat] panel DEEP LINKS
  (`openSceneSection` opens+expands+scrolls instead of toggling shut) + grid follow
  Off/Look-at/Camera + Scale 0.25 and custom snap steps in the menu + themed physics
  checkboxes + Add opens properties · [feat] ONE numeric field (DragRow everywhere)
  · [feat] camera PiP window + Capture row. New suites camera-preview-control(9)/
  panel-deeplinks(16)/number-fields(13)/camera-pip(18); 419/62 held.
- Status (2026-08-04): **Roadmap #16 (menus, grid & scene cameras) EXECUTED →
  core PR #86** (branch fix/roadmap16-menus-cameras, six commits, STACKED on #85 →
  #84 → #82; retarget to release/next as they land; plan + as-built notes in the
  cloud repo plans-core/roadmap-16-menus-grid-cameras.md). P6 deselect broadcasts
  `unlock` (peers kept objects locked forever) + "Selected ▸" gates on the SET · P1
  menu filter hidden-until-typing + ↑/↓ navigation + Enter-opens-submenu · P2 the
  node editor's private search box retired onto the shared filter · P3 Configure
  Scene ▸ Grid + Snapping with a `checked` item style replacing `●` · P4 unlimited
  NAMED camera bookmarks (lens included) + a Camera section (orbit feel, framing) ·
  P5 scene CAMERA OBJECTS (frustum viz, true-swap preview, WASD Control writing back
  as one undo, framing guide, Capture, replicated preview presence). New suites
  deselect-unlock/grid-snapping/camera-bookmarks/camera-objects; 419/62 held.
  REMAINING from #15: mesh lane D→E→F, G (convert to mesh), H (notes v2).
- Status (2026-08-01): **VR sleeve palette (K1+K2) MERGED to release/next (PR #75)**
  — plan: cloud repo plans-core/done/k-vr-sleeve-palette.md (as-built notes there).
  One commit: `$lib/vrSleeve.js` + the `vrsleeve` core-module shell + the generic
  module-VR hook registries in vrControls (nav suppressor / panel-group provider /
  trigger start-end-swallow / grip-drop interceptor / frame hook — Scene.svelte
  dispatches select events through them) + `vrSleeveEnabled` gate (Settings ▸ VR +
  `settings:sleeve` VR panel row, default OFF). Suite: vr-sleeve (29 headless checks
  w/ synthetic controller poses — structure, gating, ghost→create one-undo round trip
  w/ grid/surface snap, suppression/swallow predicates, K2 capture/persist/spawn/
  clear/cap). Lane: ../theprototype-lane-aiphys @5178. REMAINING: on-device feel
  (strip offsets on the forearm — constants at the top of vrSleeve.js) = user check.
  **AI assistant v3 flow+physics tools: PR #76 OPEN against release/next** (same
  lane; plan: plans-core/done/ai-flow-physics-tools.md). The assistant creates
  BEHAVIOR now: `create_flow_nodes`/`update_flow_nodes` always available (curated
  node-type enum + alias map, editor-identical node/edge construction incl. the
  handle-qualified edge-id format, ONE 'flownodes' history entry per call; the
  implicit-owner rule makes one-node-zero-edges the normal case), and
  `set_physics`/`create_joints`/`control_simulation` + the physics node FAMILY
  (mass/bounciness/friction/angularvelocity/motor/collider/onimpact/onenter/onexit/
  velocity) gated by a per-provider **physicsTools checkbox** (Settings ▸ AI, docs
  link). `setPhysicsFor(uuid, patch)` in physics.js = the shared physics write path
  (props history + objectParameters + collider-viz poke + CL-A A2 live mid-sim
  rebuild) used by Inspector/quick-action/AI alike. summarizeScene carries per-object
  `physics` + compact `flow` (12-node cap) + top-level `sceneFlow`/`joints`;
  repairToolCall gained the 5 names + invention aliases (add_behavior,
  start_simulation w/ action fill-in) + physics-only-updates → set_physics inference.
  Sim start/stop deliberately records NO history — undoing an AI batch never stops a
  running sim. Suite: ai-flow-physics (38 checks, scripted moving-spider scenario).
  Docs-repo page ai/local-models.md (qwen3_xml-not-hermes vLLM guidance) already on
  the docs branch. release/next merged INTO the branch (Inspector setPhysics conflict
  resolved by absorbing physicsShapeChanged into setPhysicsFor); post-merge 438/62
  held + ai/collider/joints suites green. REMAINING: live vLLM smoke = user check.
- Status (2026-08-01): **Colliders v2 + Edit Mesh Pro MERGED to release/next (PR
  #74)** — plan: cloud repo plans-core/pending/colliders-v2-editmesh-pro.md (marked
  EXECUTED). Five commits: **CL-A** colliders core (colliderSpec.js one source of
  truth, LIVE mid-sim collider rebuild, sensors + enter/exit dispatch, material
  presets, freeze axes, scene-gravity `scenephysics` singleton, collider viz,
  compound custom collider edit session on a scene-root proxy) - **CL-B** edit mesh
  pro (inset gizmo-gating fix, face-mode wireframe + Wire toggle, Face/Triangle/Shell
  granularity, subdivide/flip/weld/bridge ops, MeshEditPopup rebuilt as a FLOATING
  dragWindow toolbar with shortcuts) - **mesh sculpt** (the terrain brush generalized
  to ANY mesh: normal-direction displacement, xyz weld, floating SculptToolbar) -
  **CL-C** physics nodes (collider override incl. object-source hull + live rebuild,
  onenter/onexit, velocity with a LOCAL speed feed) - a [fix] for the PRE-EXISTING
  scene-inspector crash (fogColor bind:hex undefined under svelte 5.56). New suites:
  collider-viz/collider-live/collider-custom/mesh-ops/mesh-sculpt/
  flow-physics-collider. svelte-check baseline DROPPED to **438/62** (release.yml
  gate updated to match). Lane: ../theprototype-lane-editmesh @5183. REMAINING:
  theprototype-docs site pages (physics.md sensors/materials/freeze/gravity/viz +
  colliders.md + node pages), VR on-device feel check (user).
- Status (2026-07-28): **v1.0.0 RELEASED** (PR #56 merge-commit → `npm version 1.0.0`
  → tag-triggered release.yml → github.com/theprototype-app/core/releases/tag/v1.0.0;
  cloud deployed w/ `CORE_REF=v1.0.0`). The release batch shipped: **RP** packs
  off-bundle (github.com/theprototype-app/packs @v1 via jsDelivr — default/
  cube_diorama/khronos-upstream-index/audio-essentials 23 CC0 sounds; bundled
  starter in static/library; zip packs get an in-view Install card + their own
  library folder; installed shadows default row) · **RV V2-V8** (About version +
  setPluginInfo/compatibleHooks fail-closed gate, peer app-version warn once/session,
  SESSION_FORMAT/MODULE_FORMAT confirm gates + ConfirmModal, release.yml +
  RELEASING.md, V8 static/version.json poll → one reload toast/session) · deps
  safe-bump (svelte 5.56.8/kit 2.70/vite 5.4.21/playwright 1.62 — frozen majors
  have planned migrations, see Deps policy) · fixes (Import button, whats-new
  footer + welcome-on-start badge, sculpt-gizmo suppression + toolbar toggle,
  Shift+A opt-in default OFF, keyed toast each). svelte-check baseline **476/62**.
  KNOWN pre-existing e2e failures in the localhost env (identical pre/post deps
  bump): drag-drop-simulation cluster (explorer-drop/explorer/packs-drop) +
  user-modules, open-core-m1 (1 check), dock-sidebar-inset, layout, node-search,
  panels, script-nodes + a few two-peer timing suites. NEXT: deps migrations
  post-1.0 (cloud plans-core/pending/deps-migrations-post-1.0.md, Part A first).
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
