<script>
	// Viewport object SEARCH (125): opened from the viewport menu's "Search
	// objects…" entry (opt-in). Lists the scene's top-level objects with a type
	// icon + lock chip, type-to-filter; Enter/click selects and flies the
	// camera to it. Mirrors the Add search swap-box.
	import { objectSearch } from '../../stores/appStore.js';
	import { objectsGroup, lockedObjects } from '../../stores/sceneStore.js';
	import { selectObject, focusObject } from '$lib/objectActions';
	import { nameOf } from '$lib/lockControl';
	import { rightDragMove, inputContextMenu } from '$lib/searchMenuUx';

	let query = $state('');
	let selectedIndex = $state(0);
	/** @type {any} */
	let inputEl = $state(null);

	function close() {
		objectSearch.set(null);
		query = '';
		selectedIndex = 0;
	}

	/** @param {any} child */
	function pick(child) {
		selectObject(child.uuid);
		focusObject(child.uuid);
		close();
	}

	$effect(() => {
		if ($objectSearch) setTimeout(() => inputEl?.focus(), 0);
	});

	const TYPE_ICONS = /** @type {Record<string, string>} */ ({ Mesh: '▣', Group: '⧉', Line: '✎' });
	/** @param {any} child */
	function iconFor(child) {
		if (child.type?.endsWith('Light')) return '☀';
		return TYPE_ICONS[child.type] ?? '▪';
	}

	const results = $derived.by(() => {
		const children = /** @type {any} */ ($objectsGroup)?.children ?? [];
		const q = query.trim().toLowerCase();
		const named = children.map((/** @type {any} */ c) => ({
			child: c,
			label: c.name || c.type,
			lock: $lockedObjects.find((/** @type {any} */ l) => l[1] === c.uuid)?.[0] ?? null
		}));
		if (!q) return named;
		return named.filter((/** @type {any} */ e) => e.label.toLowerCase().includes(q));
	});

	/** @param {any} event */
	function onKeydown(event) {
		if (event.key === 'Escape') {
			event.stopPropagation();
			close();
		} else if (event.key === 'Enter' && results[selectedIndex]) {
			pick(results[selectedIndex].child);
		} else if (event.key === 'ArrowDown') {
			event.preventDefault();
			selectedIndex = Math.min(selectedIndex + 1, results.length - 1);
		} else if (event.key === 'ArrowUp') {
			event.preventDefault();
			selectedIndex = Math.max(selectedIndex - 1, 0);
		}
	}
</script>

{#if $objectSearch}
	<div class="fixed inset-0" style="z-index: 999" role="presentation" onclick={close} oncontextmenu={(e) => { e.preventDefault(); close(); }}></div>
	<div
		id="object-search-box"
		class="fixed w-64 rounded-lg border border-gray-600 bg-gray-800 p-1.5 text-xs text-gray-200 shadow-xl"
		style="left: {Math.min($objectSearch.x, window.innerWidth - 270)}px; top: {Math.min($objectSearch.y, window.innerHeight - 320)}px; z-index: 1000;"
		use:rightDragMove
	>
		<input
			id="object-search-input"
			bind:this={inputEl}
			type="text"
			class="ui-input w-full"
			placeholder="Search scene objects…"
			value={query}
			use:inputContextMenu
			oninput={(/** @type {any} */ e) => { query = e.currentTarget.value; selectedIndex = 0; }}
			onkeydown={onKeydown}
		/>
		<div class="mt-1 max-h-64 overflow-y-auto">
			{#each results as entry, index (entry.child.uuid)}
				<button
					class={'flex w-full items-baseline gap-2 rounded px-2 py-1 text-left ' +
						(index === selectedIndex ? 'bg-primary-700 text-white' : 'hover:bg-gray-700')}
					data-selected={index === selectedIndex}
					onmouseenter={() => (selectedIndex = index)}
					onclick={() => pick(entry.child)}
				>
					<span class="text-gray-400">{iconFor(entry.child)}</span>
					<span class="flex-1 truncate {entry.lock ? 'text-red-300' : ''}">{entry.label}</span>
					{#if entry.lock}<span class="text-[9px] text-red-300">{nameOf(entry.lock)}</span>{/if}
				</button>
			{/each}
			{#if !results.length}
				<p class="px-2 py-1 italic text-gray-400">No objects match “{query}”</p>
			{/if}
		</div>
	</div>
{/if}
