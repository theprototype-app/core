<script lang="ts">
	import { knifePreview } from '$lib/faceEdit';

	// M9b: the knife's rubber band. The cut is defined in SCREEN space, so the preview belongs
	// in the DOM rather than the scene — there is no 3D line to draw, and a scene-root line
	// would need a depth that the cut does not have.
	//
	// The <svg> carries explicit width/height: an svg is a REPLACED element, so `position:
	// fixed; inset: 0` alone leaves it at its 300x150 intrinsic box and silently CLIPS every
	// child away (the documented trap).
</script>

{#if $knifePreview}
	<svg class="knife-overlay" width="100%" height="100%" aria-hidden="true">
		<line
			x1={$knifePreview.from[0]}
			y1={$knifePreview.from[1]}
			x2={$knifePreview.to[0]}
			y2={$knifePreview.to[1]}
			stroke="#ff7a1a"
			stroke-width="1.5"
			stroke-dasharray="6 4"
		/>
		<circle cx={$knifePreview.from[0]} cy={$knifePreview.from[1]} r="3.5" fill="#ff7a1a" />
		<circle
			cx={$knifePreview.to[0]}
			cy={$knifePreview.to[1]}
			r="3.5"
			fill="none"
			stroke="#ff7a1a"
			stroke-width="1.5"
		/>
	</svg>
{/if}

<style>
	.knife-overlay {
		position: fixed;
		inset: 0;
		/* the band must never eat the second click */
		pointer-events: none;
		/* above the viewport, below the panels — it is viewport feedback, not chrome */
		z-index: 2;
	}
</style>
