# Settings storage keys (1.25.0) — companion to settings-inventory.md

Read from source on feat/37-settings @ f2be8687 (1.25.0). The storage-key test uses this table as its oracle.

Worktree: `(worktree)`. Paths below are relative to `src/`.

**How storage works.** Every key goes through `$lib/safeStorage` (`lib/safeStorage.js`), which is a thin
wrapper over `window.localStorage` with **no key prefix**. A key whose write failed lives in memory for the session
only. Unless a row says otherwise, "key" = a plain `localStorage` key and the value is a string.
IndexedDB is used only by "Clear saved session" (idb key `latest`).

**Scope legend.** DEVICE = this browser only (localStorage), never replicated or saved into a scene.
SHARED = saved into the scene document and/or replicated to peers (message type given).
DEVICE+wire = a local pref whose value also travels to peers inside some message (noted).

**Write-timing legend** (matters for "key exists?" assertions):
- *load-write*: the store's subscriber runs at module evaluation, so the key is (re)written on boot with the current/default value.
- *change-only*: the first subscriber call is skipped, so the key is absent until the value is changed once.
- *setter-only*: no subscriber; the key is written only by the named setter function (writing the store directly, e.g. `bind:`, does NOT persist).
- *start-write*: the persisting subscriber is installed inside a `start*()` boot function (load-write once that runs).

Encodings: "bool str" = `'true'`/`'false'`; "num str" = `String(number)`; "JSON" = `JSON.stringify(...)`.

---

## Settings.svelte (`components/menu/Settings.svelte`) — by AccordionItem section

Section headers (`{#snippet header()}`), in DOM order: **Interface** (851), **Controls** (1002), **Input** (1082),
*Touch controls* (own file, line 1157), **Scene** (1158), **Explorer** (1407), **VR** (1645), **AI** (1848),
**Export** (2037), **Node types** (2041), **Connection** (2045), **Shortcuts** (2179), **About** (2249), + the modal footer.

### Interface

Rows 1-3 come from embedded files (see their own tables below): `TextSelectionSettings`, `AvatarSettings`; `ToursSettings` sits after "Toasts in drawer only".

| Row label | store | storage key | default | scope | defined at | encoding / notes |
|---|---|---|---|---|---|---|
| *(Allow text selection everywhere — see TextSelectionSettings)* | | | | | | |
| *(Avatars: Your character / Show everyone as classic heads — see AvatarSettings)* | | | | | | |
| Theme | `theme` | `theme` | `'dark'` | DEVICE | lib/themes.js:87 | raw theme id (`dark`,`light`,`green`,… or `custom-<ms>`); load-write (applyTheme writes on every set incl. boot, themes.js:116) |
| Custom theme — Export template | *action* `exportActiveTheme()` | — (downloads a `.theme.json`) | — | — | lib/themes.js:144 | no storage write |
| Custom theme — Browse… | *action* `importThemeFile(file)` → `customThemes` + `theme` | `customThemes` (+ `theme` set to the new id) | `[]` | DEVICE | lib/themes.js:84 (store), :180 (fn) | JSON array `[{id:'custom-<Date.now()>', name, tokens:{--token: value}}]`; load-write |
| Custom theme — ✕ (per theme) | *action* `removeCustomTheme(id)` | `customThemes`; `theme` → `'dark'` if it was active | — | DEVICE | lib/themes.js:190 | |
| Game sounds | `gameSoundVolume` | `game:soundVolume` | `0.8` | DEVICE | lib/gameSfx.js:76 | num str 0..1 (step 0.05); load-write |
| Music | `gameMusicVolume` | `game:musicVolume` | `0.6` | DEVICE | lib/gameMusic.js:46 | num str 0..1; load-write |
| Welcome on start | `showWelcomeOnStart` | `showWelcomeOnStart` | `false` | DEVICE | lib/whatsNew.js:45 | bool str; load-write (boolPref, whatsNew.js:25) |
| Welcome on start — "open it now" link | *action* `openWelcome()` (+ `settingsOpen.set(false)`) | — | — | — | lib/whatsNew.js:76 | |
| Announce new versions | `showWhatsNewNotice` | `showWhatsNewNotice` | `true` | DEVICE | lib/whatsNew.js:47 | bool str; load-write |
| Toasts in drawer only | `toastsInDrawerOnly` | `toastsInDrawerOnly` | `false` | DEVICE | stores/appStore.js:630 | bool str; load-write |
| *(Tours rows — see ToursSettings)* | | | | | | |
| Show Rooms button *(only when `$drawerSlot` — cloud plugin)* | `showRoomsButton` | `showRoomsButton` | `true` | DEVICE | stores/appStore.js:660 | bool str, read `!== 'false'`; load-write |
| Floating toolbar | `floatingToolbar` | `floatingToolbar` | `true` | DEVICE | stores/appStore.js:584 | bool str, read `!== 'false'`; load-write |
| Toolbar always on top | `toolbarAlwaysOnTop` | **`toolbarOnTop`** (NOT `toolbarAlwaysOnTop`) | `false` | DEVICE | stores/appStore.js:613 | bool str, read `=== 'true'`; load-write |
| Window positions — Reset | *action* `resetWindowLayout()` + toast | removes every `win:*` key + `objectListRect`, `explorerWinW`, `explorerWinH`, `explorerHeight`, `explorerTreeW`, `uvWinW`, `uvWinH`, `controlsLayout`; then runs registered resetters | — | DEVICE | lib/dragWindow.js:45 | |
| Touch tools | `touchTools` | `touchTools` | absent ⇒ `true` if `(pointer: coarse)` or `innerWidth <= 820`, else `false` | DEVICE | stores/appStore.js:448 | bool str; load-write (so the computed default is frozen on first boot) |
| Allow undocking (touch) | `mobileUndockAllowed` | `mobileUndockAllowed` | `false` | DEVICE | stores/appStore.js:563 | bool str; load-write; also toggles `<html>.allow-undock` |
| Advanced mode | `advancedMode` | `advancedMode` | `false` | DEVICE | stores/appStore.js:366 | bool str; load-write |
| Environment in list | `showEnvInList` | `showEnvInList` | `false` | DEVICE | stores/appStore.js:374 | bool str; load-write |
| Object search in menu | `objectSearchEnabled` | `objectSearchEnabled` | `false` | DEVICE | stores/appStore.js:357 | bool str; load-write |
| Show FPS + draw calls (`#show-perf-stats`) | `perfStatsShown` | `perfStats:show` | `false` | DEVICE | lib/fpsMeter.js:26 | bool str; load-write |
| Send performance reports (`#send-perf-reports`) *(only when `$perfReportsAvailable`, i.e. `VITE_PERF_REPORTS_URL` set)* | `perfReportsOn` | `perfReports:send` | `false` | DEVICE | lib/perf/beacon.js:63 (key const :38) | bool str; load-write |
| Dock resizes the viewport (`#dock-pushes-viewport`) | `viewPrefs.dockPushesViewport` via `setViewPrefs` | `viewPrefs` | `true` | DEVICE | lib/viewPrefs.js:49 (defaults :21) | JSON object `{wireColor, outlineColor, editWireColor, dockPushesViewport}`; load-write. NB "Reset line colors" (Scene) resets this field too |

