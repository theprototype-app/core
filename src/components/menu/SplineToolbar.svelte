<script>
	// 57.3 -> 21-C2: the spline EDIT toolbox. Ported onto the shared
	// ToolboxWindow shell (key `splineToolbox`), which is what gives it the
	// header-only drag, the width grip, windowSize.js clamping and the <=640px
	// bottom sheet — the same shell the mesh and sculpt toolboxes sit on, so all
	// three edit sessions look and behave alike. Point-level editing happens in
	// the viewport on the handles; this is the whole-spline half plus the
	// reminder of which handle does what.
	import { splineEditObject, splineSelectedPoint, splinePointCount, exitSplineEdit } from '$lib/splineEdit';
	import { setSplineClosed, setSplineRadiusAll, setSplineSides, splineDataOf, splineObjectOf } from '$lib/splineTool';
	import { Check } from '@lucide/svelte';
	import ToolboxWindow from '../ui/ToolboxWindow.svelte';
	import DragRow from '../ui/DragRow.svelte';
	import { isVRMode, objectsGroup } from '../../stores/sceneStore';

	const active = $derived(!$isVRMode && !!$splineEditObject);
	// derive from $objectsGroup as well: the record is mutated in place, and a
	// THREE tree is not reactive — the appliers poke objectsGroup after every edit
	const data = $derived.by(() => {
		$objectsGroup;
		return $splineEditObject ? splineDataOf(splineObjectOf($splineEditObject)) : null;
	});
	const name = $derived($splineEditObject ? splineObjectOf($splineEditObject)?.name || 'Spline' : '');
	/** the thickness row shows the SELECTED point's radius, else the first one */
	const radius = $derived(
		data ? (data.points[$splineSelectedPoint] ?? data.points[0])?.radius ?? 0.05 : 0.05
	);

	/** @param {number} value */
	function applyRadius(value) {
		if ($splineEditObject) setSplineRadiusAll($splineEditObject, value);
	}
</script>

{#if active}
	<ToolboxWindow id="spline-edit-toolbar" key="splineToolbox" title={`〰 ${name}`} width={200}>
		{#snippet actions()}
			<button
				id="spline-edit-done"
				class="tbx-hbtn tbx-done"
				aria-label="Done"
				title="Finish (Esc)"
				onclick={() => exitSplineEdit()}><Check size={14} aria-hidden="true" /></button
			>
		{/snippet}

		<span class="tbx-label">Spline</span>
		<div class="tbx-row text-xs">
			<span id="spline-point-count" class="text-gray-400">
				{$splinePointCount} point{$splinePointCount === 1 ? '' : 's'}{$splineSelectedPoint >= 0
					? ` · #${$splineSelectedPoint + 1} selected`
					: ''}
			</span>
		</div>

		<!-- a COMMAND, not an armed tool, but a toggle with a state: the word plus
		     aria-pressed is the toolbox contract for a boolean option -->
		<div class="tbx-row">
			<button
				id="spline-closed"
				class="tbx-cmd {data?.closed ? 'tbx-on bg-primary-600 text-white' : ''}"
				aria-pressed={!!data?.closed}
				title="Join the last point back to the first"
				onclick={() => $splineEditObject && setSplineClosed($splineEditObject, !data?.closed)}
				>Loop</button
			>
		</div>

		<span class="tbx-label">Shape</span>
		<div class="tbx-row">
			<DragRow
				id="spline-radius-all"
				label="Thickness"
				value={radius}
				step={0.002}
				snap={0.01}
				decimals={3}
				min={0.002}
				max={50}
				unit="length"
				title="Set EVERY control point to this radius"
				onchange={applyRadius}
			/>
		</div>
		<div class="tbx-row">
			<DragRow
				id="spline-sides"
				label="Sides"
				value={data?.radialSegments ?? 8}
				step={0.25}
				snap={1}
				decimals={0}
				min={3}
				max={32}
				title="Sides around the tube"
				onchange={(v) => $splineEditObject && setSplineSides($splineEditObject, Math.round(v))}
			/>
		</div>

		<p class="tbx-row text-[11px] leading-snug text-gray-400">
			Drag a <span class="text-[#2f81f7]">blue</span> handle to move a point · drag the
			<span class="text-[#f59e0b]">amber</span> dot above it up/down for thickness · click a
			<span class="text-gray-300">grey</span> marker to insert a point · right-click a point to delete it.
		</p>

		{#snippet status()}
			<span>{$splinePointCount} pts · {(data?.radialSegments ?? 8)} sides</span>
		{/snippet}
	</ToolboxWindow>
{/if}
