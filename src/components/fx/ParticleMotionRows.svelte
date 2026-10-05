<script>
	// 37-fx: Inspector ▸ Particles — how the particles are DRAWN (sprites, stretched along
	// their motion, trails, a ribbon) and how much of the emitter's own velocity they keep.
	// Its own file so the Inspector edit is one line.
	import ThemedSelect from '../ui/ThemedSelect.svelte';
	import SliderRow from '../ui/SliderRow.svelte';
	import { renderModeOf } from '$lib/particleStrips.js';

	/** @type {{p: any, set: (patch: any) => void}} */
	let { p, set } = $props();

	const render = $derived(p.render ?? 'points');
	const world = $derived((p.space ?? 'local') === 'world');
</script>

<div class="ui-row items-center gap-2" data-keywords="particles render stretch trail ribbon streak sparks velocity">
	<span
		class="w-20 shrink-0 text-xs text-gray-400"
		title="Sprites: one image per particle. Stretched: each particle is drawn along its motion (sparks). Trails: each particle draws its own path. Ribbon: one band through the particles in the order they were born — in World space, the path the emitter took.">Draw as</span>
	<ThemedSelect
		id="particles-render"
		items={[
			{ value: 'points', name: 'Sprites' },
			{ value: 'stretch', name: 'Stretched along motion' },
			{ value: 'trails', name: 'Trails (per particle)' },
			{ value: 'ribbon', name: 'Ribbon (emitter path)' }
		]}
		value={render}
		onchange={(/** @type {any} */ v) => set({ render: v })}
	/>
</div>
{#if render === 'stretch'}
	<SliderRow label="Stretch" min={0.005} max={0.3} step={0.005} value={p.stretch ?? 0.04}
		onchange={(v) => set({ stretch: v })} />
{:else if render === 'trails' || renderModeOf(p) === 'trails'}
	<SliderRow label="Trail length" min={0.05} max={2} step={0.05} value={p.trail ?? 0.4}
		onchange={(v) => set({ trail: v })} />
	<SliderRow label="Segments" min={2} max={16} step={1} value={p.trailSegments ?? 8}
		onchange={(v) => set({ trailSegments: v })} />
{/if}
{#if render === 'ribbon' && renderModeOf(p) !== 'ribbon'}
	<p id="particles-ribbon-note" class="text-xs text-gray-400">
		A ribbon joins particles in the order they are born, so it needs Continuous emission — a burst is drawn as trails.
	</p>
{:else if render === 'ribbon' && !world}
	<p id="particles-ribbon-note" class="text-xs text-gray-400">
		In Local space the ribbon rides the object. Set Space to World for a trail behind it.
	</p>
{/if}
{#if world}
	<SliderRow label="Inherit velocity" min={0} max={1} step={0.05} value={p.inherit ?? 0}
		onchange={(v) => set({ inherit: v })} />
{/if}
