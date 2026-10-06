<script>
	// 36-fb F23: Inspector ▸ Fluid emitter — every setting of `userData.fluidEmitter`. Its own
	// component (one Inspector line, the settings merge rule). Writes go through
	// setFluidEmitterFor: replicated, one undo entry each; the particles stay each peer's own.
	import InsToggle from '../menu/inspector/InsToggle.svelte';
	import Section from '../ui/Section.svelte';
	import SliderRow from '../ui/SliderRow.svelte';
	import ThemedSelect from '../ui/ThemedSelect.svelte';
	import { normalizeEmitter, EMITTER_MAX_PARTICLES, QUEST_EMITTER_CAP, MAX_AREA_SIDE } from '$lib/sim/fluidEmitterCore.js';
	import { setFluidEmitterFor } from '$lib/sim/fluidEmitterActions.js';

	/** @type {{object: any}} */
	let { object } = $props();
	const f = $derived(normalizeEmitter(object?.userData?.fluidEmitter));

	/** @param {any} patch */
	function set(patch) {
		setFluidEmitterFor(object.uuid, patch);
	}
	/** @param {number} axis @param {number} v */
	function setSize(axis, v) {
		const size = f.area.size.slice();
		size[axis] = v;
		set({ area: { size } });
	}
	/** @param {number} axis @param {number} v */
	function setOffset(axis, v) {
		const offset = f.area.offset.slice();
		offset[axis] = v;
		set({ area: { offset } });
	}
	const AIMS = /** @type {Record<string, number[]>} */ ({ down: [0, -1, 0], up: [0, 1, 0], forward: [0, 0, -1], side: [1, 0, 0] });
	const aim = $derived(Object.entries(AIMS).find(([, d]) => d.every((v, i) => Math.abs(v - f.dir[i]) < 1e-3))?.[0] ?? 'custom');
	const keywords = 'fluid emitter water particles pour spill leak fountain caps max particles lifetime area';
</script>

