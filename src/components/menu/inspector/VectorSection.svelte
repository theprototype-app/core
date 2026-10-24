<script>
	// 64 D1 — Inspector ▸ Shape, for a selected vector shape: the colours its record carries (the
	// Geometry section above already holds the numeric rows — size, corner radius, stroke, extrude —
	// straight from VECTOR_PARAMS). A colour commits on CHANGE (the picker's release), so a drag
	// across the swatch is one undo entry and one message, not one per pixel.
	import Section from '../../ui/Section.svelte';
	import { sceneRevision } from '../../../stores/sceneStore';
	import { VECTOR_COLOURS } from '$lib/vector/vectorRecord.js';
	import { vectorParamsOf, setVectorParams } from '$lib/vector/vectorActions.js';
	import { vectorEditObject, enterVectorEdit, exitVectorEdit } from '$lib/vector/vectorEdit.js';
	import UiButton from '../../ui/Button.svelte';

	/** @type {{ object: any }} */
	let { object } = $props();

	const params = $derived.by(() => {
		void $sceneRevision;
		return vectorParamsOf(object);
	});
	const rows = $derived(params ? VECTOR_COLOURS.filter((c) => !c.show || c.show(params)) : []);
</script>

{#if params}
	<Section variant="panel" label="Shape" aliases={['Vector', 'Colours']}>
		<div id="vector-section" class="flex flex-col gap-1 text-xs">
			{#each rows as row (row.key)}
				<label class="flex items-center gap-2">
					<span class="w-20 shrink-0 text-text-muted">{row.label}</span>
					<input
						id={`vector-colour-${row.key}`}
						type="color"
						class="h-6 w-16 cursor-pointer rounded-sm border border-border bg-surface-inset"
						value={params[row.key]}
						onchange={(e) => setVectorParams(object.uuid, { [row.key]: e.currentTarget.value })}
					/>
					<span class="font-mono text-text-faint">{params[row.key]}</span>
				</label>
			{/each}
			{#if !rows.length}
				<p class="text-text-faint">No fill and no stroke — set Fill or Stroke above.</p>
			{/if}
		</div>
		<UiButton
			id="vector-edit-points"
			size="sm"
			variant="outline"
			title={params.kind === 'path' ? 'Drag points and handles, add points on the outline' : 'Turns the shape into a path you can reshape point by point'}
			onclick={() => ($vectorEditObject === object.uuid ? exitVectorEdit() : enterVectorEdit(object.uuid))}
			>{$vectorEditObject === object.uuid ? 'Done editing points' : 'Edit points'}</UiButton
		>
	</Section>
{/if}
