<script>
	// 36-water: mounts the scene-root 'water-root' group and drives the water renderer's
	// frame loop (waterRuntime.js). Lives beside the particle root in Scene.svelte — never
	// inside objectsGroup, so no water visual is ever saved, sent or undone.
	import { T, useTask, useThrelte } from '@threlte/core';
	import { onDestroy } from 'svelte';
	import { startWater, stopWater, tickWater } from '$lib/water/waterRuntime.js';

	const { scene, renderer } = useThrelte();
	useTask((delta) => tickWater(delta));
	onDestroy(stopWater);
</script>

<T.Group
	name="water-root"
	oncreate={(/** @type {any} */ ref) => startWater(ref, scene, renderer)}
/>
