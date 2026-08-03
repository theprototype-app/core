<script lang="ts">
	import { createEventDispatcher } from 'svelte';
	import ContextMenuItems from './ContextMenuItems.svelte';
	import Icon from './ui/Icon.svelte';

	// Generic context menu. items: [{ label, action?, disabled?, tooltip?, danger?,
	// icon?, hint?, children?: items[] } | { section } | { header }]
	// Submenus (any depth) open on hover, marked with ▸. Flips up/left near screen edges.
	// 15-Q: menus with many actions grow a TYPE-TO-FILTER row — typing flattens every
	// leaf action (path-prefixed, command-palette style) and Enter runs the top hit.
	export let x: number;
	export let y: number;
	export let items: any[] = [];

	const dispatch = createEventDispatcher();

	// The menu positions via left/top only — NO transform (a transform makes it the
	// containing block for its position:fixed submenus, which mis-placed them, 124).
	// It's portaled to <body>, measured + clamped into the viewport by `place`, and
	// caps + scrolls vertically when too tall; submenus place themselves.

	function run(item: any) {
		if (item.disabled || item.children || item.section || item.header) return;
		item.action?.();
		dispatch('close');
	}

	// ---- 15-Q type-to-filter -------------------------------------------------
	let query = '';

	/** every runnable LEAF with its submenu path, for the flattened filter view */
	function collectLeaves(list: any[], path: string[] = [], out: any[] = []) {
		for (const item of list ?? []) {
			if (!item || item.section || item.header) continue;
			if (item.children) collectLeaves(item.children, [...path, item.label], out);
			else if (item.label) out.push({ item, path });
		}
		return out;
	}
	// the header strip (what this menu acts on) leads the menu, ABOVE the filter
	$: headerItem = items[0]?.header ? items[0] : null;
	$: bodyItems = headerItem ? items.slice(1) : items;
	$: leaves = collectLeaves(items);
	// the filter row earns its space only on dense menus (the object + viewport
	// menus); tiny menus (node cards, explorer rows) stay as they were
	$: filterable = leaves.length >= 8;
	$: matches = query
		? leaves.filter(({ item, path }) =>
				[...path, item.label].join(' ').toLowerCase().includes(query.toLowerCase())
			)
		: [];

	function onFilterKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter') {
			const first = matches.find((m) => !m.item.disabled);
			if (first) run(first.item);
			e.preventDefault();
		} else if (e.key === 'Escape') {
			// Esc clears the query first; a second Esc closes the menu
			if (query) query = '';
			else dispatch('close');
			e.preventDefault();
			e.stopPropagation();
		}
	}
	function focusInput(node: HTMLInputElement) {
		// focus without scrolling the page; typing lands here immediately, and the
		// input-focus guards keep global shortcuts quiet while the menu is open.
		// Deferred one frame: the PARENT's use:portal moves the menu into <body>
		// AFTER this child action runs, and moving a focused element blurs it.
		const id = requestAnimationFrame(() => node.focus({ preventScroll: true }));
		return { destroy: () => cancelAnimationFrame(id) };
	}

	// Portal to <body> so the menu escapes any z-indexed/stacking-context ancestor
	// (e.g. the Flow editor's docked/floating window) and its z-index:1000 ranks
	// above other windows instead of being trapped at the host window's z-tier.
	function portal(node: HTMLElement) {
		document.body.appendChild(node);
		return { destroy: () => node.remove() };
	}

	// Position by MEASURING the menu (no width/height guess): open from the click,
	// but clamp fully into the viewport so it never runs off any edge on a narrow
	// screen; too-tall menus cap + scroll (.ctx-scroll). Submenus place themselves.
	function place(node: HTMLElement) {
		const reposition = () => {
			const vw = window.innerWidth;
			const vh = window.innerHeight;
			node.style.maxHeight = vh - 8 + 'px';
			const w = node.offsetWidth;
			const h = node.offsetHeight;
			let left = x > vw - w - 4 ? x - w : x; // near the right edge -> open leftward
			left = Math.max(4, Math.min(left, vw - w - 4));
			let top = y > vh - h - 4 ? y - h : y;
			top = Math.max(4, Math.min(top, vh - h - 4));
			node.style.left = left + 'px';
			node.style.top = top + 'px';
			node.style.right = 'auto';
			node.style.bottom = 'auto';
		};
		reposition();
		requestAnimationFrame(reposition);
		window.addEventListener('resize', reposition);
		return { destroy: () => window.removeEventListener('resize', reposition) };
	}
