<script>
	// L3 — Configure Scene ▸ Post-processing.
	//
	// The stack list: add / remove / reorder / per-entry enable, with each entry's
	// parameters rendered from its REGISTRY schema, so a new effect kind (or one a
	// module registers) gets its UI for free and this file never learns about it.
	//
	// It lives in its own component deliberately: Inspector.svelte is a shared file
	// the shader lane is also editing, and it is a plain `<script>` where one
	// TypeScript annotation breaks the build with a useless error.
	import DragRow from '../ui/DragRow.svelte';
	import ThemedSelect from '../ui/ThemedSelect.svelte';
	import ContextMenu from '../ContextMenu.svelte';
	import { Checkbox } from 'flowbite-svelte';
	import { onMount } from 'svelte';
	import { viewMode } from '../../stores/sceneStore';
	import { explorerItems, loadExplorer, kindOf } from '$lib/explorer';
	import { sendAsset } from '$lib/assetShare';
	import {
		scenePost,
		postEnabledLocal,
		postEffectKinds,
		postEffectDef,
		stackCounts,
		addPostEffect,
		removePostEffect,
		movePostEffect,
		setPostEffectEnabled,
		setPostEffectParams,
		setScenePostEnabled,
		beginLookGesture,
		endLookGesture
	} from '$lib/scenePost';

	/** which entry has its parameters open (one at a time — the stack is the subject,
	 * a single entry's knobs are the detail) */
	let openId = $state('');
	/** the add menu's anchor while it is open: {x, y} | null */
	/** @type {any} */
	let menu = $state(null);
	/** a live pointer reorder: {id, from, to} */
	/** @type {any} */
	let drag = $state(null);
	/** @type {any} */
	let listEl = $state(null);

	const counts = $derived(stackCounts($scenePost));
	// grouped for the add menu, so 'Colour grading' and 'Camera FX' do not
	// interleave in one flat list of a dozen entries
	const GROUP_ORDER = ['ao', 'grading', 'stylize', 'camera', 'aa', 'test', 'other'];
	/** @type {Record<string, string>} */
	const GROUP_LABEL = {
		ao: 'Ambient occlusion',
		grading: 'Colour grading',
		stylize: 'Stylize',
		camera: 'Camera FX',
		aa: 'Anti-aliasing',
		test: 'Test',
		other: 'Other'
	};
	/**
	 * The add menu, as GROUPED SUBMENUS on the shared ContextMenu.
	 *
	 * It was a ThemedSelect whose item names carried their group as a prefix
	 * ("Colour grading · LUT (colour grade)"). That pushed the Add button off the
	 * edge of a narrow panel, made every entry read as a sentence, and only gets
	 * worse — L6's post-domain presets land in this same menu. A context menu is the
	 * app's own idiom for exactly this: it portals itself, clamps to the viewport,
	 * nests by family, and brings type-to-filter over the flattened leaves for free.
	 * It also collapses the old two-step "choose, then press Add" into one action.
	 */
	const addMenuItems = $derived.by(() => {
		/** @type {Record<string, any[]>} */
		const byGroup = {};
		for (const def of postEffectKinds()) (byGroup[def.group] ??= []).push(def);
		// known families first, in a deliberate order; anything a module registers
		// under a new group follows, alphabetically
		const extra = Object.keys(byGroup)
			.filter((group) => !GROUP_ORDER.includes(group))
			.sort();
		return [...GROUP_ORDER, ...extra]
			.filter((group) => byGroup[group]?.length)
			.map((group) => ({
				label: GROUP_LABEL[group] ?? group,
				children: byGroup[group]
					.slice()
					.sort((a, b) => a.label.localeCompare(b.label))
					.map((def) => ({ label: def.label, action: () => add(def.kind) }))
			}));
	});

	/** @param {any} entry */
	function labelOf(entry) {
		return postEffectDef(entry.kind)?.label ?? entry.kind;
	}
	/** an entry whose kind this build does not know — kept, never rendered */
	/** @param {any} entry */
	function isUnknown(entry) {
		return !postEffectDef(entry.kind);
	}

	/** @param {string} kind */
	function add(kind) {
		menu = null;
		openId = addPostEffect(kind);
	}

	/** @param {any} event */
	function openAddMenu(event) {
		const box = event.currentTarget.getBoundingClientRect();
		// anchor UNDER the button, left-aligned; ContextMenu clamps into the viewport
		// from there (and shifts up rather than flipping when it will not fit below)
		menu = { x: Math.round(box.left), y: Math.round(box.bottom + 4) };
	}

	// L5: the asset picker (a LUT today). The Explorer index has to be loaded or
	// the list is empty for anyone who has not opened that panel yet; loadExplorer
	// is idempotent.
	onMount(() => {
		loadExplorer();
	});
	/** files that could plausibly BE a lookup table: a .cube, or a strip image */
	const assetItems = $derived([
		{ value: '', name: '— none —' },
		...$explorerItems
			.filter((item) => /\.cube$/i.test(item.name ?? '') || kindOf(item.name ?? '') === 'image')
			.map((item) => ({ value: item.hash, name: item.name }))
	]);

	/**
	 * Assign an asset param and PUSH its bytes once.
	 *
	 * The hash is what travels in the stack, but a peer cannot grade with a hash it
	 * has no bytes for — so the file goes out on assign (golden rule 9). A peer who
	 * still misses it pulls on demand from postEffects' `requestAsset`, which is
	 * what covers late joiners and session restores.
	 * @param {string} id @param {string} key @param {string} hash
	 */
	function assignAsset(id, key, hash) {
		setPostEffectParams(id, { [key]: hash });
		if (hash) sendAsset(hash);
	}

	// ---- pointer reorder -----------------------------------------------------
	// POINTER events, not HTML5 drag-and-drop: touch has no DnD at all, and this
	// panel is a bottom sheet on a phone. The grip's own pointerdown is attached as
	// a DIRECT listener (the action below) because svelte DELEGATES `onpointerdown`
	// and the drawer chrome swallows it on the way to the app root — the same
	// reason DragRow does it.

	/** @param {any} node @param {any} params */
	function grip(node, params) {
		/** @param {PointerEvent} event */
		const down = (event) => {
			if (event.button !== 0) return;
			event.preventDefault();
			drag = { id: params.id, from: params.index, to: params.index };
			window.addEventListener('pointermove', move);
			window.addEventListener('pointerup', up);
		};
		/** @param {PointerEvent} event */
		const move = (event) => {
			if (!drag || !listEl) return;
			// the drop index is whichever row's midpoint the pointer has passed
			const rows = [...listEl.querySelectorAll('[data-post-row]')];
			let to = rows.length - 1;
			for (let index = 0; index < rows.length; index++) {
				const box = rows[index].getBoundingClientRect();
				if (event.clientY < box.top + box.height / 2) {
					to = index;
					break;
				}
			}
			drag = { ...drag, to };
		};
		const up = () => {
			window.removeEventListener('pointermove', move);
			window.removeEventListener('pointerup', up);
			const pending = drag;
			drag = null;
			if (pending && pending.to !== pending.from) movePostEffect(pending.id, pending.to);
		};
		node.addEventListener('pointerdown', down);
		return {
			/** @param {any} next */
			update(next) {
				params = next;
			},
			destroy() {
				node.removeEventListener('pointerdown', down);
				window.removeEventListener('pointermove', move);
				window.removeEventListener('pointerup', up);
			}
		};
	}
