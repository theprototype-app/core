<script>
	// 36-sim I1: the per-object "Floats" override in Inspector ▸ Physics (dynamic bodies).
	// Its own file so the Inspector edit is one line (the settings/menus merge rule).
	// Writes `userData.physics.floats` through the caller's setPhysics — the shared write
	// path that replicates, records undo and reaches a running simulation.
	import ThemedSelect from '../ui/ThemedSelect.svelte';
	import SliderRow from '../ui/SliderRow.svelte';
	import { FLOAT_PRESETS, normalizeFloats } from '$lib/sim/buoyancy.js';
	import { floatSummary, floatWords } from '$lib/sim/floatSummary.js'; // 104 B3: the numbers set_physics answers

	/** @type {{object: any, setPhysics: (patch: any) => void}} */
	let { object, setPhysics } = $props();

	const raw = $derived(object?.userData?.physics?.floats);
	const floats = $derived(normalizeFloats(raw));
	/** the select's value: off · a preset name · 'mass' · 'custom' */
	const kind = $derived.by(() => {
		if (floats.off) return 'off';
		if (floats.density === 'mass') return 'mass';
		const hit = Object.entries(FLOAT_PRESETS).find(([, d]) => d === floats.density);
		return hit ? hit[0] : 'custom';
	});
	// 104 B3: the same waterline set_physics answers (density, share under, draft in metres); re-read on
	// every floats / mass write
	const summary = $derived.by(() => {
		void raw;
		void object?.userData?.physics?.mass;
		return floatSummary(object);
	});

	/** @param {any} patch */
	function write(patch) {
		const next = { ...(raw ?? {}), ...patch };
		for (const key of Object.keys(next)) if (next[key] == null) delete next[key];
		// the default writes no key — a scene that never touched this stays byte-identical
		setPhysics({ floats: Object.keys(next).length ? next : null });
	}

	/** @param {string} v */
	function pick(v) {
		if (v === 'off') write({ off: true });
		else if (v === 'mass') write({ off: null, density: 'mass' });
		else if (v === 'auto') write({ off: null, density: null });
		else if (v in FLOAT_PRESETS) write({ off: null, density: /** @type {any} */ (FLOAT_PRESETS)[v] });
	}
</script>

<div class="ui-row items-center gap-2" data-tour="physics-floats">
	<span class="w-20 shrink-0 text-xs text-text-muted" title="How this body behaves in water volumes">Floats</span>
	<ThemedSelect
		id="physics-floats"
		items={[
			{ value: 'auto', name: 'Auto (half under)' },
			{ value: 'foam', name: 'Foam' },
			{ value: 'cork', name: 'Cork' },
			{ value: 'wood', name: 'Wood' },
			{ value: 'ice', name: 'Ice' },
			{ value: 'rubber', name: 'Rubber (sinks slowly)' },
			{ value: 'stone', name: 'Stone (sinks)' },
			{ value: 'metal', name: 'Metal (sinks)' },
			{ value: 'mass', name: 'From mass ÷ volume' },
			...(kind === 'custom' ? [{ value: 'custom', name: 'Custom' }] : []),
			{ value: 'off', name: 'Off (ignores water)' }
		]}
		value={kind}
		onchange={(/** @type {any} */ v) => pick(v)}
	/>
</div>
{#if !floats.off}
	{#if floats.density !== 'mass'}
		<SliderRow
			id="physics-floats-density"
			label="Density"
			min={10}
			max={8000}
			step={10}
			decimals={0}
			value={floats.density}
			onchange={(v) => write({ density: v })}
		/>
	{/if}
	<SliderRow
		id="physics-floats-multiplier"
		label="Buoyancy ×"
		min={0}
		max={4}
		step={0.05}
		value={floats.multiplier}
		onchange={(v) => write({ multiplier: v === 1 ? null : v })}
	/>
	<SliderRow
		id="physics-floats-drag"
		label="Water drag ×"
		min={0}
		max={4}
		step={0.05}
		value={floats.drag}
		onchange={(v) => write({ drag: v === 1 ? null : v })}
	/>
	<p class="text-[length:var(--fs-badge)] text-text-muted" id="physics-floats-hint">
		{#if floats.density === 'mass'}Density = mass ÷ collider volume. {/if}{floatWords(summary)}
	</p>
{/if}