### Controls

| Row label | store | storage key | default | scope | defined at | encoding / notes |
|---|---|---|---|---|---|---|
| Shift+A quick add | `enableShiftAdd` | `enableShiftAdd` | `false` | DEVICE | stores/appStore.js:427 | bool str; load-write |
| Show helpers in Play (debug) (`#helpers-in-play`) | `helpersInPlay` | `helpersInPlay` | `false` | DEVICE | lib/helperLayer.js:47 | bool str; load-write |
| Double-click to open notes | `noteDoubleClickToOpen` | `noteDoubleClickToOpen` | `false` | DEVICE | stores/appStore.js:497 | bool str; load-write |
| Trackpad gestures (`#trackpad-mode`) | `trackpadMode` | `trackpadMode` | `'auto'` | DEVICE | lib/trackpadNav.js:24 | `'auto'`\|`'on'`\|`'off'`; load-write |
| Two-finger pan | `panEnabled` | `trackpadPanEnabled` | `true` | DEVICE | lib/trackpadNav.js:54 | bool str, read `!== 'false'`; load-write |
| Reverse trackpad pan | `reversePan` | `trackpadReversePan` | `false` | DEVICE | lib/trackpadNav.js:44 | bool str; load-write |
| Pinch zoom | `pinchZoomEnabled` | `trackpadPinchZoom` | `true` | DEVICE | lib/trackpadNav.js:64 | bool str, read `!== 'false'`; load-write |
| Allow browser pinch zoom | `allowBrowserZoom` | `allowBrowserZoom` | `false` | DEVICE | lib/trackpadNav.js:34 | bool str; load-write |
| Wheel diagnostics (`#wheel-diagnostics`, read-only) | `lastWheelEvents` (+ reads `trackpadMode`) | not persisted | `[]` | DEVICE (runtime) | lib/trackpadNav.js:113 | |

### Input

| Row label | store | storage key | default | scope | defined at | encoding / notes |
|---|---|---|---|---|---|---|
| Gamepad (`#gamepad-enabled`) | `gamepadPrefs.enabled` via `setGamepadPrefs` | `gamepadPrefs` | `true` | DEVICE | lib/gamepadPrefs.js:117 (key :58, defaults :60) | JSON `{enabled, invertY, deadzone, lookSensitivity, swapSticks}` (normalized); load-write |
| Swap sticks (`#gamepad-swap`) | `gamepadPrefs.swapSticks` | `gamepadPrefs` | `false` | DEVICE | lib/gamepadPrefs.js:117 | same JSON |
| Invert look Y (`#gamepad-invert-y`) | `gamepadPrefs.invertY` | `gamepadPrefs` | `false` | DEVICE | lib/gamepadPrefs.js:117 | same JSON |
| Stick deadzone (`#gamepad-deadzone`) | `gamepadPrefs.deadzone` | `gamepadPrefs` | `0.15` | DEVICE | lib/gamepadPrefs.js:117 | number, clamped 0.05–0.4 |
| Look sensitivity (`#gamepad-sensitivity`) | `gamepadPrefs.lookSensitivity` | `gamepadPrefs` | `1` | DEVICE | lib/gamepadPrefs.js:117 | number, clamped 0.5–3 |
| Per-game controls | — (info only) | — | — | — | — | |
| Mouse bindings (`#flow-mouse-bindings`) | `flowMouseBindings` | `flow:mouseBindings` | `'classic'` | DEVICE | lib/flowPrefs.js:30 (key :22) | `'classic'`\|`'select'`; load-write |
| *(Node editor opens — see NodeEditorViewSettings)* | | | | | | |

### Scene

| Row label | store | storage key | default | scope | defined at | encoding / notes |
|---|---|---|---|---|---|---|
| Show grid | `showGrid` (+ inline `onclick` toggling the key) | `showGrid` | shown (key absent) | DEVICE | stores/sceneStore.js:11 (store, init `null`); boot read components/Scene.svelte:190 | key ONLY present as `'false'` when hidden; the Checkbox `onclick` removes the key if present else sets `'false'` (presence-toggle, independent of the store value) |
| Light helper length (`#light-helper-length`) | `lightHelperLength` | `lightHelperLength` | `2` | DEVICE | lib/lightHelpers.js:21 | num str, min 0.2 (`Number(v) \|\| 2`); load-write |
| Shadow quality (`#shadow-quality`) | `shadowQuality` | `shadowQuality` | `'high'` | DEVICE | lib/lightParams.js:39 (writer :142) | `'off'`\|`'low'`\|`'medium'`\|`'high'`; start-write (`startLightParams`) |
| Reduce quality when the scene is heavy (`#auto-quality`) | `autoQuality` | `autoQuality` | `true` | DEVICE | lib/qualityGovernor.js:75 (writer :269) | bool str, read `!== 'false'`; change-only |
| Simplify distant models (`#lod-enabled`) | `lodEnabled` | `lodEnabled` | `true` | DEVICE | lib/lod.js:55 | bool str, read `!== 'false'`; change-only |
| Draw repeated kit pieces together (`#kit-instancing`) | `kitInstancingEnabled` | **`kitInstancing`** | `true` | DEVICE | lib/kitInstancing.js:45 | bool str, read `!== 'false'`; change-only |
| *(Water quality — see WaterSettings)* | | | | | | |
| Simulation controls | `showSimControls` | `showSimControls` | `false` | DEVICE | stores/appStore.js:384 | bool str; load-write |
| Sync animations | `syncedAnimations` | `syncedAnimations` | `true` | DEVICE | stores/flowStore.js:263 (writer lib/flowRuntime.js:4318) | bool str, read `!== 'false'`; start-write (flowRuntime start) |
| Spatial voice | `spatialVoice` | `spatialVoice` | `true` | DEVICE | lib/voiceChat.js:23 (writer :519) | bool str, read `!== 'false'`; load-write |
| Ping color + sound — color (`#ping-color`) | `pingColor` | `pingColor` | `''` (= automatic peer color; the input shows `#4f83cc` when empty) | DEVICE+wire (carried as `color` in every outgoing `ping` message, lib/ping.js:80) | lib/ping.js:19 | hex string or `''`; load-write; written on `change` |
| Ping color + sound — sound | `pingSound` | `pingSound` | `'ding'` | DEVICE+wire (`sound` field of `ping` message) | lib/ping.js:22 | sound id from `PING_SOUNDS` (lib/pingAudio.js:10); load-write |
| Ping color + sound — ▶ Preview (`#ping-preview`) | *action* `playPing($pingSound)` | — | — | — | lib/pingAudio.js | |
| Autosave | `autosaveEnabled` | **`autosave`** | `true` | DEVICE | lib/autosave.js:133 (writer :869) | bool str, read `!== 'false'`; start-write (`startAutosave`) |
| Auto-restore on load (`#auto-restore`) | `autoRestoreEnabled` | **`autoRestore`** | `false` | DEVICE | lib/autosave.js:141 (writer :870) | bool str; start-write |
| *(Checkpoints rows — see CheckpointSettings)* | | | | | | |
| When opening another scene (`#modules-on-open`) | `modulesOnOpen` | `scenes:modulesOnOpen` | `'ask'` | DEVICE | lib/sceneSwitch.js:51 (key const :43) | `'keep'`\|`'unload'` stored; **`'ask'` REMOVES the key** |
| Double-click action (`#double-click-action`) | `doubleClickAction` | `doubleClickAction` | `'properties'` | DEVICE | lib/selectionPrefs.js:35 | `'properties'`\|`'meshedit'`\|`'isolate'`\|`'sametype'`; load-write |
| Length (`#length-unit`) | `lengthUnit` | `lengthUnit` | `'m'` | DEVICE | lib/units.js:79 | `m`\|`cm`\|`mm`\|`in`\|`ft`; load-write |
| Angle (`#angle-unit`) | `angleUnit` | `angleUnit` | `'deg'` | DEVICE | lib/units.js:80 | `deg`\|`rad`; load-write |
| Carry animation clips | `duplicateCarriesAnimation` | `duplicateCarriesAnimation` | `true` | DEVICE | stores/appStore.js:475 | bool str, read `!== 'false'`; load-write |
| Carry object flow | `duplicateCarriesFlow` | `duplicateCarriesFlow` | `true` | DEVICE | stores/appStore.js:483 | same |
| Carry shader graph | `duplicateCarriesShader` | `duplicateCarriesShader` | `true` | DEVICE | stores/appStore.js:489 | same |
| Share materials | `shareDuplicatedMaterials` | `shareDuplicatedMaterials` | `false` | DEVICE (the shared material id it produces is scene data) | lib/materialSharing.js:57 | bool str; load-write |
| Wireframe color (`#wire-color`) | `viewPrefs.wireColor` via `setViewPrefs` | `viewPrefs` | `'#9aa4b0'` | DEVICE | lib/viewPrefs.js:49 | JSON object (see Interface) |
| Selection outline color (`#outline-color`) | `viewPrefs.outlineColor` | `viewPrefs` | `'#353535'` | DEVICE | lib/viewPrefs.js:49 | |
| Edit Mesh wireframe (`#edit-wire-auto`, `#edit-wire-color`) | `viewPrefs.editWireColor` | `viewPrefs` | `'auto'` | DEVICE | lib/viewPrefs.js:49 | `'auto'` or hex; unticking Auto writes `'#2f81f7'` |
| Reset line colors (`#reset-view-colors`) | *action* `resetViewPrefs()` + toast | `viewPrefs` ← full `DEFAULT_VIEW_PREFS` | — | DEVICE | lib/viewPrefs.js:60 | **also resets `dockPushesViewport` to `true`** (Interface row) |
| *(Loading rows — see LoadingSettings)* | | | | | | |

