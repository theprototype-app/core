<script lang="ts">
	import { createEventDispatcher } from 'svelte';
	import ContextMenuItems from './ContextMenuItems.svelte';
	import Icon from './ui/Icon.svelte';
	import { collectLeaves, rankMatches } from '$lib/menuFilter';
	import { autofocusOk, typeToFocus } from '$lib/inputDevice';

	// Generic context menu. items: [{ label, action?, disabled?, tooltip?, danger?,
	// icon?, hint?, checked?, children?: items[] } | { section } | { header }]
	// Submenus (any depth) open on hover, marked with ▸. Flips up/left near screen edges.
	//
	// 15-Q: dense menus grew a TYPE-TO-FILTER row (flattened command-palette matches).
	// 16-P1: the filter INPUT is now always mounted and focused, but COLLAPSED until
	// you type — so no menu shows an empty search box, app shortcuts stay swallowed
	// while a menu is open (the input owns the keyboard), and every menu supports
	// ↑/↓ navigation + Enter. ←/→ are left to the textbox caret; with an EMPTY box
	// they double as open/close-submenu (there is no caret to move).
	export let x: number;
	export let y: number;
	export let items: any[] = [];
	/** 16-Q6: which menu this is, so the search list REMEMBERS the height you drag
	 *  it to — per kind ('viewport', 'nodes', 'object'…), persisted locally. */
	export let sizeKey: string = 'menu';

	const dispatch = createEventDispatcher();

	// The menu positions via left/top only — NO transform (a transform makes it the
	// containing block for its position:fixed submenus, which mis-placed them, 124).
	// It's portaled to <body>, measured + clamped into the viewport by `place`, and
	// caps + scrolls vertically when too tall; submenus place themselves.

	function run(item: any) {
		if (!item || item.disabled || item.children || item.section || item.header) return;
		// 16-P2: `revealFilter` rows (the node editor's "Search nodes…") just show the
		// filter row — the menu STAYS open and the input keeps the keyboard
		if (item.revealFilter) {
			searchMode = true;
			highlight = -1;
			inputEl?.focus({ preventScroll: true });
			return;
		}
		item.action?.();
		dispatch('close');
	}

	let query = '';
	/** 16-P7: search MODE is sticky — clearing the query keeps the flat list (now
	 *  showing everything) instead of snapping back to the grouped menu; only Esc
	 *  leaves search. Entered by typing or by a `revealFilter` row. */
	let searchMode = false;
	/** the cursor position we left behind on each level, keyed by its path — so
	 *  stepping OUT of a submenu lands back on the row you came from */
	let levelHighlight: Record<string, number> = {};
	/** labels of the submenu chain currently RENDERED open */
	let openPath: string[] = [];
	/** level the keyboard cursor sits on — usually === openPath, but a pointer
	 *  grazing a sibling row moves the cursor while the open submenu lingers for
	 *  its 150ms close intent (that delay is what lets you reach a submenu
	 *  diagonally without it slamming shut) */
	let navPath: string[] = [];
	/** highlighted row at navPath's level; -1 = nothing yet */
	let highlight = -1;
	/** how many rows the empty-query browse list shows (it scrolls) */
	const BROWSE_CAP = 200;
	/** 16-Q5: default height of the SEARCH list. A menu that unfolds down the whole
	 *  screen is unusable, so the list gets a sensible box you can resize from the
	 *  corner grip. */
	const SEARCH_HEIGHT = 360;
	const MIN_LIST_HEIGHT = 140;
	/** the top edge chosen when the menu OPENED — searching keeps it */
	let placedTop: number | null = null;
	const heightStore = () => `ctx:searchHeight:${sizeKey}`;
	/** @param {number} value */
	function rememberHeight(value: number) {
		try {
			localStorage.setItem(heightStore(), String(Math.round(value)));
		} catch {}
	}
	function storedHeight(): number | null {
		try {
			const raw = parseInt(localStorage.getItem(heightStore()) ?? "", 10);
			return Number.isFinite(raw) && raw >= MIN_LIST_HEIGHT ? raw : null;
		} catch {
			return null;
		}
	}
	/** user height for the search list, dragged from the corner grip */
	// svelte-ignore state_referenced_locally
	let searchHeight: number | null = storedHeight();
	/** lets the grip re-run the placement after changing `searchHeight` */
	let repositionMenu: () => void = () => {};
	let inputEl: HTMLInputElement | null = null;

	// the header strip (what this menu acts on) leads the menu, ABOVE the filter
	$: headerItem = items[0]?.header ? items[0] : null;
	$: bodyItems = headerItem ? items.slice(1) : items;
	$: leaves = collectLeaves(items);
	/** With a query: ranked matches. In search mode WITHOUT one: every action, so
	 *  the box doubles as a full browse list (the node editor's old search box did
	 *  this, and clearing the query should not throw you out of it). */
	$: matches = query ? rankMatches(leaves, query) : searchMode ? leaves.slice(0, BROWSE_CAP) : [];
	/** flat list instead of the grouped tree? */
	$: listMode = searchMode || !!query;

	/** the item list at a submenu path @param {any[]} list @param {string[]} path */
	function levelItems(list: any[], path: string[]) {
		let current = list;
		for (const label of path) {
			const parent = current?.find((item: any) => item?.label === label && item.children);
			if (!parent) return current ?? [];
			current = parent.children;
		}
		return current ?? [];
	}
	const selectable = (list: any[]) => (list ?? []).filter((item) => item && !item.section && !item.header);
	/** rows the keyboard walks: the flat list while searching, else the cursor's level */
	$: navRows = listMode ? matches.map((entry) => entry.item) : selectable(levelItems(bodyItems, navPath));
	$: if (highlight >= navRows.length) highlight = navRows.length - 1;

	function scrollNavIntoView() {
		requestAnimationFrame(() =>
			document.querySelector('[data-ctx-active="true"]')?.scrollIntoView({ block: 'nearest' })
		);
	}

	/** move the highlight, skipping disabled rows @param {number} delta */
	function move(delta: number) {
		if (!navRows.length) return;
		let next = highlight;
		for (let step = 0; step < navRows.length; step++) {
			next =
				next < 0
					? delta > 0
						? 0
						: navRows.length - 1
					: (next + delta + navRows.length) % navRows.length;
			if (!navRows[next]?.disabled) break;
		}
		highlight = next;
		scrollNavIntoView();
	}

	const levelKey = (path: string[]) => path.join('|');

	/** @param {any} item */
	function openChildrenOf(item: any) {
		if (!item?.children) return false;
		levelHighlight[levelKey(navPath)] = highlight; // remember where we were
		navPath = [...navPath, item.label];
		openPath = navPath;
		const remembered = levelHighlight[levelKey(navPath)];
		highlight = remembered ?? -1;
		if (highlight < 0) move(1);
		return true;
	}

	function activate() {
		// Enter with no explicit highlight runs the top hit (15-Q behavior)
		const item = navRows[highlight] ?? (query ? navRows.find((entry) => !entry.disabled) : null);
		if (!item || item.disabled) return;
		if (openChildrenOf(item)) return;
		run(item);
	}

	function back() {
		if (!navPath.length) return false;
		// leaving a submenu forgets ITS cursor but restores the parent's (Q1: it used
		// to reset to the top row every time)
		delete levelHighlight[levelKey(navPath)];
		navPath = navPath.slice(0, -1);
		openPath = navPath;
		highlight = levelHighlight[levelKey(navPath)] ?? -1;
		return true;
	}

	function onFilterKeydown(event: KeyboardEvent) {
		if (event.key === 'ArrowDown') {
			move(1);
			event.preventDefault();
		} else if (event.key === 'ArrowUp') {
			move(-1);
			event.preventDefault();
		} else if (event.key === 'Enter') {
			activate();
			event.preventDefault();
		} else if (event.key === 'Escape') {
			// Esc unwinds one step at a time: query → search mode → open submenu →
			// the menu itself. (Clearing the query by BACKSPACE deliberately stays in
			// search mode showing everything — only Esc goes back to the menu.)
			if (query) {
				query = '';
				highlight = 0;
			} else if (searchMode) {
				searchMode = false;
				highlight = -1;
			} else if (!back()) {
				dispatch('close');
			}
			event.preventDefault();
			event.stopPropagation();
		} else if (!query && event.key === 'ArrowRight') {
			openChildrenOf(navRows[highlight]);
			event.preventDefault();
		} else if (!query && event.key === 'ArrowLeft') {
			back();
			event.preventDefault();
		}
	}

	function onFilterInput(event: Event) {
		query = (event.currentTarget as HTMLInputElement).value;
		// typing enters search mode; DELETING the text keeps you there (the list simply
		// widens to every action) — only Esc returns to the grouped menu
		if (query) searchMode = true;
		// filtering resets the walk to the top hit so Enter is predictable
		openPath = [];
		navPath = [];
		highlight = 0;
	}

	function focusInput(node: HTMLInputElement) {
		// focus without scrolling the page; typing lands here immediately, and the
		// input-focus guards keep global shortcuts quiet while the menu is open.
		// Deferred one frame: the PARENT's use:portal moves the menu into <body>
		// AFTER this child action runs, and moving a focused element blurs it.
		inputEl = node;
		// TOUCH: never autofocus. It slides the on-screen keyboard over the menu the
		// user just opened, and type-to-filter is not why they long-pressed. The
		// feature is not lost on a touch device that HAS a keyboard: `typeToFocus`
		// hands the first printable key to this field and inserts it, so a tablet with
		// a Bluetooth keyboard behaves exactly like a PC. (The "Search nodes…" row
		// still focuses on demand — that tap IS the request.)
		const stopTypeToFocus = autofocusOk() ? null : typeToFocus(() => inputEl);
		const id = autofocusOk()
			? requestAnimationFrame(() => node.focus({ preventScroll: true }))
			: 0;
		return {
			destroy: () => {
				if (id) cancelAnimationFrame(id);
				stopTypeToFocus?.();
			}
		};
	}

	// Clicking a row must NOT steal focus from the (invisible) filter input —
	// opening a submenu by click would otherwise hand the keyboard back to the
	// app's global shortcuts. Preventing mousedown's default keeps focus put and
	// still lets the click through.
	function keepFocus(event: MouseEvent) {
		if (event.target !== inputEl) event.preventDefault();
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
		let lastW = -1;
		let lastH = -1;
		const reposition = () => {
			const vw = window.innerWidth;
			const vh = window.innerHeight;
			// measure the NATURAL height first (uncapped) — every decision needs it
			node.style.maxHeight = 'none';
			const w = node.offsetWidth;
			const natural = node.offsetHeight;
			lastW = w;
			node.style.right = 'auto';
			node.style.bottom = 'auto';
			let left = x > vw - w - 4 ? x - w : x; // near the right edge -> open leftward
			node.style.left = Math.max(4, Math.min(left, vw - w - 4)) + 'px';

			if (listMode) {
				// 16-Q5: SEARCHING must not move the menu. Keep the top it opened with
				// and give the list a sensible height (resizable from the corner grip)
				// instead of letting it unfold down the whole screen.
				const top = placedTop ?? Math.max(4, Math.min(y, vh - Math.min(natural, SEARCH_HEIGHT) - 4));
				const room = Math.max(MIN_LIST_HEIGHT, vh - top - 8);
				node.style.top = top + 'px';
				node.style.maxHeight = Math.min(searchHeight ?? SEARCH_HEIGHT, room) + 'px';
				lastH = node.offsetHeight;
				return;
			}

			// Opening: sit AT the cursor and prefer downward. Not enough room below?
			// shift the whole menu UP just far enough that its bottom stays inside,
			// keeping the top as close to the cursor as possible — no flipping, so the
			// menu never jumps to the other side of the pointer. A scrollbar appears
			// only when the content is taller than the window itself.
			const maxH = vh - 8;
			let top = y;
			if (natural > vh - y - 4) top = Math.max(4, vh - natural - 4);
			node.style.top = top + 'px';
			node.style.maxHeight = maxH + 'px';
			placedTop = top;
			lastH = node.offsetHeight;
		};
		repositionMenu = reposition;
		reposition();
		requestAnimationFrame(reposition);
		// 16-P1: the menu RESIZES while it is open now (the filter row reveals, matches
		// replace the item list) — a menu opened near the bottom edge and flipped up
		// would otherwise grow straight off the screen. Re-place on any size change,
		// guarded so the maxHeight write can't loop.
		const observer = new ResizeObserver(() => {
			if (node.offsetWidth === lastW && node.offsetHeight === lastH) return;
			reposition();
		});
		observer.observe(node);
		window.addEventListener('resize', reposition);
		return {
			destroy: () => {
				observer.disconnect();
				window.removeEventListener('resize', reposition);
			}
		};
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

<!-- the menu container takes a mousedown handler only to KEEP focus in the filter
     input (see keepFocus); it is not itself a focus target -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions, a11y_interactive_supports_focus -->
<div
	use:portal
	use:place
	class="ctx-scroll fixed min-w-36 overflow-y-auto overflow-x-hidden rounded-lg border border-gray-200 bg-white py-1 text-xs shadow-lg dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200"
	style="left: 0; top: 0; z-index: calc(var(--z-menu) + 1);"
	role="menu"
	on:mousedown={keepFocus}
>
	{#if headerItem}
		<ContextMenuItems items={[headerItem]} onrun={run} />
	{/if}
	<!-- always mounted (it owns the keyboard) but collapsed until there's a query -->
	<div class="ctx-filter" class:on={listMode} role="presentation">
		<Icon name="search" size={12} />
		<input
			class="ctx-filter-input"
			type="text"
			placeholder="Filter…"
			aria-label="Filter menu actions"
			value={query}
			use:focusInput
			on:input={onFilterInput}
			on:keydown={onFilterKeydown}
			on:click|stopPropagation
		/>
	</div>
	{#if listMode}
		<!-- flattened command-palette view: matches for a query, or EVERY action when
		     the query is empty (the browse list the node search box used to be) -->
		{#each matches as match, index}
			<!-- pointer-driven like every other menu row (the filter input owns the
			     keyboard: ↑/↓ move, Enter runs the highlighted hit) -->
			<!-- svelte-ignore a11y_interactive_supports_focus, a11y_click_events_have_key_events -->
			<div
				class="ctx-match {match.item.disabled
					? 'cursor-default text-gray-400 dark:text-gray-500'
					: 'cursor-pointer'} {match.item.danger && !match.item.disabled ? 'text-red-500' : ''}"
				class:ctx-active={index === highlight}
				data-ctx-active={index === highlight}
				role="menuitem"
				title={match.item.tooltip ?? ''}
				on:mouseenter={() => (highlight = index)}
				on:click={() => run(match.item)}
			>
				{#if match.path.length}
					<span class="ctx-match-path">{match.path.join(' ▸ ')} ▸ </span>
				{/if}{match.item.label}
				{#if match.item.hint}<span class="ctx-hint-inline">{match.item.hint}</span>{/if}
			</div>
		{/each}
		{#if !matches.length}
			<div class="px-3 py-2 text-[11px] italic text-gray-400" role="presentation">
				{query ? 'No matching action' : 'Nothing to search here'}
			</div>
		{/if}
		<!-- 16-Q5: drag to resize the search list (only while searching) -->
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="ctx-grip"
			title="Drag to resize the list"
			on:pointerdown={(event) => {
				const startY = event.clientY;
				const startH = (event.currentTarget as HTMLElement).closest('[role="menu"]')?.clientHeight ?? SEARCH_HEIGHT;
				const move = (moveEvent: PointerEvent) => {
					searchHeight = Math.max(MIN_LIST_HEIGHT, startH + (moveEvent.clientY - startY));
					repositionMenu();
				};
				const up = () => {
					window.removeEventListener('pointermove', move);
					window.removeEventListener('pointerup', up);
					if (searchHeight) rememberHeight(searchHeight); // 16-Q6: keep it next time
				};
				window.addEventListener('pointermove', move);
				window.addEventListener('pointerup', up);
				event.preventDefault();
				event.stopPropagation();
			}}
		></div>
	{:else}
		<ContextMenuItems
			items={bodyItems}
			onrun={run}
			{openPath}
			{navPath}
			{highlight}
			onopen={(next) => {
				// hover-intent opened a submenu (deeper) or closed one (shallower):
				// the keyboard cursor follows into a fresh submenu, and never stays
				// stranded below a level that just closed
				const deeper = next.length > openPath.length;
				openPath = next;
				if (deeper || navPath.length > next.length) {
					navPath = next;
					highlight = -1;
				}
			}}
			onhover={(level, index) => {
				// pointer moves the cursor immediately; the OPEN submenu keeps its
				// close-intent delay (owned by ContextMenuItems)
				navPath = level;
				highlight = index;
			}}
		/>
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
	/* 16-P1: collapsed by default — mounted + focused, but taking no space. NOT
	   display:none / hidden: the input must stay focusable to own the keyboard. */
	.ctx-filter {
		display: flex;
		align-items: center;
		gap: 6px;
		height: 0;
		padding: 0 12px;
		opacity: 0;
		overflow: hidden;
		color: rgb(148 163 184);
	}
	/* typing reveals it as a normal menu ROW (same padding/size as an item) */
	.ctx-filter.on {
		height: auto;
		padding: 5px 12px;
		opacity: 1;
		margin-bottom: 2px;
		background: rgb(148 163 184 / 0.1);
		border-bottom: 1px solid rgb(148 163 184 / 0.25);
	}
	.ctx-filter-input {
		flex: 1 1 auto;
		min-width: 0;
		width: 130px;
		padding: 0;
		background: transparent;
		border: 0;
		font-size: 12px;
		line-height: 1.25;
		color: inherit;
	}
	/* the app's global input styling paints a heavy focus ring — the row's own
	   tint is the affordance here */
	.ctx-filter-input,
	.ctx-filter-input:focus {
		outline: none !important;
		box-shadow: none !important;
	}
	/* 16-Q5: resize grip for the search list — sticks to the bottom-right corner */
	.ctx-grip {
		position: sticky;
		bottom: 0;
		margin-left: auto;
		margin-right: 2px;
		width: 14px;
		height: 14px;
		cursor: ns-resize;
		background: linear-gradient(
			135deg,
			transparent 42%,
			rgb(148 163 184 / 0.55) 42%,
			rgb(148 163 184 / 0.55) 58%,
			transparent 58%
		);
	}
	.ctx-match {
		padding: 5px 12px;
		white-space: nowrap;
	}
	/* ONE highlight for mouse and keyboard (they always agree) */
	.ctx-match.ctx-active {
		background: rgb(148 163 184 / 0.18);
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
