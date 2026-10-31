<script>
	// 51-surface (E3) — one set's FILL: count or density over the host's whole surface, the minimum
	// spacing between instances, and the masks (slope range, height range, painted terrain layer),
	// all drawn from the set's seed, so every peer and every reload shows the same layout. A set with
	// no fill offers "Fill the whole surface".
	// Every edit is ONE undo entry + ONE message (terrainPaint.editScatterSet); a drag previews
	// locally (throttled — a 5,000-instance fill re-lays in tens of ms) and commits on release.
	import DragRow from '../../ui/DragRow.svelte';
	import UiButton from '../../ui/Button.svelte';
	import Checkbox from '../../ui/Checkbox.svelte';
	import ThemedSelect from '../../ui/ThemedSelect.svelte';
	import Segmented from '../../ui/Segmented.svelte';
	import { editScatterSet, rerollScatterSet } from '$lib/terrainPaint';
	import { newSeed, MAX_INSTANCES, DENSITY_MIN, DENSITY_MAX } from '$lib/terrainScatterCore';
	import { SLOPE_MAX, SPACING_MAX } from '$lib/scatterSurfaceCore';

	/** @type {{ object: any, set: any }} */
	let { object, set } = $props();

	const uuid = $derived(object?.uuid ?? '');
	const terrain = $derived(!!object?.userData?.terrain);
	const gen = $derived(set?.gen ?? null);
	const byCount = $derived(!!gen && gen.count != null);
	const idBase = $derived('scatter-fill-' + String(set?.id ?? '').replace(/[^\w-]/g, '_'));

	/** the host's local height range — the height mask's starting values and the drag's bounds */
	const yRange = $derived.by(() => {
		const geo = object?.geometry;
		if (!geo?.attributes?.position) return { lo: 0, hi: 1 };
		if (!geo.boundingBox) geo.computeBoundingBox();
		const lo = geo.boundingBox.min.y;
		const hi = geo.boundingBox.max.y;
		return { lo, hi: hi > lo ? hi : lo + 1 };
	});

	const DEFAULT_GEN = { count: 200, scaleMin: 0.8, scaleMax: 1.2, rot: true };

	// ---- one write path: a drag previews (throttled), its release commits with the before ----

	/** the block before an in-flight drag (null = no drag) @type {any} */
	let gestureBefore = null;
	/** @type {any} */
	let pending = null;
	/** @type {ReturnType<typeof setTimeout> | null} */
	let timer = null;

	/** @param {Record<string, any>} patch the new gen fields */
	function genPatch(patch) {
		const next = { ...(gen ?? DEFAULT_GEN), ...patch };
		for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
		return { gen: next };
	}

	/** @param {Record<string, any>} patch */
	function write(patch) {
		if (gestureBefore !== null) {
			pending = patch;
			if (!timer)
				timer = setTimeout(() => {
					timer = null;
					if (pending) editScatterSet(uuid, set.id, genPatch(pending), { record: false, send: false });
					pending = null;
				}, 100);
			return;
		}
		editScatterSet(uuid, set.id, genPatch(patch));
	}
	function scrubStart() {
		gestureBefore = object?.userData?.terrainScatter ?? null;
	}
	/** @param {() => Record<string, any>} last the final patch of the drag */
	function scrubEnd(last) {
		if (timer) clearTimeout(timer);
		timer = null;
		pending = null;
		const before = gestureBefore;
		gestureBefore = null;
		editScatterSet(uuid, set.id, genPatch(last()), { before });
	}

	// the live values a drag's release commits (DragRow reports values, not patches)
	let lastCount = $state(0);
	let lastDensity = $state(0);
	let lastSpacing = $state(0);
	/** @type {number[]} */
	let lastSlope = $state([0, SLOPE_MAX]);
	/** @type {number[]} */
	let lastHeight = $state([0, 1]);
	let lastLayerMin = $state(0.5);
	$effect(() => {
		lastCount = gen?.count ?? 200;
		lastDensity = gen?.density ?? 0.5;
		lastSpacing = gen?.spacing ?? 0;
		lastSlope = gen?.slope ?? [0, SLOPE_MAX];
		lastHeight = gen?.height ?? [yRange.lo, yRange.hi];
		lastLayerMin = gen?.layer?.min ?? 0.5;
	});

	function startFill() {
		editScatterSet(uuid, set.id, { gen: { ...DEFAULT_GEN }, seed: set.seed ?? newSeed() });
	}
	function stopFill() {
		editScatterSet(uuid, set.id, { gen: null, ov: null, seed: null });
	}
	/** @param {'count' | 'density'} mode */
	function setMode(mode) {
		if (mode === 'count') write({ count: lastCount || 200, density: undefined });
		else write({ density: lastDensity || 0.5, count: undefined });
	}

	const LAYER_ITEMS = [
		{ value: 'none', name: 'Any' },
		{ value: '0', name: 'Layer 1' },
		{ value: '1', name: 'Layer 2' },
		{ value: '2', name: 'Layer 3' },
		{ value: '3', name: 'Layer 4' }
	];
