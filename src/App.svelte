<script>
  import { onMount } from 'svelte'
  import { Canvas } from '@threlte/core'
  import Scene from './components/Scene.svelte'
  import Menu from './components/Menu.svelte'
  import Flow from './components/Flow.svelte'
  import { isLocked } from './stores/sceneStore'
  import { startFlowRuntime } from '$lib/flowRuntime'
  import { startShortcuts } from '$lib/shortcuts'
  import { startSnapping } from '$lib/snapping'
  import { importFile, load } from '$lib/fileHandler.svelte'
  import { showToast } from './stores/appStore'

  // node graph animations keep running even when the flow drawer is closed
  onMount(() => {
    startFlowRuntime()
    startShortcuts()
    startSnapping()
    // store access for automated tests, opt-in via localStorage
    if (localStorage.getItem('debugStores')) {
      Promise.all([
        import('./stores/sceneStore'),
        import('./stores/appStore'),
        import('./stores/flowStore')
      ]).then(([sceneStore, appStore, flowStore]) => {
        window.__stores = { ...sceneStore, ...appStore, ...flowStore }
      })
    }
  })

  // drop 3d files anywhere on the viewport to import them
  function handleDrop(event) {
    // the flow editor has its own drag&drop (node palette)
    if (event.target?.closest && event.target.closest('#flow-list')) return
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
{/if}
<Menu />

<Canvas>
  <Scene />
</Canvas>
