<script>
	// 47 T1/T2 — Inspector ▸ Terrain paint + Scatter, for a selected Terrain. The four layers
	// (colour, texture, tiling) the Paint brush blends between, and the scatter sets the
	// Scatter brush made (count, align to slope, remove). Painting itself happens in the
	// Sculpt toolbox; "Paint…" opens it on this terrain with the Paint brush armed.
	// Every edit is ONE undo entry + ONE message (terrainPaint.setTerrainLayers /
	// editScatterSet); a tiling scrub or a colour drag previews locally and commits on release.
	import Section from '../../ui/Section.svelte';
	import DragRow from '../../ui/DragRow.svelte';
	import UiButton from '../../ui/Button.svelte';
	import Checkbox from '../../ui/Checkbox.svelte';
	import ShaderTexturePicker from '../../editors/nodes/ShaderTexturePicker.svelte';
	import { sceneRevision } from '../../../stores/sceneStore';
	import { layersOf, setTerrainLayers, clearTerrainPaint, editScatterSet } from '$lib/terrainPaint';
	import { layerCoverage, base64ToBytes, decodeSplatBlock } from '$lib/terrainPaintCore';
	import { normalizeScatter, scatterColliderOf, MAX_INSTANCES } from '$lib/terrainScatterCore';
	import ThemedSelect from '../../ui/ThemedSelect.svelte';

	/** @type {{ object: any }} */
	let { object } = $props();

	const uuid = $derived(object?.uuid ?? '');
	// re-read on every scene change: a peer's edit, an undo, a brush stroke
	const layers = $derived.by(() => {
		void $sceneRevision;
		return uuid ? layersOf(uuid) : [];
	});
	const coverage = $derived.by(() => {
		void $sceneRevision;
		const d = decodeSplatBlock(object?.userData?.terrainSplat);
		return d ? [0, 1, 2, 3].map((i) => Math.round(layerCoverage(d.bytes, i) * 100)) : null;
	});
	const scatter = $derived.by(() => {
		void $sceneRevision;
		return normalizeScatter(object?.userData?.terrainScatter, base64ToBytes)?.sets ?? [];
	});
	const total = $derived(scatter.reduce((sum, s) => sum + s.count, 0));
	const materialColor = $derived.by(() => {
		void $sceneRevision;
		const m = Array.isArray(object?.material) ? object.material[0] : object?.material;
		return m?.color ? '#' + m.color.getHexString() : '#808080'; // tokens-ok: a material colour fallback (data, not UI)
	});

	const WHITE = '#ffffff'; // tokens-ok: a layer colour default (data, not UI)

	/** the layers an in-flight gesture started from (null = no gesture) */
	/** @type {any} */
	let gestureBefore = null;

	/** @param {number} i @param {Record<string, any>} patch @param {'preview'|'commit'|'now'} mode */
	function edit(i, patch, mode) {
		const next = layers.map((l, k) => (k === i ? { ...l, ...patch } : l));
		if (mode === 'preview') {
			if (gestureBefore === null) gestureBefore = object.userData.terrainLayers ?? null;
			setTerrainLayers(uuid, next, { record: false, send: false });
			return;
		}
		const before = gestureBefore ?? undefined;
		gestureBefore = null;
		setTerrainLayers(uuid, next, before === undefined ? {} : { before });
	}

	async function openPaint() {
		const ts = await import('$lib/terrainSculpt');
		if (ts.enterSculpt(uuid)) ts.sculptOp.set('paint');
	}
	async function openScatter() {
		const ts = await import('$lib/terrainSculpt');
		if (ts.enterSculpt(uuid)) ts.sculptOp.set('scatter');
	}
	const COLLIDER_ITEMS = [
		{ value: 'none', name: 'None' },
		{ value: 'box', name: 'Box' },
		{ value: 'sphere', name: 'Sphere' },
		{ value: 'hull', name: 'Mesh hull' }
	];
	/** @param {any} s */
	const setName = (s) => (s.source.kind === 'primitive' ? s.source.type : s.source.name || 'Library model');
</script>

