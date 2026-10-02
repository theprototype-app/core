<script>
	// 33 (K6) — THE LOD GROUP in object settings, modelled on Unity's LOD Group / Unreal's LOD
	// settings: a level BAR (LOD0 … LODn, then Culled), drag the edges between segments to
	// set each transition by SCREEN SIZE, Force LOD, Generate levels (meshopt, in the worker),
	// replace a level with another model, and SELECT a level to see it in the viewport while
	// you edit it (offset with the gizmo, a material override), then back to Auto.
	//
	// Every write goes through lodGroupActions (one undo entry + one replicated message; a
	// drag is previewed locally per move and committed on release). What this panel shows
	// about the RUNTIME (built, tris, the level drawn, the screen size) is read from
	// lodGroup.js and refreshed by its throttled tick.
	import { onDestroy } from 'svelte';
	import ThemedSelect from '../ui/ThemedSelect.svelte';
	import DragRow from '../ui/DragRow.svelte';
	import { objectsGroup } from '../../stores/sceneStore';
	import { lodGroupInfo, lodGroupTick, lodPreview, buildAllLevels } from '$lib/lodGroup';
	import { lodShowLevels, lodStats, lodEnabled } from '$lib/lod';
	import { levelColor } from '$lib/lodGroupCore';
	import {
		setLodGroup,
		forceLodLevel,
		generateLodLevels,
		updateLodLevel,
		replaceLodLevel,
		addLodLevel,
		removeLodLevel,
		dragLodThreshold,
		editableGroupOf
	} from '$lib/lodGroupActions';
	import { lodLevelGizmo, startLevelGizmo, stopLevelGizmo, resetLevelOffset } from '$lib/lodLevelEdit';

	/** @type {{uuid: string}} */
	let { uuid } = $props();

	/** The selected level (null = none: the group runs on its own mode). LOCAL. */
	/** @type {number | null} */
	let sel = $state(null);

	/** @param {string} id @param {any} _tick @param {any} _group */
	function read(id, _tick, _group) {
		return lodGroupInfo(id);
	}
	const info = $derived(read(uuid, $lodGroupTick, $objectsGroup));

	/** what 31-perf's automatic LOD is doing for this object's meshes (no group) */
	/** @param {string} id @param {any} _tick @param {any} _group */
	function readAuto(id, _tick, _group) {
		/** @type {any} */
		let root = null;
		$objectsGroup?.traverse?.((/** @type {any} */ o) => {
			if (o.uuid === id) root = o;
		});
		if (!root) return { meshes: 0, levels: [] };
		const uuids = new Set();
		root.traverse((/** @type {any} */ o) => o.isMesh && uuids.add(o.uuid));
		const mine = lodStats().meshes.filter((m) => uuids.has(m.uuid));
		return { meshes: mine.length, levels: mine.map((m) => m.levels ? [m.triangles, ...m.levels] : [m.triangles]) };
	}
	const auto = $derived(info ? null : readAuto(uuid, $lodGroupTick, $objectsGroup));

	// the preview follows the selected level; leaving (another object, the panel closing)
	// returns the viewport to the group's own mode
	$effect(() => {
		const level = sel;
		const levels = info?.levels.length ?? 0;
		if (level !== null && level < levels) lodPreview.set({ uuid, level });
		else lodPreview.set(null);
	});
	let lastUuid = '';
	$effect(() => {
		if (uuid !== lastUuid) {
			lastUuid = uuid;
			sel = null;
		}
	});
	onDestroy(() => {
		lodPreview.set(null);
		stopLevelGizmo();
	});

	// ---- the bar: screen size 100% (left) -> 0% (right) on a sqrt scale, because the
	// thresholds that matter (4%, 12%) would be slivers on a linear one
	/** @param {number} s */
	const xOf = (s) => (1 - Math.sqrt(Math.max(0, Math.min(1, s)))) * 100;
	/** @param {number} x 0..1 */
	const sOf = (x) => Math.pow(1 - Math.max(0, Math.min(1, x)), 2);
	/** @param {number} s */
	const pct = (s) => (s >= 0.1 ? Math.round(s * 100) + '%' : (s * 100).toFixed(1) + '%');

	const segments = $derived.by(() => {
		if (!info) return [];
		const lv = info.levels;
		const out = lv.map((/** @type {any} */ level, /** @type {number} */ i) => ({
			level: i,
			from: i === 0 ? 0 : xOf(lv[i - 1].screenSize),
			to: i === lv.length - 1 && !info.block.cull ? 100 : xOf(level.screenSize),
			tris: level.tris,
			status: level.status
		}));
		return out;
	});

	/** @type {any} */
	let barEl = $state(null);
	/** @type {{edge: number, before: any} | null} */
	let drag = null;
	/** the edge drag: a DIRECT pointer listener (panel chrome swallows delegated ones) */
	/** @param {HTMLElement} node @param {number} edge */
	function edgeDrag(node, edge) {
		let current = edge;
		/** @param {PointerEvent} e */
		const down = (e) => {
			if (e.button !== 0) return;
			e.preventDefault();
			e.stopPropagation();
			drag = { edge: current, before: JSON.parse(JSON.stringify(editableGroupOf(uuid))) };
			window.addEventListener('pointermove', move);
			window.addEventListener('pointerup', up);
		};
		/** @param {PointerEvent} e */
		const valueAt = (e) => {
			const r = barEl?.getBoundingClientRect();
			return r && r.width > 0 ? sOf((e.clientX - r.left) / r.width) : null;
		};
		/** @param {PointerEvent} e */
		const move = (e) => {
			if (!drag) return;
			const v = valueAt(e);
			if (v !== null) dragLodThreshold(uuid, drag.edge, v);
		};
		/** @param {PointerEvent} e */
		const up = (e) => {
			window.removeEventListener('pointermove', move);
			window.removeEventListener('pointerup', up);
			if (!drag) return;
			const v = valueAt(e);
			dragLodThreshold(uuid, drag.edge, v ?? editableGroupOf(uuid)?.levels[drag.edge].screenSize ?? 0, { commit: true, before: drag.before });
			drag = null;
		};
		node.addEventListener('pointerdown', down);
		return {
			/** @param {number} next */
			update(next) {
				current = next;
			},
			destroy() {
				node.removeEventListener('pointerdown', down);
				window.removeEventListener('pointermove', move);
				window.removeEventListener('pointerup', up);
			}
		};
	}

	const forceItems = $derived([
		{ value: 'auto', name: 'Auto' },
		...(info?.levels ?? []).map((/** @type {any} */ _l, /** @type {number} */ i) => ({ value: String(i), name: 'LOD' + i })),
	]);
	const forceValue = $derived(info?.block.mode === 'forced' ? String(info.block.forced) : 'auto');

	const level = $derived(sel !== null && info ? info.levels[sel] ?? null : null);

	/** @param {any} l */
	function sourceLabel(l) {
		if (!l) return '';
		if (l.source === 'self') return 'The object itself';
		if (l.source === 'pack') return 'Pack file · ' + String(l.ref).split('/').pop();
		if (l.source === 'generated') return 'Generated · ' + Math.round((l.ratio ?? 0) * 100) + '% of LOD0';
		if (l.source === 'explorer') return 'Explorer · ' + (l.name || String(l.ref).slice(0, 10));
		if (l.source === 'object') return 'Object · ' + (objectName(l.ref) || 'missing');
		return l.source;
	}
	/** @param {string} id */
	function objectName(id) {
		/** @type {any} */
		let name = '';
		$objectsGroup?.traverse?.((/** @type {any} */ o) => {
			if (o.uuid === id) name = o.name || o.type;
		});
		return name;
	}
	const replaceItems = $derived(
		($objectsGroup?.children ?? [])
			.filter((/** @type {any} */ o) => o.uuid !== uuid && !o.userData?.isEditOverlay)
			.slice(0, 200)
			.map((/** @type {any} */ o) => ({ value: o.uuid, name: o.name || o.type }))
	);

	/** @param {number} i */
	function selectLevel(i) {
		sel = sel === i ? null : i;
		if ($lodLevelGizmo) stopLevelGizmo();
	}

	let ratioDraft = $state(0.5);
	$effect(() => {
		if (level?.source === 'generated') ratioDraft = level.ratio ?? 0.5;
	});

	/** @param {DragEvent} e */
	function onDrop(e) {
		e.preventDefault();
		const raw = e.dataTransfer?.getData('application/x-explorer-item');
		if (!raw || sel === null || sel === 0) return;
		try {
			const payload = JSON.parse(raw);
			dropReplace(payload);
		} catch {
			/* not ours */
		}
	}
	/** @param {any} payload */
	async function dropReplace(payload) {
		if (sel === null) return;
		const { explorerItems } = await import('$lib/explorer');
		/** @type {any[]} */
		let items = [];
		explorerItems.subscribe((v) => (items = v))();
		const item = items.find((it) => it.id === payload.id);
		if (item?.kind === 'object' && item.hash) {
			replaceLodLevel(uuid, sel, { source: 'explorer', ref: item.hash, name: item.name });
			return;
		}
		if (payload.url) {
			// a pack item: its file IS a pack level
			const base = (await import('$lib/packs')).PACKS_BASE.replace(/\/+$/, '') + '/';
			const ref = String(payload.url).startsWith(base) ? String(payload.url).slice(base.length) : String(payload.url);
			replaceLodLevel(uuid, sel, { source: 'pack', ref, name: payload.name });
		}
	}