### Explorer

| Row label | store | storage key | default | scope | defined at | encoding / notes |
|---|---|---|---|---|---|---|
| When you add files during a session (`#share-new-files`) | `shareNewFiles` | `shared:shareNewFiles` | `'ask'` | DEVICE | lib/sharedLibrary.js:505 | `'ask'`\|`'always'`\|`'never'`; load-write. Migration: if key absent and legacy `shared:autoShareAll === 'true'` ⇒ `'always'` |
| Download shared files automatically (`#auto-download`) | `autoDownload` | `shared:autoDownload` | `true` | DEVICE | lib/sharedLibrary.js:527 | bool str; load-write |
| Offer to merge unsaved work on connect (`#merge-on-connect`) | `mergeOnConnect` | `connect:mergeOnConnect` | `false` | DEVICE | lib/connectionState.js:241 (writer :255) | bool str; load-write |
| Who can unshare a file (`#unshare-authority`) | `unshareAuthority` | `shared:unshareAuthority` | `'anyone'` | DEVICE | lib/sharedLibrary.js:461 | `'anyone'`\|`'owner'`; load-write |
| Keep versions per scene (`#keep-versions`) | `keepVersionsSetting` | `project:keepVersions` | `10` (`KEEP_VERSIONS`) | DEVICE | lib/projectManifest.js:61 | num str, integer ≥ 0 (0 = auto-versioning off); load-write |
| When importing files already in your library (`#import-duplicate-mode`) | `duplicateImportMode` | `importDuplicateMode` | `'ask'` | DEVICE | lib/importDuplicates.js:47 | `'ask'`\|`'skip'`\|`'copy'`; load-write |
| Save name (`#save-name-template`) | `saveNameTemplate` | `saveNameTemplate` | `'[name]'` | DEVICE | lib/saveName.js:149 (DEFAULT_TEMPLATE :26) | raw string; load-write |
| Keep a recycle bin (`#recycle-bin`) | `recycleBinEnabled` | `shared:recycleBin` | `true` | DEVICE | lib/sharedLibrary.js:574 | bool str; load-write |
| Delete without asking (`#delete-no-confirm`) | `deleteWithoutConfirm` | **`shared:deleteNoConfirm`** | `false` | DEVICE | lib/sharedLibrary.js:556 | bool str; load-write |
| Keep deleted files after a reload (`#keep-recycle-bin`) | `keepRecycleBin` | `shared:keepRecycleBin` | `false` | DEVICE | lib/sharedLibrary.js:577 | bool str; load-write |
| Deleted files log (`#deleted-log`) | `deletedLogEnabled` | `shared:deletedLog` | `true` | DEVICE | lib/sharedLibrary.js:618 | bool str; load-write |
| Storage used — Show breakdown (`#settings-storage`) | *action* `openStorageModal()` | — | — | — | lib/storageUsage.js:743 | |

### VR

Order: "VR override", then the whole `VRSettingsSection` (see its table), then the rows below.

