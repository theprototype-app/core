<script>
	// 102b-arrange row 2 — Inspector ▸ Tidy (any selection): the layer it is on, select similar,
	// rename many (multi-select) and randomise (multi-select). Every button is ONE undo step and one
	// wire envelope (tidyActions). A lazy chunk: the Inspector imports it on demand.
	import Section from '../../ui/Section.svelte';
	import PropRow from '../../ui/PropRow.svelte';
	import DragRow from '../../ui/DragRow.svelte';
	import ThemedSelect from '../../ui/ThemedSelect.svelte';
	import UiButton from '../../ui/Button.svelte';
	import { scenePhysicsState_ } from '$lib/scenePhysics';
	import { selectedObjects, sceneRevision, objectsGroup } from '../../../stores/sceneStore';
	import { normalizeLayers } from '$lib/layersCore.js';
	import { renamePlan } from '$lib/tidyCore.js';
	import { addLayer, setObjectsLayer, selectSimilar, renameMany, randomise } from '$lib/tidyActions.js';

	const sel = $derived(/** @type {string[]} */ ($selectedObjects ?? []));
	const multi = $derived(sel.length > 1);
	const layers = $derived(normalizeLayers($scenePhysicsState_?.layers) ?? []);
	/** the selection's layer: an id, '' (none) or null (mixed) */
	const current = $derived.by(() => {
		void $sceneRevision;
		const ids = sel.map((u) => /** @type {any} */ ($objectsGroup)?.getObjectByProperty('uuid', u)?.userData?.layer ?? '');
		return ids.every((id) => id === ids[0]) ? ids[0] ?? '' : null;
	});
	const layerItems = $derived([{ value: '', name: 'No layer' }, ...layers.map((l) => ({ value: l.id, name: l.name })), { value: '__new', name: 'New layer…' }]);

	/** @param {any} v */
	function pickLayer(v) {
		const id = v === '__new' ? addLayer() : String(v ?? '');
		if (id === null) return;
		setObjectsLayer(sel, id || null);
	}

	const SIMILAR = [
		{ by: 'shape', text: 'Shape', title: 'Select every object of the same shape (primitive type, or the same mesh)' },
		{ by: 'material', text: 'Material', title: 'Select every object with the same material (type, colour and texture, or a shared material)' },
		{ by: 'prefab', text: 'Prefab', title: 'Select every instance of the same prefab' },
		{ by: 'tag', text: 'Tag', title: 'Select every object sharing a tag with this one' },
		{ by: 'layer', text: 'Layer', title: 'Select every object on the same layer' }
	];

	let pattern = $state('{name} {n}');
	let start = $state(1);
	let pad = $state(0);
	const preview = $derived.by(() => {
		void $sceneRevision;
		const names = sel.slice(0, 3).map((u) => {
			const o = /** @type {any} */ ($objectsGroup)?.getObjectByProperty('uuid', u);
			return o?.name || o?.type || '';
		});
		return renamePlan(names, pattern, start, pad).join(', ') + (sel.length > 3 ? ', …' : '');
	});

	let rot = $state([0, 180, 0]);
	let scaleMin = $state(1);
	let scaleMax = $state(1);
	let offset = $state([0, 0, 0]);
	let seed = $state(1);
	const AXES = ['X', 'Y', 'Z'];
</script>

<Section variant="panel" label="Tidy" aliases={['Layer', 'Select similar', 'Rename many', 'Randomise', 'Randomize']}>
	<div id="tidy-section" class="flex flex-col gap-1">
		<PropRow label="Layer" valueBox={false}>
			{#snippet control()}
				<ThemedSelect id="tidy-layer" class="min-w-0" title="Which layer the selection is on (Configure Scene ▸ Layers hides and locks them)" items={layerItems} value={current ?? undefined} mixed={current === null} onchange={pickLayer} />
			{/snippet}
		</PropRow>
		<PropRow label="Select similar" valueBox={false}>
			{#snippet control()}
				<div class="flex flex-wrap gap-1">
					{#each SIMILAR as s (s.by)}
						<UiButton id={`tidy-similar-${s.by}`} size="sm" variant="outline" text={s.text} title={s.title} onclick={() => selectSimilar(s.by)} />
					{/each}
				</div>
			{/snippet}
		</PropRow>
		{#if multi}
			<PropRow label="Rename" labelFor="tidy-rename-pattern" valueBox={false}>
				{#snippet control()}
					<input id="tidy-rename-pattern" class="ui-input min-w-0 flex-1" bind:value={pattern} title="{'{n}'} is the counter, {'{name}'} the old name" aria-label="Rename pattern" />
				{/snippet}
			</PropRow>
			<DragRow id="tidy-rename-start" label="Start at" title="The first number" value={start} min={0} max={99999} step={1} decimals={0} onchange={(v) => (start = v)} />
			<DragRow id="tidy-rename-pad" label="Digits" title="Pad the counter with zeros to this many digits (0 = no padding)" value={pad} min={0} max={6} step={1} decimals={0} onchange={(v) => (pad = v)} />
			<p id="tidy-rename-preview" class="text-[length:var(--fs-badge)] text-text-faint">{preview}</p>
			<div class="flex justify-end">
				<UiButton id="tidy-rename" size="sm" variant="outline" icon="pencil" text={`Rename ${sel.length}`} title="Rename the selection in the order you picked it (one undo)" onclick={() => renameMany(sel, pattern, start, pad)} />
			</div>
			{#each AXES as axis, i (axis)}
				<DragRow id={`tidy-rand-rot-${axis.toLowerCase()}`} label={`Turn ${axis} ±`} title={`Turn each object by up to this many degrees either way about ${axis}`} value={rot[i]} min={0} max={180} step={1} decimals={0} onchange={(v) => (rot[i] = v)} />
			{/each}
			<DragRow id="tidy-rand-scale-min" label="Size from" title="The smallest size factor (1 = unchanged)" value={scaleMin} min={0.01} max={100} step={0.01} decimals={2} onchange={(v) => (scaleMin = v)} />
			<DragRow id="tidy-rand-scale-max" label="Size to" title="The largest size factor (1 = unchanged)" value={scaleMax} min={0.01} max={100} step={0.01} decimals={2} onchange={(v) => (scaleMax = v)} />
			{#each AXES as axis, i (axis)}
				<DragRow id={`tidy-rand-off-${axis.toLowerCase()}`} label={`Move ${axis} ±`} title={`Move each object up to this far either way on ${axis}`} unit="length" value={offset[i]} min={0} max={1000} step={0.05} onchange={(v) => (offset[i] = v)} />
			{/each}
			<DragRow id="tidy-rand-seed" label="Seed" title="The same seed gives the same result" value={seed} min={0} max={99999} step={1} decimals={0} onchange={(v) => (seed = v)} />
			<div class="flex justify-end gap-1">
				<UiButton id="tidy-rand-seed-next" size="sm" variant="ghost" text="New seed" title="Try another random result" onclick={() => (seed = Math.floor(Math.random() * 99999))} />
				<UiButton id="tidy-randomise" size="sm" variant="outline" icon="sparkles" text="Randomise" title="Turn, size and move each object within the ranges (one undo)" onclick={() => randomise(sel, { rot, scale: [scaleMin, scaleMax], offset, seed })} />
			</div>
		{/if}
	</div>
</Section>
