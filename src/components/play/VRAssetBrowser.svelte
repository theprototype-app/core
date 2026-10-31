<script lang="ts">
	// 52-browser (V4): the wrist Asset Browser's lifetime ($lib/vr/assetBrowser.js). No markup: the panel is
	// one canvas-textured plane the module adds to the scene while it is open in a session; this component
	// only mounts its hooks and the radial entry (Add ▸ Assets), and undoes them on unmount.
	import { onMount } from 'svelte'
	import { mountVRAssetBrowser } from '$lib/vr/assetBrowser.js'

	onMount(() => mountVRAssetBrowser())
</script>
