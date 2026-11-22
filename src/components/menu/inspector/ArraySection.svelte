<script>
	// 102b-arrange row 1 — Inspector ▸ Array: repeat the object in a line, a grid, a circle or along a
	// path. The copies are drawn from ONE record on the object (arrayRuntime), so every field is a live
	// preview, one undo step per edit (a scrub folds into one) and one message to peers per edit.
	// "Make real objects" turns the copies into ordinary objects (one undo). Loaded lazily by the
	// Inspector, so nothing here is paid at boot.
	// @ts-ignore - no bundled three type declarations (project-wide)
	import * as THREE from 'three';
	import Section from '../../ui/Section.svelte';
	import PropRow from '../../ui/PropRow.svelte';
	import DragRow from '../../ui/DragRow.svelte';
	import Segmented from '../../ui/Segmented.svelte';
	import Toggle from '../../ui/Toggle.svelte';
	import ThemedSelect from '../../ui/ThemedSelect.svelte';
	import UiButton from '../../ui/Button.svelte';
	import { objectsGroup, sceneRevision } from '../../../stores/sceneStore';
	import { normalizeArray, arraySummary, ARRAY_MAX } from '$lib/arrayCore.js';
	import { setArray, makeArrayReal } from '$lib/arrayActions.js';
	import { textPathTargets } from '$lib/textPathSources.js';

	/** @type {{ object: any }} */
	let { object } = $props();

	const uuid = $derived(object?.uuid ?? '');
	const rec = $derived.by(() => {
		void $sceneRevision;
		return object?.userData?.array ? normalizeArray(object.userData.array) : null;
	});
	const pathItems = $derived.by(() => {
		void $sceneRevision;
		return textPathTargets($objectsGroup).filter((t) => t.value !== uuid);
	});
	const AXES = /** @type {const} */ (['x', 'y', 'z']);

	/** @param {any} patch */
	const set = (patch) => setArray(uuid, patch);
	/** @param {'step'|'grid'|'gridStep'|'rotStep'} key @param {number} axis @param {number} v */
	function setAxis(key, axis, v) {
		if (!rec) return;
		const next = [...rec[key]];
		next[axis] = v;
		set({ [key]: next });
	}

	/** a first array: five copies in a row along X, spaced by the object's own width plus a little */
	function start() {
		const box = new THREE.Box3().setFromObject(object);
		const width = box.isEmpty() ? 1 : Math.max(0.1, box.max.x - box.min.x);
		const parentScale = object.parent ? object.parent.getWorldScale(new THREE.Vector3()).x || 1 : 1;
		const step = Math.round(((width + 0.25) / parentScale) * 100) / 100;
		set({ mode: 'line', count: 5, step: [step, 0, 0], gridStep: [step, step, step], radius: Math.max(1, step * 1.5) });
	}
</script>

