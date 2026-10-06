<script>
	// 36-fb F24: Inspector ▸ Flow path — every setting of `userData.flowPath`, the point list,
	// and "shape it from a spline" (the app's spline tool is the place to draw a curve; this
	// copies its points into the path). Writes go through setFlowPathFor: replicated, one undo
	// entry each, and every peer rebuilds the same ribbon from the record.
	import InsToggle from '../menu/inspector/InsToggle.svelte';
	import Section from '../ui/Section.svelte';
	import SliderRow from '../ui/SliderRow.svelte';
	import DragRow from '../ui/DragRow.svelte';
	import ThemedSelect from '../ui/ThemedSelect.svelte';
	// @ts-ignore - no bundled three type declarations (project-wide)
	import * as THREE from 'three';
	import { objectsGroup } from '../../stores/sceneStore';
	import { normalizeFlowPath, MAX_FLOW_POINTS, arcLengths } from '$lib/sim/flowPathCore.js';
	import { setFlowPathFor } from '$lib/sim/fluidEmitterActions.js';

	/** @type {{object: any}} */
	let { object } = $props();
	const f = $derived(normalizeFlowPath(object?.userData?.flowPath));
	const length = $derived(arcLengths(f.points).total);

	/** @param {any} patch */
	function set(patch) {
		setFlowPathFor(object.uuid, patch);
	}
	/** @param {number} i @param {number} axis @param {number} v */
	function setPoint(i, axis, v) {
		const points = f.points.map((p) => p.slice());
		points[i][axis] = v;
		set({ points });
	}
	/** one more point past the end, along the last segment */
	function addPoint() {
		const p = f.points;
		const a = p[p.length - 2], b = p[p.length - 1];
		set({ points: [...p, [b[0] + (b[0] - a[0]), b[1] + (b[1] - a[1]), b[2] + (b[2] - a[2])]] });
	}
	/** @param {number} i */
	function removePoint(i) {
		if (f.points.length <= 2) return;
		set({ points: f.points.filter((_, k) => k !== i) });
	}
	/** the scene's splines, by name */
	const splines = $derived.by(() => {
		/** @type {{value: string, name: string}[]} */
		const out = [];
		$objectsGroup?.traverse?.((/** @type {any} */ o) => {
			if (Array.isArray(o.userData?.spline?.points) && o.userData.spline.points.length >= 2) out.push({ value: o.uuid, name: o.name || 'Spline' });
		});
		return out;
	});
	/** copy a spline's points (its frame) into this path (our frame) @param {string} uuid */
	function fromSpline(uuid) {
		const sp = $objectsGroup?.getObjectByProperty('uuid', uuid);
		if (!sp) return;
		sp.updateWorldMatrix(true, false);
		object.updateWorldMatrix(true, false);
		const inv = new THREE.Matrix4().copy(object.matrixWorld).invert();
		const v = new THREE.Vector3();
		const points = sp.userData.spline.points.slice(0, MAX_FLOW_POINTS).map((/** @type {any} */ q) => {
			v.set(q.pos[0], q.pos[1], q.pos[2]).applyMatrix4(sp.matrixWorld).applyMatrix4(inv);
			return [round(v.x), round(v.y), round(v.z)];
		});
		set({ points });
	}
	/** @param {number} x */
	const round = (x) => Math.round(x * 1000) / 1000;
	const keywords = 'flow path river chute pipe stream current loop recycle fountain water';
</script>