</script>

<div id="lod-group" class="flex flex-col gap-2 text-xs text-gray-300">
	{#if !info}
		<p id="lod-none" class="text-[11px] text-gray-400">
			{#if auto && auto.meshes}
				Automatic: {auto.meshes} mesh{auto.meshes === 1 ? '' : 'es'} simplified at a distance
				({auto.levels.map((l) => l.join(' → ')).join('; ')} tris).
			{:else}
				No LOD group — the object always draws in full detail.
			{/if}
			{#if !$lodEnabled}<span class="block text-amber-400">"Simplify distant models" is off in Settings.</span>{/if}
		</p>
		<div class="flex flex-wrap gap-1">
			<button id="lod-generate" type="button" class="ui-button" onclick={() => generateLodLevels(uuid)}>Generate levels</button>
		</div>
		<p class="text-[10px] text-gray-500">Builds simplified copies (50% / 25% / 10% of the triangles) that draw when the object is small on screen.</p>
	{:else}
		{#if info.implicit}
			<p id="lod-implicit" class="text-[10px] italic text-gray-400">From the pack — saved with the scene once you change it.</p>
		{/if}
		<!-- the level bar -->
		<div class="flex items-center justify-between text-[10px] text-gray-500">
			<span>100%</span><span>screen height</span><span>0%</span>
		</div>
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			id="lod-bar"
			bind:this={barEl}
			class="relative h-9 w-full select-none overflow-hidden rounded-sm border border-gray-600"
			ondragover={(e) => e.preventDefault()}
			ondrop={onDrop}
		>
			{#each segments as seg (seg.level)}
				<button
					type="button"
					class="lod-seg absolute top-0 flex h-full flex-col items-start justify-center overflow-hidden px-1 text-left leading-tight"
					class:lod-seg-sel={sel === seg.level}
					class:lod-seg-active={info.current === seg.level}
					data-level={seg.level}
					style:left={seg.from + '%'}
					style:width={Math.max(0, seg.to - seg.from) + '%'}
					style:background={levelColor(seg.level) + (sel === seg.level ? 'cc' : '66')}
					title={'LOD' + seg.level + (seg.tris != null ? ' · ' + seg.tris + ' tris' : '') + ' — click to select and preview'}
					onclick={() => selectLevel(seg.level)}
				>
					<span class="font-semibold text-white">LOD{seg.level}</span>
					<span class="text-[9px] text-gray-100">{seg.tris != null ? seg.tris + ' tris' : seg.status === 'loading' ? '…' : seg.status === 'failed' ? 'failed' : 'not built'}</span>
				</button>
			{/each}
			{#if info.block.cull}
				<div
					class="lod-seg-culled absolute top-0 flex h-full items-center justify-center bg-gray-700 text-[9px] text-gray-300"
					style:left={xOf(info.levels[info.levels.length - 1].screenSize) + '%'}
					style:right="0"
				>
					Culled
				</div>
			{/if}
			{#each info.levels as l, i (i)}
				{#if i < info.levels.length - 1 || info.block.cull}
					<div
						class="lod-edge absolute top-0 z-10 h-full w-[7px] -translate-x-1/2 cursor-ew-resize"
						data-edge={i}
						style:left={xOf(l.screenSize) + '%'}
						title={'LOD' + i + ' → ' + (i < info.levels.length - 1 ? 'LOD' + (i + 1) : 'culled') + ' at ' + pct(l.screenSize) + ' — drag'}
						use:edgeDrag={i}
					>
						<div class="mx-auto h-full w-[2px] bg-white/80"></div>
					</div>
				{/if}
			{/each}
			<!-- where the object is on screen right now -->
			<div id="lod-marker" class="pointer-events-none absolute bottom-0 h-1.5 w-0.5 bg-white" style:left={xOf(Math.min(1, info.size)) + '%'}></div>
		</div>
		<div class="flex flex-wrap gap-x-3 text-[10px] text-gray-400">
			{#each info.levels as l, i (i)}
				<span>LOD{i} &lt; {pct(l.screenSize)}</span>
			{/each}
			<span id="lod-now">now: LOD{info.current < 0 ? ' culled' : info.current} at {pct(Math.min(1, info.size))}</span>
		</div>

		<div class="ui-row items-center gap-2">
			<span class="w-24 shrink-0 text-xs text-gray-400">Force LOD</span>
			<ThemedSelect
				id="lod-force"
				items={forceItems}
				value={forceValue}
				onchange={(/** @type {any} */ v) => forceLodLevel(uuid, v === 'auto' ? 'auto' : Number(v))}
			/>
		</div>

		<label class="flex items-center gap-2">
			<input
				id="lod-cull"
				type="checkbox"
				class="tp-check"
				checked={!!info.block.cull}
				onchange={(/** @type {any} */ e) => setLodGroup(uuid, { ...info.block, cull: e.currentTarget.checked })}
			/>
			Cull when smaller than the last level's size
		</label>
		<label class="flex items-center gap-2">
			<input id="lod-overlay" type="checkbox" class="tp-check" checked={$lodShowLevels} onchange={(/** @type {any} */ e) => lodShowLevels.set(e.currentTarget.checked)} />
			Show LOD level in the viewport (colours, this screen only)
		</label>

		{#if level && sel !== null}
			<div id="lod-level-detail" class="flex flex-col gap-1.5 rounded-sm border border-gray-600/60 p-2" data-level={sel}>
				<div class="flex items-center justify-between">
					<span class="font-semibold text-gray-100">LOD{sel}</span>
					<span class="text-[10px] text-gray-400">previewing on this screen</span>
				</div>
				<p id="lod-level-source" class="text-[11px]">{sourceLabel(level)} · {level.tris != null ? level.tris + ' tris' : level.status}</p>
				{#if level.error}<p class="text-[10px] text-amber-400">{level.error}</p>{/if}
				{#if sel === 0}
					<p class="text-[10px] text-gray-500">LOD0 is the object itself — edit it with the rest of this panel.</p>
				{:else}
					{#if level.source === 'generated'}
						<DragRow
							id="lod-level-ratio"
							label="Triangles %"
							value={Math.round(ratioDraft * 100)}
							min={1}
							max={99}
							step={0.5}
							decimals={0}
							onchange={(v) => (ratioDraft = v / 100)}
							onscrubend={() => updateLodLevel(uuid, /** @type {number} */ (sel), { ratio: ratioDraft })}
						/>
						<button id="lod-level-apply-ratio" type="button" class="ui-button-quiet self-start" onclick={() => updateLodLevel(uuid, /** @type {number} */ (sel), { ratio: ratioDraft })}>Rebuild at {Math.round(ratioDraft * 100)}%</button>
					{/if}
					<div class="ui-row items-center gap-2">
						<span class="w-24 shrink-0 text-xs text-gray-400">Replace with</span>
						<ThemedSelect
							id="lod-level-replace"
							items={[{ value: '', name: 'Choose an object…' }, { value: '__generated', name: 'Generated (meshopt)' }, ...replaceItems]}
							value=""
							onchange={(/** @type {any} */ v) => {
								if (!v || sel === null) return;
								if (v === '__generated') replaceLodLevel(uuid, sel, { source: 'generated', ratio: level.ratio ?? 0.5 });
								else replaceLodLevel(uuid, sel, { source: 'object', ref: v });
							}}
						/>
					</div>
					<p class="text-[10px] text-gray-500">…or drop a model from the Explorer on the bar.</p>
					<div class="flex flex-wrap gap-1">
						{#if $lodLevelGizmo?.uuid === uuid && $lodLevelGizmo?.level === sel}
							<button id="lod-level-move" type="button" class="ui-button tbx-on" aria-pressed="true" onclick={() => stopLevelGizmo()}>Done moving</button>
						{:else}
							<button id="lod-level-move" type="button" class="ui-button" aria-pressed="false" onclick={() => startLevelGizmo(uuid, /** @type {number} */ (sel))}>Move level</button>
						{/if}
						{#if level.offset}
							<button id="lod-level-reset" type="button" class="ui-button-quiet" onclick={() => resetLevelOffset(uuid, /** @type {number} */ (sel))}>Reset offset</button>
						{/if}
						<button id="lod-level-remove" type="button" class="ui-button-quiet" onclick={() => {
							const i = sel;
							sel = null;
							if (i !== null) removeLodLevel(uuid, i);
						}}>Remove level</button>
					</div>
					<label class="flex items-center gap-2">
						<input
							id="lod-level-override"
							type="checkbox"
							class="tp-check"
							checked={!!level.material}
							onchange={(/** @type {any} */ e) => updateLodLevel(uuid, /** @type {number} */ (sel), { material: e.currentTarget.checked ? { color: '#ffffff' } : undefined })}
						/>
						Own material for this level
					</label>
					{#if level.material}
						<div class="ui-row items-center gap-2">
							<span class="w-24 shrink-0 text-xs text-gray-400">Colour</span>
							<input
								id="lod-level-color"
								type="color"
								value={level.material.color ?? '#ffffff'}
								onchange={(/** @type {any} */ e) => updateLodLevel(uuid, /** @type {number} */ (sel), { material: { ...level.material, color: e.currentTarget.value } })}
							/>
						</div>
						<DragRow
							id="lod-level-roughness"
							label="Roughness"
							value={level.material.roughness ?? 0.5}
							min={0}
							max={1}
							step={0.005}
							decimals={2}
							onchange={(v) => updateLodLevel(uuid, /** @type {number} */ (sel), { material: { ...level.material, roughness: v } })}
						/>
						<DragRow
							id="lod-level-metalness"
							label="Metalness"
							value={level.material.metalness ?? 0}
							min={0}
							max={1}
							step={0.005}
							decimals={2}
							onchange={(v) => updateLodLevel(uuid, /** @type {number} */ (sel), { material: { ...level.material, metalness: v } })}
						/>
					{/if}
				{/if}
			</div>
		{:else}
			<p class="text-[10px] text-gray-500">Click a level on the bar to select it: the viewport shows that level while it is selected.</p>
		{/if}

		<div class="flex flex-wrap gap-1">
			<button id="lod-add-level" type="button" class="ui-button-quiet" onclick={() => addLodLevel(uuid)}>+ Level</button>
			<button id="lod-generate" type="button" class="ui-button-quiet" onclick={() => generateLodLevels(uuid)}>Generate levels</button>
			<button id="lod-build-all" type="button" class="ui-button-quiet" onclick={() => buildAllLevels(uuid)}>Build all now</button>
			{#if !info.implicit}
				<button id="lod-remove-group" type="button" class="ui-button-quiet" onclick={() => {
					sel = null;
					setLodGroup(uuid, null);
				}}>Remove group</button>
			{/if}
		</div>
	{/if}
</div>

<style>
	.lod-seg {
		border-right: 1px solid rgb(0 0 0 / 0.35);
	}
	.lod-seg-sel {
		outline: 2px solid #fff;
		outline-offset: -2px;
	}
	.lod-seg-active span:first-child::after {
		content: ' ●';
		font-size: 8px;
	}
</style>
