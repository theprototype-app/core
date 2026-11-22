<script>
	// 57.3 -> 21-C2: the spline EDIT toolbox. Ported onto the shared
	// ToolboxWindow shell (key `splineToolbox`), which is what gives it the
	// header-only drag, the width grip, windowSize.js clamping and the <=640px
	// bottom sheet — the same shell the mesh and sculpt toolboxes sit on, so all
	// three edit sessions look and behave alike. Point-level editing happens in
	// the viewport on the handles; this is the whole-spline half plus the
	// reminder of which handle does what.
	import {
		splineEditObject,
		splineSelectedPoint,
		splinePointCount,
		exitSplineEdit,
		splineAddMode,
		splineGizmoMode,
		setSplineAddMode,
		setSplineGizmoMode,
		selectPoints,
		deletePoints
	} from '$lib/splineEdit';
	import { pathSelectedPoints } from '$lib/path/pathState.js';
	import { reversePathObject } from '$lib/path/pathActions.js';
	import { setSplineClosed, setSplineRadiusAll, setSplineSides, splineDataOf, splineObjectOf } from '$lib/splineTool';
	import Icon from '../ui/Icon.svelte';
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
	// 78 F4: a PATH record gets the path tools (add points, multi-point gizmo, reverse)
	const isPath = $derived(!!data?.path);
	/** @type {{mode: 'translate'|'rotate'|'scale', label: string, icon: string}[]} */
	const GIZMO_MODES = [
		{ mode: 'translate', label: 'Move', icon: 'move' },
		{ mode: 'rotate', label: 'Rotate', icon: 'rotate-cw' },
		{ mode: 'scale', label: 'Scale', icon: 'maximize-2' }
	];
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
	<ToolboxWindow id="spline-edit-toolbar" key="splineToolbox" title={name} width={200}>
		{#snippet actions()}
			<button
				id="spline-edit-done"
				class="tbx-hbtn tbx-done"
				aria-label="Done"
				title="Finish (Esc)"
				onclick={() => exitSplineEdit()}><Icon name="check" size={16} aria-hidden="true" /></button
			>
		{/snippet}

		<span class="tbx-label">Spline</span>
		<div class="tbx-row text-xs">
			<span id="spline-point-count" class="text-text-muted">
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
				class="tbx-cmd {data?.closed ? 'tbx-on bg-accent-fill text-on-accent' : ''}"
				aria-pressed={!!data?.closed}
				title="Join the last point back to the first"
				onclick={() => $splineEditObject && setSplineClosed($splineEditObject, !data?.closed)}
				>Loop</button
			>
		</div>

		{#if isPath}
			<span class="tbx-label">Path</span>
			<div class="tbx-row">
				<button
					id="path-add-points"
					class="tbx-cmd {$splineAddMode ? 'tbx-on bg-accent-fill text-on-accent' : ''}"
					aria-pressed={$splineAddMode}
					title="Click the scene to add points to the end (Esc stops)"
					onclick={() => setSplineAddMode(!$splineAddMode)}
					><Icon name="plus" size={16} aria-hidden="true" /> Add points</button
				>
				<button id="path-toolbox-reverse" class="tbx-cmd" title="Walk the other way round" onclick={() => $splineEditObject && reversePathObject($splineEditObject)}
					><Icon name="arrow-left-right" size={16} aria-hidden="true" /> Reverse</button
				>
			</div>
			<div class="tbx-row" role="group" aria-label="Picked points">
				<button id="path-select-all" class="tbx-cmd" title="Pick every point (Ctrl+A)" onclick={() => selectPoints(Array.from({ length: $splinePointCount }, (_v, i) => i))}
					><Icon name="box-select" size={16} aria-hidden="true" /> All</button
				>
				<button
					id="path-delete-points"
					class="tbx-cmd"
					disabled={!$pathSelectedPoints.length}
					title="Delete the picked points (Delete)"
					onclick={() => deletePoints($pathSelectedPoints)}><Icon name="trash-2" size={16} aria-hidden="true" /> Delete</button
				>
			</div>
			{#if $pathSelectedPoints.length > 1}
				<div class="tbx-row" role="group" aria-label="Gizmo for the picked points">
					{#each GIZMO_MODES as g (g.mode)}
						<button
							id="path-gizmo-{g.mode}"
							class="tbx-cmd {$splineGizmoMode === g.mode ? 'tbx-on bg-accent-fill text-on-accent' : ''}"
							aria-pressed={$splineGizmoMode === g.mode}
							title="{g.label} the picked points about their centre"
							onclick={() => setSplineGizmoMode(g.mode)}><Icon name={g.icon} size={16} aria-hidden="true" /> {g.label}</button
						>
					{/each}
				</div>
			{/if}
			<p class="tbx-row text-[11px] leading-snug text-text-muted">
				Click a point to pick it · Ctrl/Shift-click to pick several and move, rotate or scale them together · click a
				<span class="text-text-2">grey</span> marker to insert a point · right-click a point to delete it. Waits, speeds,
				jumps and events are in the Properties panel.
			</p>
		{:else}
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

		<p class="tbx-row text-[11px] leading-snug text-text-muted">
			Drag a <span class="text-[#2f81f7]">blue</span> handle to move a point · drag the <!-- tokens-ok: names the 3D handle's three.js colour -->
			<span class="text-[#f59e0b]">amber</span> dot above it up/down for thickness · click a <!-- tokens-ok: names the 3D thickness dot's three.js colour -->
			<span class="text-text-2">grey</span> marker to insert a point · right-click a point to delete it.
		</p>
		{/if}

		{#snippet status()}
			<span>{$splinePointCount} pts · {(data?.radialSegments ?? 8)} sides</span>
		{/snippet}
	</ToolboxWindow>
{/if}