| Row label | store | storage key | default | scope | defined at | encoding / notes |
|---|---|---|---|---|---|---|
| VR override | `vrOverride` (+ inline `onclick` toggling the key) | `vrOverride` | off (key absent) | DEVICE | stores/sceneStore.js:55 (init `false`); boot read components/Scene.svelte:191 | presence-toggle like Show grid: on stores `'true'`, off REMOVES the key. Boot sets the store to the RAW string (`'true'` or `null`), not a boolean. Also written by components/menu/Controls.svelte:932/943/958 |
| *(VR settings table rows — see VRSettingsSection)* | | | | | | |
| My hand model (`#my-hand-model`) | `myHandModel` via `setMyHandModel(hash)` | `myHandModel` | `''` (Default) | DEVICE+wire: `setMyHandModel` sends `{type:'handmodel', peerId, hash}` + pushes the asset bytes; also in the handshake (`handModelState`) | lib/handModels.js:19 (setter :34, writer :98) | Explorer item content hash or `''`; start-write (`startHandModels`) |
| Colocation probe (dev) — Probe AR capabilities (`#ar-probe-run`) | *action* `probeSupport()` + `runArProbe()` | writes `arprobe-findings-v1` (JSON list) and `arprobe-anchor-v1` (JSON) | — | DEVICE | lib/arProbe.js:186, :522 (keys :24-25) | |
| Colocation probe (dev) — Clear stored anchor (`#ar-probe-clear`) | *action* `clearProbeState()` | removes `arprobe-anchor-v1` and `arprobe-findings-v1` | — | DEVICE | lib/arProbe.js:598 | |
| Probe report *(only when findings exist; read-only)* | `probeFindings` | `arprobe-findings-v1` | `[]` | DEVICE | lib/arProbe.js:63 | JSON array of `{ok, step, detail}` |
| Colocation — Colocate here (`#colocate-here`) | *action* `colocateHereFromView()` → `setRoomAlignment` | `roomAlignment` not persisted (a persistent anchor `colocation-anchors-v1` is minted only in-headset) | — | DEVICE | lib/colocationCalibrate.js:298; store lib/colocation.js:209 | |
| Colocation — Stop (`#colocate-stop`) | *action* `stopColocation()` | none (keeps the anchor record) | — | DEVICE | lib/colocationCalibrate.js:317 | |
| Colocation — Forget <room> (`#colocate-forget`) | *action* `forgetRoom(key)`; candidate from `anchorRecords`+`roomAlignment` via `forgetCandidate` | removes `[key]` from `colocation-anchors-v1` AND from `colocation-nudge-v1` | — | DEVICE | lib/colocationAnchors.js:487 (store :103, key :66) | JSON map `{roomKey: {handle, alignment:{px,py,pz,yaw}, at}}` |
| Fine-tune X/Y/Z/Yaw (`#nudge-dx`…`#nudge-dyaw`) *(only while colocated)* | `roomNudge` via `setRoomNudge(patch)` | `colocation-nudge-v1` | `null` (zero) | DEVICE | store lib/colocation.js:504; setter lib/colocationNudge.js:121 (key :44) | JSON map `{roomKey: {dx, dy, dz, dyaw, at}}` (metres / radians; the Yaw field shows degrees); an all-zero nudge deletes the room's entry |
| Fine-tune — Reset (`#nudge-reset`) | *action* `resetRoomNudge()` | deletes current room's entry in `colocation-nudge-v1` | — | DEVICE | lib/colocationNudge.js:153 | |
| Ghost hands (`#colocated-ghost-hands`) | `colocatedGhostHands` | `colocatedGhostHands` | `true` | DEVICE | lib/colocationPresence.js:69 (writer :249) | bool str, read `!== 'false'`; load-write |

### AI

| Row label | store | storage key | default | scope | defined at | encoding / notes |
|---|---|---|---|---|---|---|
| Enable assistant | `aiEnabled` (bind) + `setAiEnabled` on change | `aiEnabled` | `false` | DEVICE | lib/ai/providers.js:129 (setter :219, key :92) | bool str; setter-only |
| Providers — list / active radio | `aiProviders`, `aiActiveProvider` via `setAiActiveProvider(id)` | `aiProviders`, `aiActiveProvider` | `[]`, `null` | DEVICE | lib/ai/providers.js:114 / :118 (keys :90-91, setter :210) | `aiProviders`: JSON array; `aiActiveProvider`: provider id string, **key removed when null**; setter-only. The first provider added becomes active automatically |
| Providers — Edit / ✕ / + Add provider | *actions* `aiStartEdit` (form), `removeAiProvider(id)`, `aiStartAdd` | `aiProviders` (+ `aiActiveProvider` if the active one was removed) | — | DEVICE | lib/ai/providers.js:200 | |
| New / Edit provider form — Save | *action* `addAiProvider(config)` / `updateAiProvider(id, config)` | `aiProviders` | — | DEVICE | lib/ai/providers.js:154 / :185 | each record `{id, preset, label, baseUrl, apiKey, model, stream?, physicsTools?, temperature?, models?, managedBy?}` — `stream` stored only when `false`, `physicsTools` only when `true`, `temperature` only when a number, `models` ≤ 500. Plaintext API key |
| New / Edit provider form — Test connection | *action* `testConnection(...)` / `listModels(...)` | none | — | — | lib/ai/client | |
| *(Voice typing rows — see AiSttSettings)* | | | | | | |
| Mesh generation | `meshGenEnabled` (bind) + `setMeshGenEnabled` | `meshGenEnabled` | `false` | DEVICE | lib/ai/meshProviders.js:90 (setter :175, key :55) | bool str; setter-only |
| Mesh providers — list / active radio | `meshProviders`, `meshActiveProvider` via `setMeshActiveProvider` | `meshProviders`, `meshActiveProvider` | `[]`, `null` | DEVICE | lib/ai/meshProviders.js:76 / :79 (keys :53-54) | as AI; active key removed when null; first added becomes active |
| New / Edit mesh provider form — Save | *action* `addMeshProvider` / `updateMeshProvider`; ✕ `removeMeshProvider` | `meshProviders` | — | DEVICE | lib/ai/meshProviders.js:114 / :142 / :158 | record `{id, kind, label, baseUrl, apiKey, …preset.defaults, workflowJson?, outputNodeId? (comfyui), mode?, assetProxy? (meshy), managedBy?}` |
| Storage | — (info only) | — | — | — | — | |

### Export / Node types

Each section is a single component — see ExportSettingsSection and NodeTypesSection below.

### Connection

| Row label | store | storage key | default | scope | defined at | encoding / notes |
|---|---|---|---|---|---|---|
| Session size (`#soft-peer-cap`) | `softPeerCap` | `connect:softPeerCap` | `8` (`SOFT_PEER_CAP_DEFAULT`) | DEVICE | lib/connectionState.js:119 (consts :85-86) | num str, integer 2–16 (`HARD_PEER_CAP` 16); load-write |
| Signaling server (`#peer-server-mode`) | `peerServerConfig.mode` via `setPeerMode` | `peerServerConfig` | `'default'` | DEVICE | lib/peerServer.js:170 (key :135, defaults :137) | JSON `{mode, custom:{host, port, path, secure, key, stunUrls, turnUrls, turnUsername, turnCredential}}`; mode `'default'`\|`'public'`\|`'custom'`\|`'local'`; load-write |
| Server host *(custom mode only)* | `peerServerConfig.custom.host` via `setPeerCustom` | `peerServerConfig` | `''` | DEVICE | lib/peerServer.js:170 | |
| Port + path *(custom)* | `.custom.port`, `.custom.path` | `peerServerConfig` | `443`, `'/peerjs'` | DEVICE | lib/peerServer.js:170 | default port is a NUMBER; after an edit it is the input's STRING |
| Secure (wss) *(custom)* | `.custom.secure` | `peerServerConfig` | `true` | DEVICE | lib/peerServer.js:170 | boolean |
| TURN URLs *(custom)* | `.custom.turnUrls` | `peerServerConfig` | `''` | DEVICE | lib/peerServer.js:170 | comma-separated string |
| TURN credentials *(custom)* | `.custom.turnUsername`, `.custom.turnCredential` | `peerServerConfig` | `''`, `''` | DEVICE | lib/peerServer.js:170 | |
| STUN URLs *(custom)* | `.custom.stunUrls` | `peerServerConfig` | `''` | DEVICE | lib/peerServer.js:170 | (`custom.key` exists in the record but has no row) |
| Apply changes — Apply (`#peer-server-apply`) | *action* `applyPeerServer()` → `$peers.switchServer(null)` (falls back to `location.reload()`) | none | — | — | components/menu/Settings.svelte:162 | |
| Apply changes — Reload (`#peer-server-reload`) | *action* `location.reload()` | none | — | — | | |

