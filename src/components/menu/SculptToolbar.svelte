<script>
	import { viewportHasKeys } from '$lib/keyScope'; // 36 U11
	// T-2: sculpt toolbar — CL-B B5 floating strip -> M0 TOOLBOX: rebuilt on the
	// shared ToolboxWindow shell so both edit toolboxes look and behave the same
	// (header drag, width-resize reflows the square brush buttons, status
	// footer). Also hosts the MESH sculpt session (same stores — sculptObject
	// may be any mesh now, not just terrain). Ids and behavior unchanged.
	import {
		sculptObject,
		sculptMode,
		sculptOp,
		sculptRadius,
		sculptStrength,
		exitSculpt,
		setSculptGizmo
	} from '$lib/terrainSculpt';
	import Icon from '../ui/Icon.svelte';
	import ToolboxWindow from '../ui/ToolboxWindow.svelte';
	import ThemedSelect from '../ui/ThemedSelect.svelte';
	import Checkbox from '../ui/Checkbox.svelte';
	import { gizmoSuppressed, objectsGroup, sceneRevision } from '../../stores/sceneStore';
	// 47 T1/T2: the Paint (splat layers) and Scatter (instances) brushes ride this toolbox —
	// same session, lock, radius and strength; their own options show while they are armed
	import {
		paintLayer,
		scatterSource,
		scatterDensity,
		scatterScaleMin,
		scatterScaleMax,
		scatterRandomRotation,
		scatterAlign,
		scatterCollider,
		scatterErase,
		layersOf
	} from '$lib/terrainPaint';
	import { SCATTER_PRIMITIVES, sourceKey } from '$lib/terrainScatterCore';
	import { explorerItems } from '$lib/explorer';

	const OPS = [
		{ op: 'raise', label: 'Raise', icon: 'raise', desc: 'pull the surface up along its normals' },
		{ op: 'lower', label: 'Lower', icon: 'lower', desc: 'push the surface down' },
		{ op: 'smooth', label: 'Smooth', icon: 'smooth', desc: 'relax the surface' },
		{ op: 'flatten', label: 'Flatten', icon: 'flatten', desc: 'level toward the hit plane' }
	];
	// terrain only: a plain mesh has no splat map or height grid
	const TERRAIN_OPS = [
		{ op: 'paint', label: 'Paint', icon: 'paint', desc: 'paint a texture layer onto the terrain' },
		{ op: 'scatter', label: 'Scatter', icon: 'scatter', desc: 'paint (or erase) instances of a model' }
	];
	const ops = $derived($sculptMode === 'terrain' ? [...OPS, ...TERRAIN_OPS] : OPS);

	// the four layer swatches re-read the terrain on every scene change (an Inspector edit,
	// a peer's message, undo); layer 0 with no colour shows the material's own colour
	const layers = $derived.by(() => {
		void $sceneRevision;
		return $sculptObject ? layersOf($sculptObject) : [];
	});
	const baseColor = $derived.by(() => {
		void $sceneRevision;
		const object = /** @type {any} */ ($objectsGroup)?.getObjectByProperty?.('uuid', $sculptObject);
		const m = Array.isArray(object?.material) ? object.material[0] : object?.material;
		return m?.color ? '#' + m.color.getHexString() : '#808080'; // tokens-ok: a material colour fallback (data, not UI)
	});
	/** @param {number} i */
	const swatch = (i) => (i === 0 && !layers[0]?.color ? baseColor : layers[i]?.color || '#ffffff'); // tokens-ok: a layer colour fallback (data)

	// scatter sources: the primitives, then every Library model (Explorer object items)
	const sourceItems = $derived([
		...SCATTER_PRIMITIVES.map((type) => ({ value: 'p:' + type, name: type })),
		...(/** @type {any[]} */ ($explorerItems) ?? [])
			.filter((item) => item?.kind === 'object' && item.hash)
			.map((item) => ({ value: 'l:' + item.hash, name: item.name }))
	]);
	/** @param {string} key */
	function pickSource(key) {
		if (key.startsWith('p:')) scatterSource.set({ kind: 'primitive', type: key.slice(2) });
		else {
			const item = /** @type {any[]} */ ($explorerItems).find((i) => i?.hash === key.slice(2));
			scatterSource.set({ kind: 'library', hash: key.slice(2), name: item?.name ?? '' });
		}
	}

	/** @param {KeyboardEvent} event */
	function onKeydown(event) {
		if (!viewportHasKeys(event)) return; // 36 U11: keys in another pane are that pane's
		if (event.key === 'Escape' && $sculptObject) exitSculpt();
	}
