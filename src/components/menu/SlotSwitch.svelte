<script>
	// 105-slots: "Switch material…" for ONE slot — one popover, three sources. Presets (the starters, yours, peers')
	// and the CC0 library COPY a template into the slot (applyMaterialPreset with the slot: one `materials` commit,
	// the slot keeps its id, name and off flag). "In this scene" lists every distinct slot look in the scene by object
	// and slot name. Lazy (the Inspector imports it on the first Switch material…). On a narrow touch screen it is a
	// bottom sheet.
	import { get } from 'svelte/store';
	import { objectsGroup } from '../../stores/sceneStore';
	import { showToast } from '../../stores/appStore';
	import { nameOf } from '$lib/lockControl';
	import { materialsOf } from '$lib/materialsHandler';
	import {
		starterPresets,
		materialPresets,
		peerMaterialPresets,
		resolvePreset,
		applyMaterialPreset,
		lookOfMaterial
	} from '$lib/materialPresets';
	import { swatchLayers, LOOK_DEFAULTS } from '$lib/materialPresetsCore';
	import { slotsOf, replaceSlotMaterial } from '$lib/materialSlots.js';
	import { openAssetBrowserForSlot } from '$lib/cc0/assetBrowserState.js';
	import { minimalScroll } from '$lib/ui/minimalScroll.js';

	/** @type {{ object: any, index: number, x?: number, y?: number, onclose: () => void }} */
	let { object, index, x = 40, y = 120, onclose } = $props();

	const slotName = $derived(slotsOf(object)[index]?.name || 'Slot ' + (index + 1));
	const starters = starterPresets().map((s) => ({
		label: s.label,
		preset: s.preset,
		resolved: resolvePreset(s.preset)
	}));
	const mine = $derived(
		$materialPresets.map((p) => ({
			label: p.name,
			preset: p.payload,
			resolved: resolvePreset(p.payload)
		}))
	);
	const peers = $derived(
		Object.entries($peerMaterialPresets)
			.filter(([, list]) => list.length)
			.map(([peerId, list]) => ({
				peerId,
				items: list.map((/** @type {any} */ p) => ({
					label: p.label,
					preset: p,
					resolved: resolvePreset(p)
				}))
			}))
	);

	/** every distinct slot look in the scene (by look, not by instance), with where it is */
	const inScene = $derived.by(() => {
		$objectsGroup;
		/** @type {{key: string, label: string, where: string, material: any, look: any}[]} */
		const out = [];
		const seen = new Set();
		get(objectsGroup)?.traverse?.((/** @type {any} */ node) => {
			if (!node.isMesh || !node.material) return;
			const own = materialsOf(node);
			const slots = own.length > 1 ? slotsOf(node) : null;
			own.forEach((m, i) => {
				if (node === object && i === index) return;
				const look = lookOfMaterial(m);
				if (!look) return;
				const key = JSON.stringify(look);
				if (seen.has(key)) return;
				seen.add(key);
				const objectName = node.name || node.type;
				const slot = slots ? slots[i]?.name || 'Slot ' + (i + 1) : '';
				out.push({
					key,
					label: slot ? objectName + ' · ' + slot : objectName,
					where: node.uuid + ':' + i,
					material: m,
					look
				});
			});
		});
		return out.slice(0, 60);
	});

	/** @param {any} resolved */
	function swatchStyle(resolved) {
		if (!resolved) return '';
		const layers = swatchLayers(resolved);
		if (!resolved.map) return 'background:' + layers.join(', ');
		const color = resolved.color ?? LOOK_DEFAULTS.color;
		return (
			'background:' +
			[
				...layers.slice(0, -1),
				`url("${resolved.map}") center / 220%`,
				`linear-gradient(${color}, ${color})`
			].join(', ')
		);
	}

	/** @param {any} preset @param {string} label */
	function usePreset(preset, label) {
		if (applyMaterialPreset(object.uuid, preset, index)) showToast(label + ' on ' + slotName);
		onclose();
	}
	/** @param {any} entry */
	function useSceneLook(entry) {
		// a COPY of that look (the slot keeps its id, name and off flag)
		if (replaceSlotMaterial(object.uuid, index, entry.material.clone()))
			showToast(entry.label + ' copied to ' + slotName);
		onclose();
	}
	function openLibrary() {
		openAssetBrowserForSlot({ uuid: object.uuid, slot: index, label: slotName });
		onclose();
	}

	/** keep the popover on screen (desktop); the sheet layout ignores it */
	const left = $derived(
		Math.max(8, Math.min(x, (typeof innerWidth === 'number' ? innerWidth : 1280) - 300))
	);
	const top = $derived(
		Math.max(8, Math.min(y, (typeof innerHeight === 'number' ? innerHeight : 800) - 420))
	);

	/** @param {HTMLElement} node */
	function dismiss(node) {
		// portaled to <body>: the Inspector's scroller (and a drawer's transform) must not clip or re-anchor it
		document.body.appendChild(node);
		const onDown = (/** @type {PointerEvent} */ e) => {
			if (!node.contains(/** @type {Node} */ (e.target))) onclose();
		};
		const onKey = (/** @type {KeyboardEvent} */ e) => {
			if (e.key === 'Escape') {
				e.stopPropagation();
				onclose();
			}
		};
		// next tick: the click that opened it must not close it
		const t = setTimeout(() => document.addEventListener('pointerdown', onDown, true), 0);
		node.addEventListener('keydown', onKey);
		queueMicrotask(() => /** @type {HTMLElement | null} */ (node.querySelector('button'))?.focus());
		return {
			destroy() {
				clearTimeout(t);
				document.removeEventListener('pointerdown', onDown, true);
				node.removeEventListener('keydown', onKey);
				// a node moved out of the component's range is not removed by svelte: take it out ourselves (measured: a
				// second Switch material… found the first popover still in <body>)
				node.remove();
			}
		};
	}
