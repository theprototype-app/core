<script>
	// Add-object SEARCH popover (phase 77): opened from the viewport menu's
	// 🔍 entry or Shift+A. Results are Category · Label over the full catalog;
	// Enter/click spawns at the menu's ground point and replicates.
	import { untrack } from 'svelte';
	import { addMenu } from '../../stores/appStore.js';
	import { primitivesCatalog } from '$lib/primitivesCatalog';
	import { spawnAtPoint } from '$lib/addObjects';
	import { rightDragMove, inputContextMenu } from '$lib/searchMenuUx';

	let query = $state('');
	let selectedIndex = $state(0);
	/** @type {any} */
	let inputEl = $state(null);
	/** @type {any} */
	let boxEl = $state(null);
	let pos = $state({ left: 0, top: 0 });

	// Placement: the popover is anchored to the point that opened it (the cursor for
	// Shift+A / the viewport menu). It opens below-right, FLIPS to the other side of
	// the anchor when there is no room, and is then clamped so it can never hang off
	// the viewport even partially. The size is MEASURED rather than assumed — the box
	// grows and shrinks with the results list, so the old hardcoded 270x320 guess both
	// pushed a short box up needlessly and let a tall one overflow.
	const MARGIN = 8;
	const GAP = 8;
	// plain let, not $state: only place()/onDragMove read it, both untracked — keeping
	// it out of the reactive graph removes one more way to feed an update loop
	let dragged = false;

	/**
	 * Pin a position so no edge of the box leaves the viewport.
	 * @param {number} left @param {number} top
	 */
	function clampTo(left, top) {
		const w = boxEl?.offsetWidth || 256;
		const h = boxEl?.offsetHeight || 320;
		return {
			left: Math.max(MARGIN, Math.min(left, Math.max(MARGIN, window.innerWidth - w - MARGIN))),
			top: Math.max(MARGIN, Math.min(top, Math.max(MARGIN, window.innerHeight - h - MARGIN)))
		};
	}

	function place() {
		const menu = $addMenu;
		if (!menu || !boxEl) return;
		// a box the user moved deliberately stays put — just keep it on-screen
		if (dragged) {
			pos = clampTo(pos.left, pos.top);
			return;
		}
		const w = boxEl.offsetWidth || 256;
		const h = boxEl.offsetHeight || 320;
		let left = menu.x + GAP;
		if (left + w > window.innerWidth - MARGIN) left = menu.x - w - GAP; // flip left
		let top = menu.y + GAP;
		if (top + h > window.innerHeight - MARGIN) top = menu.y - h - GAP; // flip above
		pos = clampTo(left, top);
	}

	/**
	 * Right-drag: own the position here so it survives the re-place on resize.
	 * @param {number} dx @param {number} dy
	 */
	function onDragMove(dx, dy) {
		dragged = true;
		pos = clampTo(pos.left + dx, pos.top + dy);
	}

	// Re-place on open, and keep it on-screen as the box resizes (typing filters the
	// list, so its height changes) or the window does.
	//
	// place() is called through untrack(): it READS pos/dragged and WRITES pos, so a
	// tracked call would make this effect depend on what its own ResizeObserver
	// writes — an update loop that trips effect_update_depth_exceeded and kills the
	// component's reactivity (positioning then freezes). The effect must depend on
	// the OPEN state and the element only.
	$effect(() => {
		const open = !!$addMenu;
		const el = boxEl;
		if (!open || !el) return;
		untrack(() => place());
		const observer = new ResizeObserver(() => untrack(() => place()));
		observer.observe(el);
		return () => observer.disconnect();
	});

	function close() {
		addMenu.set(null);
		query = '';
		selectedIndex = 0;
		dragged = false; // the next open re-anchors to wherever it is invoked from
	}

	/** @param {string} command */
	function spawn(command) {
		const menu = $addMenu;
		spawnAtPoint(command, menu?.point ?? null);
		close();
	}

	// focus the input whenever the popover opens
	$effect(() => {
		if ($addMenu) setTimeout(() => inputEl?.focus(), 0);
	});

	const entries = primitivesCatalog.flatMap((group) =>
		group.items.map((item) => ({ ...item, group: group.group }))
	);
	const results = $derived.by(() => {
		const q = query.trim().toLowerCase();
		if (!q) return entries;
		const starts = entries.filter((e) => e.label.toLowerCase().startsWith(q));
		const contains = entries.filter(
			(e) => !e.label.toLowerCase().startsWith(q) && e.label.toLowerCase().includes(q)
		);
		return [...starts, ...contains];
	});

	/** @param {any} event */
	function onSearchKeydown(event) {
		if (event.key === 'Escape') {
			event.stopPropagation();
			close();
		} else if (event.key === 'Enter' && results[selectedIndex]) {
			spawn(results[selectedIndex].command);
		} else if (event.key === 'ArrowDown') {
			event.preventDefault();
			selectedIndex = Math.min(selectedIndex + 1, results.length - 1);
			scrollSelectedIntoView();
		} else if (event.key === 'ArrowUp') {
			event.preventDefault();
			selectedIndex = Math.max(selectedIndex - 1, 0);
			scrollSelectedIntoView();
		}
	}

	function scrollSelectedIntoView() {
		requestAnimationFrame(() =>
			document
				.querySelector('#add-search-box [data-selected="true"]')
				?.scrollIntoView({ block: 'nearest' })
		);
	}
</script>

<!-- top level: svelte:window cannot live inside a block. place() no-ops when closed. -->
<svelte:window onresize={place} />

{#if $addMenu}
	<div class="fixed inset-0" style="z-index: 999" role="presentation" onclick={close} oncontextmenu={(e) => { e.preventDefault(); close(); }}></div>
	<div
		id="add-search-box"
		bind:this={boxEl}
		class="fixed w-64 rounded-lg border border-gray-600 bg-gray-800 p-1.5 text-xs text-gray-200 shadow-xl"
		style="left: {pos.left}px; top: {pos.top}px; z-index: 1000;"
		use:rightDragMove={{ onMove: onDragMove }}
	>
		<input
			id="add-search-input"
			bind:this={inputEl}
			type="text"
			class="ui-input w-full"
			placeholder="Search objects…"
			value={query}
			use:inputContextMenu
			oninput={(e) => { query = e.currentTarget.value; selectedIndex = 0; }}
			onkeydown={onSearchKeydown}
		/>
		<div class="mt-1 max-h-64 overflow-y-auto">
			{#each results as entry, index (entry.command)}
				<button
					class={'flex w-full items-baseline gap-2 rounded-sm px-2 py-1 text-left ' +
						(index === selectedIndex ? 'bg-primary-700 text-white' : 'hover:bg-gray-700')}
					data-selected={index === selectedIndex}
					onmouseenter={() => (selectedIndex = index)}
					onclick={() => spawn(entry.command)}
				>
					<span class="text-[10px] uppercase tracking-wider text-gray-400">{entry.group}</span>
					<span>{entry.label}</span>
				</button>
			{/each}
			{#if !results.length}
				<p class="px-2 py-1 italic text-gray-400">No matches for “{query}”</p>
			{/if}
		</div>
	</div>
{/if}