<Section variant="panel" label="Array">
	<div id="array-section" class="flex flex-col gap-1">
		{#if !rec}
			<p class="text-[length:var(--fs-badge)] text-text-faint">Repeat this object in a line, a grid, a circle or along a path. The copies follow every change you make to it.</p>
			<div class="flex justify-end">
				<UiButton id="array-start" size="sm" variant="outline" icon="repeat" text="Make an array" title="Repeat this object: five copies in a row to start with (one undo)" onclick={start} />
			</div>
		{:else}
			<p id="array-summary" class="text-[length:var(--fs-badge)] text-text-2">{arraySummary(rec)}</p>
			<PropRow label="Shape" valueBox={false}>
				{#snippet control()}
					<Segmented
						id="array-mode"
						label="Array shape"
						options={[
							{ value: 'line', label: 'Line', title: 'Copies in a row, each one step further on' },
							{ value: 'grid', label: 'Grid', title: 'Copies in rows and columns (and layers)' },
							{ value: 'circle', label: 'Circle', title: 'Copies around a centre (a full ring or an arc)' },
							{ value: 'path', label: 'Path', title: 'Copies along a Path, a spline or a flow path' }
						]}
						value={rec.mode}
						onchange={(/** @type {string} */ v) => set({ mode: v })}
					/>
				{/snippet}
			</PropRow>
			{#if rec.mode !== 'grid'}
				<DragRow id="array-count" label="Count" title={`How many objects, this one included (2-${ARRAY_MAX})`} value={rec.count} min={2} max={ARRAY_MAX} step={1} decimals={0} onchange={(v) => set({ count: v })} />
			{/if}
			{#if rec.mode === 'line'}
				{#each AXES as axis, i (axis)}
					<DragRow id={`array-step-${axis}`} label={`Step ${axis.toUpperCase()}`} title={`Distance from one copy to the next on ${axis.toUpperCase()}`} unit="length" value={rec.step[i]} step={0.05} onchange={(v) => setAxis('step', i, v)} />
				{/each}
			{:else if rec.mode === 'grid'}
				{#each AXES as axis, i (axis)}
					<DragRow id={`array-grid-${axis}`} label={`Count ${axis.toUpperCase()}`} title={`How many on ${axis.toUpperCase()} (the grid holds up to ${ARRAY_MAX})`} value={rec.grid[i]} min={1} max={50} step={1} decimals={0} onchange={(v) => setAxis('grid', i, v)} />
				{/each}
				{#each AXES as axis, i (axis)}
					<DragRow id={`array-gridstep-${axis}`} label={`Spacing ${axis.toUpperCase()}`} title={`Distance between neighbours on ${axis.toUpperCase()}`} unit="length" value={rec.gridStep[i]} step={0.05} onchange={(v) => setAxis('gridStep', i, v)} />
				{/each}
			{:else if rec.mode === 'circle'}
				<DragRow id="array-radius" label="Radius" title="How far the copies sit from the centre (the centre is this far to the object's left, -X)" unit="length" value={rec.radius} min={0} max={1000} step={0.05} onchange={(v) => set({ radius: v })} />
				<DragRow id="array-arc" label="Arc" title="How much of the circle to fill, in degrees (360 = a full ring)" value={rec.arc} min={1} max={360} step={1} decimals={0} onchange={(v) => set({ arc: v })} />
				<PropRow label="Face out" valueBox={false}>
					{#snippet control()}
						<Toggle id="array-face-out" label="Face out" title="Turn each copy to face away from the centre" checked={rec.faceOut} onchange={(v) => set({ faceOut: v })} />
					{/snippet}
				</PropRow>
			{:else}
				<PropRow label="Path" valueBox={false}>
					{#snippet control()}
						<ThemedSelect id="array-path" class="min-w-0" title="The Path the copies follow; its shape starts at this object" placeholder={pathItems.length ? 'Pick a path' : 'No paths in the scene'} items={pathItems.map((t) => ({ value: t.value, name: t.name }))} value={rec.path || undefined} onchange={(v) => set({ path: String(v ?? '') })} />
					{/snippet}
				</PropRow>
				{#if !rec.path}
					<p id="array-path-hint" class="text-[length:var(--fs-badge)] text-text-faint">Pick a Path (Add ▸ Path), a spline or a flow path. The copies follow its shape, starting at this object.</p>
				{/if}
				<DragRow id="array-spacing" label="Spacing" title="Distance between copies along the path (0 = spread them evenly over its whole length)" unit="length" value={rec.spacing} min={0} max={1000} step={0.05} onchange={(v) => set({ spacing: v })} />
				<PropRow label="Follow" valueBox={false}>
					{#snippet control()}
						<Toggle id="array-follow" label="Turn with the path" title="Turn each copy with the path's direction" checked={rec.follow} onchange={(v) => set({ follow: v })} />
					{/snippet}
				</PropRow>
			{/if}
			{#each AXES as axis, i (axis)}
				<DragRow id={`array-rot-${axis}`} label={`Turn ${axis.toUpperCase()}`} title={`Each copy turns this many more degrees about its own ${axis.toUpperCase()} than the one before`} value={rec.rotStep[i]} min={-360} max={360} step={1} decimals={1} onchange={(v) => setAxis('rotStep', i, v)} />
			{/each}
			<DragRow id="array-scale-step" label="Grow" title="Size change per copy (0.1 = each copy 10 % bigger than the one before; negative shrinks)" value={rec.scaleStep} min={-0.9} max={10} step={0.01} decimals={2} onchange={(v) => set({ scaleStep: v })} />
			<p class="text-[length:var(--fs-badge)] text-text-faint">Copies are drawn, not objects: they have no physics or logic and you cannot click them. Make them real objects to give them their own.</p>
			<div class="flex flex-wrap justify-end gap-1">
				<UiButton id="array-remove" size="sm" variant="ghost" icon="trash-2" text="Remove array" title="Take the copies away; the object stays (one undo)" onclick={() => set(null)} />
				<UiButton id="array-make-real" size="sm" variant="outline" icon="boxes" text="Make real objects" title="Turn every copy into an ordinary object you can move, give physics and logic to (one undo)" onclick={() => makeArrayReal(uuid)} />
			</div>
		{/if}
	</div>
</Section>
