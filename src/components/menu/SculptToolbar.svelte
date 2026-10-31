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
		sculptScatterOnly,
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
	import { sourceKey, normalizeScatter } from '$lib/terrainScatterCore';
	import { base64ToBytes } from '$lib/terrainPaintCore';
	import { scatterCounts } from '$lib/terrainSurface';
	// 51 E4: the tools that EDIT what is scattered (brushes + the Select tool)
	import {
		scatterTool,
		scatterAffects,
		scatterBrushReverse,
		scatterSelectionCount,
		scatterGizmoMode,
		setScatterTool,
		setScatterGizmoMode,
		rotateSelectedInstances,
		scaleSelectedInstances,
		rerollSelectedInstances,
		deleteSelectedInstances
	} from '$lib/scatterEdit';
	import { explorerItems } from '$lib/explorer';
	import { prefabs, loadPrefabs } from '$lib/prefabs';
	// 51 E1: one catalog (primitives, Library, pack items, prefabs) shared with Properties ▸ Scatter
	import { sourceChoices, resolveSourceChoice, packChoiceList, loadPackChoices, sourceLabel } from '$lib/scatterSources';

	const OPS = [
		{ op: 'raise', label: 'Raise', icon: 'raise', desc: 'pull the surface up along its normals' },
		{ op: 'lower', label: 'Lower', icon: 'lower', desc: 'push the surface down' },
		{ op: 'smooth', label: 'Smooth', icon: 'smooth', desc: 'relax the surface' },
		{ op: 'flatten', label: 'Flatten', icon: 'flatten', desc: 'level toward the hit plane' }
	];
	// terrain only: a plain mesh has no splat map
	const PAINT_OP = { op: 'paint', label: 'Paint', icon: 'paint', desc: 'paint a texture layer onto the terrain' };
	// 51-surface: scatter paints on ANY mesh's own surface
	const SCATTER_OP = { op: 'scatter', label: 'Scatter', icon: 'scatter', desc: 'paint (or erase) instances of a model' };
	const ops = $derived(
		$sculptScatterOnly ? [SCATTER_OP] : $sculptMode === 'terrain' ? [...OPS, PAINT_OP, SCATTER_OP] : [...OPS, SCATTER_OP]
	);

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

	// scatter sources: the primitives, every Library model, the pack items, the prefabs (look only)
	let prefabsAsked = false;
	$effect(() => {
		if ($sculptOp !== 'scatter') return;
		loadPackChoices();
		if (!prefabsAsked) {
			prefabsAsked = true;
			void loadPrefabs(); // the prefab list is read lazily (the Explorer reads it on open)
		}
	});
	const sourceItems = $derived(
		sourceChoices({ library: $explorerItems, packs: $packChoiceList, prefabs: $prefabs, current: [$scatterSource] })
	);
	let preparing = $state(false);
	/** @param {string} key */
	async function pickSource(key) {
		// a prefab is exported to its look first (a GLB in the Library) — say so while it runs
		if (key.startsWith('f:')) preparing = true;
		try {
			const source = await resolveSourceChoice(key, $explorerItems);
			if (source) scatterSource.set(source);
		} finally {
			preparing = false;
		}
	}

	// 51 E4: Paint/Erase were two buttons; the edit tools join them in one armed row
	const SCATTER_TOOLS = [
		{ tool: 'paint', label: 'Paint', icon: 'scatter', desc: 'paint instances of the model above' },
		{ tool: 'erase', label: 'Erase', icon: 'scatter-erase', desc: 'erase instances (Affects picks which models)' },
		{ tool: 'rotate', label: 'Rotate', icon: 'scatter-rotate', desc: 'turn the instances under the brush' },
		{ tool: 'scale', label: 'Scale', icon: 'scatter-scale', desc: 'grow (or shrink) the instances under the brush' },
		{ tool: 'relax', label: 'Relax', icon: 'scatter-relax', desc: 'even out the spacing under the brush' },
		{ tool: 'select', label: 'Select', icon: 'scatter-select', desc: 'pick instances and move, turn, scale, delete or re-roll them' }
	];
	const GIZMO_MODES = /** @type {const} */ ([
		{ mode: 'translate', label: 'Move', desc: 'Slide the selection over the ground (height follows the terrain)' },
		{ mode: 'rotate', label: 'Turn', desc: 'Turn the selection about up' },
		{ mode: 'scale', label: 'Size', desc: 'Scale the selection' }
	]);
	// 51-union: on a mesh host (51-surface) only Paint + Erase — the 47 erase flag, which works there
	const onMesh = $derived($sculptMode !== 'terrain');
	const scatterTools = $derived(onMesh ? SCATTER_TOOLS.slice(0, 2) : SCATTER_TOOLS);
	// the armed tool; the 47 erase flag still reads as Erase (a suite or an old caller sets it)
	const tool = $derived(onMesh ? ($scatterErase ? 'erase' : 'paint') : $scatterErase && $scatterTool === 'paint' ? 'erase' : $scatterTool);
	/** @param {string} t */
	function pickTool(t) {
		if (onMesh) {
			scatterErase.set(t === 'erase');
			setScatterTool('paint');
			return;
		}
		scatterErase.set(false);
		setScatterTool(/** @type {any} */ (t));
	}
	// Affects: every model on this terrain, or one of them
	const affectItems = $derived.by(() => {
		void $sceneRevision;
		const object = /** @type {any} */ ($objectsGroup)?.getObjectByProperty?.('uuid', $sculptObject);
		const sets = normalizeScatter(object?.userData?.terrainScatter, base64ToBytes)?.sets ?? [];
		// 51-union: the DRAWN count (a seeded fill's instances are not in `count`, the painted records)
		const drawn = object ? scatterCounts(object) : {};
		return [
			{ value: '', name: 'All models' },
			...sets.map((/** @type {any} */ s) => ({
				value: s.id,
				name: sourceLabel(s.source) + ` (${drawn[s.id] ?? s.count})`
			}))
		];
	});

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
		title={$sculptScatterOnly ? 'Scatter on object' : $sculptMode === 'mesh' ? 'Sculpt mesh' : 'Sculpt terrain'}
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
		{#if $sculptOp !== 'scatter' || tool === 'rotate' || tool === 'scale' || tool === 'relax'}
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

		{#if $sculptOp === 'scatter'}
			<!-- 47 T2 + 51 E4: what to scatter + how, and the TOOLS that edit what is there (51-surface:
			     a mesh host keeps Paint + Erase; the edit tools read a terrain's instances) -->
			<span class="tbx-label">Scatter</span>
			<div class="tbx-row text-xs">
				<ThemedSelect
					id="sculpt-scatter-source"
					title="What the brush scatters — a primitive, a Library model, a pack item or a prefab (its look only)"
					clip={false}
					items={sourceItems}
					value={sourceKey($scatterSource)}
					onchange={(v) => pickSource(String(v))}
				/>
			</div>
			{#if preparing || $scatterSource?.note}
				<p id="sculpt-scatter-source-note" class="tbx-row text-[length:var(--fs-badge)] text-text-muted" role="status">
					{preparing ? 'Preparing the prefab\u2019s look\u2026' : $scatterSource.note}
				</p>
			{/if}
			<div class="tbx-row text-xs" role="toolbar" aria-label="Scatter tools">
				{#each scatterTools as t (t.tool)}
					<button
						id={`sculpt-scatter-${t.tool}`}
						class="tbx-btn {tool === t.tool ? 'tbx-on bg-accent-fill text-on-accent' : ''}"
						aria-label={t.label}
						aria-pressed={tool === t.tool}
						title={`${t.label} — ${t.desc}`}
						onclick={() => pickTool(t.tool)}><Icon name={'tool:' + t.icon} size={20} aria-hidden="true" /></button
					>
				{/each}
			</div>
			{#if tool !== 'paint' && !onMesh}
				<!-- 51 E4: per-source edits — every tool can be held to ONE model -->
				<div class="tbx-row text-xs" title="Which scattered model the tool may touch">
					<span>Affects</span>
					<ThemedSelect
						id="sculpt-scatter-affects"
						class="min-w-0 flex-1"
						clip={false}
						items={affectItems}
						value={$scatterAffects}
						onchange={(v) => scatterAffects.set(String(v))}
					/>
				</div>
			{/if}
			{#if tool === 'rotate' || tool === 'scale'}
				<div class="tbx-row text-xs">
					<label class="flex items-center gap-1.5">
						<Checkbox
							id="sculpt-scatter-reverse"
							label={tool === 'rotate' ? 'Turn the other way' : 'Shrink'}
							checked={$scatterBrushReverse}
							onchange={(v) => scatterBrushReverse.set(!!v)}
						/>
						{tool === 'rotate' ? 'Turn the other way' : 'Shrink'}
					</label>
				</div>
			{/if}
			{#if tool === 'select'}
				<div id="sculpt-scatter-selection" class="tbx-row text-xs" aria-live="polite">
					{$scatterSelectionCount
						? `${$scatterSelectionCount} selected`
						: 'Click an instance, drag a box, Ctrl+A for all'}
				</div>
				{#if $scatterSelectionCount}
					<div class="tbx-row text-xs" role="group" aria-label="Gizmo">
						{#each GIZMO_MODES as g (g.mode)}
							<button
								id={`sculpt-scatter-gizmo-${g.mode}`}
								class="tbx-cmd {$scatterGizmoMode === g.mode ? 'tbx-on bg-accent-fill text-on-accent' : ''}"
								aria-pressed={$scatterGizmoMode === g.mode}
								title={g.desc}
								onclick={() => setScatterGizmoMode(g.mode)}>{g.label}</button
							>
						{/each}
					</div>
					<div class="tbx-row flex-wrap text-xs" role="group" aria-label="Selected instances">
						<button id="sculpt-scatter-turn-left" class="tbx-cmd" title="Turn each selected instance 15° left" onclick={() => rotateSelectedInstances(15)}>Turn left</button>
						<button id="sculpt-scatter-turn-right" class="tbx-cmd" title="Turn each selected instance 15° right" onclick={() => rotateSelectedInstances(-15)}>Turn right</button>
						<button id="sculpt-scatter-bigger" class="tbx-cmd" title="Scale the selection up 10 %" onclick={() => scaleSelectedInstances(1.1)}>Bigger</button>
						<button id="sculpt-scatter-smaller" class="tbx-cmd" title="Scale the selection down 10 %" onclick={() => scaleSelectedInstances(1 / 1.1)}>Smaller</button>
						<button
							id="sculpt-scatter-reroll"
							class="tbx-cmd"
							title="New random turn and size for the selection (from Scale and Random rotation below); every other instance keeps its edits"
							onclick={() => rerollSelectedInstances()}>Re-roll</button
						>
						<button id="sculpt-scatter-delete" class="tbx-cmd tbx-danger" title="Delete the selected instances (Delete)" onclick={() => deleteSelectedInstances()}>Delete</button>
						<button
							id="sculpt-scatter-to-objects"
							class="tbx-cmd"
							title="Make the selected instances real objects (a logic prefab comes with its logic); one undo turns them back"
							onclick={() => import('$lib/scatterConvert').then((m) => m.instancesToObjects({ scope: 'selection' }))}>To objects</button
						>
					</div>
				{/if}
			{/if}
			{#if tool === 'paint'}
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
			{/if}
			{#if tool === 'paint' || tool === 'select'}
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
			{/if}
			{#if tool === 'paint'}
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
