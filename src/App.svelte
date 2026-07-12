<script>
  import { onMount } from 'svelte'
  import { Canvas } from '@threlte/core'
  import Scene from './components/Scene.svelte'
  import Menu from './components/Menu.svelte'
  import Flow from './components/Flow.svelte'
  import Explorer from './components/editors/Explorer.svelte'
  import TextEditorWindow from './components/editors/TextEditorWindow.svelte'
  import ImagePreviewWindow from './components/editors/ImagePreviewWindow.svelte'
  import DungeonMinimap from './components/play/DungeonMinimap.svelte'
  import DrawToolbar from './components/menu/DrawToolbar.svelte'
  import { isLocked } from './stores/sceneStore'
  import { startFlowRuntime } from '$lib/flowRuntime'
  import { startNodeSync } from '$lib/nodesHandler'
  import { startLockSweep } from '$lib/lockControl'
  import { loadUserModules } from '$lib/userModules'
  import { startEnvironment } from '$lib/environment'
  import { startSceneBounds } from '$lib/sceneBounds'
  import { startShortcuts } from '$lib/shortcuts'
  import { startSnapping } from '$lib/snapping'
  import { startMultiTransform } from '$lib/multiTransform'
  import { startLightParams } from '$lib/lightParams'
  import { startAutosave } from '$lib/autosave'
  import { startSceneAssets } from '$lib/sceneAssets'
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
    startFlowRuntime()
    startNodeSync()
    startLockSweep()
    startMultiTransform()
    startLightParams()
    loadUserModules()
    startEnvironment()
    startSceneBounds()
    startShortcuts()
    startSnapping()
    startAutosave()
    startSceneAssets()
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
        import('./lib/userModules'),
        import('./lib/environment'),
        import('./lib/animatedImports'),
        import('./lib/fileHandler.svelte'),
        import('./lib/sceneBounds'),
        import('./lib/cameraClip'),
        import('./lib/ping'),
        import('./lib/sessions'),
        import('./lib/geometryEdit'),
        import('./lib/lightParams'),
        import('./lib/themes'),
        import('./lib/vrRadialMenu'),
        import('./lib/vrPalette'),
        import('./lib/vrWindowPoses'),
        import('./lib/vrKeyboard'),
        import('./lib/faceEdit'),
        import('./lib/avatarModel'),
        import('./lib/explorer'),
        import('./lib/bottomDock'),
        import('./lib/explorerDrop'),
        import('./lib/assetShare'),
        import('./lib/soundRuntime'),
        import('./lib/dungeonPlay'),
        import('./lib/sceneAssets'),
        import('three'),
        import('three/examples/jsm/exporters/GLTFExporter.js'),
        import('./lib/snapping')
      ]).then(([sceneStore, appStore, flowStore, meshEdit, vrControls, autosave, voiceChat, annotationsHandler, flowRuntime, history, materialsHandler, objectActions, commandsHandler, moduleSDK, drawModeLib, pathCapture, lockControl, prefabsLib, physics, userModulesLib, environmentLib, animatedImports, fileHandler, sceneBounds, cameraClip, ping, sessionsLib, geometryEdit, lightParams, themesLib, vrRadialMenu, vrPaletteLib, vrWindowPosesLib, vrKeyboardLib, faceEditLib, avatarModelLib, explorerLib, bottomDock, explorerDrop, assetShare, soundRuntime, dungeonPlay, sceneAssetsLib, THREE, GLTFExporterModule, snappingLib]) => {
        window.__stores = { ...sceneStore, ...appStore, ...flowStore, meshEdit, vrControls, autosave, voiceChat, annotationsHandler, flowRuntime, history, materialsHandler, objectActions, commandsHandler, moduleSDK, drawMode: drawModeLib, pathCapture, lockControl, prefabs: prefabsLib, physics, userModules: userModulesLib, environment: environmentLib, animatedImports, fileHandler, sceneBounds, cameraClip, ping, sessions: sessionsLib, geometryEdit, lightParams, themes: themesLib, vrRadialMenu, vrPalette: vrPaletteLib, vrWindowPoses: vrWindowPosesLib, vrKeyboard: vrKeyboardLib, faceEdit: faceEditLib, avatarModel: avatarModelLib, explorer: explorerLib, bottomDock, explorerDrop, assetShare, soundRuntime, dungeonPlay, sceneAssets: sceneAssetsLib, THREE, GLTFExporterModule, snapping: snappingLib }
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
    files.forEach((file) => {
      const name = file.name.toLowerCase()
      if (modelExt.test(name)) importFile(file, file.name.replace(modelExt, ''))
      else if (name.endsWith('.json')) load(file)
      else skipped.push(file.name)
    })
    if (skipped.length > 0)
      showToast('Unsupported: ' + skipped.join(', ') + '. Supported formats: .glb, .gltf, .obj, .stl, .fbx (models), .json (scene)')
  }
</script>

<svelte:window on:dragover|preventDefault on:drop|preventDefault={handleDrop} />

{#if !$isLocked}
<Flow />
<Explorer />
<TextEditorWindow />
<ImagePreviewWindow />
{/if}
<Menu />
<DrawToolbar />
<ModulesManager />
<DungeonMinimap />

<Canvas>
  <Scene />
</Canvas>