### Shortcuts

| Row label | store | storage key | default | scope | defined at | encoding / notes |
|---|---|---|---|---|---|---|
| Each rebindable shortcut (click keys → capture) | `shortcuts` registry (array, not a store) via `rebindShortcut(id, combo)` | `shortcutOverrides` | no overrides (key absent) | DEVICE | registry lib/shortcuts.js:182; key :762; save :791 | JSON `{shortcutId: comboString}`; **key removed when the map is empty**; setting a combo equal to `defaultKeys` deletes that entry |
| Conflict — Swap | *action* `setOverride(other.id, mine.keys)` + `setOverride(id, keys)` | `shortcutOverrides` | — | DEVICE | lib/shortcuts.js:994 | |
| Per-row reset (↺) | *action* `resetShortcut(id)` | `shortcutOverrides` | — | DEVICE | lib/shortcuts.js:1006 | |
| Reset all (`#shortcut-reset-all`) | *action* `resetAllShortcuts()` | removes `shortcutOverrides` | — | DEVICE | lib/shortcuts.js:1012 | |
| Layout note (`#shortcut-layout-note`) | `nonLatinLayoutSeen` (read-only) | not persisted | `false` | runtime | lib/shortcuts.js:1095 | |
| Locked rows | — (display only) | — | — | — | | |

### About

| Row label | store | storage key | default | scope | defined at | encoding / notes |
|---|---|---|---|---|---|---|
| Version | `versionString()` (read-only) | — | — | — | lib/version.js | |
| Diagnostics — Copy diagnostics (`#about-copy-diagnostics`) | *action* `copyDiagnostics()` + toast | none (clipboard) | — | — | lib/diagnostics | |
| Cloud plugin *(only with a plugin)* | `cloudPluginInfo` (read-only) | not persisted | `null` | runtime | lib/cloudHooks.js:196 | |
| Dev Builds / Source Code / Modules / Docs | — (links) | — | — | — | | |

### Modal footer

| Row label | store | storage key | default | scope | defined at | encoding / notes |
|---|---|---|---|---|---|---|
| Reset settings | *action* `safeStorage.clear()` | **clears ALL of localStorage** (every key in this document, plus non-settings keys) and the in-memory fallback | — | DEVICE | lib/safeStorage.js:125 | |
| Clear saved session | *action* `clearSavedSession()` | IndexedDB key `latest` deleted (+ toast) | — | DEVICE | lib/autosave.js:824 | |
| What's new (`#about-whats-new`) | *action* `openWhatsNew()` (+ `settingsOpen.set(false)`) | writes `lastSeenVersion` = APP_VERSION | — | DEVICE | lib/whatsNew.js:65 (markSeen :56) | |

### Settings window chrome (not rows, but persisted by the modal)

| What | store | storage key | default | scope | defined at | notes |
|---|---|---|---|---|---|---|
| Last section shown in the sidebar | settingsNav (`createSettingsNav`) | `settings:section` | — | DEVICE | lib/settingsNav.js:23 (write :74, read :101) | `sectionKeyOf(label)` = lowercase alnum (`interface`, `nodetypes`, `touchcontrols`, …) |
| WindowShell (key `"settings"`) sidebar state | WindowShell `$state` | `ws:settings:primaryOpen`, `ws:settings:secondaryOpen`, `ws:settings:secondaryMode`, `ws:settings:secondaryPinned`, `ws:settings:side`, `ws:settings:primaryWidth`, `ws:settings:secondaryWidth` | primaryWidth 168 | DEVICE | components/shared/WindowShell.svelte:52-68 | uses raw `localStorage`, not safeStorage |
| Search box | `settingsQuery` (component `let`) | not persisted | `''` | — | Settings.svelte:588 | |

---

## settings/TextSelectionSettings.svelte (Interface)

| Row label | store | storage key | default | scope | defined at | encoding / notes |
|---|---|---|---|---|---|---|
| Allow text selection everywhere (`#allow-text-select`) | `allowTextSelection` | `allowTextSelection` | `false` | DEVICE | lib/textSelection.js:21 (key :18) | bool str; change-only; also toggles `<html>.allow-text-select` |

## settings/AvatarSettings.svelte (Interface ▸ Avatars)

| Row label | store | storage key | default | scope | defined at | encoding / notes |
|---|---|---|---|---|---|---|
| Your character — Customize character… (`#settings-customize-character`) | *action* `settingsOpen.set(false); characterModalOpen.set(true)` | none here | — | — | stores/appStore.js | opens CharacterModal |
| Show everyone as classic heads (`#avatars-peers-classic`) | `peersAsClassic` | `avatars:peersClassic` | `false` | DEVICE | lib/avatars/avatarState.js:36 | **`'1'`/`'0'`** (not true/false); load-write |

## settings/ToursSettings.svelte (Interface ▸ Tours)

| Row label | store | storage key | default | scope | defined at | encoding / notes |
|---|---|---|---|---|---|---|
| Show tours automatically (`#setting-tours-auto`) | no store; `tours.autoStartEnabled()` / `tours.setAutoStart(on)` (re-read via `tourRecords` tick) | `toursAutoStart` | on (key absent) | DEVICE | lib/tours/engine.js:53, :263-268; lib/tours/index.js:34 | off stores `'false'`; on REMOVES the key |
| VR welcome — Start VR welcome (`#setting-tour-vr`) | *action* `startVRWelcome()` (+ close Settings); status text reads `tour.vr-welcome` | progress key `tour.vr-welcome` | — | DEVICE | lib/tours/builtin.js:329 (ids :24-26); key fn engine.js:55 | progress value `'done'` or JSON `{at: n}` |
| Editor tour — Start editor tour (`#setting-tour-editor`) | *action* `startEditorTour()`; status reads `tour.editor` or `tour.editor-touch` (coarse pointer) | `tour.editor` / `tour.editor-touch` | — | DEVICE | lib/tours/builtin.js:338 | |
| Offer Enter VR (`#setting-xr-offer`) | `xrOfferEnabled` | `xrOfferSession` | `true` | DEVICE | lib/xrOffer.js:31 (keys :24-25) | bool str, read `!== 'false'`; load-write. Switching on after off also REMOVES `xrOfferDeclined` |
| Reset tours — Reset all (`#setting-tours-reset`) | *action* `resetAllTours()` → `tours.close(); tours.reset()` | removes `tour.<id>` for every registered tour AND `toursAutoStart` | — | DEVICE | lib/tours/builtin.js:342; engine.js:257 | |

## settings/CheckpointSettings.svelte (Scene ▸ Checkpoints)

| Row label | store | storage key | default | scope | defined at | encoding / notes |
|---|---|---|---|---|---|---|
| Keep automatic checkpoints (`#checkpoints-auto`) | `autoCheckpoints` | `checkpoints:auto` | `true` | DEVICE | lib/checkpoints.js:89 | bool str, read `!== 'false'`; load-write |
| Automatic checkpoint every (`#checkpoints-every`) | `autoCheckpointMinutes` | `checkpoints:every` | `10` | DEVICE | lib/checkpoints.js:91 (choices :59-60) | num str ∈ {5,10,30,60}; load-write |
| Checkpoint storage (`#checkpoints-cap`) | `checkpointCapMb` | `checkpoints:capMb` | `250` | DEVICE | lib/checkpoints.js:93 (choices :57-58) | num str ∈ {100,250,500,1000} (MB); load-write |
| Checkpoint storage — Open the timeline (`#checkpoints-open-timeline`) | *action* `settingsOpen.set(false); checkpointsOpen.set(true)` | none | — | — | stores/appStore.js | |

