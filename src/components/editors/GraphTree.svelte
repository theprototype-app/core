<script>
	// #20 P7: the GRAPHS tree — a navigator for the documents of one editor kind.
	//
	// A collapsible section stacked ABOVE the palette in the same left pane (the fork
	// answer): both visible at once, no new column, and the collapse state persists like
	// every other section. It is a NAVIGATOR, not a second object list, so it lists only
	// `Scene` plus the objects that actually own a document of this kind — an object with
	// no flow graph has nothing to navigate to.
	//
	// Clicking a row SELECTS the object, which is what switches the editor's scope: both
	// editors derive their scope from the selection rather than from a scope control, so
	// there is one way for the scope to change and the tree does not need its own.
	//
	// THREE trees are not reactive, so the rows list `objectsGroup` as a dependency —
	// without it a rename or a delete leaves a stale name in the tree.
	import { ChevronDown, ChevronRight, Waypoints } from '@lucide/svelte';
	import { objectsGroup, selectedObjects } from '../../stores/sceneStore';
	import { applySelectionSet, deselectObject } from '$lib/objectActions';

	/** `paneHeight` is the LEFT COLUMN's measured height — see the resize ceiling below.
	 * @type {{ kind: 'flow'|'shader', documents: Record<string, any>, sceneKey: string,
	 *   label?: string, paneHeight?: number }} */
	let { kind, documents, sceneKey, label = 'Graphs', paneHeight = 0 } = $props();

	const LS = typeof localStorage !== 'undefined' ? localStorage : null;
	// a ONE-TIME read of `kind` on purpose: an editor never changes which kind it shows,
	// so the persisted collapse state is looked up once at mount
	// svelte-ignore state_referenced_locally
	let open = $state(LS?.getItem('graphTree:' + kind) !== 'false');
	function toggle() {
		open = !open;
		LS?.setItem('graphTree:' + kind, String(open));
	}

	// ---- the resize grip, the animation clip list's shape exactly ---------------
	// That list's cap used to be a FLAT 360px with no relation to its pane, so on a short
	// dock the grip was pushed clean off the bottom of the window with no way back. So the
	// ceiling is derived from the MEASURED column, less the room the palette below needs
	// (a group header plus a few entries), and the floor keeps the grip grabbable.
	const TREE_RESERVE = 132;
	// svelte-ignore state_referenced_locally
	let treeH = $state(parseInt(LS?.getItem('graphTree:h:' + kind) ?? '120') || 120);
	let resizing = $state(false);
	const treeMax = $derived(Math.max(56, (paneHeight || 320) - TREE_RESERVE));
	// re-clamp whenever the pane SHRINKS (dock resize, window resize, undock, or a stored
	// height from a taller pane): a height that was legal before must not strand the grip
	$effect(() => {
		const max = treeMax;
		if (treeH > max) treeH = max;
	});
	function startResize(/** @type {any} */ e) {
		resizing = true;
		e.currentTarget.setPointerCapture(e.pointerId);
		e.preventDefault();
	}
	function doResize(/** @type {any} */ e) {
		if (!resizing) return;
		treeH = Math.min(Math.max(56, treeH + e.movementY), treeMax);
	}
	function endResize(/** @type {any} */ e) {
		if (!resizing) return;
		resizing = false;
		e.currentTarget.releasePointerCapture?.(e.pointerId);
		LS?.setItem('graphTree:h:' + kind, String(treeH));
	}

	// $objectsGroup is READ here on purpose: a derived that only watched `documents`
	// would keep a deleted object's name forever (the THREE-trees-are-not-reactive rule)
	const rows = $derived(
		Object.keys(documents ?? {})
			.filter((key) => key !== sceneKey)
			.map((uuid) => {
				const object = $objectsGroup?.getObjectByProperty('uuid', uuid);
				return {
					uuid,
					name: object?.name || object?.type || 'Object',
					// an ORPHAN: the document outlives its object until the next save prunes
					// it, so say so rather than pretending it is navigable
					missing: !object,
					nodes: (documents?.[uuid]?.nodes ?? []).length
				};
			})
			.sort((a, b) => a.name.localeCompare(b.name))
	);

	const sceneNodes = $derived((documents?.[sceneKey]?.nodes ?? []).length);
	const sceneActive = $derived(($selectedObjects?.length ?? 0) !== 1);
	/** @param {string} uuid */
	const isActive = (uuid) => $selectedObjects?.length === 1 && $selectedObjects[0] === uuid;
