<script lang="ts">
	// 36 U3b: the VR welcome's world-space panel + its input watcher (src/lib/tours/vrPanel.js).
	// No markup: the panel is a plain THREE mesh the module adds to the scene while a VR tour
	// runs; this component only owns its lifetime.
	import { onMount } from 'svelte'
	import { mountTourVRPanel } from '$lib/tours/vrPanel.js'

	onMount(() => mountTourVRPanel())
</script>