</script>

<!-- backdrop to catch outside clicks -->
<div
	use:portal
	class="fixed inset-0"
	style="z-index: var(--z-menu);"
	role="presentation"
	on:click={() => dispatch('close')}
	on:contextmenu|preventDefault={() => dispatch('close')}
></div>

<div
	use:portal
	use:place
	class="ctx-scroll fixed min-w-36 overflow-y-auto overflow-x-hidden rounded-lg border border-gray-200 bg-white py-1 text-xs shadow-lg dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200"
	style="left: 0; top: 0; z-index: calc(var(--z-menu) + 1);"
	role="menu"
>
	{#if headerItem}
		<ContextMenuItems items={[headerItem]} onrun={run} />
	{/if}
	{#if filterable}
		<div class="ctx-filter" role="presentation">
			<Icon name="search" size={12} />
			<input
				class="ctx-filter-input"
				type="text"
				placeholder="Type to filter…"
				aria-label="Filter menu actions"
				bind:value={query}
				use:focusInput
				on:keydown={onFilterKeydown}
				on:click|stopPropagation
			/>
		</div>
	{/if}
	{#if query}
		<!-- flattened command-palette view: every matching leaf, path-prefixed -->
		{#each matches as match, index}
			<!-- pointer-driven like every other menu row (the filter input owns the
			     keyboard: Enter runs the top hit) -->
			<!-- svelte-ignore a11y_interactive_supports_focus, a11y_click_events_have_key_events -->
			<div
				class="ctx-match {match.item.disabled
					? 'cursor-default text-gray-400 dark:text-gray-500'
					: 'cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-600'} {match.item.danger && !match.item.disabled ? 'text-red-500' : ''}"
				class:ctx-match-first={index === 0 && !match.item.disabled}
				role="menuitem"
				title={match.item.tooltip ?? ''}
				on:click={() => run(match.item)}
			>
				{#if match.path.length}
					<span class="ctx-match-path">{match.path.join(' ▸ ')} ▸ </span>
				{/if}{match.item.label}
				{#if match.item.hint}<span class="ctx-hint-inline">{match.item.hint}</span>{/if}
			</div>
		{/each}
		{#if !matches.length}
			<div class="px-3 py-2 text-[11px] italic text-gray-400" role="presentation">No matching action</div>
		{/if}
	{:else}
		<ContextMenuItems items={bodyItems} onrun={run} />
	{/if}
</div>

<style>
	/* a slim but VISIBLE vertical scrollbar for a too-tall menu/submenu */
	:global(.ctx-scroll) {
		scrollbar-width: thin;
	}
	:global(.ctx-scroll::-webkit-scrollbar) {
		width: 8px;
	}
	:global(.ctx-scroll::-webkit-scrollbar-thumb) {
		background: rgb(148 163 184 / 0.7);
		border-radius: 4px;
	}
	:global(.ctx-scroll::-webkit-scrollbar-track) {
		background: transparent;
	}
	/* 15-Q type-to-filter row */
	.ctx-filter {
		display: flex;
		align-items: center;
		gap: 6px;
		margin: 2px 6px 4px;
		padding: 3px 6px;
		border-radius: 6px;
		background: rgb(148 163 184 / 0.12);
		color: rgb(148 163 184);
	}
	.ctx-filter:focus-within {
		background: rgb(148 163 184 / 0.2);
	}
	.ctx-filter-input {
		flex: 1 1 auto;
		min-width: 0;
		width: 130px;
		background: transparent;
		border: 0;
		font-size: 11px;
		color: inherit;
	}
	/* the app's global input styling paints a heavy focus ring — the tinted
	   wrapper (focus-within above) is the affordance here */
	.ctx-filter-input,
	.ctx-filter-input:focus {
		outline: none !important;
		box-shadow: none !important;
	}
	.ctx-match {
		padding: 5px 12px;
		white-space: nowrap;
	}
	.ctx-match-first {
		background: rgb(148 163 184 / 0.12);
	}
	.ctx-match-path {
		color: rgb(148 163 184 / 0.85);
	}
	.ctx-hint-inline {
		margin-left: 10px;
		font-family: ui-monospace, monospace;
		font-size: 10px;
		color: rgb(148 163 184 / 0.8);
	}
</style>
