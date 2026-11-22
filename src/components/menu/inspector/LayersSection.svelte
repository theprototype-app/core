<script>
	// 102b-arrange row 2 — Configure Scene ▸ Layers: name, colour and lock (scene data: saved, shared,
	// one undo per edit) and hide (THIS screen only). A lazy chunk: the Inspector imports it on demand.
	import UiButton from '../../ui/Button.svelte';
	import { scenePhysicsState_ } from '$lib/scenePhysics';
	import { sceneRevision } from '../../../stores/sceneStore';
	import { normalizeLayers } from '$lib/layersCore.js';
	import { addLayer, updateLayer, removeLayer, selectLayer, setLayerHidden, membersOf } from '$lib/tidyActions.js';
	import { hiddenLayers } from '$lib/layersRuntime.js';

	const layers = $derived(normalizeLayers($scenePhysicsState_?.layers) ?? []);
	const counts = $derived.by(() => {
		void $sceneRevision;
		/** @type {Record<string, number>} */
		const out = {};
		for (const l of layers) out[l.id] = membersOf(l.id).length;
		return out;
	});
</script>

<div id="layers-section" class="flex flex-col gap-1">
	{#if !layers.length}
		<p class="text-[length:var(--fs-badge)] text-text-faint">Layers group objects across the scene so you can hide, lock or select them together. Put an object on a layer in its Inspector (Tidy ▸ Layer).</p>
	{/if}
	{#each layers as l (l.id)}
		<div class="layer-row flex items-center gap-1" data-layer-id={l.id}>
			<input
				class="layer-swatch"
				type="color"
				value={l.color}
				aria-label={`Colour of layer ${l.name}`}
				title="The layer's colour (shown beside its objects' layer)"
				onchange={(e) => updateLayer(l.id, { color: e.currentTarget.value })}
			/>
			<input
				class="ui-input min-w-0 flex-1"
				value={l.name}
				aria-label="Layer name"
				title="Rename the layer"
				onchange={(e) => updateLayer(l.id, { name: e.currentTarget.value })}
			/>
			<span class="text-[length:var(--fs-badge)] text-text-faint" title="Objects on this layer">{counts[l.id] ?? 0}</span>
			<UiButton
				variant="icon"
				size="sm"
				icon={$hiddenLayers.has(l.id) ? 'eye-off' : 'eye'}
				label={$hiddenLayers.has(l.id) ? `Show layer ${l.name}` : `Hide layer ${l.name}`}
				title={$hiddenLayers.has(l.id) ? 'Show this layer again (this screen only)' : 'Hide this layer on your screen only; nobody else is affected and saves keep it'}
				pressed={$hiddenLayers.has(l.id)}
				onclick={() => setLayerHidden(l.id, !$hiddenLayers.has(l.id))}
			/>
			<UiButton
				variant="icon"
				size="sm"
				icon={l.locked ? 'lock' : 'lock-open'}
				label={l.locked ? `Unlock layer ${l.name}` : `Lock layer ${l.name}`}
				title={l.locked ? 'Unlock: its objects can be clicked again' : 'Lock for everyone: clicks in the viewport pass through its objects (pick them in the object list)'}
				pressed={!!l.locked}
				onclick={() => updateLayer(l.id, { locked: !l.locked })}
			/>
			<UiButton variant="icon" size="sm" icon="box-select" label={`Select layer ${l.name}`} title="Select every object on this layer" onclick={() => selectLayer(l.id)} />
			<UiButton variant="icon" size="sm" icon="trash-2" label={`Remove layer ${l.name}`} title="Remove the layer; its objects stay, on no layer (one undo)" onclick={() => removeLayer(l.id)} />
		</div>
	{/each}
	<div class="flex justify-end">
		<UiButton id="layers-add" size="sm" variant="outline" icon="layers" text="Add layer" title="Add a layer to this scene (one undo)" onclick={() => addLayer()} />
	</div>
</div>

<style>
	.layer-swatch {
		width: 1.5rem;
		height: 1.5rem;
		padding: 0;
		border: 1px solid var(--border-input);
		border-radius: 0.25rem;
		background: none;
		flex: none;
	}
</style>
