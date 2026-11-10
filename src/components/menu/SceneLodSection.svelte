<script>
	// 46 P2 — Configure Scene ▸ Level of detail: the SCENE's LOD distance (environment.lodBias,
	// replicated scene data — environment.js). One knob, because when detail steps down is a
	// decision about how this scene looks; everything else about LOD is per asset (its LOD group,
	// Explorer ▸ Import settings) or per device (Settings ▸ Import, the quality governor).
	import Section from '../ui/Section.svelte';
	import SliderRow from '../ui/SliderRow.svelte';
	import { environment, lodBiasOf, setSceneLodBias } from '$lib/environment';

	/** 78-int PL17: collapsed by default; the group label (The scene) replaces the Shared badge */
	let { closed = false, note = '' } = $props();
	const value = $derived(lodBiasOf($environment));
</script>

<Section variant="panel" label="Level of detail" {closed} {note}>
	<SliderRow
		id="scene-lod-bias"
		label="LOD distance"
		resetValue={1}
		min={0.25}
		max={4}
		step={0.05}
		{value}
		onchange={(v) => setSceneLodBias(v)}
	/>
	<p class="text-text-muted text-[length:var(--fs-badge)] italic">
		Above 1 keeps full detail further away; below 1 switches to lighter levels sooner. Applies to
		every model with an LOD chain, for everyone in the scene.
	</p>
</Section>
