<script>
	// 16-P5: the letterbox guide for camera previews. The preview camera renders at
	// the camera's framing aspect (16:9, 4:3, …), which leaves bars in a differently
	// shaped window — this masks them, so what you see IS the frame you'd capture.
	// Pure overlay: pointer-events off, and it only exists while previewing a camera
	// whose `guide` is on and whose aspect is not 'free'.
	import { cameraPreview } from '$lib/cameraPreview';
	import { objectsGroup } from '../../stores/sceneStore';
	import { cameraSpec, aspectRatio } from '$lib/cameraObjects';

	const object = $derived(
		$cameraPreview ? ($objectsGroup?.getObjectByProperty('uuid', $cameraPreview.uuid) ?? null) : null
	);
	const spec = $derived(object ? cameraSpec(object) : null);
	const ratio = $derived(spec && spec.guide ? aspectRatio(spec.aspect) : 0);

	let vw = $state(0);
	let vh = $state(0);
	const bars = $derived.by(() => {
		if (!ratio || !vw || !vh) return null;
		const viewport = vw / vh;
		if (Math.abs(viewport - ratio) < 0.01) return null;
		// too WIDE a window -> vertical bars; too tall -> horizontal bars
		if (viewport > ratio) {
			const frame = vh * ratio;
			return { side: 'x', size: Math.max(0, (vw - frame) / 2) };
		}
		const frame = vw / ratio;
		return { side: 'y', size: Math.max(0, (vh - frame) / 2) };
	});
</script>

<svelte:window bind:innerWidth={vw} bind:innerHeight={vh} />

{#if bars}
	<div class="guide" aria-hidden="true">
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
		inset: 0;
		pointer-events: none;
		/* above the viewport, below every panel/HUD */
		z-index: 1;
	}
	.bar {
		position: absolute;
		background: rgb(2 6 23 / 0.82);
	}
</style>
