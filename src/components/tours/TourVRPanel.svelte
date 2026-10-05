<script lang="ts">
	// 36 U3b: the VR welcome's world-space panel + its input watcher (src/lib/tours/vrPanel.js),
	// and 36 A2's offerSession decision (src/lib/xrOffer.js; Scene binds <XR offerSession>).
	// No markup: the panel is a plain THREE mesh the module adds to the scene while a VR tour
	// runs; this component only owns the lifetimes.
	import { onMount } from 'svelte'
	import { mountTourVRPanel } from '$lib/tours/vrPanel.js'
	import { installXROffer } from '$lib/xrOffer'
	import { vrPassthrough, isVRMode } from '../../stores/sceneStore'

	onMount(() => {
		const unmount = mountTourVRPanel()
		const uninstall = installXROffer({ passthrough: vrPassthrough, vrMode: isVRMode })
		return () => {
			unmount()
			uninstall()
		}
	})
</script>
