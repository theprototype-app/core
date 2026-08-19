<script>
  import { onMount } from 'svelte'
  import { Canvas } from '@threlte/core'
  import Scene from './components/Scene.svelte'
  import Menu from './components/Menu.svelte'
  import ConfirmModal from './components/menu/ConfirmModal.svelte'
  import Flow from './components/Flow.svelte'
  import FlowCode from './components/editors/FlowCode.svelte'
  import AnimationWindow from './components/editors/AnimationWindow.svelte'
  import UvEditor from './components/editors/UvEditor.svelte'
  import ShaderEditor from './components/editors/ShaderEditor.svelte'
  import { SvelteFlowProvider } from '@xyflow/svelte'
  import Explorer from './components/editors/Explorer.svelte'
  import TextEditorWindow from './components/editors/TextEditorWindow.svelte'
  import ImagePreviewWindow from './components/editors/ImagePreviewWindow.svelte'
  import ModelPreviewWindow from './components/editors/ModelPreviewWindow.svelte'
  import DungeonMinimap from './components/play/DungeonMinimap.svelte'
  import PlayReticle from './components/play/PlayReticle.svelte'
  import DrawToolbar from './components/menu/DrawToolbar.svelte'
  import SculptToolbar from './components/menu/SculptToolbar.svelte'
  import SplineToolbar from './components/menu/SplineToolbar.svelte'
  import ModuleToolboxLayer from './components/ui/ModuleToolboxLayer.svelte'
  import { isLocked } from './stores/sceneStore'
  import { startFlowRuntime } from '$lib/flowRuntime'
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
  import { startViewMode } from '$lib/viewMode'
  import { startInputRuntime } from '$lib/inputRuntime'
  import { startPossess } from '$lib/possess'
  import { startHandModels } from '$lib/handModels'
  import { startAutosave } from '$lib/autosave'
  import { startSceneAssets } from '$lib/sceneAssets'
  import { startNetworkQuality } from '$lib/networkQuality'
  import { startWhatsNew } from '$lib/whatsNew'
  import { startUpdateCheck } from '$lib/updateCheck'
  import { startTrackpadNav } from '$lib/trackpadNav'
  import { startCloudPlugin } from '$lib/cloudPlugin'
  import { startShaderGraphs } from '$lib/shaderGraph'
  import { startShaderSync } from '$lib/shaderSync'
  import { startHudSync } from '$lib/hudSync'
  import { startHudImages } from '$lib/hudImages'
  import { startGameSync } from '$lib/gameSync'
  import HudLayer from './components/hud/HudLayer.svelte'
  import HudEditor from './components/editors/HudEditor.svelte'
  import { importFile, load } from '$lib/fileHandler.svelte'
  import { showToast } from './stores/appStore'
  import { get } from 'svelte/store'
  import { initModules, disabledModules } from '$lib/moduleSDK'
  import { coreModules } from './modules/index.js'
  import ModulesManager from './components/menu/ModulesManager.svelte'

  // before children mount: node components/effects must exist when the
  // flow editor and runtime first look them up
  initModules(coreModules.filter((mod) => !get(disabledModules).includes(mod.id)))

  // node graph animations keep running even when the flow drawer is closed
  onMount(() => {
    // 15-N: register the PWA service worker (a no-cache passthrough — see
    // static/sw.js) so mobile browsers offer "Install app". Dev is skipped: a
    // SW in front of vite's HMR only causes confusion.
    if ('serviceWorker' in navigator && import.meta.env.PROD)
      navigator.serviceWorker.register('/sw.js').catch(() => {})
    startFlowRuntime()
    startNodeSync()
    startLockSweep()
    startMultiTransform()
    startLightParams()
    startShadowDefaults()
    startViewMode()
    startInputRuntime()
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
    // RW: first visit -> welcome overlay; a new version -> logo dot + one toast
    startWhatsNew()
    // V8: poll the deployed version.json — one reload toast per session (prod only)
    startUpdateCheck()
    // open-core (M1): load a configured cloud plugin (no-op in the OSS build)
    startCloudPlugin()
    // QW: trackpad two-finger pan + pinch page-zoom guards (desktop + mobile)
    startTrackpadNav()
    // shader graphs: the compile/target wiring + the replication and history seams
    startShaderGraphs()
    startShaderSync()
    startHudSync()
    startHudImages()
    startGameSync()
    // #20 P5: deliberately NOTHING to start here. A plain reload comes up in the DEFAULT
    // state — all windows closed — and the layout is restored only by an explicit
    // Restore, by the auto-restore setting, or by loading a file, because it rides the
    // saved payload rather than localStorage.
    // store access for automated tests, opt-in via localStorage
    if (localStorage.getItem('debugStores')) {
      Promise.all([
        import('./stores/sceneStore'),
        import('./stores/appStore'),
        import('./stores/flowStore'),
        import('./lib/meshEdit'),
        import('./lib/vrControls'),
        import('./lib/autosave'),
        import('./lib/voiceChat'),
        import('./lib/audioEngine'),
        import('./lib/annotationsHandler'),
        import('./lib/flowRuntime'),
        import('./lib/history'),
        import('./lib/materialsHandler'),
        import('./lib/objectActions'),
        import('./lib/commandsHandler.svelte'),
        import('./lib/moduleSDK'),
        import('./lib/drawMode'),
        import('./lib/pathCapture'),
        import('./lib/lockControl'),
        import('./lib/prefabs'),
        import('./lib/physics'),
        import('./lib/joints'),
        import('./lib/possess'),
        import('./lib/handModels'),
        import('./lib/terrainSculpt'),
        import('./lib/userModules'),
        import('./lib/environment'),
        import('./lib/sceneMusic'),
        import('./lib/animatedImports'),
        import('./lib/fileHandler.svelte'),
        import('./lib/fileWindows'),
        import('./lib/sceneBounds'),
        import('./lib/cameraClip'),
        import('./lib/ping'),
        import('./lib/sessions'),
        import('./lib/geometryEdit'),
        import('./lib/lightParams'),
        import('./lib/shadowDefaults'),
        import('./lib/palette'),
        import('./lib/viewMode'),
        import('./lib/inputRuntime'),
        import('./lib/shortcuts'),
        import('./lib/themes'),
        import('./lib/vrRadialMenu'),
        import('./lib/vrPalette'),
        import('./lib/vrWindowPoses'),
        import('./lib/vrKeyboard'),
        import('./lib/faceEdit'),
        import('./lib/meshToolParams'),
        import('./lib/avatarModel'),
        import('./lib/explorer'),
        import('./lib/bottomDock'),
        import('./lib/explorerDrop'),
        import('./lib/assetShare'),
        import('./lib/soundRuntime'),
        import('./lib/dungeonPlay'),
        import('./lib/sceneAssets'),
        import('three'),
        import('three/addons/exporters/GLTFExporter.js'),
        import('./lib/snapping'),
        import('./lib/flowSockets'),
        import('./lib/networkQuality'),
        import('./lib/packs'),
        import('./lib/customNodes'),
        import('./lib/nodesHandler'),
        import('./lib/nodeCatalog'),
        import('./lib/objectMenu'),
        import('./lib/animationPreview'),
        import('./lib/ai/providers'),
        import('./lib/ai/tools'),
        import('./lib/ai/assistant'),
        import('./lib/ai/meshProviders'),
        import('./lib/ai/meshJobs'),
        import('./lib/flowGraphs'),
        import('./lib/objectFlow'),
        import('./lib/peerServer'),
        import('./lib/cloudHooks'),
        import('./lib/cloudPlugin'),
        import('./lib/connectionState'),
        import('./lib/peerApproval'),
        import('./lib/particleRuntime'),
        import('./lib/particleActions'),
        import('./lib/particlePresets'),
        import('./lib/version'),
        import('./lib/whatsNew'),
        import('./lib/confirmDialog'),
        import('./lib/scenePhysics'),
        import('./lib/playInteract'),
        import('./lib/moveSmoothing'),
        import('./lib/playSettings'),
        import('./lib/colliderSpec'),
        import('./lib/colliderHelpers'),
        import('./lib/colliderEdit'),
        import('./lib/editSession'),
        import('./lib/trackpadNav'),
        import('./lib/vrSleeve'),
        import('./lib/gridSettings'),
        import('./lib/viewPrefs'),
        import('./lib/cameraBookmarks'),
        import('./lib/cameraObjects'),
        import('./lib/cameraHelpers'),
        import('./lib/onionSkin'),
        import('./lib/cameraPreview'),
        import('./lib/addObjects'),
        import('./lib/cameraPip'),
        import('./lib/inputDevice'),
        import('./lib/sceneTemplates'),
        import('./lib/bvhPicking'),
        import('./lib/multiTransform'),
        import('./lib/objectOrigin'),
        import('./lib/moduleGallery'),
        import('./lib/uvEditor'),
        import('./lib/uvUnwrap'),
        import('./lib/meshTopology'),
        import('./lib/meshBudget'),
        import('./lib/proportional'),
        import('./lib/proportionalRing'),
        import('./lib/scenePick'),
        import('./lib/snapEngine'),
        import('./lib/meshPivot'),
        import('./lib/selectionPrefs'),
        import('./lib/editOverlays'),
        import('./lib/objectPermissions'),
        import('./lib/scenePost'),
        import('./lib/postEffects'),
        import('./lib/viewportOverrides'),
        import('postprocessing'),
        import('./lib/shaderBackends'),
        import('./lib/shaderGraph'),
        import('./lib/shaderSync'),
        import('./lib/shaderTextures'),
        import('./lib/shaderCatalog'),
        import('./lib/units'),
        import('./lib/postBackends'),
        import('./lib/workspace'),
        import('./lib/editResume'),
        import('./lib/moduleRequirements'),
        import('./lib/hudDocs'),
        import('./lib/hudSync'),
        import('./lib/idb'),
        import('./lib/hudKinds'),
        import('./lib/hudImages'),
        import('./lib/gameState'),
        import('./lib/gameSync'),
        import('./lib/hudActions'),
        import('./lib/moduleNodeIO'),
        import('./lib/moduleToolboxes'),
        import('./lib/splineTube'),
        import('./lib/splineTool'),
        import('./lib/splineEdit'),
        import('./lib/terrainCarve'),
        import('./lib/flattenActions')
      ]).then(([sceneStore, appStore, flowStore, meshEdit, vrControls, autosave, voiceChat, audioEngineLib, annotationsHandler, flowRuntime, history, materialsHandler, objectActions, commandsHandler, moduleSDK, drawModeLib, pathCapture, lockControl, prefabsLib, physics, jointsLib, possessLib, handModelsLib, terrainSculptLib, userModulesLib, environmentLib, sceneMusicLib, animatedImports, fileHandler, fileWindowsLib, sceneBounds, cameraClip, ping, sessionsLib, geometryEdit, lightParams, shadowDefaultsLib, paletteLib, viewModeLib, inputRuntimeLib, shortcutsLib, themesLib, vrRadialMenu, vrPaletteLib, vrWindowPosesLib, vrKeyboardLib, faceEditLib, meshToolParamsLib, avatarModelLib, explorerLib, bottomDock, explorerDrop, assetShare, soundRuntime, dungeonPlay, sceneAssetsLib, THREE, GLTFExporterModule, snappingLib, flowSocketsLib, networkQualityLib, packsLib, customNodesLib, nodesHandlerLib, nodeCatalogLib, objectMenuLib, animationPreviewLib, aiProvidersLib, aiToolsLib, aiAssistantLib, meshProvidersLib, meshJobsLib, flowGraphsLib, objectFlowLib, peerServerLib, cloudHooksLib, cloudPluginLib, connectionStateLib, peerApprovalLib, particleRuntimeLib, particleActionsLib, particlePresetsLib, versionLib, whatsNewLib, confirmDialogLib, scenePhysicsLib, playInteractLib, moveSmoothingLib, playSettingsLib, colliderSpecLib, colliderHelpersLib, colliderEditLib, editSessionLib, trackpadNavLib, vrSleeveLib, gridSettingsLib, viewPrefsLib, cameraBookmarksLib, cameraObjectsLib, cameraHelpersLib, onionSkinLib, cameraPreviewLib, addObjectsLib, cameraPipLib, inputDeviceLib, sceneTemplatesLib, bvhPickingLib, multiTransformLib, objectOriginLib, moduleGalleryLib, uvEditorLib, uvUnwrapLib, meshTopologyLib, meshBudgetLib, proportionalLib, proportionalRingLib, scenePickLib, snapEngineLib, meshPivotLib, selectionPrefsLib, editOverlaysLib, objectPermissionsLib, scenePostLib, postEffectsLib, viewportOverridesLib, postprocessingModule, shaderBackendsLib, shaderGraphLib, shaderSyncLib, shaderTexturesLib, shaderCatalogLib, unitsLib, postBackendsLib, workspaceLib, editResumeLib, moduleRequirementsLib, hudDocsLib, hudSyncLib, idbLib, hudKindsLib, hudImagesLib, gameStateLib, gameSyncLib, hudActionsLib, moduleNodeIOLib, moduleToolboxesLib, splineTubeLib, splineToolLib, splineEditLib, terrainCarveLib, flattenActionsLib]) => {
        window.__stores = { ...sceneStore, ...appStore, ...flowStore, meshEdit, vrControls, autosave, voiceChat, audioEngine: audioEngineLib, annotationsHandler, flowRuntime, history, materialsHandler, objectActions, commandsHandler, moduleSDK, drawMode: drawModeLib, pathCapture, lockControl, prefabs: prefabsLib, physics, joints: jointsLib, possess: possessLib, handModels: handModelsLib, terrainSculpt: terrainSculptLib, userModules: userModulesLib, environment: environmentLib, sceneMusic: sceneMusicLib, animatedImports, fileHandler, fileWindows: fileWindowsLib, sceneBounds, cameraClip, ping, sessions: sessionsLib, geometryEdit, lightParams, shadowDefaults: shadowDefaultsLib, palette: paletteLib, viewModeCtl: viewModeLib, inputRuntime: inputRuntimeLib, shortcutsRegistry: shortcutsLib, themes: themesLib, vrRadialMenu, vrPalette: vrPaletteLib, vrWindowPoses: vrWindowPosesLib, vrKeyboard: vrKeyboardLib, faceEdit: faceEditLib, meshToolParams: meshToolParamsLib, avatarModel: avatarModelLib, explorer: explorerLib, bottomDock, explorerDrop, assetShare, soundRuntime, dungeonPlay, sceneAssets: sceneAssetsLib, THREE, GLTFExporterModule, snapping: snappingLib, flowSockets: flowSocketsLib, networkQuality: networkQualityLib, packs: packsLib, customNodes: customNodesLib, nodesHandler: nodesHandlerLib, nodeCatalog: nodeCatalogLib, objectMenu: objectMenuLib, animationPreview: animationPreviewLib, aiProviders: aiProvidersLib, aiTools: aiToolsLib, aiAssistant: aiAssistantLib, meshProviders: meshProvidersLib, meshJobs: meshJobsLib, flowGraphsCtl: flowGraphsLib, objectFlow: objectFlowLib, peerServer: peerServerLib, cloudHooks: cloudHooksLib, cloudPlugin: cloudPluginLib, connectionState: connectionStateLib, peerApproval: peerApprovalLib, particleRuntime: particleRuntimeLib, particleActions: particleActionsLib, particlePresets: particlePresetsLib, version: versionLib, whatsNew: whatsNewLib, confirmDialog: confirmDialogLib, scenePhysics: scenePhysicsLib, playInteract: playInteractLib, moveSmoothing: moveSmoothingLib, playSettings: playSettingsLib, colliderSpec: colliderSpecLib, colliderHelpers: colliderHelpersLib, colliderEdit: colliderEditLib, editSession: editSessionLib, trackpadNav: trackpadNavLib, vrSleeve: vrSleeveLib, gridSettings: gridSettingsLib, viewPrefs: viewPrefsLib, cameraBookmarks: cameraBookmarksLib, cameraObjects: cameraObjectsLib, cameraHelpers: cameraHelpersLib, onionSkin: onionSkinLib, cameraPreview: cameraPreviewLib, addObjects: addObjectsLib, cameraPip: cameraPipLib, inputDevice: inputDeviceLib, sceneTemplates: sceneTemplatesLib, bvhPicking: bvhPickingLib, multiTransform: multiTransformLib, objectOrigin: objectOriginLib, moduleGallery: moduleGalleryLib, uvEditor: uvEditorLib, uvUnwrap: uvUnwrapLib, meshTopology: meshTopologyLib, meshBudget: meshBudgetLib, proportional: proportionalLib, proportionalRing: proportionalRingLib, scenePick: scenePickLib, snapEngine: snapEngineLib, meshPivot: meshPivotLib, selectionPrefs: selectionPrefsLib, editOverlays: editOverlaysLib, objectPermissions: objectPermissionsLib, scenePost: scenePostLib, postEffects: postEffectsLib, viewportOverrides: viewportOverridesLib, postprocessing: postprocessingModule, shaderBackends: shaderBackendsLib, shaderGraph: shaderGraphLib, shaderSync: shaderSyncLib, shaderTextures: shaderTexturesLib, shaderCatalog: shaderCatalogLib, units: unitsLib, postBackends: postBackendsLib, workspace: workspaceLib, editResume: editResumeLib, moduleRequirements: moduleRequirementsLib, hudDocs: hudDocsLib, hudSync: hudSyncLib, idb: idbLib, hudKinds: hudKindsLib, hudImages: hudImagesLib, gameState: gameStateLib, gameSync: gameSyncLib, hudActions: hudActionsLib, moduleNodeIO: moduleNodeIOLib, moduleToolboxes: moduleToolboxesLib, splineTube: splineTubeLib, splineTool: splineToolLib, splineEdit: splineEditLib, terrainCarve: terrainCarveLib, flattenActions: flattenActionsLib }
      })
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

{#if !$isLocked}
<Flow />
<FlowCode />
<AnimationWindow />
<UvEditor />
<SvelteFlowProvider><ShaderEditor /></SvelteFlowProvider>
<HudEditor />
<Explorer />
<TextEditorWindow />
<ImagePreviewWindow />
<ModelPreviewWindow />
{/if}
<Menu />
<ConfirmModal />
<DrawToolbar />
<SculptToolbar />
<SplineToolbar />
<!-- A5: module toolboxes. OUTSIDE the {#if !$isLocked} block — a toolbox that opted
     into playMode has to survive Play mode, and the layer decides per box. -->
<ModuleToolboxLayer />
<ModulesManager />
<DungeonMinimap />
<PlayReticle />
<!-- A2: the HUD renders in PLAY mode, so it sits outside the {#if !$isLocked} block
     above (a game HUD that dies when you press play is no HUD at all). --z-hud, no
     new tier: it beats the camera PiP and loses to modal/toast/menu. -->
<HudLayer />

<Canvas>
  <Scene />
</Canvas>
