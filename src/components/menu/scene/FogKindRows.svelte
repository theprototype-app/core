<script>
	// 102b-papercuts (scout row 18): which fog — Linear (Near / Far, the fog every older build draws),
	// Distance (exponential: thickens with distance) or Height (lies on the ground, thinning upward).
	// Rows only; every edit goes through editEnvSky like the rest of the Fog block, so it replicates,
	// saves and undoes on the environment singleton. Near / Far stay shown for Linear only, and stay in
	// the document for the other two (an older build falls back to them).
	import PropRow from '../../ui/PropRow.svelte';
	import SliderRow from '../../ui/SliderRow.svelte';
	import ThemedSelect from '../../ui/ThemedSelect.svelte';
	import { editEnvSky } from '$lib/environment';
	import { fogKindOf, fogDensityOf, heightFogOf } from '$lib/fogModes.js';
	import { fogKindPatch } from '$lib/fogEdit.js';

	/** @type {{fog: any}} */
	let { fog } = $props();
	const kind = $derived(fogKindOf(fog));
	const layer = $derived(heightFogOf(fog));
</script>

<PropRow label="Kind" valueBox={false}>
	{#snippet control()}
		<ThemedSelect
			id="fog-kind"
			class="flex-1"
			value={kind}
			title="Linear: fog from Near to Far. Distance: thickens with distance. Height: lies on the ground and thins upward"
			items={[
				{ value: 'linear', name: 'Linear (near to far)' },
				{ value: 'distance', name: 'Distance' },
				{ value: 'height', name: 'Height (ground fog)' }
			]}
			onchange={(/** @type {any} */ v) => editEnvSky({ fog: fogKindPatch(fog, v) })}
		/>
	{/snippet}
</PropRow>
{#if kind !== 'linear'}
	<SliderRow id="fog-density" label="Density" min={0.001} max={0.3} step={0.001} decimals={3} value={fogDensityOf(fog)}
		onchange={(v) => editEnvSky({ fog: { density: v } })} />
{/if}
{#if layer}
	<SliderRow id="fog-base" label="Ground height" min={Math.min(-20, Math.floor(layer.base))} max={Math.max(50, Math.ceil(layer.base))} step={0.1} decimals={1} value={layer.base}
		onchange={(v) => editEnvSky({ fog: { base: v } })} />
	<SliderRow id="fog-thickness" label="Thickness" min={0.5} max={Math.max(60, Math.ceil(layer.thickness))} step={0.1} decimals={1} value={layer.thickness}
		onchange={(v) => editEnvSky({ fog: { thickness: v } })} />
{/if}
