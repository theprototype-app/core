<script>
	// 102b-papercuts: the Geometry section's offer for a BAKED rounded box (a mesh that is exactly one). A lazy
	// chunk: it only shows once the rounded-box chunk has recognised the mesh. Never converts by itself.
	import Section from '../ui/Section.svelte';
	import UiButton from '../ui/Button.svelte';

	/** @type {{ offer: {width: number, height: number, depth: number, radius: number}, uuid: string, onconverted?: () => void }} */
	let { offer, uuid, onconverted = () => {} } = $props();
</script>

<Section variant="panel" label="Geometry">
	<p id="geometry-rounded-offer" class="px-1 text-[length:var(--fs-badge)] text-text-2">
		This mesh is a rounded box ({offer.width} x {offer.height} x {offer.depth} m, corner {offer.radius} m).
	</p>
	<UiButton
		id="geometry-convert-rounded"
		size="sm"
		variant="outline"
		title="Make it a Box with a corner radius: it looks the same, saves as a few numbers instead of every vertex, and gets its Geometry rows back. Undo puts the mesh back."
		onclick={() => {
			void import('$lib/roundedBoxConvert.js').then((m) => {
				if (m.convertToRoundedBox(uuid)) onconverted();
			});
		}}>Convert to a rounded Box</UiButton
	>
</Section>