</script>

<Checkbox id="post-enabled" checked={$scenePost.enabled} onchange={(e) => setScenePostEnabled(e.currentTarget.checked)}>
	Scene look enabled (shared)
</Checkbox>

<!-- the cost model, visible: the gap between enabled entries and PASSES is the
	 Effect-merging rule doing its job, and an author has no other way to see it -->
<p id="post-counts" class="text-[10px] text-gray-400">
	Effects: {counts.enabled}{counts.effects !== counts.enabled ? ' of ' + counts.effects : ''}, passes: {counts.passes}{counts.merged >
	0
		? ' (' + counts.merged + ' merged into a shared pass)'
		: ''}
</p>

{#if $scenePost.effects.length === 0}
	<p class="text-xs text-gray-400">
		No look yet. Add ambient occlusion, colour grading or a camera effect below — the stack runs top
		to bottom over the finished frame, and everyone in the session sees it.
	</p>
{:else}
	<div id="post-stack" class="flex flex-col gap-0.5" bind:this={listEl}>
		{#each $scenePost.effects as entry, index (entry.id)}
			<div data-post-row class:post-drop={drag && drag.to === index && drag.from !== index}>
				<div
					id={'post-row-' + entry.id}
					class="flex items-center gap-1 rounded-sm bg-gray-700/60 px-1 py-0.5"
					class:opacity-50={drag && drag.id === entry.id}
				>
					<span
						id={'post-grip-' + entry.id}
						class="cursor-grab select-none px-1 text-gray-400 hover:text-gray-200"
						title="Drag to reorder — the stack runs top to bottom"
						use:grip={{ id: entry.id, index }}>⠿</span
					>
					<input
						id={'post-toggle-' + entry.id}
						type="checkbox"
						class="h-3 w-3 shrink-0 accent-primary-600"
						checked={entry.enabled}
						title="Render this effect"
						aria-label={'Enable ' + labelOf(entry)}
						onchange={(e) => setPostEffectEnabled(entry.id, e.currentTarget.checked)}
					/>
					<button
						id={'post-open-' + entry.id}
						class="flex-1 truncate text-left text-xs text-gray-200 hover:text-white"
						title={isUnknown(entry)
							? 'This effect comes from a newer version — it is kept and shared, but this build cannot render it'
							: 'Show parameters'}
						onclick={() => (openId = openId === entry.id ? '' : entry.id)}
					>
						{labelOf(entry)}{#if isUnknown(entry)}<span class="ml-1 text-[10px] text-amber-400">unsupported</span
							>{/if}
					</button>
					<button
						id={'post-up-' + entry.id}
						class="px-1 text-[10px] text-gray-400 hover:text-gray-100 disabled:opacity-30"
						title="Move earlier in the stack"
						aria-label="Move up"
						disabled={index === 0}
						onclick={() => movePostEffect(entry.id, index - 1)}>↑</button
					>
					<button
						id={'post-down-' + entry.id}
						class="px-1 text-[10px] text-gray-400 hover:text-gray-100 disabled:opacity-30"
						title="Move later in the stack"
						aria-label="Move down"
						disabled={index === $scenePost.effects.length - 1}
						onclick={() => movePostEffect(entry.id, index + 1)}>↓</button
					>
					<button
						id={'post-remove-' + entry.id}
						class="px-1 text-[10px] text-gray-400 hover:text-red-400"
						title="Remove from the stack"
						aria-label={'Remove ' + labelOf(entry)}
						onclick={() => removePostEffect(entry.id)}>✕</button
					>
				</div>
				{#if openId === entry.id}
					<div id={'post-params-' + entry.id} class="flex flex-col gap-1 px-2 pb-1 pt-1">
						{#if isUnknown(entry)}
							<p class="text-[10px] italic text-amber-400">
								Saved and shared as-is. Open this scene in a build that has "{entry.kind}" to edit it.
							</p>
						{:else if (postEffectDef(entry.kind)?.params ?? []).length === 0}
							<p class="text-[10px] italic text-gray-400">No parameters.</p>
						{:else}
							{#each postEffectDef(entry.kind).params as param (param.key)}
								{#if param.type === 'select'}
									<!-- min-w-0 + flex-1: without it a long option name makes the select
										 refuse to shrink and pushes the row past the panel edge -->
									<div class="ui-row items-center gap-2">
										<span class="w-20 shrink-0 text-xs text-gray-300">{param.label}</span>
										<ThemedSelect
											id={'post-param-' + entry.id + '-' + param.key}
											class="min-w-0 flex-1"
											items={(param.options ?? []).map((/** @type {any} */ o) => ({ value: o.value, name: o.label }))}
											value={entry.params[param.key]}
											onchange={(v) => setPostEffectParams(entry.id, { [param.key]: v })}
										/>
									</div>
								{:else if param.type === 'asset'}
									<div class="ui-row items-center gap-2">
										<span class="w-20 shrink-0 text-xs text-gray-300">{param.label}</span>
										<ThemedSelect
											id={'post-param-' + entry.id + '-' + param.key}
											class="min-w-0 flex-1"
											items={assetItems}
											value={entry.params[param.key] ?? ''}
											placeholder="Pick a file…"
											onchange={(v) => assignAsset(entry.id, param.key, String(v ?? ''))}
										/>
									</div>
								{:else if param.type === 'bool'}
									<Checkbox
										id={'post-param-' + entry.id + '-' + param.key}
										checked={!!entry.params[param.key]}
										onchange={(e) => setPostEffectParams(entry.id, { [param.key]: e.currentTarget.checked })}
									>
										{param.label}
									</Checkbox>
								{:else}
									<DragRow
										id={'post-param-' + entry.id + '-' + param.key}
										label={param.label}
										value={Number(entry.params[param.key] ?? param.default ?? 0)}
										min={param.min ?? -Infinity}
										max={param.max ?? Infinity}
										step={param.step ?? 0.01}
										decimals={param.decimals ?? 2}
										title={param.hint ?? ''}
										onchange={(v) => setPostEffectParams(entry.id, { [param.key]: v })}
										onscrubstart={beginLookGesture}
										onscrubend={endLookGesture}
									/>
								{/if}
								{#if param.hint}
									<p class="text-[10px] italic text-gray-500">{param.hint}</p>
								{/if}
							{/each}
						{/if}
					</div>
				{/if}
			</div>
		{/each}
	</div>
{/if}

<button
	id="post-add"
	class="ui-chip w-full justify-center bg-gray-600 text-gray-200 hover:bg-gray-500"
	title="Add a post-processing effect to the scene's look"
	onclick={openAddMenu}
>
	+ Add effect
</button>
{#if menu}
	<ContextMenu
		x={menu.x}
		y={menu.y}
		items={addMenuItems}
		sizeKey="post-add"
		onclose={() => (menu = null)}
	/>
{/if}

<p class="text-[10px] italic text-gray-400">
	The stack is part of the scene: everyone sees it and it is saved with the file. Whether YOUR
	viewport renders it is local — pick "Scene look" in View.
</p>
{#if $scenePost.effects.length && $viewMode !== 'custom'}
	<p class="text-[10px] text-amber-400">
		This scene has a look, but your viewport is showing "{$viewMode}" — switch View to Scene look to
		see it.
	</p>
{/if}
{#if $scenePost.effects.length && !$postEnabledLocal}
	<p class="text-[10px] text-amber-400">Scene look rendering is switched off on this device (View).</p>
{/if}
<p class="text-[10px] italic text-gray-400">
	Post-processing does not run in VR — the effects are skipped in a headset, and objects still look
	the same.
</p>

<style>
	/* the drop target during a pointer reorder */
	.post-drop {
		box-shadow: inset 0 2px 0 0 var(--accent, #3b82f6);
	}
</style>
