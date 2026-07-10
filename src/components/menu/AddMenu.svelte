<script>
	// Add-object SEARCH popover (phase 77): opened from the viewport menu's
	// 🔍 entry or Shift+A. Results are Category · Label over the full catalog;
	// Enter/click spawns at the menu's ground point and replicates.
	import { addMenu } from '../../stores/appStore.js';
	import { primitivesCatalog } from '$lib/primitivesCatalog';
	import { spawnAtPoint } from '$lib/addObjects';

	let query = $state('');
	let selectedIndex = $state(0);
	/** @type {any} */
	let inputEl = $state(null);

	function close() {
		addMenu.set(null);
		query = '';
		selectedIndex = 0;
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
		} else if (event.key === 'ArrowUp') {
			event.preventDefault();
			selectedIndex = Math.max(selectedIndex - 1, 0);
		}
	}
</script>

{#if $addMenu}
	<div class="fixed inset-0" style="z-index: 999" role="presentation" onclick={close} oncontextmenu={(e) => { e.preventDefault(); close(); }}></div>
	<div
		id="add-search-box"
		class="fixed w-64 rounded-lg border border-gray-600 bg-gray-800 p-1.5 text-xs text-gray-200 shadow-xl"
		style="left: {Math.min($addMenu.x, window.innerWidth - 270)}px; top: {Math.min($addMenu.y, window.innerHeight - 320)}px; z-index: 1000;"
	>
		<input
			id="add-search-input"
			bind:this={inputEl}
			type="text"
			class="ui-input w-full"
			placeholder="Search objects…"
			value={query}
			oninput={(e) => { query = e.currentTarget.value; selectedIndex = 0; }}
			onkeydown={onSearchKeydown}
		/>
		<div class="mt-1 max-h-64 overflow-y-auto">
			{#each results as entry, index (entry.command)}
				<button
					class={'flex w-full items-baseline gap-2 rounded px-2 py-1 text-left ' +
						(index === selectedIndex ? 'bg-primary-700 text-white' : 'hover:bg-gray-700')}
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