<div data-keywords={keywords} class="contents">
	<Section variant="panel" label="Flow path">
		<div data-tour="flow-path" class="contents">
			<div class="ui-row items-center gap-2">
				<span class="w-20 shrink-0 text-xs text-text-muted">Kind</span>
				<ThemedSelect
					id="flow-path-kind"
					items={[
						{ value: 'river', name: 'River / chute' },
						{ value: 'pipe', name: 'Pipe (pump)' }
					]}
					value={f.kind}
					onchange={(/** @type {any} */ v) => set({ kind: v })}
				/>
			</div>
			<SliderRow id="flow-path-speed" label="Speed m/s" min={0} max={20} step={0.1} value={f.speed} onchange={(v) => set({ speed: v })} />
			<SliderRow id="flow-path-width" label="Width" min={0.05} max={10} step={0.05} value={f.width} onchange={(v) => set({ width: v })} />
			{#if f.kind === 'river'}
				<SliderRow id="flow-path-depth" label="Depth" min={0.02} max={5} step={0.02} value={f.depth} onchange={(v) => set({ depth: v })} />
				<SliderRow id="flow-path-strength" label="Pull /s" min={0} max={40} step={0.5} value={f.strength} onchange={(v) => set({ strength: v })} />
				<InsToggle id="flow-path-recycle" checked={f.recycle} onchange={(/** @type {any} */ e) => set({ recycle: e.currentTarget.checked })}
					>Loop: water reaching the end starts again</InsToggle
				>
			{/if}
			<InsToggle id="flow-path-show" checked={f.show} onchange={(/** @type {any} */ e) => set({ show: e.currentTarget.checked })}
				>{f.kind === 'pipe' ? 'Show the pipe' : 'Show the water surface'}</InsToggle
			>
			{#if f.kind === 'river'}
				<div class="ui-row items-center gap-2">
					<span class="w-20 shrink-0 text-xs text-text-muted">Colour</span>
					<input
						id="flow-path-color"
						type="color"
						class="h-6 w-8 cursor-pointer rounded-sm border border-border-strong bg-transparent"
						aria-label="Water colour"
						value={f.color}
						onchange={(/** @type {any} */ e) => set({ color: e.currentTarget.value })}
					/>
				</div>
				<SliderRow id="flow-path-opacity" label="Opacity" min={0.05} max={1} step={0.05} value={f.opacity} onchange={(v) => set({ opacity: v })} />
			{/if}
			<p class="text-[length:var(--fs-badge)] font-semibold uppercase tracking-wide text-text-muted">Points ({length.toFixed(2)} m)</p>
			{#each f.points as p, i (i)}
				<!-- a GRID with min-width-0 cells: three DragRows in a flex row were wider than the
				     Inspector and scrolled the whole panel sideways (seen in the light-theme shot) -->
				<div class="grid items-center gap-1" style="grid-template-columns: 1rem repeat(3, minmax(0, 1fr)) auto" data-flow-point={i}>
					<span class="text-[length:var(--fs-badge)] text-text-muted">{i + 1}</span>
					{#each ['X', 'Y', 'Z'] as axis, a (axis)}
						<div class="min-w-0 overflow-hidden">
							<DragRow id={'flow-point-' + i + '-' + a} label={axis} value={p[a]} step={0.05} decimals={2} unit="length" onchange={(v) => setPoint(i, a, v)} />
						</div>
					{/each}
					<button
						class="ui-chip shrink-0 px-1 text-text-2 hover:text-[var(--ink-bad,#f87171)]"
						title="Remove this point"
						aria-label={'Remove point ' + (i + 1)}
						disabled={f.points.length <= 2}
						onclick={() => removePoint(i)}>✕</button
					>
				</div>
			{/each}
			<div class="ui-row items-center gap-2">
				<button id="flow-path-add-point" class="ui-chip bg-gray-600 text-text-2 hover:bg-gray-500" disabled={f.points.length >= MAX_FLOW_POINTS} onclick={addPoint}
					>Add point</button
				>
				{#if splines.length}
					<ThemedSelect
						id="flow-path-from-spline"
						items={[{ value: '', name: 'Shape from a spline…' }, ...splines]}
						value=""
						onchange={(/** @type {any} */ v) => v && fromSpline(v)}
					/>
				{/if}
			</div>
			<p class="mt-1 text-[length:var(--fs-badge)] text-text-muted">
				Water from a Fluid emitter whose area reaches this path is carried along it. Objects with a "Float along flow" node ride it. Physics bodies pass through the
				surface (it is a sensor).
			</p>
		</div>
	</Section>
</div>
