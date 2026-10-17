<script>
	// 47 M1: the Measure toolbox — the readout of the chain being drawn and its commands, on the
	// shared ToolboxWindow shell (a floating palette on desktop, a bottom sheet <=640px, so the
	// touch path has a Keep / Undo point that needs no keyboard). Shown while measuring.
	// 48 B2: ✓ KEEPS the chain as a scene item (it used to drop it); Keep starts the next one;
	// while a kept measurement is being EDITED (Tab) the readout is that item's.
	import Icon from '../ui/Icon.svelte';
	import ToolboxWindow from '../ui/ToolboxWindow.svelte';
	import {
		measureMode,
		measurement,
		measureSnap,
		measureEditing,
		stopMeasure,
		keepMeasurement,
		discardMeasurement,
		undoMeasurePoint,
		removeEditPoint
	} from '$lib/measure';
	import { chainStats, formatLength, formatAngle, segmentDelta } from '$lib/measureCore';
	import { measurementOf, worldPointsOf, measurementItems } from '$lib/measureItems';
	import { isVRMode, sceneRevision } from '../../stores/sceneStore';

	const active = $derived(!$isVRMode && $measureMode);
	const editing = $derived($measureEditing);
	const points = $derived.by(() => {
		void $sceneRevision;
		if (editing) {
			const o = measurementOf(editing.uuid);
			return o ? worldPointsOf(o) : [];
		}
		return $measurement?.points ?? [];
	});
	const stats = $derived(chainStats(points));
	const lastAngle = $derived(stats.angles.length ? stats.angles[stats.angles.length - 1] : null);
	const delta = $derived(points.length >= 2 ? segmentDelta(points[points.length - 2], points[points.length - 1]) : null);
	const snapOf = $derived($measurement?.snaps?.[$measurement.snaps.length - 1] ?? '');
	const itemCount = $derived.by(() => {
		void $sceneRevision;
		return measurementItems().length;
	});
</script>

{#if active}
	<ToolboxWindow id="measure-toolbar" key="measureToolbox" title={editing ? 'Edit measurement' : 'Measure'} width={210}>
		{#snippet actions()}
			<button
				id="measure-done"
				class="tbx-hbtn tbx-done"
				aria-label="Done"
				title={editing ? 'Finish editing (Tab or Esc)' : 'Keep this measurement and stop measuring'}
				onclick={() => stopMeasure()}><Icon name="check" size={16} aria-hidden="true" /></button
			>
		{/snippet}

		<div class="tbx-row text-xs" id="measure-readout">
			{#if editing}
				<span class="text-text-muted">
					{editing.active >= 0 ? `Point ${editing.active + 1} picked up — click where it goes` : 'Click a point to pick it up, or elsewhere to add one'}
				</span>
			{:else if points.length === 0}
				<span class="text-text-muted">Click or tap a point to start</span>
			{:else if points.length === 1}
				<span class="text-text-muted">1 point{snapOf ? ` · ${snapOf}` : ''} — pick the next</span>
			{/if}
			{#if points.length >= 2}
				<span class="flex flex-col gap-0.5">
					<span><span class="text-text-muted">Last</span> <b id="measure-last">{formatLength(stats.segments[stats.segments.length - 1])}</b></span>
					{#if stats.segments.length > 1}
						<span><span class="text-text-muted">Total</span> <b id="measure-total">{formatLength(stats.total)}</b> · {stats.segments.length} segments</span>
					{/if}
					{#if lastAngle != null}
						<span><span class="text-text-muted">Angle</span> <b id="measure-angle">{formatAngle(lastAngle)}</b></span>
					{/if}
					{#if delta}
						<span class="font-mono text-[length:var(--fs-badge)] text-text-muted" id="measure-delta">
							Δ x {delta[0].toFixed(3)} · y {delta[1].toFixed(3)} · z {delta[2].toFixed(3)}
						</span>
					{/if}
				</span>
			{/if}
		</div>

		{#if editing}
			<div class="tbx-row">
				<button
					id="measure-remove-point"
					class="tbx-cmd"
					disabled={points.length <= 2}
					title="Remove the picked point (or the last one) — Backspace"
					onclick={() => removeEditPoint()}>Remove point</button
				>
			</div>
		{:else}
			<div class="tbx-row">
				<button id="measure-undo-point" class="tbx-cmd" disabled={!points.length} title="Remove the last point (Backspace)" onclick={() => undoMeasurePoint()}
					>Undo point</button
				>
				<button
					id="measure-pin"
					class="tbx-cmd"
					disabled={points.length < 2}
					title="Keep this measurement in the scene and start a new one (Enter, or click the last point again)"
					onclick={() => keepMeasurement()}>Keep</button
				>
			</div>
			<div class="tbx-row">
				<button id="measure-discard" class="tbx-cmd" disabled={!points.length} title="Drop the measurement being drawn (Esc leaves the tool and drops it too)" onclick={() => discardMeasurement()}
					>Discard</button
				>
			</div>
		{/if}
		<div class="tbx-row">
			<label class="flex items-center gap-1 text-xs" title="Snap points to the vertex, edge or face centre under the pointer">
				<input
					id="measure-snap"
					class="tbx-check"
					type="checkbox"
					checked={$measureSnap}
					onchange={(e) => measureSnap.set(e.currentTarget.checked)}
				/>
				Snap to vertices, edges, faces
			</label>
		</div>

		{#snippet status()}
			<span id="measure-status">{itemCount} in the scene · Tab on one edits it</span>
		{/snippet}
	</ToolboxWindow>
{/if}