<Section variant="panel" label="Terrain paint" aliases={['Splat', 'Terrain layers', 'Texture layers']}>
	<div id="terrain-paint-layers" class="flex flex-col gap-1.5">
		{#each layers as layer, i (i)}
			<div class="flex items-center gap-2 text-xs" id={`terrain-layer-${i}`}>
				<span class="w-12 shrink-0 text-text-muted">Layer {i + 1}</span>
				<input
					id={`terrain-layer-${i}-color`}
					type="color"
					class="h-6 w-8 shrink-0 cursor-pointer rounded-sm border border-border bg-transparent p-0"
					title={i === 0 && !layer.color ? 'The material colour — pick one to override it' : 'Layer colour (multiplies the texture)'}
					value={i === 0 && !layer.color ? materialColor : layer.color || WHITE}
					oninput={(e) => edit(i, { color: e.currentTarget.value }, 'preview')}
					onchange={(e) => edit(i, { color: e.currentTarget.value }, 'commit')}
				/>
				<ShaderTexturePicker
					compact
					hash={layer.texture}
					onpick={(/** @type {string} */ hash) => edit(i, { texture: hash || '' }, 'now')}
				/>
				<div class="min-w-0 flex-1">
					<DragRow
						id={`terrain-layer-${i}-tiling`}
						label="×"
						title="Tiling — how many times the texture repeats across the terrain"
						value={layer.tiling}
						min={0.1}
						max={200}
						step={0.05}
						snap={1}
						decimals={1}
						onscrubstart={() => (gestureBefore = object.userData.terrainLayers ?? null)}
						onchange={(/** @type {number} */ v) => edit(i, { tiling: v }, gestureBefore !== null ? 'preview' : 'now')}
						onscrubend={() => edit(i, {}, 'commit')}
					/>
				</div>
			</div>
			{#if i === 0 && (layer.color || layer.texture)}
				<button
					id="terrain-layer-0-material"
					class="ui-button-quiet self-start text-[length:var(--fs-badge)]"
					onclick={() => edit(0, { color: '', texture: '' }, 'now')}>Use the material for layer 1</button
				>
			{/if}
		{/each}
	</div>
	{#if coverage}
		<p id="terrain-paint-coverage" class="text-[length:var(--fs-badge)] text-text-muted">
			Painted: {coverage.map((c, i) => `${i + 1}: ${c}%`).join(' · ')}
		</p>
	{/if}
	<div class="flex flex-wrap gap-2">
		<UiButton id="terrain-paint-open" size="sm" variant="outline" onclick={openPaint}>Paint…</UiButton>
		{#if coverage}
			<UiButton id="terrain-paint-clear" size="sm" variant="outline" onclick={() => clearTerrainPaint(uuid)}>Clear paint</UiButton>
		{/if}
	</div>
</Section>

<Section variant="panel" label="Scatter" aliases={['Foliage', 'Instances', 'Trees']}>
	{#if scatter.length}
		<div id="terrain-scatter-sets" class="flex flex-col gap-1">
			{#each scatter as s (s.id)}
				<div class="flex flex-col gap-1 text-xs" data-scatter-set={s.id}>
					<div class="flex items-center gap-2">
						<span class="min-w-0 flex-1 truncate" title={setName(s)}>{setName(s)}</span>
						<span class="text-text-muted">{s.count}</span>
						<label class="flex items-center gap-1">
							<Checkbox label="Align to slope" checked={s.align} onchange={(/** @type {boolean} */ v) => editScatterSet(uuid, s.id, { align: !!v })} />
							Align
						</label>
						<button class="ui-button-quiet" title="Remove every instance of this model" onclick={() => editScatterSet(uuid, s.id, null)}>Remove</button>
					</div>
					<!-- 48 B1: what a simulation gives each instance (static, built on every peer from this field) -->
					<div class="flex items-center gap-2">
						<span class="w-14 shrink-0 text-text-muted">Collider</span>
						<ThemedSelect
							id={`terrain-scatter-collider-${s.id}`}
							class="min-w-0 flex-1"
							title="The static collider every instance of this model gets while a simulation runs"
							items={COLLIDER_ITEMS}
							value={scatterColliderOf(s.collider)}
							onchange={(/** @type {string} */ v) => editScatterSet(uuid, s.id, { collider: v })}
						/>
					</div>
				</div>
			{/each}
		</div>
		<p id="terrain-scatter-total" class="text-[length:var(--fs-badge)] text-text-muted">{total} of {MAX_INSTANCES} instances</p>
	{:else}
		<p class="text-[length:var(--fs-badge)] text-text-muted">No scattered models yet.</p>
	{/if}
	<UiButton id="terrain-scatter-open" size="sm" variant="outline" onclick={openScatter}>Scatter…</UiButton>
</Section>