## settings/LoadingSettings.svelte (Scene ▸ Loading)

| Row label | store | storage key | default | scope | defined at | encoding / notes |
|---|---|---|---|---|---|---|
| Loading placeholders (`#placeholder-style`) | `placeholderStyle` | `placeholderStyle` **+** `placeholderStyleChosen` | `'modern'` | DEVICE | lib/loadStates.js:108 (writer :111) | `placeholderStyle` is **JSON-encoded** (`'"modern"'` / `'"boxes"'`); every pick also writes `placeholderStyleChosen = '1'`; change-only |
| Placeholder grid texture (`#placeholder-grid-on`) | `placeholderGrid.on` via `setGrid` → `normalizeGrid` | `placeholderGrid` | `true` | DEVICE | lib/loadStates.js:120 (defaults :83, persisted() :28) | JSON `{on, size, color, opacity, speed}`; change-only |
| Grid size (m) (`#placeholder-grid-size`) | `placeholderGrid.size` | `placeholderGrid` | `0.5` | DEVICE | lib/loadStates.js:120 | clamp 0.05–10 |
| Grid color (`#placeholder-grid-color`) | `placeholderGrid.color` | `placeholderGrid` | `'#bfe6ff'` | DEVICE | lib/loadStates.js:120 | `#rrggbb` |
| Grid opacity (`#placeholder-grid-opacity`) | `placeholderGrid.opacity` | `placeholderGrid` | `0.45` | DEVICE | lib/loadStates.js:120 | 0–1 |
| Placeholder animation speed (`#placeholder-anim-speed`) | `placeholderGrid.speed` | `placeholderGrid` | `1` | DEVICE | lib/loadStates.js:120 | 0–4 |
| Stuck after (seconds) (`#placeholder-stuck-seconds`) | `placeholderStuckSeconds` | `placeholderStuckSeconds` | `10` | DEVICE | lib/loadStates.js:122 | JSON number (e.g. `'10'`), integer 1–120; change-only |

## settings/NodeEditorViewSettings.svelte (Input ▸ Node editor)

| Row label | store | storage key | default | scope | defined at | encoding / notes |
|---|---|---|---|---|---|---|
| Node editor opens (`#flow-opens`) | `nodeEditorOpens` | `flow:opens` | `'left'` | DEVICE | lib/flowView.js:35 (key :27) | `'left'`\|`'framed'`; load-write |

## settings/SettingsNav.svelte, SettingsSections.svelte, SettingsSection.svelte

Chrome only (sidebar, accordion wrapper). No setting rows. Persistence: `settings:section` via lib/settingsNav.js (see "Settings window chrome").

## TouchControlsSettings.svelte (its own section, header "Touch controls")

