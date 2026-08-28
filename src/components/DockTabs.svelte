<script>
	// Notebook tab strip for the bottom dock. EVERY panel that is docked+open is a tab
	// here — the Flow family (Node editor / Flow Code / Animation / UV editor / Shader
	// editor / HUD editor) and the Explorer alike. Rendered at the top edge of each
	// docked panel; since only the visible panel renders, only one strip shows.
	// Clicking a tab activates it (nothing is closed — the panel that was showing just
	// stops rendering); the "+" opens another view, docked.
	// W2: the strip also carries the dock's own chrome — "–" minimizes the whole dock
	// (every tab stays open, nothing renders, the inset goes to 0) and "✕" closes just
	// the ACTIVE tab, letting visibleDockKey's fallback promote the next one.
	import { dockTabs, bottomDockActive, visibleDockKey, activateDock, dockMinimized } from '$lib/bottomDock';
	import { dockAddItems, closeStoreFor } from '$lib/dockMenu';
	import ContextMenu from './ContextMenu.svelte';

	let addMenu = $state(/** @type {{x:number,y:number}|null} */ (null));
	const addItems = dockAddItems();
	function openAdd(/** @type {MouseEvent} */ e) {
		const r = /** @type {HTMLElement} */ (e.currentTarget).getBoundingClientRect();
		addMenu = { x: r.left, y: r.bottom + 4 };
	}

	/** Close the tab the dock is SHOWING — `visibleDockKey`, not `bottomDockActive`:
	 * when the active tab is closed/undocked the dock falls back to another present
	 * panel, and the strip is drawn by whichever one is actually rendering. Closing it
	 * lets that same fallback promote the next tab; closing the last one empties the
	 * dock (no occupant -> no inset). */
	function closeActive() {
		closeStoreFor($visibleDockKey ?? '')?.set(true);
	}
</script>

<div class="absolute -top-6 left-3 z-20 flex gap-0.5">
	{#each $dockTabs as tab (tab.key)}
		<button
			class="tab-note px-4 pb-0.5 pt-1 text-xs font-semibold {$bottomDockActive === tab.key
				? 'bg-gray-700 text-white'
				: 'bg-gray-900/70 text-gray-400 hover:text-gray-200'}"
			onclick={() => activateDock(tab.key)}>{tab.title}</button
		>
	{/each}
	<button
		class="tab-note bg-gray-900/70 px-3 pb-0.5 pt-1 text-xs font-semibold text-gray-300 hover:text-white"
		title="Add a view (Flow Code, Animation, UV editor, Shader editor, HUD editor, Explorer)"
		onclick={openAdd}>＋</button
	>
	<button
		id="dock-minimize"
		class="tab-note bg-gray-900/70 px-3 pb-0.5 pt-1 text-xs font-semibold text-gray-300 hover:text-white"
		title="Minimize the dock"
		onclick={() => dockMinimized.set(true)}>–</button
	>
	<button
		id="dock-close-tab"
		class="tab-note bg-gray-900/70 px-3 pb-0.5 pt-1 text-xs font-semibold text-gray-300 hover:text-white"
		title="Close this tab"
		onclick={closeActive}>✕</button
	>
</div>

{#if addMenu}
	<ContextMenu x={addMenu.x} y={addMenu.y} items={addItems} on:close={() => (addMenu = null)} />
{/if}
