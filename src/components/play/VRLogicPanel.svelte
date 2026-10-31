<script lang="ts">
	// 74 VH1: the VR logic panel's lifetime ($lib/vr/logicPanel.js). No markup: the panel and its wrist pad are
	// canvas-textured planes the module adds to the scene while it is open in a session; this component only
	// mounts its hooks and the radial entries (Tools ▸ Logic, Selected ▸ Edit logic), and undoes them on unmount.
	import { onMount } from 'svelte'
	import { mountVRLogic } from '$lib/vr/logicPanel.js'

	onMount(() => mountVRLogic())
</script>
