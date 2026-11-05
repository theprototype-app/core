<script>
  // 94 SP1 — THE PLAY ENTRY'S ROOT (`/play`, src/routes/play). The editor's App.svelte minus every
  // editor surface: no Menu (sidebar, pill, panels, toasts), no node / shader / HUD / UV / animation /
  // timeline editors, no Explorer, Inspector, AI window, settings, toolbars or modals that only
  // editing opens. What stays is the player: the viewport (<Scene>, the SAME component the editor
  // plays in), the play HUD, touch controls, the game shell, the player's chrome (EmbedChrome), the
  // peer layer and the runtime starters below — each one the editor's own function, started in the
  // editor's order, so a game plays through one code path in both pages (no fork of the runtime).
  //
  // RULE for this file: a STATIC import here is paid by every shared play link before its first
  // frame (perf/boot-budget.json holds it, `node scripts/boot-size.cjs --check`). Anything a game
  // only sometimes needs is an `import()` at the point of use.
  // fix-play-link: the app's stylesheet (tokens, fonts, the shared kit). The play entry never loaded
  // it, so every kit surface here — the modules ask, the confirm dialog, the start card's tokens —
  // rendered in the browser's default serif with no colours (device lab, Quest 3 + folded N6)
  import './app.css';
  import { safeStorage } from '$lib/safeStorage';
  import '$lib/threeFixes.js';
  import '$lib/troikaFonts.js';
  import { onMount } from 'svelte';
  import { get } from 'svelte/store';
  import { Canvas } from '@threlte/core';
  import { PCFShadowMap } from 'three';
  import Scene from './components/Scene.svelte';
  import ConfirmModal from './components/menu/ConfirmModal.svelte';
  import ContextLostOverlay from './components/ContextLostOverlay.svelte';
  import NoWebGLScreen from './components/NoWebGLScreen.svelte';
  import RenderPausedOverlay from './components/RenderPausedOverlay.svelte';
  import EmbedChrome from './components/play/EmbedChrome.svelte';
  import MadeWithBadge from './components/play/MadeWithBadge.svelte';
  import PlayReticle from './components/play/PlayReticle.svelte';
  import PlayBanner from './components/play/PlayBanner.svelte';
  import TouchPlayControls from './components/play/TouchPlayControls.svelte';
  import DungeonMinimap from './components/play/DungeonMinimap.svelte';
  import HudLayer from './components/hud/HudLayer.svelte';
  import GameShellMenu from './components/hud/GameShellMenu.svelte';
  import CaptionOverlay from './components/play/CaptionOverlay.svelte';
  import PlayerColorFilter from './components/play/PlayerColorFilter.svelte';
  import FpsCounter from './components/hud/FpsCounter.svelte';
  import AutoQualityNotice from './components/AutoQualityNotice.svelte';
  import LiveRegions from './components/ui/LiveRegions.svelte';
  import { probeWebGL2, reportNoWebGL } from '$lib/webglSupport.js';
  import { installChunkReload } from '$lib/chunkReload.js';
  import './lib/overloadGuard';
  import './lib/textSelection';
  import { flowPaused } from './stores/flowStore';
  import { initModules, disabledModules } from '$lib/moduleSDK';
  import { coreModules } from './modules/index.js';
  import { startDiagnostics } from '$lib/diagnostics';
  import { startWireErrors } from '$lib/wireErrors';
  import { startErrorReports } from '$lib/errorReports';
  import { startSceneMetrics } from './lib/sceneBudget';
  import { startPerfRecorder } from './lib/perf/recorder';
  import { startPerfBeacon } from './lib/perf/beacon';
  import { startLod } from './lib/lod';
  import { startLodGroups } from './lib/lodGroup';
  import { startKitInstancing } from './lib/kitInstancing';
  import { startFlowRuntime } from '$lib/flowRuntime';
  import { startNodeSync } from '$lib/nodesHandler';
  import { startLightParams } from '$lib/lightParams';
  import { startShadowBudget } from '$lib/shadowBudget';
  import { startShadowDefaults } from '$lib/shadowDefaults';
  import { startPackRefs } from '$lib/packRefs';
  import { startViewMode } from '$lib/viewMode';
  import { startInputRuntime } from '$lib/inputRuntime';
  import { startPossess } from '$lib/possess';
  import { startHandModels } from '$lib/handModels';
  import { startEnvironment } from '$lib/environment';
  import { startSceneMusic } from '$lib/sceneMusic';
  import { startSceneBounds } from '$lib/sceneBounds';
  import { startSceneAssets } from '$lib/sceneAssets';
  import { startNetworkQuality } from '$lib/networkQuality';
  import { startAudioDevices } from './lib/audioDevices';
  import { startCloudPlugin } from '$lib/cloudPlugin';
  import { startTrackpadNav } from '$lib/trackpadNav';
  import { startInviteLinks } from '$lib/inviteLinks';
  import { startHelperLayer } from '$lib/helperLayer';
  import { startShaderGraphs } from '$lib/shaderGraph';
  import { startTerrainSurface } from '$lib/terrainSurface';
  import { startMaterialSharing } from '$lib/materialSharing';
  import { startMaterialTiers } from '$lib/materialTiers.js';
  import { startShaderSync } from '$lib/shaderSync';
  import { startHudSync } from '$lib/hudSync';
  import { startSequenceSync } from '$lib/sequenceSync';
  import { startSequencePlayer } from '$lib/sequencePlayer';
  import { startHudImages } from '$lib/hudImages';
  import { startGameSync } from '$lib/gameSync';
  import { startGamePresence } from '$lib/gamePresence';
  import { startGameShell } from '$lib/gameShellWire';
  import { startPlayEntry } from '$lib/play/playBoot.js';
  // the peer layer: the editor's Connect bar creates it on mount, before the Canvas mounts <Scene>
  // (whose self row and camera sends need a peer id); the play entry has no Connect bar, so it
  // creates the same PeerConnection here, during its own init. An invite hash is read by the
  // constructor exactly as in the app (94-routes A4).
  import { createPeer, PeerConnection } from '$lib/peerHandler.svelte';
  import { peers } from './stores/appStore';

  // before children mount: node components / effects must exist when the runtime first looks them up
  initModules(coreModules.filter((mod) => !get(disabledModules).includes(mod.id)));

  if (typeof window !== 'undefined' && !get(peers)) peers.set(new PeerConnection(createPeer(), () => {}));

  const webglOk = probeWebGL2();
  installChunkReload();

  onMount(() => {
    startDiagnostics();
    startWireErrors();
    startErrorReports();
    if (!webglOk) reportNoWebGL();
    startSceneMetrics();
    startPerfRecorder();
    startPerfBeacon();
    startLod();
    startLodGroups();
    startKitInstancing();
    // 27-D safe mode: `#safe` starts the flow runtime paused (a hanging script cannot lock the page)
    if (typeof location !== 'undefined' && /(^|[#&])safe\b/i.test(location.hash)) flowPaused.set({ paused: true, reason: 'safe mode' });
    startFlowRuntime();
    startNodeSync();
    startLightParams();
    startShadowBudget();
    startShadowDefaults();
    startPackRefs();
    startViewMode();
    startInputRuntime();
    startPossess();
    startHandModels();
    startEnvironment();
    startSceneMusic();
    startSceneBounds();
    startSceneAssets();
    startNetworkQuality();
    startAudioDevices();
    // fix-play-link: the modules this player installed come back at boot, as in the editor — the
    // play entry never restored them, so "This scene uses modules" asked on every visit. Before the
    // plugin, whose `?s=` load runs the ask (and the ask waits for this restore)
    import('$lib/userModules').then((m) => m.loadUserModules());
    startCloudPlugin();
    startTrackpadNav();
    startInviteLinks();
    startHelperLayer();
    startShaderGraphs();
    startTerrainSurface();
    startMaterialSharing();
    startMaterialTiers();
    startShaderSync();
    startHudSync();
    startSequenceSync();
    startSequencePlayer();
    startHudImages();
    startGameSync();
    startGamePresence();
    startGameShell();
    // `?scene=<url>`, `window.tpPlay`, the frame's postMessage events (src/lib/play/playBoot.js)
    startPlayEntry();
    // the hook table is ~300 lazy loaders: a play link pays for it only when a test asks
    if (safeStorage.getItem('debugStores')) import('$lib/debugHooks').then((m) => m.installDebugHooks());
  });
</script>

<EmbedChrome />
<MadeWithBadge />
<ConfirmModal />
<ContextLostOverlay />
<RenderPausedOverlay />
<DungeonMinimap />
<PlayReticle />
<PlayBanner />
<TouchPlayControls />
<HudLayer />
<LiveRegions />
<AutoQualityNotice />
<GameShellMenu />
<CaptionOverlay />
<PlayerColorFilter />
<FpsCounter />

<div id="viewport" role="region" aria-label="3D viewport" class="viewport">
  {#if webglOk}
  <Canvas shadows={PCFShadowMap}>
    <Scene />
  </Canvas>
  {/if}
</div>
{#if !webglOk}<NoWebGLScreen />{/if}

<style>
  .viewport {
    position: absolute;
    inset: 0;
  }
  .viewport:focus-visible {
    outline: var(--focus-ring-width) solid var(--focus-ring);
    outline-offset: calc(-1 * var(--focus-ring-width));
  }
</style>