</script>

{#if !gen}
	<UiButton id={idBase + '-start'} size="sm" variant="outline" onclick={startFill}
		>Fill the whole surface</UiButton
	>
{:else}
	<div id={idBase} class="flex flex-col gap-1 rounded-sm bg-surface-inset px-2 py-1.5" data-scatter-fill={set.id}>
		<div class="flex items-center gap-2">
			<span class="w-14 shrink-0 text-text-muted">Fill</span>
			<Segmented
				id={idBase + '-mode'}
				label="Fill by"
				options={[
					{ value: 'count', label: 'Count' },
					{ value: 'density', label: 'Density' }
				]}
				value={byCount ? 'count' : 'density'}
				onchange={(/** @type {string} */ v) => setMode(v === 'count' ? 'count' : 'density')}
			/>
			<button
				id={idBase + '-reroll'}
				class="ui-button-quiet ml-auto"
				title={`A new seed (now ${set.seed}): a fresh layout with the same settings (hand edits are kept)`}
				onclick={() => rerollScatterSet(uuid, set.id)}>Re-roll</button
			>
		</div>
		{#if byCount}
			<DragRow
				id={idBase + '-count'}
				label="Count"
				title="How many instances the fill places over the whole surface (masks and spacing permitting)"
				value={gen.count}
				min={0}
				max={MAX_INSTANCES}
				step={2}
				snap={1}
				decimals={0}
				onscrubstart={scrubStart}
				onchange={(/** @type {number} */ v) => {
					lastCount = Math.round(v);
					write({ count: lastCount, density: undefined });
				}}
				onscrubend={() => scrubEnd(() => ({ count: lastCount, density: undefined }))}
			/>
		{:else}
			<DragRow
				id={idBase + '-density'}
				label="Per m²"
				title="Instances per square metre of the object's own surface (before its scale)"
				value={gen.density}
				min={DENSITY_MIN}
				max={DENSITY_MAX}
				step={0.01}
				snap={0.01}
				decimals={2}
				onscrubstart={scrubStart}
				onchange={(/** @type {number} */ v) => {
					lastDensity = v;
					write({ density: v, count: undefined });
				}}
				onscrubend={() => scrubEnd(() => ({ density: lastDensity, count: undefined }))}
			/>
		{/if}
		<DragRow
			id={idBase + '-spacing'}
			label="Spacing"
			title="Minimum distance between two instances — none closer, none overlapping (0 = off)"
			unit="length"
			value={gen.spacing ?? 0}
			min={0}
			max={SPACING_MAX}
			step={0.01}
			snap={0.05}
			decimals={2}
			onscrubstart={scrubStart}
			onchange={(/** @type {number} */ v) => {
				lastSpacing = v;
				write({ spacing: v > 0 ? v : undefined });
			}}
			onscrubend={() => scrubEnd(() => ({ spacing: lastSpacing > 0 ? lastSpacing : undefined }))}
		/>
		<div class="flex items-center gap-2">
			<Checkbox
				id={idBase + '-slope-on'}
				label="Limit by slope"
				checked={!!gen.slope}
				onchange={(/** @type {boolean} */ v) => write({ slope: v ? [0, 30] : undefined })}
			/>
			<span class="text-text-2">Slope</span>
			{#if gen.slope}
				<span class="ml-auto text-[length:var(--fs-badge)] text-text-faint">0° flat · 90° wall</span>
			{/if}
		</div>
		{#if gen.slope}
			<div class="grid grid-cols-2 gap-1">
				<DragRow
					id={idBase + '-slope-min'}
					label="From"
					ariaLabel="Slope from (degrees)"
					unit="angleDeg"
					value={gen.slope[0]}
					min={0}
					max={SLOPE_MAX}
					step={0.5}
					snap={1}
					decimals={0}
					onscrubstart={scrubStart}
					onchange={(/** @type {number} */ v) => {
						lastSlope = [v, lastSlope[1]];
						write({ slope: lastSlope });
					}}
					onscrubend={() => scrubEnd(() => ({ slope: lastSlope }))}
				/>
				<DragRow
					id={idBase + '-slope-max'}
					label="To"
					ariaLabel="Slope to (degrees)"
					unit="angleDeg"
					value={gen.slope[1]}
					min={0}
					max={SLOPE_MAX}
					step={0.5}
					snap={1}
					decimals={0}
					onscrubstart={scrubStart}
					onchange={(/** @type {number} */ v) => {
						lastSlope = [lastSlope[0], v];
						write({ slope: lastSlope });
					}}
					onscrubend={() => scrubEnd(() => ({ slope: lastSlope }))}
				/>
			</div>
		{/if}
		<div class="flex items-center gap-2">
			<Checkbox
				id={idBase + '-height-on'}
				label="Limit by height"
				checked={!!gen.height}
				onchange={(/** @type {boolean} */ v) => write({ height: v ? [yRange.lo, yRange.hi] : undefined })}
			/>
			<span class="text-text-2">Height</span>
			{#if gen.height}
				<span class="ml-auto text-[length:var(--fs-badge)] text-text-faint">in the object's own frame</span>
			{/if}
		</div>
		{#if gen.height}
			<div class="grid grid-cols-2 gap-1">
				<DragRow
					id={idBase + '-height-min'}
					label="From"
					ariaLabel="Height from (metres)"
					unit="length"
					value={gen.height[0]}
					step={0.02}
					snap={0.05}
					decimals={2}
					onscrubstart={scrubStart}
					onchange={(/** @type {number} */ v) => {
						lastHeight = [v, lastHeight[1]];
						write({ height: lastHeight });
					}}
					onscrubend={() => scrubEnd(() => ({ height: lastHeight }))}
				/>
				<DragRow
					id={idBase + '-height-max'}
					label="To"
					ariaLabel="Height to (metres)"
					unit="length"
					value={gen.height[1]}
					step={0.02}
					snap={0.05}
					decimals={2}
					onscrubstart={scrubStart}
					onchange={(/** @type {number} */ v) => {
						lastHeight = [lastHeight[0], v];
						write({ height: lastHeight });
					}}
					onscrubend={() => scrubEnd(() => ({ height: lastHeight }))}
				/>
			</div>
		{/if}
		{#if terrain}
			<!-- the painted terrain layer mask: the fill follows the paint (re-paint and it re-lays) -->
			<div class="flex items-center gap-2">
				<span class="w-14 shrink-0 text-text-muted">On paint</span>
				<ThemedSelect
					id={idBase + '-layer'}
					class="min-w-0 flex-1"
					title="Only where this painted layer covers the terrain"
					items={LAYER_ITEMS}
					value={gen.layer ? String(gen.layer.i) : 'none'}
					onchange={(/** @type {string} */ v) =>
						write({ layer: v === 'none' ? undefined : { i: Number(v), min: lastLayerMin } })}
				/>
			</div>
			{#if gen.layer}
				<DragRow
					id={idBase + '-layer-min'}
					label="Coverage"
					title="How much of the layer must be there (0..1) for an instance to be placed"
					value={gen.layer.min}
					min={0}
					max={1}
					step={0.01}
					snap={0.05}
					decimals={2}
					onscrubstart={scrubStart}
					onchange={(/** @type {number} */ v) => {
						lastLayerMin = v;
						write({ layer: { i: gen.layer.i, min: v } });
					}}
					onscrubend={() => scrubEnd(() => ({ layer: { i: gen.layer.i, min: lastLayerMin } }))}
				/>
			{/if}
		{/if}
		<button
			id={idBase + '-stop'}
			class="ui-button-quiet self-start text-[length:var(--fs-badge)]"
			title="Remove the fill (instances painted by hand stay)"
			onclick={stopFill}>Remove fill</button
		>
	</div>
{/if}
