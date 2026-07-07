<script>
  import { onMount } from 'svelte'
  import { Canvas } from '@threlte/core'
  import Scene from './components/Scene.svelte'
  import Menu from './components/Menu.svelte'
  import Flow from './components/Flow.svelte'
  import { isLocked } from './stores/sceneStore'
  import { startFlowRuntime } from '$lib/flowRuntime'
  import { startShortcuts } from '$lib/shortcuts'

  // node graph animations keep running even when the flow drawer is closed
  onMount(() => {
    startFlowRuntime()
    startShortcuts()
  })
</script>

{#if !$isLocked}
<Flow />
{/if}
<Menu />

<Canvas>
  <Scene />
</Canvas>