| Row label | store | storage key | default | scope | defined at | encoding / notes |
|---|---|---|---|---|---|---|
| Show touch controls (`#touch-visibility-auto/always/never`) | `touchPrefs.visibility` via `setTouchPrefs` | `touchControlsPrefs` | `'auto'` | DEVICE | lib/touchActions.js:251 (key :217, defaults :219) | JSON `{visibility, showInEdit, haptics, scope}`; setter-only. `scope` (`'game'`) has no row here |
| Show in edit (`#touch-show-in-edit`) | `touchPrefs.showInEdit` | `touchControlsPrefs` | `false` | DEVICE | lib/touchActions.js:251 | |
| Haptic tick (`#touch-haptics`) | `touchPrefs.haptics` | `touchControlsPrefs` | `true` | DEVICE | lib/touchActions.js:251 | |
| Look speed (`#touch-look-speed`) | `touchLookSpeed` via `setTouchLookSpeed` | `touchLookSpeed` | `1` | DEVICE | lib/touchControls.js:75 (key :54, setter :78) | num str, clamp 0.25–3; setter-only |
| Layout — Edit layout (`#touch-edit-layout`) | *action* `openTouchLayoutEditor()` (+ close Settings); the editor saves via `saveTouchLayout` | `touchControlsLayouts` | — | DEVICE | lib/touchActions.js:619; store :344 (key :287) | JSON `{global: layout\|null, games: {[gameId]: {v:1, items:{[id]: {x, y, size, opacity, hidden?}}}}}` |
| Layout — Reset (`#touch-reset-layout`) | *action* `resetTouchLayout('game', $gameId)` + `resetTouchLayout('global', $gameId)` + toast | `touchControlsLayouts` (game entry deleted, global → null) | `{global:null, games:{}}` | DEVICE | lib/touchActions.js:375; `gameId` lib/gameSettings.js:183 | |
| Button looks — one row per action (built-ins + the open scene's actions): Upload / Explorer… / ✕ (Released, Pressed), Tint, Size, Default look | `touchTextures` via `setTouchTexture(id, patch)` / `clearTouchTexture(id)` | `touchControlsTextures` | `{}` (built-in look) | DEVICE | lib/touchActions.js:491 (key :455, setter :494, clear :509) | JSON `{[actionId]: {released?: dataURL, pressed?: dataURL, tint?: '#rrggbb', scale?: 0.5–1.6}}`; images are data: URLs ≤ 160 KB; scale 1 is omitted; an empty record is deleted |

## VRSettingsSection.svelte (inside VR)

Rows come from `VR_SETTINGS` (lib/vr/settingsSchema.js:70) filtered to `desktop !== false`, grouped by page
(Comfort, Body, Controls, Display, Editing). Hidden on desktop: `heightReset`, `remap`, `bindingsReset`, `fps`, `mic`.
Each row writes through the row's `set()`; `put(store, key, v)` (settingsSchema.js:61) = `store.set(v)` + `setItem(key, String(v))`.

| Row label | store | storage key | default | scope | defined at | encoding / notes |
|---|---|---|---|---|---|---|
| Turning (`#vr-set-turning`) | `vrSmoothTurn` + `vrSnapAngle` (reads `vrSnapAngleLast`) | `vrSmoothTurn`; `vrSnapAngle` | shown as `'snap'` (smooth false, snap 45) | DEVICE | schema :72; lib/vr/prefs.js:50; stores/sceneStore.js:97 | derived `smooth`/`snap`/`off`. Writes `vrSmoothTurn` bool str; `off` writes `vrSnapAngle='0'`; `snap`/`smooth` restore `vrSnapAngle` from `vrSnapAngleLast` (or 45) if it was 0 |
| Snap angle (`#vr-set-snapAngle`) | `vrSnapAngleLast` (+ `vrSnapAngle`) | `vrSnapAngleLast`; `vrSnapAngle` | `45` | DEVICE | schema :92; lib/vr/prefs.js:60; stores/sceneStore.js:97 | num str ∈ {15,30,45,90}; `vrSnapAngleLast` change-only (persisted()); `vrSnapAngle` written unless snap is 0 while smooth is on. `vrSnapAngle` boot-read is `parseInt(... \|\| '45')` |
| Smooth speed (`#vr-set-smoothSpeed`) | `vrSmoothTurnSpeed` | `vrSmoothTurnSpeed` | `90` | DEVICE | schema :108; lib/vr/prefs.js:52 | num str ∈ {45,90,135,180}; change-only |
| Mirror turn (`#vr-set-mirror`) | `vrMirrorSnapTurn` | `vrMirrorSnapTurn` | `false` | DEVICE | schema :119; stores/sceneStore.js:101 | bool str (put) |
| Comfort vignette (`#vr-set-vignette`) | `vrComfortVignette` | `vrComfortVignette` | `false` | DEVICE | schema :120; lib/vr/prefs.js:54 | bool str; change-only |
| Teleport (`#vr-set-teleport`) | `vrTeleportEnabled` | `vrTeleportEnabled` | `true` | DEVICE | schema :121; stores/sceneStore.js:105 | bool str, read `!== 'false'` (put) |
| Flying (`#vr-set-flying`) | `vrFlying` | `vrFlying` | `false` | DEVICE | schema :122; stores/sceneStore.js:120 | bool str (put) |
| Stance (`#vr-set-stance`) | `vrStance` | `vrStance` | `'standing'` | DEVICE | schema :124; lib/vr/prefs.js:56 | `'standing'`\|`'seated'`; change-only |
| Height (`#vr-set-height`) | `vrHeightOffset` | `vrHeightOffset` | `0` | DEVICE | schema :140; lib/vr/prefs.js:58 | num str, metres −0.5…+0.5 rounded to 0.01; change-only |
| Menu hand (`#vr-set-menuHand`) | `vrMenuHand` (+ `vrBindings` follows) | `vrMenuHand` (+ `vrBindings`) | `'right'` | DEVICE | schema :156; stores/sceneStore.js:92; bindings.js:298 | `'left'`\|`'right'`; the bindings subscriber re-saves `vrBindings` |
| Hold to open menu (`#vr-set-menuHold`) | `vrMenuHold` | `vrMenuHold` | `false` | DEVICE | schema :177; stores/sceneStore.js:130 | bool str (put) |
| Left-handed (`#vr-set-leftHanded`) | derived `isLeftHanded()`; set = `mirrorBindings()` | `vrBindings` (+ `vrMenuHand` via syncMenuHandOut) | `false` (default layout) | DEVICE | schema :178; lib/vr/bindings.js:208, :221 | |
| Grab style (`#vr-set-grabStyle`) | `vrGrabStyle` | `vrGrabStyle` | `'rigid'` | DEVICE | schema :179; stores/sceneStore.js:235 | `'rigid'`\|`'move'`\|`'rotate'` (put) |
| Controls remap table — Hand / Button selects (`#vr-bind-<action>-hand`, `#vr-bind-<action>-control`), Swap them / Cancel | `vrBindings` via `setBinding(id, patch, {swap?})` | `vrBindings` | `defaultBindings()` from `VR_ACTIONS` (lib/vr/bindings.js:45: move L stick, turn R stick, teleport R stick, menu R secondary, mode L secondary, pause L primary, ptt R primary, ping R stickClick, worldPan R grip; grab/select locked) | DEVICE | lib/vr/bindings.js:132 (save :137, setBinding :167) | JSON `{[actionId]: {hand, control}}` |
| Controls remap table — Reset buttons (`#vr-bind-reset`) | *action* `resetBindings()` + toast | `vrBindings` (+ `vrMenuHand`) | — | DEVICE | lib/vr/bindings.js:201 | |
| Refresh rate (`#vr-set-refresh`) | `vrTargetHz` (+ `applyVRFrameRate()`) | `vrTargetHz` | `'auto'` | DEVICE | schema :198; stores/sceneStore.js:165 | STRING `'auto'`\|`'90'`\|`'120'`; load-write |
| Statistics card (`#vr-set-stats`) | `vrStatsOpen` | **`vrStats`** | `false` | DEVICE | schema :218; stores/sceneStore.js:212 | bool str (put) |
| Peer hands (`#vr-set-peerHands`) | `peerHandStyle` | `peerHandStyle` | `'hands'` | DEVICE | schema :219; stores/sceneStore.js:173 | `'model'`\|`'hands'`\|`'spheres'`; load-write |
| Passthrough (`#passthrough-toggle`, red switch) | `vrPassthrough` | `vrPassthrough` | `false` | DEVICE | schema :235; stores/sceneStore.js:125 | bool str (put) + toast |
| Selection wireframe (`#vr-set-wireframe`) | `vrWireframeSelection` | **`vrWireframe`** | `true` | DEVICE | schema :249; stores/sceneStore.js:208 | bool str, read `!== 'false'` (put) |
| Reset panel positions (`#vr-set-resetPanels`, action button) | *action* `resetWindowPoses()` + toast | removes `vrWindowPoses` | — | DEVICE | schema :250; lib/vrWindowPoses.js:53 | |
| Game HUD (`#vr-set-gameHud`) | `vrHudPlacement` via `setVrHudPlacement` | `vr:hudPlacement` | `'head'` | DEVICE | schema :252; lib/vrHudPrefs.js:37 (key :9) | `'head'`\|`'world'`\|`'wrist'`; setter-only. Migration: absent and legacy `vr:gameStrip === 'false'` ⇒ `'wrist'` |
| Game HUD size (`#vr-set-gameHudSize`) | `vrHudSize` via `setVrHudSize` | `vr:hudSize` | `'medium'` | DEVICE | schema :268; lib/vrHudPrefs.js:39 | `'small'`\|`'medium'`\|`'large'`; setter-only |
| Button hints (`#vr-set-gameHudHints`) | `vrHudHints` via `setVrHudHints` | `vr:hudHints` | `true` | DEVICE | schema :283; lib/vrHudPrefs.js:41 | bool str, read `!== 'false'`; setter-only |
| Hold to move vertex (`#vr-set-vertexHold`) | `vrVertexHold` | `vrVertexHold` | `true` | DEVICE | schema :302; stores/sceneStore.js:116 | bool str, read `!== 'false'` (put) |
| Sleeve palette (`#vr-set-sleeve`) | `vrSleeveEnabled` | `vrSleeveEnabled` | `false` | DEVICE | schema :303; stores/sceneStore.js:111 | bool str (put) |
| Face edit limit (`#vr-set-faceCap`, free number ≥ 10 on desktop) | `vrFaceCap` | `vrFaceCap` | `2500` (`VR_FACE_CAP`) | DEVICE | schema :305; lib/faceEdit.js:110 (const :107) | num str (int); load-write |
| Vertex edit limit (`#vr-set-vertexCap`, free number ≥ 10) | `vrVertexCap` | `vrVertexCap` | `800` (`VR_VERTEX_CAP`) | DEVICE | schema :316; lib/meshEdit.js:1779 (const :1776) | num str (int); load-write |

## AiSttSettings.svelte (inside AI)

| Row label | store | storage key | default | scope | defined at | encoding / notes |
|---|---|---|---|---|---|---|
| Voice typing provider (`#ai-stt-preset`) | `sttConfig.preset` via `applySttPreset(preset)` (also resets baseUrl + model to the preset's) | `aiStt` | `'openai'` | DEVICE | lib/ai/stt.js:64 (key :32, defaults :35, setter :67) | JSON `{preset, baseUrl, apiKey, model, language}` (normalized); setter-only |
| Voice typing server — Base URL (`#ai-stt-base`) | `sttConfig.baseUrl` via `setSttConfig` | `aiStt` | `'https://api.openai.com/v1'` | DEVICE | lib/ai/stt.js:64 | trailing `/` stripped |
| — API key (`#ai-stt-key`) | `sttConfig.apiKey` | `aiStt` | `''` | DEVICE | lib/ai/stt.js:64 | plaintext |
| — Model (`#ai-stt-model`) | `sttConfig.model` | `aiStt` | `'whisper-1'` | DEVICE | lib/ai/stt.js:64 | empty ⇒ preset default |
| — Language hint (`#ai-stt-language`) | `sttConfig.language` | `aiStt` | `''` | DEVICE | lib/ai/stt.js:64 | |
| — Test connection (`#ai-stt-test`) | *action* `transcribe(silentWav())` | none | — | — | lib/ai/stt.js:102 | |

## ExportSettingsSection.svelte (Export)

All rows share one key, `export:prefs` (lib/export/exportStores.js:39), JSON of the full coerced prefs
`{preset, startFullscreen, showFps, quality, vrButton, useCdnForPacks, thumbnail, viewportW, viewportH, embedUrl}`;
store `exportPrefs` (exportStores.js:93), setter-only via `setExportPrefs` (:96). Defaults at :46.

| Row label | store | storage key | default | scope | defined at | encoding / notes |
|---|---|---|---|---|---|---|
| Show Made with ThePrototype badge (`#export-badge`) | — (always checked, disabled) | none | on | — | — | |
| Start fullscreen (`#export-start-fullscreen`) | `exportPrefs.startFullscreen` | `export:prefs` | `false` | DEVICE | lib/export/exportStores.js:93 | boolean |
| Show FPS (`#export-show-fps`) | `exportPrefs.showFps` | `export:prefs` | `false` | DEVICE | lib/export/exportStores.js:93 | boolean |
| Quality (`#export-quality`) | `exportPrefs.quality` | `export:prefs` | `'auto'` | DEVICE | lib/export/exportStores.js:93 | `auto`\|`high`\|`medium`\|`low` |
| Include VR button (`#export-vr-button`) | `exportPrefs.vrButton` | `export:prefs` | `true` | DEVICE | lib/export/exportStores.js:93 | boolean |
| Use CDN for packs (`#export-cdn-packs`) | `exportPrefs.useCdnForPacks` | `export:prefs` | `false` | DEVICE | lib/export/exportStores.js:93 | boolean |
| Compress textures (`#export-compress-textures`) | — (disabled, not wired) | none | off | — | — | |

## NodeTypesSection.svelte (Node types)

| Row label | store | storage key | default | scope | defined at | encoding / notes |
|---|---|---|---|---|---|---|
| Filter node types… (`#node-types-filter`) | component `let filter` | not persisted | `''` | — | NodeTypesSection.svelte:566 | |
| Turn all on (`#node-types-enable-all`) | `disabledNodeTypes.set([])` | removes `disabledNodeTypes` | — | DEVICE | lib/nodeTypePrefs.js:21 | |
| Group checkbox (`.node-type-group-toggle`) / per-type checkbox (`.node-type-toggle`) | `disabledNodeTypes` via `setNodeTypesEnabled(types, on)` | `disabledNodeTypes` | `[]` (all on) | DEVICE | lib/nodeTypePrefs.js:21 (key :9, setter :29) | JSON array of type ids, sorted; **key removed when empty**; load-write |

## water/WaterSettings.svelte (Scene)

| Row label | store | storage key | default | scope | defined at | encoding / notes |
|---|---|---|---|---|---|---|
| Water quality (`#water-quality`) | `waterQuality` | `water:quality` | `'auto'` | DEVICE | lib/water/waterPrefs.js:19 (key :7) | `auto`\|`high`\|`medium`\|`low`; load-write |

## scene/*.svelte — NOT in the Settings modal

These four are imported by `components/menu/Inspector.svelte:13-16` (Configure Scene panel), not by Settings.svelte.
All are **SHARED scene data**: fields of the `scenePhysicsState_` singleton (lib/scenePhysics.js:247), written via
`setScenePhysics` (:276), replicated as message **`scenephysics`** (full state, latest-wins on `changedAt`;
handshake reply :318), saved in `.tpscene`/sessions as payload key **`physics`** (lib/sessions.js:317) and in the
autosave snapshot as **`physics`** (lib/autosave.js:363). `scenePhysicsSnapshot()` (:324) returns null when everything
is default, and each field below is OMITTED from the state when at its default.

| Row label | store | storage key | default | scope | defined at | encoding / notes |
|---|---|---|---|---|---|---|
| Hold camera until loaded (`#hold-camera-until-loaded`) — CameraHoldSetting | `scenePhysicsState_.holdCamera` | scene `physics.holdCamera` / msg `scenephysics` | `false` (omitted) | SHARED | lib/scenePhysics.js:214 | present only as `true` |
| Start simulation on load (`#sim-on-load`) — SimOnLoadSetting | `.simOnLoad` via `setSimOnLoad` | scene `physics.simOnLoad` / msg `scenephysics` | `false` (omitted) | SHARED (+ undo kind `simonload`) | lib/scenePhysics.js:219; lib/sim/simOnLoadHistory.js:16 | present only as `true` |
| Fluid budget (`#scene-fluid-budget`) — FluidBudgetSetting | `.fluidBudget` | scene `physics.fluidBudget` / msg `scenephysics` | `8000` (`DEFAULT_FLUID_BUDGET`, omitted when not set) | SHARED | lib/scenePhysics.js:222; lib/sim/fluidEmitterCore.js:253 | integer 200–20000 |
| Selection passes through — Water / Transparent surfaces / Triggers (`#pick-through-water/transparent/triggers`) — SelectionPassSetting | `.pick` | scene `physics.pick` / msg `scenephysics` | `{water:true, transparent:false, triggers:false}` (omitted when equal) | SHARED | lib/scenePhysics.js:74, :217; lib/selectThrough.js:64 | object `{water, transparent, triggers}` |

---

## Uncertainties / caveats

- `?` ThemedSelect with numeric items (`checkpoints:every`, `checkpoints:capMb`, VR choices): the stored string is the same either way, but whether the in-memory store holds a number or a string after a pick depends on ThemedSelect (not checked).
- `?` The exact JSON shape of an in-progress tour's progress (`tour.<id>` = `{at: n}`) was read from engine.js:96-100's reader only; the writer (`saveProgress`) was not opened.
- `?` "Colocate here" / "Stop" persistence: `setRoomAlignment` (lib/colocation.js:225) was not read in full; it is documented as local and not replicated, and the anchor record is minted only in a headset session.
- The four `scene/*.svelte` components are not part of the Settings modal; they are included because they were listed.
