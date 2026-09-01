<script>
	// 16-P5: the letterbox guide for camera previews. The preview camera renders at
	// the camera's framing aspect (16:9, 4:3, …), which leaves bars in a differently
	// shaped window — this masks them, so what you see IS the frame you'd capture.
	// Pure overlay: pointer-events off, and it only exists while previewing a camera
	// whose `guide` is on and whose aspect is not 'free'.
	import { cameraPreview } from '$lib/cameraPreview';
	import { objectsGroup } from '../../stores/sceneStore';
	import { cameraSpec, aspectRatio } from '$lib/cameraObjects';
	import { viewportInset } from '$lib/bottomDock';

	const object = $derived(
		$cameraPreview ? ($objectsGroup?.getObjectByProperty('uuid', $cameraPreview.uuid) ?? null) : null
	);
	const spec = $derived(object ? cameraSpec(object) : null);
	const ratio = $derived(spec && spec.guide ? aspectRatio(spec.aspect) : 0);

	let vw = $state(0);
	let vh = $state(0);
	// W9: the letterbox masks the bars the RENDERER leaves, and the renderer draws into
	// the canvas — so both the aspect comparison and the box itself are measured against
	// the canvas, which is the window minus whatever the bottom dock took. Measuring
	// against the window sized the bars for an aspect nothing was rendered at, and the
	// guide covered the dock as well.
	const height = $derived(Math.max(0, vh - $viewportInset));
	const bars = $derived.by(() => {
		if (!ratio || !vw || !height) return null;
		const viewport = vw / height;
		if (Math.abs(viewport - ratio) < 0.01) return null;
		// too WIDE a window -> vertical bars; too tall -> horizontal bars
		if (viewport > ratio) {
			const frame = height * ratio;
			return { side: 'x', size: Math.max(0, (vw - frame) / 2) };
		}
		const frame = vw / ratio;
		return { side: 'y', size: Math.max(0, (height - frame) / 2) };
	});
</script>

<svelte:window bind:innerWidth={vw} bind:innerHeight={vh} />

{#if bars}
	<!-- the box IS the canvas: full window, less the space the dock took (W9) -->
	<div class="guide" style="bottom: {$viewportInset}px" aria-hidden="true">
		{#if bars.side === 'x'}
			<div class="bar" style="left: 0; top: 0; bottom: 0; width: {bars.size}px"></div>
			<div class="bar" style="right: 0; top: 0; bottom: 0; width: {bars.size}px"></div>
		{:else}
			<div class="bar" style="top: 0; left: 0; right: 0; height: {bars.size}px"></div>
			<div class="bar" style="bottom: 0; left: 0; right: 0; height: {bars.size}px"></div>
		{/if}
	</div>
{/if}

<style>
	.guide {
		position: fixed;
		/* `bottom` is set inline from the dock inset, so `inset: 0` would fight it */
		top: 0;
		left: 0;
		right: 0;
		pointer-events: none;
		/* above the viewport, below every panel/HUD */
		z-index: 1;
	}
	.bar {
		position: absolute;
		background: rgb(2 6 23 / 0.82);
	}
</style>
