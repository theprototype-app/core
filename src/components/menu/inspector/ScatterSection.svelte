<script>
	// 47 T2 — Inspector ▸ Scatter: the sets a scatter brush (or a fill) made on this object —
	// count, align to slope, collider, remove. 51-surface moved it out of TerrainPaintSection
	// VERBATIM so ANY mesh can carry a Scatter section (the "Add scatter" row); the terrain
	// renders it in the same place it always did.
	// Every edit is ONE undo entry + ONE message (terrainPaint.editScatterSet).
	import Section from '../../ui/Section.svelte';
	import DragRow from '../../ui/DragRow.svelte';
	import UiButton from '../../ui/Button.svelte';
	import Checkbox from '../../ui/Checkbox.svelte';
	import { sceneRevision } from '../../../stores/sceneStore';
	import {
		editScatterSet,
		addScatterSet,
		scatterSource,
		addScatterSource,
		removeScatterSource,
		setScatterSourceWeight,
		scatterBlockNow
	} from '$lib/terrainPaint';
	import { base64ToBytes } from '$lib/terrainPaintCore';
	import { normalizeScatter, scatterColliderOf, sourceOf, sourceKey, MAX_INSTANCES } from '$lib/terrainScatterCore';
	import { scatterCounts } from '$lib/terrainSurface';
	import ThemedSelect from '../../ui/ThemedSelect.svelte';
	import ScatterFillRows from './ScatterFillRows.svelte'; // 51-surface E3
	import { sourceChoices, resolveSourceChoice, sourceLabel, packChoiceList, loadPackChoices } from '$lib/scatterSources';
	import { explorerItems } from '$lib/explorer';
	import { prefabs } from '$lib/prefabs';

	/** @type {{ object: any }} */
	let { object } = $props();

	const uuid = $derived(object?.uuid ?? '');
	// re-read on every scene change: a peer's edit, an undo, a brush stroke
	const scatter = $derived.by(() => {
		void $sceneRevision;
		return normalizeScatter(object?.userData?.terrainScatter, base64ToBytes)?.sets ?? [];
	});
	// 51-surface: what each set DRAWS (painted + its fill after masks/spacing), from the last layout
	const drawn = $derived.by(() => {
		void $sceneRevision;
		return scatterCounts(object);
	});
	const countOf = (/** @type {any} */ s) => drawn[s.id] ?? s.count;
	const total = $derived(scatter.reduce((sum, s) => sum + countOf(s), 0));
	const terrain = $derived(!!object?.userData?.terrain);
	$effect(() => {
		if (scatter.length) loadPackChoices();
	});
	const addItems = $derived(
		sourceChoices({ library: $explorerItems, packs: $packChoiceList, prefabs: $prefabs, current: [$scatterSource] })
	);
	let preparing = $state('');
	/** 51 E1: add a model to a set — it becomes a weighted mix @param {any} s @param {string} key */
	async function addModel(s, key) {
		preparing = s.id;
		try {
			const source = await resolveSourceChoice(key, $explorerItems);
			if (source) addScatterSource(uuid, s.id, source, 1);
		} finally {
			preparing = '';
		}
	}
	/** the block a scrub started from (null = no gesture) @type {any} */
	let setBefore = null;
	/** @type {any} */
	let lastPatch = null;
	/** a set-field scrub: preview locally, ONE entry + message on release
	 * @param {any} s @param {Record<string, any>} patch */
	function setField(s, patch) {
		if (setBefore !== null) {
			lastPatch = { id: s.id, patch };
			editScatterSet(uuid, s.id, patch, { record: false, send: false });
		} else editScatterSet(uuid, s.id, patch);
	}
	function endField() {
		const before = setBefore;
		setBefore = null;
		if (lastPatch) editScatterSet(uuid, lastPatch.id, lastPatch.patch, { before });
		lastPatch = null;
	}
	/** @param {any} s @param {number} i @param {number} w */
	function setWeight(s, i, w) {
		if (setBefore !== null) {
			setScatterSourceWeight(uuid, s.id, i, w, { record: false, send: false });
			lastPatch = { weight: [s.id, i, w] };
		} else setScatterSourceWeight(uuid, s.id, i, w);
	}
	function endWeight() {
		const before = setBefore;
		setBefore = null;
		if (lastPatch?.weight) setScatterSourceWeight(uuid, lastPatch.weight[0], lastPatch.weight[1], lastPatch.weight[2], { before });
		lastPatch = null;
	}
	/** the add-a-model choices a set does not already draw @param {any} s */
	const notInSet = (s) => {
		const keys = new Set(sourcesOfSet(s).map((/** @type {any} */ e) => sourceKey(e.source)));
		return addItems.filter((c) => !keys.has(c.value));
	};
	/** @param {any} s */
	const sourcesOfSet = (s) => s.sources ?? [{ source: s.source, w: 1 }];

	async function openScatter() {
		const ts = await import('$lib/terrainSculpt');
		// 51-surface: on a plain mesh a scatter-only session (the geometry is left untouched)
		if (ts.enterSculpt(uuid, { scatter: !terrain })) ts.sculptOp.set('scatter');
	}
	/** 51-surface: a new FILL set — the brush's current source over the whole surface */
	function addFill() {
		const source = sourceOf($scatterSource) ?? { kind: 'primitive', type: 'Cone' };
		addScatterSet(uuid, { source, gen: { count: 200, scaleMin: 0.8, scaleMax: 1.2, rot: true } });
	}
	const COLLIDER_ITEMS = [
		{ value: 'none', name: 'None' },
		{ value: 'box', name: 'Box' },
		{ value: 'sphere', name: 'Sphere' },
		{ value: 'hull', name: 'Mesh hull' }
	];
	/** @param {any} s */
	const setName = (s) => (s.sources ? 'Mix of ' + s.sources.length + ' models' : sourceLabel(s.source));
