<script>
	// 37-fx: Inspector ▸ Particles — how the particles are DRAWN (sprites, stretched along
	// their motion, trails, a ribbon) and how much of the emitter's own velocity they keep.
	// Its own file so the Inspector edit is one line. Built from the 38 redesign kit
	// (PropRow + Segmented, tokens only) so nothing here needs restyling later.
	import PropRow from '../ui/PropRow.svelte';
	import Segmented from '../ui/Segmented.svelte';
	import { renderModeOf } from '$lib/particleStrips.js';

	/** @type {{p: any, set: (patch: any) => void}} */
	let { p, set } = $props();

	const render = $derived(p.render ?? 'points');
	const world = $derived((p.space ?? 'local') === 'world');
	const MODES = [
		{ value: 'points', label: 'Sprites', title: 'Sprites: one image per particle' },
		{ value: 'stretch', label: 'Stretch', title: 'Stretched along motion: each particle is drawn along the way it moves (sparks)' },
		{ value: 'trails', label: 'Trails', title: 'Trails: each particle draws its own path' },
		{ value: 'ribbon', label: 'Ribbon', title: 'Ribbon: one band through the particles in the order they were born — in World space, the path the emitter took' }
	];
</script>

<div class="pm" data-keywords="particles render stretch trail ribbon streak sparks velocity">
	<!-- four options do not fit the PropRow middle column (measured: "SpritesStretch" ran
	     together and "Ribbon" clipped), so the control takes the whole row under its label -->
	<div class="pm-mode">
		<span id="particles-render-label" class="pm-label">Draw as</span>
		<Segmented id="particles-render" full labelledby="particles-render-label" options={MODES} value={render} onchange={(v) => set({ render: v })} />
	</div>
	{#if render === 'stretch'}
		<PropRow label="Stretch" slider min={0.005} max={0.3} step={0.005} decimals={3} value={p.stretch ?? 0.04}
			title="Seconds of motion each streak covers" onchange={(v) => set({ stretch: v })} />
	{:else if render === 'trails' || renderModeOf(p) === 'trails'}
		<PropRow label="Trail length" slider min={0.05} max={2} step={0.05} value={p.trail ?? 0.4}
			title="Seconds of path each trail shows" onchange={(v) => set({ trail: v })} />
		<PropRow label="Segments" slider min={2} max={16} step={1} decimals={0} value={p.trailSegments ?? 8}
			onchange={(v) => set({ trailSegments: Math.round(v) })} />
	{/if}
	{#if render === 'ribbon' && renderModeOf(p) !== 'ribbon'}
		<p id="particles-ribbon-note" class="pm-note">
			A ribbon joins particles in the order they are born, so it needs Continuous emission — a burst is drawn as trails.
		</p>
	{:else if render === 'ribbon' && !world}
		<p id="particles-ribbon-note" class="pm-note">
			In Local space the ribbon rides the object. Set Space to World for a trail behind it.
		</p>
	{/if}
	{#if world}
		<PropRow label="Inherit velocity" slider min={0} max={1} step={0.05} value={p.inherit ?? 0}
			title="How much of the emitter's own speed a particle keeps when it is born" onchange={(v) => set({ inherit: v })} />
	{/if}
</div>

<style>
	.pm {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}
	.pm-mode {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
	}
	.pm-label {
		font-size: var(--fs-desc);
		color: var(--text-2);
		line-height: 1.3;
	}
	.pm-note {
		margin: 0;
		font-size: var(--fs-desc);
		color: var(--text-muted);
	}
</style>
