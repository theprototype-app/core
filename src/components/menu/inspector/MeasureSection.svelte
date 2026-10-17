<script>
	// 48 B2 — Inspector ▸ Measurement, for a selected measurement item: its segment lengths, the
	// angle at each joint, the total, and the way into editing its points (Tab does the same).
	// Read-only numbers off the replicated record, re-read on every scene change (a peer's edit,
	// an undo, the item moved or scaled).
	import Section from '../../ui/Section.svelte';
	import UiButton from '../../ui/Button.svelte';
	import { sceneRevision } from '../../../stores/sceneStore';
	import { worldPointsOf } from '$lib/measureItems';
	import { chainStats, formatLength, formatAngle } from '$lib/measureCore';
	import { editMeasurement } from '$lib/measure';

	/** @type {{ object: any }} */
	let { object } = $props();

	const stats = $derived.by(() => {
		void $sceneRevision;
		return chainStats(object ? worldPointsOf(object) : []);
	});
</script>

<Section variant="panel" label="Measurement" aliases={['Measure', 'Dimension', 'Distance']}>
	<div id="measure-section" class="flex flex-col gap-1 text-xs">
		{#each stats.segments as length, i (i)}
			<div class="flex items-center gap-2" data-measure-segment={i}>
				<span class="w-20 shrink-0 text-text-muted">Segment {i + 1}</span>
				<b class="tabular-nums">{formatLength(length)}</b>
				{#if stats.angles[i] != null}
					<span class="text-text-muted">· {formatAngle(stats.angles[i])} after</span>
				{/if}
			</div>
		{/each}
		{#if stats.segments.length > 1}
			<div class="flex items-center gap-2">
				<span class="w-20 shrink-0 text-text-muted">Total</span>
				<b id="measure-section-total" class="tabular-nums">{formatLength(stats.total)}</b>
			</div>
		{/if}
	</div>
	<UiButton id="measure-section-edit" size="sm" variant="outline" title="Pick up a point and place it again, or add points (Tab)" onclick={() => editMeasurement(object.uuid)}
		>Edit points (Tab)</UiButton
	>
</Section>