</script>

<div
	id="slot-switch"
	class="ss-pop"
	role="dialog"
	aria-label="Switch material for {slotName}"
	style="left:{left}px; top:{top}px"
	use:dismiss
	use:minimalScroll
>
	<div class="ss-head">
		<span class="ss-title">Switch material — {slotName}</span>
		<button type="button" class="ss-close" aria-label="Close" onclick={onclose}>Close</button>
	</div>

	<p class="ss-label">Presets</p>
	<div class="ss-grid" role="group" aria-label="Starter presets">
		{#each starters as s (s.label)}
			<button
				type="button"
				class="ss-swatch"
				data-switch-preset={s.label}
				title={s.label}
				aria-label={s.label}
				style={swatchStyle(s.resolved)}
				onclick={() => usePreset(s.preset, s.label)}
			></button>
		{/each}
	</div>
	{#if mine.length}
		<p class="ss-sub">Yours</p>
		<div class="ss-grid" role="group" aria-label="Your presets">
			{#each mine as p (p.label)}
				<button
					type="button"
					class="ss-swatch"
					data-switch-preset={p.label}
					title={p.label}
					aria-label={p.label}
					style={swatchStyle(p.resolved)}
					onclick={() => usePreset(p.preset, p.label)}
				></button>
			{/each}
		</div>
	{/if}
	{#each peers as group (group.peerId)}
		<p class="ss-sub">From {nameOf(group.peerId)}</p>
		<div class="ss-grid" role="group" aria-label="{nameOf(group.peerId)}'s presets">
			{#each group.items as p, i (p.label + ':' + i)}
				<button
					type="button"
					class="ss-swatch"
					title={p.label}
					aria-label={p.label}
					style={swatchStyle(p.resolved)}
					onclick={() => usePreset(p.preset, p.label)}
				></button>
			{/each}
		</div>
	{/each}

	<p class="ss-label">CC0 library</p>
	<button type="button" id="slot-switch-cc0" class="ui-button-quiet ss-wide" onclick={openLibrary}
		>Browse materials… (Apply to {slotName})</button
	>

	<p class="ss-label">In this scene</p>
	{#if inScene.length}
		<ul class="ss-list" aria-label="Materials in this scene">
			{#each inScene as entry (entry.where)}
				<li>
					<button
						type="button"
						class="ss-item"
						data-switch-scene={entry.where}
						onclick={() => useSceneLook(entry)}
					>
						<span class="ss-dot" style={swatchStyle(entry.look)}></span>
						<span class="ss-item-name">{entry.label}</span>
					</button>
				</li>
			{/each}
		</ul>
	{:else}
		<p class="ss-empty">No other materials in the scene yet.</p>
	{/if}
</div>

<style>
	.ss-pop {
		position: fixed;
		z-index: var(--z-menu);
		width: 288px;
		max-height: min(420px, calc(100vh - 16px));
		overflow-y: auto;
		padding: 8px;
		border: 1px solid var(--border);
		border-radius: var(--radius-card);
		background: var(--surface-1);
		color: var(--text);
		box-shadow: var(--shadow-window);
	}
	.ss-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		margin-bottom: 4px;
	}
	.ss-title {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: var(--fs-body);
		color: var(--text-2);
	}
	.ss-close {
		flex-shrink: 0;
		padding: 2px 6px;
		border-radius: var(--radius-button);
		font-size: var(--fs-badge);
		color: var(--text-muted);
	}
	.ss-close:hover {
		background: var(--surface-hover);
	}
	.ss-label {
		margin: 8px 0 4px;
		font-size: var(--fs-badge);
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--text-faint);
	}
	.ss-sub {
		margin: 6px 0 2px;
		font-size: var(--fs-badge);
		color: var(--text-muted);
	}
	.ss-grid {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
	}
	.ss-swatch {
		width: 28px;
		height: 28px;
		border-radius: 50%;
		border: 1px solid var(--border);
	}
	.ss-swatch:hover,
	.ss-swatch:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}
	.ss-wide {
		width: 100%;
		text-align: left;
	}
	.ss-list {
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.ss-item {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		min-height: 32px;
		padding: 2px 4px;
		border-radius: var(--radius-button);
		text-align: left;
		font-size: var(--fs-body);
		color: var(--text-2);
	}
	.ss-item:hover {
		background: var(--surface-hover);
	}
	.ss-dot {
		width: 18px;
		height: 18px;
		flex-shrink: 0;
		border-radius: 50%;
		border: 1px solid var(--border);
	}
	.ss-item-name {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.ss-empty {
		font-size: var(--fs-badge);
		color: var(--text-muted);
	}
	@media (pointer: coarse) {
		.ss-swatch {
			width: 44px;
			height: 44px;
		}
		.ss-item,
		.ss-wide,
		.ss-close {
			min-height: 44px;
		}
	}
	/* a narrow touch screen (Find N6 folded): a bottom sheet */
	@media (max-width: 640px) {
		.ss-pop {
			left: 0 !important;
			right: 0;
			top: auto !important;
			bottom: 0;
			width: auto;
			max-height: 70vh;
			border-radius: var(--radius-card) var(--radius-card) 0 0;
		}
	}
</style>