<div data-keywords={keywords} class="contents">
	<Section variant="panel" label="Fluid emitter">
		<div data-tour="fluid-emitter" class="contents">
			<InsToggle id="fluid-emitter-on" checked={f.on} onchange={(/** @type {any} */ e) => set({ on: e.currentTarget.checked })}>Emitting</InsToggle>
			<div class="ui-row items-center gap-2" title="Stream pours continuously; Spill releases the spill amount once">
				<span class="w-20 shrink-0 text-xs text-text-muted">Mode</span>
				<ThemedSelect
					id="fluid-emitter-mode"
					items={[
						{ value: 'stream', name: 'Stream' },
						{ value: 'burst', name: 'Spill (once)' }
					]}
					value={f.mode}
					onchange={(/** @type {any} */ v) => set({ mode: v })}
				/>
			</div>
			<SliderRow id="fluid-emitter-rate" label="Rate /s" min={0} max={3000} step={10} decimals={0} value={f.rate} onchange={(v) => set({ rate: v })} />
			{#if f.mode === 'burst'}
				<SliderRow id="fluid-emitter-amount" label="Spill amount" min={1} max={EMITTER_MAX_PARTICLES} step={10} decimals={0} value={f.amount} onchange={(v) => set({ amount: v })} />
			{/if}
			<SliderRow id="fluid-emitter-speed" label="Speed" min={0} max={12} step={0.1} value={f.speed} onchange={(v) => set({ speed: v })} />
			<SliderRow id="fluid-emitter-spread" label="Spread °" min={0} max={90} step={1} decimals={0} value={f.spread} onchange={(v) => set({ spread: v })} />
			<div class="ui-row items-center gap-2">
				<span class="w-20 shrink-0 text-xs text-text-muted">Aim</span>
				<ThemedSelect
					id="fluid-emitter-aim"
					items={[
						{ value: 'down', name: 'Down (pour)' },
						{ value: 'up', name: 'Up (fountain)' },
						{ value: 'forward', name: 'Forward' },
						{ value: 'side', name: 'Sideways' },
						...(aim === 'custom' ? [{ value: 'custom', name: 'Custom' }] : [])
					]}
					value={aim}
					onchange={(/** @type {any} */ v) => AIMS[v] && set({ dir: AIMS[v] })}
				/>
			</div>
			<p class="text-badge font-semibold uppercase tracking-wide text-text-muted">Hard caps</p>
			<SliderRow id="fluid-emitter-max" label="Max particles" min={64} max={EMITTER_MAX_PARTICLES} step={50} decimals={0} value={f.maxParticles} onchange={(v) => set({ maxParticles: v })} />
			<SliderRow id="fluid-emitter-lifetime" label="Lifetime s" min={0.5} max={600} step={0.5} value={f.lifetime} onchange={(v) => set({ lifetime: v })} />
			{#each ['Width', 'Height', 'Depth'] as label, i (label)}
				<SliderRow id={'fluid-emitter-area-' + i} label={'Area ' + label.toLowerCase()} min={0.3} max={MAX_AREA_SIDE} step={0.1} value={f.area.size[i]} onchange={(v) => setSize(i, v)} />
			{/each}
			<SliderRow id="fluid-emitter-area-drop" label="Area below" min={-MAX_AREA_SIDE} max={MAX_AREA_SIDE} step={0.1} value={f.area.offset[1]} onchange={(v) => setOffset(1, v)} />
			<InsToggle id="fluid-emitter-floor" checked={f.floor} onchange={(/** @type {any} */ e) => set({ floor: e.currentTarget.checked })}>Area floor holds water</InsToggle>
			<p class="text-badge font-semibold uppercase tracking-wide text-text-muted">Fluid</p>
			<SliderRow id="fluid-emitter-size" label="Drop size" min={0.025} max={0.12} step={0.005} decimals={3} value={f.particleSize} onchange={(v) => set({ particleSize: v })} />
			<SliderRow id="fluid-emitter-viscosity" label="Viscosity" min={0} max={1} step={0.01} value={f.viscosity} onchange={(v) => set({ viscosity: v })} />
			<SliderRow id="fluid-emitter-tension" label="Surface tension" min={0} max={2} step={0.05} value={f.surfaceTension} onchange={(v) => set({ surfaceTension: v })} />
			<SliderRow id="fluid-emitter-cohesion" label="Cohesion" min={0} max={1} step={0.05} value={f.cohesion} onchange={(v) => set({ cohesion: v })} />
			<SliderRow id="fluid-emitter-friction" label="Friction" min={0} max={1} step={0.05} value={f.friction} onchange={(v) => set({ friction: v })} />
			<div class="ui-row items-center gap-2">
				<span class="w-20 shrink-0 text-xs text-text-muted">Colour</span>
				<input
					id="fluid-emitter-color"
					type="color"
					class="h-6 w-8 cursor-pointer rounded-sm border border-border-strong bg-transparent"
					aria-label="Fluid colour"
					value={f.color}
					onchange={(/** @type {any} */ e) => set({ color: e.currentTarget.value })}
				/>
			</div>
			<SliderRow id="fluid-emitter-clarity" label="Clarity" min={0} max={1} step={0.05} value={f.clarity} onchange={(v) => set({ clarity: v })} />
			<div class="ui-row items-center gap-2">
				<span class="w-20 shrink-0 text-xs text-text-muted">Look</span>
				<ThemedSelect
					id="fluid-emitter-quality"
					items={[
						{ value: 'auto', name: 'Auto' },
						{ value: 'high', name: 'Smooth surface' },
						{ value: 'points', name: 'Drops (cheapest)' }
					]}
					value={f.quality}
					onchange={(/** @type {any} */ v) => set({ quality: v })}
				/>
			</div>
			<InsToggle id="fluid-emitter-interact" checked={f.interact} onchange={(/** @type {any} */ e) => set({ interact: e.currentTarget.checked })}>Collide with the scene</InsToggle>
			<InsToggle id="fluid-emitter-join" checked={f.joinPools} onchange={(/** @type {any} */ e) => set({ joinPools: e.currentTarget.checked })}>Pouring into water joins it</InsToggle>
			<button id="fluid-emitter-restart" class="ui-chip bg-gray-600 text-text-2 hover:bg-gray-500" onclick={() => set({ generation: f.generation + 1 })}>Restart</button>
			<p class="mt-1 text-badge text-text-muted">
				Each player simulates their own splash; these settings are shared. Pauses when off-screen. Quest shows drops (max {QUEST_EMITTER_CAP}). Water
				leaving the area is gone; pouring into a pool joins it.
			</p>
		</div>
	</Section>
</div>