</script>

<div class="gt-wrap" id={'graph-tree-' + kind}>
	<button class="gt-head" onclick={toggle} aria-expanded={open}>
		{#if open}
			<ChevronDown size={12} aria-hidden="true" />
		{:else}
			<ChevronRight size={12} aria-hidden="true" />
		{/if}
		<span class="flex-1 text-left">{label}</span>
		<span class="gt-count">{rows.length + (sceneNodes ? 1 : 0)}</span>
	</button>
	{#if open}
		<div class="gt-body" role="tree" aria-label={label} style="max-height: {treeH}px">
			<!-- Scene is ALWAYS the root, whether or not it owns a document: it is where a
			     deselect takes you, so it must be reachable even when empty -->
			<button
				class="gt-row gt-root"
				class:gt-active={sceneActive}
				id={'graph-tree-' + kind + '-scene'}
				onclick={() => deselectObject()}
				title="The scene-wide graph — deselect everything"
			>
				<span class="gt-ico"><Waypoints size={12} aria-hidden="true" /></span>
				<span class="flex-1 truncate text-left">Scene</span>
				{#if sceneNodes}<span class="gt-count">{sceneNodes}</span>{/if}
			</button>
			{#each rows as row (row.uuid)}
				<button
					class="gt-row gt-child"
					class:gt-active={isActive(row.uuid)}
					class:gt-missing={row.missing}
					onclick={() => !row.missing && applySelectionSet([row.uuid])}
					disabled={row.missing}
					title={row.missing
						? row.name + ' — the object is gone; the graph is dropped on the next save'
						: 'Edit ' + row.name + "'s own graph"}
				>
					<span class="flex-1 truncate text-left">{row.name}</span>
					<span class="gt-count">{row.nodes}</span>
				</button>
			{/each}
			{#if !rows.length}
				<p class="gt-empty">
					{kind === 'shader'
						? 'No object has its own shader yet — select one and create it.'
						: 'No object has its own flow yet.'}
				</p>
			{/if}
		</div>
		<!-- drag to give the tree more (or less) room, the animation clip list's grip -->
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			id={'graph-tree-' + kind + '-resize'}
			class="gt-grip"
			class:gt-grip-on={resizing}
			style="touch-action: none"
			title="Drag to resize the list"
			onpointerdown={startResize}
			onpointermove={doResize}
			onpointerup={endResize}
		></div>
	{/if}
</div>

<style>
	.gt-wrap {
		border-bottom: 1px solid rgb(75 85 99 / 0.5);
		flex: 0 0 auto;
	}
	.gt-head {
		display: flex;
		align-items: center;
		gap: 4px;
		width: 100%;
		padding: 4px 6px;
		font-size: 10px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: rgb(156 163 175);
	}
	.gt-head:hover {
		color: rgb(229 231 235);
	}
	.gt-body {
		/* bounded by the grip's height (inline), so a scene with fifty flows can never
		   push the palette off the pane */
		overflow-y: auto;
	}
	.gt-grip {
		height: 6px;
		cursor: ns-resize;
		border-top: 1px solid rgb(75 85 99 / 0.6);
		background: rgb(31 41 55 / 0.4);
	}
	.gt-grip:hover,
	.gt-grip-on {
		background: var(--accent, rgb(29 78 216 / 0.4));
	}
	.gt-row {
		display: flex;
		align-items: center;
		gap: 4px;
		width: 100%;
		padding: 2px 6px;
		font-size: 11px;
		color: rgb(209 213 219);
		min-width: 0;
	}
	.gt-row:hover:not(:disabled) {
		background: rgb(55 65 81 / 0.7);
	}
	.gt-child {
		padding-left: 20px;
	}
	.gt-active {
		background: rgb(37 99 235 / 0.25);
		color: #fff;
	}
	.gt-missing {
		opacity: 0.45;
		font-style: italic;
	}
	.gt-ico {
		display: inline-flex;
		color: rgb(156 163 175);
	}
	.gt-count {
		font-size: 9px;
		color: rgb(107 114 128);
		font-variant-numeric: tabular-nums;
	}
	.gt-empty {
		padding: 4px 8px 6px 20px;
		font-size: 10px;
		color: rgb(107 114 128);
	}
</style>
