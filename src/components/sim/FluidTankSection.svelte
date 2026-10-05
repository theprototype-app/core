<script>
	// 36-sim U2b: Inspector ▸ Fluid tank — every setting of a tank's `userData.fluid`.
	// Its own component (one Inspector line, the settings merge rule). Writes go through
	// setFluidFor: replicated, one undo entry each; the particles stay each peer's own.
	import { Checkbox } from 'flowbite-svelte';
	import Section from '../ui/Section.svelte';
	import SliderRow from '../ui/SliderRow.svelte';
	import ThemedSelect from '../ui/ThemedSelect.svelte';
	import { normalizeFluid, FLUID_MAX_PARTICLES } from '$lib/sim/fluidCore.js';
	import { setFluidFor } from '$lib/sim/fluidActions.js';

	/** @type {{object: any}} */
	let { object } = $props();
	const f = $derived(normalizeFluid(object?.userData?.fluid));

	/** @param {any} patch */
	function set(patch) {
		setFluidFor(object.uuid, patch);
	}
</script>

<Section label="Fluid tank">
	<div data-tour="fluid-tank" class="contents">
		<SliderRow id="fluid-count" label="Particles" min={200} max={FLUID_MAX_PARTICLES} step={100} decimals={0} value={f.count} onchange={(v) => set({ count: v })} />
		<SliderRow id="fluid-fill" label="Fill" min={0} max={0.95} step={0.05} value={f.fill} onchange={(v) => set({ fill: v })} />
		<SliderRow id="fluid-viscosity" label="Viscosity" min={0} max={1} step={0.01} value={f.viscosity} onchange={(v) => set({ viscosity: v })} />
		<SliderRow id="fluid-tension" label="Surface tension" min={0} max={2} step={0.05} value={f.surfaceTension} onchange={(v) => set({ surfaceTension: v })} />
		<SliderRow id="fluid-gravity" label="Gravity ×" min={-2} max={4} step={0.05} value={f.gravityScale} onchange={(v) => set({ gravityScale: v })} />
		<div class="ui-row items-center gap-2">
			<span class="w-20 shrink-0 text-xs text-gray-400">Colour</span>
			<input
				id="fluid-color"
				type="color"
				class="h-6 w-8 cursor-pointer rounded-sm border border-gray-600 bg-transparent"
				aria-label="Fluid colour"
				value={f.color}
				onchange={(/** @type {any} */ e) => set({ color: e.currentTarget.value })}
			/>
		</div>
		<SliderRow id="fluid-clarity" label="Clarity" min={0} max={1} step={0.05} value={f.clarity} onchange={(v) => set({ clarity: v })} />
		<div class="ui-row items-center gap-2">
			<span class="w-20 shrink-0 text-xs text-gray-400">Look</span>
			<ThemedSelect
				id="fluid-quality"
				items={[
					{ value: 'auto', name: 'Auto (surface on desktop, drops on Quest)' },
					{ value: 'high', name: 'Smooth surface' },
					{ value: 'points', name: 'Drops (cheapest)' }
				]}
				value={f.quality}
				onchange={(/** @type {any} */ v) => set({ quality: v })}
			/>
		</div>
		<Checkbox id="fluid-emitter-on" checked={f.emitter.on} onchange={(/** @type {any} */ e) => set({ emitter: { on: e.currentTarget.checked } })}>Pour (emitter)</Checkbox>
		{#if f.emitter.on}
			<SliderRow id="fluid-emitter-rate" label="Pour rate" min={0} max={4000} step={50} decimals={0} value={f.emitter.rate} onchange={(v) => set({ emitter: { rate: v } })} />
			<SliderRow id="fluid-emitter-speed" label="Pour speed" min={0} max={10} step={0.1} value={f.emitter.speed} onchange={(v) => set({ emitter: { speed: v } })} />
		{/if}
		<Checkbox id="fluid-drain-on" checked={f.drain.on} onchange={(/** @type {any} */ e) => set({ drain: { on: e.currentTarget.checked } })}>Drain</Checkbox>
		{#if f.drain.on}
			<SliderRow id="fluid-drain-rate" label="Drain rate" min={0} max={4000} step={50} decimals={0} value={f.drain.rate} onchange={(v) => set({ drain: { rate: v } })} />
		{/if}
		<!-- 36-fb-water F16: tip the tank and it pours out — capped, so it never piles up -->
		<Checkbox id="fluid-spill-on" checked={f.spill.on} onchange={(/** @type {any} */ e) => set({ spill: { on: e.currentTarget.checked } })}>Spill when tipped</Checkbox>
		{#if f.spill.on}
			<SliderRow id="fluid-spill-max" label="Max spilled drops" min={10} max={2000} step={10} decimals={0} value={f.spill.maxDrops} onchange={(v) => set({ spill: { maxDrops: v } })} />
			<SliderRow id="fluid-spill-life" label="Drop lifetime (s)" min={0.5} max={30} step={0.5} value={f.spill.lifetime} onchange={(v) => set({ spill: { lifetime: v } })} />
		{/if}
		<button id="fluid-refill" class="ui-chip bg-gray-600 text-gray-200 hover:bg-gray-500" onclick={() => set({ generation: f.generation + 1 })}>
			Refill
		</button>
		<p class="mt-1 text-[10px] text-gray-400">
			Each player simulates their own splash; these settings are shared. Pauses when off-screen. Quest shows drops (max 1500).
		</p>
	</div>
</Section>
