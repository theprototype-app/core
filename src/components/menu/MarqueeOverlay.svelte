<script>
	// Marquee rectangle (phase 13): Scene.svelte writes screen coords into the
	// store while shift-dragging; this draws the box above the viewport.
	import { marqueeRect } from '../../stores/sceneStore';
</script>

{#if $marqueeRect}
	<div
		class="pointer-events-none fixed border border-primary-400 bg-primary-500/10"
		style="left: {$marqueeRect.x0}px; top: {$marqueeRect.y0}px;
			width: {$marqueeRect.x1 - $marqueeRect.x0}px; height: {$marqueeRect.y1 - $marqueeRect.y0}px;
			z-index: var(--z-hud)"
	></div>
{/if}