</script>

<Section variant="panel" label="Scatter" aliases={['Foliage', 'Instances', 'Trees']}>
	{#if scatter.length}
		<div id="terrain-scatter-sets" class="flex flex-col gap-1">
			{#each scatter as s (s.id)}
				<div class="flex flex-col gap-1 text-xs" data-scatter-set={s.id}>
					<div class="flex items-center gap-2">
						<span class="min-w-0 flex-1 truncate" title={setName(s)}>{setName(s)}</span>
						<span class="text-text-muted" title="Instances this set draws" data-scatter-count={countOf(s)}>{countOf(s)}</span>
						<label class="flex items-center gap-1">
							<Checkbox label={terrain ? 'Align to slope' : 'Align to surface'} checked={s.align} onchange={(/** @type {boolean} */ v) => editScatterSet(uuid, s.id, { align: !!v })} />
							Align
						</label>
						{#if terrain}
							<!-- 51 E5: the edit tools (and so convert) read a terrain's instances -->
							<button
								class="ui-button-quiet"
								data-scatter-to-objects={s.id}
								title="Make every instance of this model a real object (one undo turns them back)"
								onclick={() => import('$lib/scatterConvert').then((m) => m.instancesToObjects({ scope: 'set', uuid, setId: s.id }))}>To objects</button
							>
						{/if}
						<button class="ui-button-quiet" title="Remove every instance of this set" onclick={() => editScatterSet(uuid, s.id, null)}>Remove</button>
					</div>
					<ul class="flex flex-col gap-0.5" aria-label={`Models in ${setName(s)}`} data-scatter-sources={s.id}>
						{#each sourcesOfSet(s) as e, i (i)}
							<li class="flex flex-col" data-scatter-source={i}>
								<div class="flex items-center gap-2">
									<span class="min-w-0 flex-1 truncate" title={sourceLabel(e.source)}>{sourceLabel(e.source)}</span>
									{#if s.sources}
										<div class="w-20 shrink-0">
											<DragRow
												id={`terrain-scatter-weight-${s.id}-${i}`}
												label="w"
												ariaLabel={`Weight of ${sourceLabel(e.source)}`}
												title="How often this model is picked, against the others in the set"
												value={e.w}
												min={0.01}
												max={1000}
												step={0.05}
												decimals={1}
												onscrubstart={() => (setBefore = scatterBlockNow(uuid))}
												onchange={(/** @type {number} */ v) => setWeight(s, i, v)}
												onscrubend={endWeight}
											/>
										</div>
										<button class="ui-button-quiet" aria-label={`Remove ${sourceLabel(e.source)} from this set`} title="Remove this model (and the instances painted with it)" onclick={() => removeScatterSource(uuid, s.id, i)}>✕</button>
									{/if}
								</div>
								{#if e.source.note}
									<span class="text-[length:var(--fs-badge)] text-text-muted" data-scatter-note>{e.source.note}</span>
								{/if}
							</li>
						{/each}
					</ul>
					<ThemedSelect
						id={`terrain-scatter-add-${s.id}`}
						class="min-w-0"
						title="Mix another model into this set — a primitive, a Library model, a pack item, a prefab (its look) or the brush's current source"
						placeholder={preparing === s.id ? 'Preparing…' : 'Add a model to the mix…'}
						clip={false}
						items={notInSet(s)}
						value={undefined}
						onchange={(/** @type {string} */ v) => addModel(s, String(v))}
					/>
					<!-- 51 E1: per-instance colour variation, and how deep each instance sits in the ground -->
					<div class="flex items-center gap-2">
						<div class="min-w-0 flex-1">
							<DragRow
								id={`terrain-scatter-tint-${s.id}`}
								label="Tint"
								title="Colour variation between instances (0 = all alike)"
								value={s.tint ?? 0}
								min={0}
								max={1}
								step={0.005}
								decimals={2}
								onscrubstart={() => (setBefore = scatterBlockNow(uuid))}
								onchange={(/** @type {number} */ v) => setField(s, { tint: v })}
								onscrubend={endField}
							/>
						</div>
						<div class="min-w-0 flex-1">
							<DragRow
								id={`terrain-scatter-sink-${s.id}`}
								label="Sink"
								title="Push each instance into the ground by this much (metres at scale 1; negative lifts it)"
								value={s.sink ?? 0}
								min={-2}
								max={5}
								step={0.005}
								decimals={2}
								unit="length"
								onscrubstart={() => (setBefore = scatterBlockNow(uuid))}
								onchange={(/** @type {number} */ v) => setField(s, { sink: v })}
								onscrubend={endField}
							/>
						</div>
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
					<ScatterFillRows {object} set={s} />
				</div>
			{/each}
		</div>
		<p id="terrain-scatter-total" class="text-[length:var(--fs-badge)] text-text-muted">{total} of {MAX_INSTANCES} instances</p>
	{:else}
		<p class="text-[length:var(--fs-badge)] text-text-muted">
			{terrain ? 'No scattered models yet.' : 'Scatter models over this object’s surface — they move, turn and scale with it.'}
		</p>
	{/if}
	<div class="flex flex-wrap gap-2">
		<!-- 51-surface E2: the "Add scatter" row (any mesh — the Water section's Add bubble / pour
		     emitter rows sit just above it); it adds a FILL over the whole surface -->
		<UiButton id="scatter-add" size="sm" variant="outline" onclick={addFill}>{scatter.length ? 'Add fill' : 'Add scatter'}</UiButton>
		<UiButton id="terrain-scatter-open" size="sm" variant="outline" onclick={openScatter}>{terrain ? 'Scatter…' : 'Paint scatter…'}</UiButton>
	</div>
</Section>
