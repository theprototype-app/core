<script>
	import { safeStorage } from '$lib/safeStorage';
  // 34 R4 (A2): the debug hook's table. A STATIC import on purpose (the module has no static
  // deps, only lazy loaders): the install must start synchronously in onMount, before the first
  // frames' blocking shader links. A dynamic import here queued it behind them (a third e2e page
  // took 34 s instead of 8 s to publish __stores).
  import { installDebugHooks } from '$lib/debugHooks'
  import { onMount } from 'svelte'
  import { Canvas } from '@threlte/core'
  // 30 P0: threlte's Canvas defaults `shadows` to PCFSoftShadowMap, which three 0.185
  // deprecates and silently downgrades to PCFShadowMap on the first shadow render (with a
  // console warning). Asking for PCF directly is the identical picture, minus the warning.
  import { PCFShadowMap } from 'three'
  import Scene from './components/Scene.svelte'
  import Menu from './components/Menu.svelte'
  import ConfirmModal from './components/menu/ConfirmModal.svelte'
  // loose-scenes fix (bug 2a): importing something you already have. Importing this
  // module is ALSO what registers explorer.js's duplicate-resolver seam, which is why
  // the whole feature turns on here rather than inside the leaf.
  import ImportDuplicatesModal from './components/menu/ImportDuplicatesModal.svelte'
  // R22 round 13 P2: the storage breakdown. Mounted here beside the other panel modals
  // and OUTSIDE the {#if !$isLocked} block is deliberately NOT wanted - it is an editor
  // panel, so it sits with ConfirmModal where every entry point can reach it.
  import StorageModal from './components/menu/StorageModal.svelte'
  import Flow from './components/Flow.svelte'
  import FlowCode from './components/editors/FlowCode.svelte'
  import AnimationWindow from './components/editors/AnimationWindow.svelte'
  import UvEditor from './components/editors/UvEditor.svelte'
  import ShaderEditor from './components/editors/ShaderEditor.svelte'
  import { SvelteFlowProvider } from '@xyflow/svelte'
  import Explorer from './components/editors/Explorer.svelte'
  import TextEditorWindow from './components/editors/TextEditorWindow.svelte'
  import FilePreviewWindow from './components/editors/FilePreviewWindow.svelte'
  import { previewWindows } from './lib/fileWindows'
  import ModelPreviewWindow from './components/editors/ModelPreviewWindow.svelte'
  import DungeonMinimap from './components/play/DungeonMinimap.svelte'
  // 26-A: the desktop Statistics window + the sampler that feeds it and the status-line
  // budget meter. `renderer.info` had exactly one reader before this (the VR plate).
  import StatsOverlay from './components/menu/StatsOverlay.svelte'
  import MomentReport from './components/menu/MomentReport.svelte'
  import ProfilerLive from './components/menu/ProfilerLive.svelte'
  import { startSceneMetrics, budgetSummary } from './lib/sceneBudget'
  import { startPerfRecorder } from './lib/perf/recorder'
  import { startDetailedProbe } from './lib/perf/detailed'
  import { startPerfLive } from './lib/perf/live'
  import { startPerfBeacon } from './lib/perf/beacon'
  import { startStaleModuleWatch } from './lib/staleModules'
  import { startLod } from './lib/lod'
  import { startLodGroups } from './lib/lodGroup'
  import { startKitInstancing } from './lib/kitInstancing'
  import PlayReticle from './components/play/PlayReticle.svelte'
  import TouchPlayControls from './components/play/TouchPlayControls.svelte'
  import DrawToolbar from './components/menu/DrawToolbar.svelte'
  import SculptToolbar from './components/menu/SculptToolbar.svelte'
  import SplineToolbar from './components/menu/SplineToolbar.svelte'
  import ModuleToolboxLayer from './components/ui/ModuleToolboxLayer.svelte'
  import { isLocked } from './stores/sceneStore'
  // 29-E: `?embed=1` — the editor windows and the dock inset stand down for the page's
  // life; a corner link and a ▶ button are the only chrome an embed draws
  import { embedMode, embedOpenUrl, requestPlay } from './lib/playMode'
  import { objectsGroup, globalRenderer } from './stores/sceneStore'
  import { startFlowRuntime, resumeFlowRuntime } from '$lib/flowRuntime'
  // 27-G: the one overlay that must sit above everything, because nothing else on
  // screen is usable while the graphics context is gone.
  import ContextLostOverlay from './components/ContextLostOverlay.svelte'
  // 26-G: the frame-freeze half of Stage 4 (the context-loss half is the overlay above)
  import RenderPausedOverlay from './components/RenderPausedOverlay.svelte'
  import './lib/overloadGuard'
  import './lib/textSelection' // 36 U6: chrome text is not selectable; viewport drags never select
  // 27-D: safe mode pauses the runtime BEFORE it is started, so a scene whose scripts
  // hang on load can still be opened and edited.
  import { flowPaused } from './stores/flowStore'
  import { startNodeSync } from '$lib/nodesHandler'
  import { startLockSweep } from '$lib/lockControl'
  import { loadUserModules } from '$lib/userModules'
  import { startEnvironment } from '$lib/environment'
  import { startSceneMusic } from '$lib/sceneMusic'
  import { startSceneBounds } from '$lib/sceneBounds'
  import { startShortcuts } from '$lib/shortcuts'
  import { startSnapping } from '$lib/snapping'
  import { startMultiTransform } from '$lib/multiTransform'
  import { startLightParams } from '$lib/lightParams'
  import { startShadowDefaults } from '$lib/shadowDefaults'
  import { startPackRefs } from '$lib/packRefs'
  import { startViewMode } from '$lib/viewMode'
  import { startInputRuntime } from '$lib/inputRuntime'
  // 21-E2.4: right-drag a HUD element in the viewport. Installed here rather than from
  // HudLayer because it is a window-CAPTURE gesture that must exist whether or not the
  // layer is currently mounted — the `startInputRuntime` shape, idempotent.
  import { startHudViewportDrag } from '$lib/hudViewportDrag'
  import { startPossess } from '$lib/possess'
  import { startHandModels } from '$lib/handModels'
  import { startAutosave } from '$lib/autosave'
  import { startSceneAssets } from '$lib/sceneAssets'
  import { startNetworkQuality } from '$lib/networkQuality'
  import { startAudioDevices } from './lib/audioDevices'