</script>

<svelte:window onkeydown={onKeydown} />

{#if $sculptObject}
	<ToolboxWindow
		id="sculpt-toolbar"
		key="sculptToolbox"
		title={$sculptMode === 'mesh' ? 'Sculpt mesh' : 'Sculpt terrain'}
	>
		{#snippet actions()}
			<button
				id="sculpt-done"
				class="tbx-hbtn tbx-done"
				aria-label="Done"
				title="Finish sculpting (Esc)"
				onclick={() => exitSculpt()}><Icon name="check" size={16} aria-hidden="true" /></button
			>
		{/snippet}

		<!-- BRUSH: an armed radio — exactly one brush is active -->
		<span class="tbx-label">Brush</span>
		{#each ops as o (o.op)}
			<button
				id={`sculpt-op-${o.op}`}
				class="tbx-btn {o.op === $sculptOp ? 'tbx-on bg-accent-fill text-on-accent' : ''}"
				aria-label={o.label}
				title={`${o.label} — ${o.desc}`}
				onclick={() => sculptOp.set(/** @type {any} */ (o.op))}><Icon name={'tool:' + o.icon} size={20} /></button
			>
		{/each}

		<div class="tbx-row text-xs">
			<label class="flex items-center gap-1.5">
				Radius
				<input
					id="sculpt-radius"
					type="range"
					min="0.5"
					max="8"
					step="0.25"
					class="w-20 accent-accent"
					value={$sculptRadius}
					oninput={(e) => sculptRadius.set(+e.currentTarget.value)}
				/>
				<span class="w-7">{$sculptRadius}m</span>
			</label>
		</div>
		{#if $sculptOp !== 'scatter'}
		<div class="tbx-row text-xs">
			<label class="flex items-center gap-1.5">
				Strength
				<input
					id="sculpt-strength"
					type="range"
					min="0.05"
					max="1"
					step="0.05"
					class="w-20 accent-accent"
					value={$sculptStrength}
					oninput={(e) => sculptStrength.set(+e.currentTarget.value)}
				/>
				<span class="w-7">{$sculptStrength.toFixed(2)}</span>
			</label>
		</div>
		{/if}

		{#if $sculptOp === 'paint' && $sculptMode === 'terrain'}
			<!-- 47 T1: the layer the brush lays down (colours/textures/tiling live in the
			     Inspector's Terrain layers section) -->
			<span class="tbx-label">Layer</span>
			{#each [0, 1, 2, 3] as i (i)}
				<button
					id={`sculpt-paint-layer-${i}`}
					class="tbx-btn {i === $paintLayer ? 'tbx-on bg-accent-fill text-on-accent' : ''}"
					aria-label={`Layer ${i + 1}`}
					aria-pressed={i === $paintLayer}
					title={i === 0 && !layers[0]?.color && !layers[0]?.texture ? 'Layer 1 — the material' : `Layer ${i + 1}`}
					onclick={() => paintLayer.set(i)}
					><span class="layer-chip" style:background={swatch(i)}></span><span class="text-[length:var(--fs-badge)]">{i + 1}</span></button
				>
			{/each}
		{/if}

		{#if $sculptOp === 'scatter' && $sculptMode === 'terrain'}
			<!-- 47 T2: what to scatter + how; Erase removes the chosen source's instances -->
			<span class="tbx-label">Scatter</span>
			<div class="tbx-row text-xs">
				<ThemedSelect
					id="sculpt-scatter-source"
					title="What the brush scatters — a primitive or a Library model"
					clip={false}
					items={sourceItems}
					value={sourceKey($scatterSource)}
					onchange={(v) => pickSource(String(v))}
				/>
			</div>
			<div class="tbx-row text-xs">
				<button
					id="sculpt-scatter-paint"
					class="tbx-btn {!$scatterErase ? 'tbx-on bg-accent-fill text-on-accent' : ''}"
					aria-pressed={!$scatterErase}
					title="Paint instances"
					onclick={() => scatterErase.set(false)}><Icon name="tool:scatter" size={20} aria-hidden="true" /></button
				>
				<button
					id="sculpt-scatter-erase"
					class="tbx-btn {$scatterErase ? 'tbx-on bg-accent-fill text-on-accent' : ''}"
					aria-pressed={$scatterErase}
					title="Erase instances of this source"
					onclick={() => scatterErase.set(true)}><Icon name="tool:scatter-erase" size={20} aria-hidden="true" /></button
				>
			</div>
			<div class="tbx-row text-xs">
				<label class="flex items-center gap-1.5" title="Instances per square metre (the footer shows /m²)">
					Density
					<input
						id="sculpt-scatter-density"
						type="range"
						min="0.05"
						max="2"
						step="0.05"
						class="w-20 accent-accent"
						value={$scatterDensity}
						oninput={(e) => scatterDensity.set(+e.currentTarget.value)}
					/>
					<span class="w-7">{$scatterDensity.toFixed(2)}</span>
				</label>
			</div>
			<div class="tbx-row text-xs">
				<label class="flex items-center gap-1.5">
					Scale
					<input
						id="sculpt-scatter-scale-min"
						type="number"
						min="0.05"
						max="20"
						step="0.05"
						class="ui-input w-14"
						value={$scatterScaleMin}
						onchange={(e) => scatterScaleMin.set(Math.max(0.05, +e.currentTarget.value || 1))}
					/>
					–
					<input
						id="sculpt-scatter-scale-max"
						type="number"
						min="0.05"
						max="20"
						step="0.05"
						class="ui-input w-14"
						value={$scatterScaleMax}
						onchange={(e) => scatterScaleMax.set(Math.max(0.05, +e.currentTarget.value || 1))}
					/>
				</label>
			</div>
			<div class="tbx-row text-xs">
				<label class="flex items-center gap-1.5">
					<Checkbox id="sculpt-scatter-rotate" label="Random rotation" checked={$scatterRandomRotation} onchange={(v) => scatterRandomRotation.set(!!v)} />
					Random rotation
				</label>
			</div>
			<div class="tbx-row text-xs">
				<label class="flex items-center gap-1.5">
					<Checkbox id="sculpt-scatter-align" label="Align to slope" checked={$scatterAlign} onchange={(v) => scatterAlign.set(!!v)} />
					Align to slope
				</label>
			</div>
			<!-- 48 B1: a NEW model's set starts with this collider (Properties ▸ Scatter edits a set's own) -->
			<div class="tbx-row text-xs" title="The static collider a newly scattered model gets in a simulation — change an existing model's in Properties ▸ Scatter">
				<span>Collider</span>
				<ThemedSelect
					id="sculpt-scatter-collider"
					class="min-w-0 flex-1"
					items={[
						{ value: 'none', name: 'None' },
						{ value: 'box', name: 'Box' },
						{ value: 'sphere', name: 'Sphere' },
						{ value: 'hull', name: 'Mesh hull' }
					]}
					value={$scatterCollider}
					onchange={(v) => scatterCollider.set(v)}
				/>
			</div>
		{/if}

		<!-- DISPLAY: gizmo opt-in — sculpt entry always suppresses the transform
		     gizmo so a stray drag can't move the object; this re-enables it -->
		<span class="tbx-label">Display</span>
		<button
			id="sculpt-gizmo"
			class="tbx-btn"
			aria-label="Toggle the move gizmo"
			aria-pressed={!$gizmoSuppressed}
			title={$gizmoSuppressed ? 'Show the move gizmo (off to avoid accidental moves)' : 'Hide the move gizmo'}
			onclick={() => setSculptGizmo($gizmoSuppressed)}><Icon name="move-3d" size={20} aria-hidden="true" /></button
		>

		{#snippet status()}
			<span>{$sculptRadius}m · {$sculptOp === 'scatter' ? $scatterDensity.toFixed(2) + '/m²' : Math.round($sculptStrength * 100) + '%'}</span>
		{/snippet}
	</ToolboxWindow>
{/if}

<style>
	.layer-chip {
		display: inline-block;
		width: 12px;
		height: 12px;
		border-radius: 3px;
		box-shadow: inset 0 0 0 1px currentColor;
		margin-right: 2px;
	}
</style>