import { registerVRPatch } from './lib/vrPatch'
import { startMusicToolbox } from './lib/musicToolbox'
  import { startWhatsNew } from '$lib/whatsNew'
  import { startUpdateCheck } from '$lib/updateCheck'
  // 27-B: the diagnostics ring buffer + global error capture (hardening audit H4)
  import { startDiagnostics, registerDiagnosticsSection } from '$lib/diagnostics'
  // 27-H: whether localStorage is working, and what has fallen back to memory
  import { storageDebug } from '$lib/safeStorage'
  // 27-A: the wire-failure counters contribute their own diagnostics section
  import { startWireErrors } from '$lib/wireErrors'
  import { startTrackpadNav } from '$lib/trackpadNav'
  import { startInviteLinks } from '$lib/inviteLinks'
  import { startHelperLayer, helpersInPlay } from '$lib/helperLayer'
  import { startCloudPlugin } from '$lib/cloudPlugin'
  import { startShaderGraphs } from '$lib/shaderGraph'
  import { startMaterialSharing } from '$lib/materialSharing'
  import { startShaderSync } from '$lib/shaderSync'
  import { startHudSync } from '$lib/hudSync'
  import { startHudImages } from '$lib/hudImages'
  import { startGameSync } from '$lib/gameSync'
  import { startGamePresence } from '$lib/gamePresence'
  import { startColocationCalibration } from '$lib/colocationCalibrate'
  import { startColocationPresence } from '$lib/colocationPresence'
  import { startColocationAnchors } from '$lib/colocationAnchors'
  import { startColocationNudge } from '$lib/colocationNudge'
  import ColocationBadge from './components/menu/ColocationBadge.svelte'
  import { loadProjectManifest } from '$lib/projectManifest'
  import { startSharedLibrary } from '$lib/sharedLibrary'
  import { startSceneIdentity } from '$lib/sceneIdentity'
  import GameChip from './components/hud/GameChip.svelte'
  import HudLayer from './components/hud/HudLayer.svelte'
  // 31 K3: the game shell — the pause menu + its wiring
  import GameShellMenu from './components/hud/GameShellMenu.svelte'
  import FpsCounter from './components/hud/FpsCounter.svelte'
  import { startGameShell } from '$lib/gameShellWire'
  // 33 (L2-L4): keep/unload modules on a scene switch, and the scope a kept module lives in
  import { startSceneSwitch } from '$lib/sceneSwitch'
  import HudEditor from './components/editors/HudEditor.svelte'
  import { importFile, load } from '$lib/fileHandler.svelte'
  import { showToast, showInfoToast } from './stores/appStore'
  // 34 PF: the Profiler dock tab, loaded the first time it opens (it is closed by default)
  import { profilerClose } from './stores/appStore'
  import { peers, userdata } from './stores/appStore'
  import { get } from 'svelte/store'
  import { initModules, disabledModules } from '$lib/moduleSDK'
  import { coreModules } from './modules/index.js'
  import ModulesManager from './components/menu/ModulesManager.svelte'
  // W9: the pref that decides whether the bottom dock RESIZES the viewport (default)
  // or overlays it. A local view preference — see the .viewport style below.
  import { viewPrefs } from '$lib/viewPrefs'

  // before children mount: node components/effects must exist when the
  // flow editor and runtime first look them up
  initModules(coreModules.filter((mod) => !get(disabledModules).includes(mod.id)))

  // node graph animations keep running even when the flow drawer is closed
  onMount(() => {
    // 27-B: FIRST, so a failure during the rest of this boot is already recorded.
    startDiagnostics()
    startWireErrors()
    // 26-A: one rAF loop, ~2 samples a second. Started here rather than inside Scene so
    // it keeps measuring while the canvas is remounting — which is exactly when a
    // report about the app freezing tends to be written.
    startSceneMetrics()
    // 34 PF/R1: the always-on light ring (moments, beacon windows) + user recordings
    startPerfRecorder()
    startDetailedProbe()
    // 34 PF (profiler-xr): stream this device's frames to a peer that asks (and watch theirs)
    startPerfLive()
    // 34 R1: performance reports (opt-in; inert without VITE_PERF_REPORTS_URL)
    startPerfBeacon()
    // 34 R1: an installed module older than this build expects -> toast + a Modules row
    startStaleModuleWatch()
    // 31-perf P2: automatic levels of detail (a render-time swap; see lod.js)
    startLod()
    // 33: per-object LOD GROUPS (userData.lod / a pack item's `lods`) ride the same render pass
    startLodGroups()
    // 33-scenes: pristine copies of one kit piece draw as ONE instanced call (kitInstancing.js)
    startKitInstancing()
    // …and the numbers ride the bundle, so a report carries them (audit H4 + roadmap
    // 26 section 3's last row).
    registerDiagnosticsSection('scene-budget', () => budgetSummary())
    // The bundle reads its context through registered sections, which is what keeps
    // diagnostics.js a leaf: it never imports a store, the root component does.
    registerDiagnosticsSection('session', () => {
      /** @type {any} */ const peer = get(peers)
      /** @type {any} */ const group = get(objectsGroup)
      /** @type {any} */ const renderer = get(globalRenderer)
      let objects = 0
      let meshes = 0
      group?.traverse?.((/** @type {any} */ o) => {
        if (o === group) return
        objects++
        if (o.isMesh) meshes++
      })
      return {
        peerId: peer?.peer?.id ?? null,
        openConns: peer ? Object.keys(peer.connections ?? {}).length : 0,
        roster: (get(userdata) ?? []).length,
        objects,
        meshes,
        render: renderer?.info
          ? {
              calls: renderer.info.render.calls,
              triangles: renderer.info.render.triangles,
              geometries: renderer.info.memory.geometries,
              textures: renderer.info.memory.textures
            }
          : null
      }
    })
    // 27-H (audit M4): is persistence actually working? `degraded` means settings are
    // applying but not surviving a reload — invisible from the outside, and the first
    // thing worth knowing when somebody reports that their preferences keep resetting.
    registerDiagnosticsSection('storage', () => storageDebug())
    // 15-N: register the PWA service worker (a no-cache passthrough — see
    // static/sw.js) so mobile browsers offer "Install app". Dev is skipped: a
    // SW in front of vite's HMR only causes confusion.
    if ('serviceWorker' in navigator && import.meta.env.PROD)
      navigator.serviceWorker.register('/sw.js').catch(() => {})
    // 27-D (audit C1): SAFE MODE. A scene whose scripts hang on load cannot be repaired,
    // because the editor never gets a frame to repair it in. Opening the same URL with
    // `#safe` starts with the flow runtime PAUSED: the graph loads, the node can be
    // edited or deleted, and Resume (or a reload without the hash) starts it again.
    //
    // The hash is the whole mechanism, deliberately. A HELD key cannot be read at boot —
    // there is no synchronous API for modifier state, only events — so a Shift check here
    // would look like a second way in while being one the first frame could never honour.
    if (typeof location !== 'undefined' && /(^|[#&])safe\b/i.test(location.hash)) {
      flowPaused.set({ paused: true, reason: 'safe mode' })
      showInfoToast(
        'safe-mode',
        'Safe mode: the flow runtime is paused, so scripts are not running. Fix the node, then press Resume.',
        [{ label: 'Resume', action: () => resumeFlowRuntime() }]
      )
    }
    startFlowRuntime()
    startNodeSync()
    startLockSweep()
    startMultiTransform()
    startLightParams()
    startShadowDefaults()
    startPackRefs()
    startViewMode()
    startInputRuntime()
    startHudViewportDrag()
    startPossess()
    startHandModels()
    loadUserModules()
    startEnvironment()
    startSceneMusic()
    startSceneBounds()
    startShortcuts()
    startSnapping()
    startAutosave()
    startSceneAssets()
    startNetworkQuality()
    startAudioDevices() // 23-A3: the device reconcile off objectsGroup
    registerVRPatch() // 23-B1: plugs, cables and knobs in VR
    startMusicToolbox() // 23-B2: the Music toolbox, through the module toolbox registry
    // RW: first visit -> welcome overlay; a new version -> logo dot + one toast
    startWhatsNew()
    // V8: poll the deployed version.json — one reload toast per session (prod only)
    startUpdateCheck()
    // open-core (M1): load a configured cloud plugin (no-op in the OSS build)
    startCloudPlugin()
    // QW: trackpad two-finger pan + pinch page-zoom guards (desktop + mobile)
    startTrackpadNav()
    // 24-D1: an invite link pasted into the open tab (hashchange → dial / ask)
    startInviteLinks()
    // 24-E2: the editor camera renders the helper layer outside Play (debug toggle in Play)
    startHelperLayer()
    // shader graphs: the compile/target wiring + the replication and history seams
    startShaderGraphs()
    // D2: re-unifies shared materials by id whenever the scene changes — every carrier
    // (GLTF, a peer's per-object messages, undo) rebuilds materials, and the id survives
    // where the instance does not
    startMaterialSharing()
    startShaderSync()
    startHudSync()
    startHudImages()
    startGameSync()
    // 21-F3: publish our play mode when it changes, and watch for an abandoned round
    startGamePresence()
    startGameShell()
    startSceneSwitch()
    // CO2: the colocation calibration ritual — VR radial entries, trigger hooks,
    // markers, locomotion suppression and the colocated world-grab divert
    startColocationCalibration()
    // CO5: publish which physical ROOM we are in when it changes, so a co-present peer
    // can stop rendering our avatar and stop playing our voice (their side, locally)
    startColocationPresence()
    // CO3: persist a calibration as an XRAnchor per room; restore it on the next XR
    // session (zero ritual) and follow the anchor's refined pose while presenting
    startColocationAnchors()
    startColocationNudge()
    // 21-G2: the local project (scene histories + asset list) survives a reload
    // 21-G7: and once it is in, fold every scene's older versions onto the hidden shelf —
    // the migration for a library built before G7 (which minted a card per save) and the
    // one-visible-item invariant for every project that arrives afterwards
    loadProjectManifest().then(() => import('$lib/levels').then((m) => m.foldSceneVersions()))
    // 21-G9: the window title says where you are — "Scene* - Project - theprototype".
    // The dirty asterisk rides autosave's own change signal, throttled: the check
    // serializes the whole scene, so it may never run per keystroke (see the module).
    startSceneIdentity()
    // R22-R1: the shared Explorer index — adopt what peers published, reconcile ours
    startSharedLibrary()
    // #20 P5: deliberately NOTHING to start here. A plain reload comes up in the DEFAULT
    // state — all windows closed — and the layout is restored only by an explicit
    // Restore, by the auto-restore setting, or by loading a file, because it rides the
    // saved payload rather than localStorage.
    // store access for automated tests, opt-in via localStorage
    if (safeStorage.getItem('debugStores')) {
      // 34 R4 (A2): one row per hook in $lib/debugHooks.js (no positional tails here any more)
      installDebugHooks()
    }
  })

  // drop 3d files anywhere on the viewport to import them
  function handleDrop(event) {
    // panels with their own drag&drop handle theirs (flow palette, Explorer)
    if (event.target?.closest && (event.target.closest('#flow-list') || event.target.closest('#explorer-list') || event.target.closest('#explorer-window'))) return
    // Explorer cards dropped on the viewport place/texture at the point (96)
    const explorerPayload = event.dataTransfer?.getData('application/x-explorer-item')
    if (explorerPayload) {
      import('./lib/explorerDrop').then((m) => m.dropExplorerItem(JSON.parse(explorerPayload), event.clientX, event.clientY))
      return
    }
    const files = [...(event.dataTransfer?.files ?? [])]
    if (files.length === 0) return
    const skipped = []
    const modelExt = /\.(glb|gltf|obj|stl|fbx)$/
    // 17-D2: a .mtl / texture dropped ALONGSIDE a model is its companion, not
    // an unsupported file — importFile pairs them up.
    const companionExt = /\.(mtl|png|jpe?g|webp|bmp|gif)$/i
    const companions = files.filter((file) => companionExt.test(file.name))
    files.forEach((file) => {
      const name = file.name.toLowerCase()
      if (modelExt.test(name)) importFile(file, file.name.replace(modelExt, ''), undefined, undefined, companions)
      else if (name.endsWith('.json')) load(file)
      else if (!companions.includes(file)) skipped.push(file.name)
    })
    if (skipped.length > 0)
      showToast('Unsupported: ' + skipped.join(', ') + '. Supported formats: .glb, .gltf, .obj, .stl, .fbx (models), .json (scene)')
  }
</script>

<svelte:window on:dragover|preventDefault on:drop|preventDefault={handleDrop} />

{#if !$isLocked && !$embedMode}
<Flow />
<FlowCode />
<AnimationWindow />
<UvEditor />
<SvelteFlowProvider><ShaderEditor /></SvelteFlowProvider>
<HudEditor />
<Explorer />
{#if !$profilerClose}
{#await import('./components/editors/Profiler.svelte') then m}<m.default />{/await}
{/if}
<TextEditorWindow />
<!-- R22 round 12: ONE INSTANCE PER OPEN PREVIEW. With the multi-window pref off the list
     never holds more than one, so this renders exactly what it always did. -->
{#each $previewWindows as w, i (w.id)}
  <FilePreviewWindow winId={w.id} index={i} />
{/each}
<ModelPreviewWindow />
{/if}
<Menu />
{#if $embedMode}
  <!-- 29-E: the embed's only chrome. The link opens the same scene in the full app (a
       new tab — the iframe stays where it is); the ▶ shows only when not playing, so an
       Esc inside the frame has a way back in (browsers grant the pointer lock only in a
       gesture, which this click is). --z-hud: above the canvas, below modals. -->
  <div id="embed-chrome" class="pointer-events-none fixed inset-x-0 bottom-3 flex items-end justify-between px-3" style="z-index: var(--z-hud)">
    <a id="embed-open-link" class="pointer-events-auto rounded-md bg-gray-900/80 px-2.5 py-1 text-[11px] font-semibold text-gray-100 shadow backdrop-blur-sm hover:bg-gray-800" href={embedOpenUrl()} target="_blank" rel="noopener">Open in theprototype.app ↗</a>
    {#if $isLocked !== true}
      <button id="embed-play" type="button" class="pointer-events-auto rounded-md bg-orange-600/90 px-3 py-1 text-[12px] font-semibold text-white shadow hover:bg-orange-500" on:click={() => requestPlay()}>▶ Play</button>
    {/if}
  </div>
{/if}
{#if $isLocked && $helpersInPlay}
  <!-- 24-E2: helpers are rendering inside Play on purpose — say so, so a screenshot
       cannot be mistaken for the game (the SimControls chip corner) -->
  <div id="helpers-debug-chip" class="pointer-events-none fixed right-4 top-16 rounded-sm bg-amber-500/90 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-black" style="z-index: var(--z-hud)">DEBUG · helpers</div>
{/if}
<ConfirmModal />
<ContextLostOverlay />
<RenderPausedOverlay />
<ImportDuplicatesModal />
<StorageModal />
<DrawToolbar />
<SculptToolbar />
<SplineToolbar />
<!-- A5: module toolboxes. OUTSIDE the {#if !$isLocked} block — a toolbox that opted
     into playMode has to survive Play mode, and the layer decides per box. -->
<ModuleToolboxLayer />
<ModulesManager />
<DungeonMinimap />
<StatsOverlay />
<MomentReport />
<ProfilerLive />
<PlayReticle />
<!-- W4: the touch play controls (virtual stick, look drag, exit). Beside PlayReticle
     and outside the {#if !$isLocked} block for the same reason: they exist ONLY while
     playing, which is exactly where that block draws nothing. -->
<TouchPlayControls />
<!-- CO2: the colocated badge — outside the isLocked gate, colocation survives play mode -->
<ColocationBadge />
<!-- A2: the HUD renders in PLAY mode, so it sits outside the {#if !$isLocked} block
     above (a game HUD that dies when you press play is no HUD at all). --z-hud, no
     new tier: it beats the camera PiP and loses to modal/toast/menu. -->
<HudLayer />
<!-- 30 P1: the game chip — "Game · <state>" + ▶ Test play. Beside HudLayer because it is the
     editor's stand-in for a game's screens, which HudLayer no longer draws outside Play.
     Editor-only (it hides itself in Play, in VR and in embed mode). -->
<GameChip />
<!-- 31 K3: the pause menu every game shares (Esc / the corner Menu button) -->
<GameShellMenu />
<FpsCounter />

<!-- W9: THE VIEWPORT IS A LAYOUT REGION.
     threlte's Canvas fills its parent (`width/height: 100%`) and sizes the renderer
     from a ResizeObserver on that parent, so shrinking this wrapper is the whole
     mechanism: the drawing buffer, the camera aspect, the composer and N8AO all
     follow from threlte's own resize task, once per frame.
     `bottom` is the open dock's height, which is what makes the dock a REGION (the
     DCC behaviour: the canvas ends where the panel begins) instead of an overlay
     drawn on top of a full-window canvas. No `z-index` — a stacking context here
     would trap the PiP frame and the framing guide; the dock's --z-bottom (35)
     already sits above the canvas at the default 0. No `transition` either: each
     step reallocates the composer's render targets, so animating the inset turns one
     realloc into one per frame. -->
<div class="viewport" class:viewport-inset={$viewPrefs.dockPushesViewport && !$embedMode}>
  <Canvas shadows={PCFShadowMap}>
    <Scene />
  </Canvas>
</div>

<style>
  .viewport {
    position: absolute;
    left: 0;
    right: 0;
    top: 0;
    bottom: 0;
  }
  /* the pref OFF keeps the pre-W9 behaviour: a full-window canvas the dock covers */
  .viewport-inset {
    bottom: var(--bottom-inset, 0px);
  }
</style>
