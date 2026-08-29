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
	//
	// W5 moved that chrome to the RIGHT EDGE. Both groups are absolutely positioned in
	// the same panel-relative band (`-top-6`), one at `left-3` and one at `right-3` —
	// and since the dock panel is `inset-x-0`, the right group lands on the browser's
	// right edge, which is where window chrome belongs. The tab group is capped at
	// `right-24` so a strip full of tabs SCROLLS under the cluster instead of running
	// beneath it. The three buttons became lucide icons (Plus / Minus / X): they are
	// chrome, and a text "–" next to a text "✕" reads as punctuation.
	//
	// W5 also gave a TAB its own context menu (right-click; a long press on Android
	// fires `contextmenu` natively). It acts on the tab you clicked, which is the half
	// the strip could not do before, and since W6 it is the ONLY way the strip closes
	// anything: W5's right-cluster ✕ read as "close the dock" and was removed. Closing
	// a view is the panel's own header ✕ (floating) or this menu (docked).
	//
	// W6 also pinned the BAND HEIGHT. Every button here is `h-5.5` (22px) on purpose:
	// W5's icon buttons carried no `text-xs`, so their 24px line-height plus `pt-1.5
	// pb-1` made them 34px, and a flex row stretches its items — so every text tab
	// inherited that height (measured 22 -> 34). That both fattened the strip and, at
	// `-top-6`, dropped its bottom edge 10px INSIDE the panel, burying the top-edge
	// resize hot-zone. An explicit height on each button is what keeps one member from
	// ever setting the band's height again.
	import { dockTabs, bottomDockActive, activateDock, dockMinimized } from '$lib/bottomDock';
	import { dockAddItems, dockTabItems } from '$lib/dockMenu';
	import ContextMenu from './ContextMenu.svelte';
	import { Plus, PanelBottom } from '@lucide/svelte';

	let addMenu = $state(/** @type {{x:number,y:number}|null} */ (null));
	// Rebuilt per OPEN, not once at init: the list drops views that are already docked,
	// and that set changes every time a tab opens or closes.
	let addItems = $state(/** @type {any[]} */ ([]));
	function openAdd(/** @type {MouseEvent} */ e) {
		const r = /** @type {HTMLElement} */ (e.currentTarget).getBoundingClientRect();
		addItems = dockAddItems();
		addMenu = { x: r.left, y: r.bottom + 4 };
	}

	let tabMenu = $state(/** @type {{x:number,y:number,items:any[]}|null} */ (null));
	/** @param {MouseEvent} e @param {string} key */
	function openTabMenu(e, key) {
		e.preventDefault();
		tabMenu = { x: e.clientX, y: e.clientY, items: dockTabItems(key) };
	}

</script>

<div class="absolute -top-6 left-3 right-24 z-20 flex gap-0.5 overflow-x-auto">
	{#each $dockTabs as tab (tab.key)}
		<button
			class="tab-note h-5.5 shrink-0 px-4 pb-0.5 pt-1 text-xs font-semibold {$bottomDockActive === tab.key
				? 'bg-gray-700 text-white'
				: 'bg-gray-900/70 text-gray-400 hover:text-gray-200'}"
			oncontextmenu={(e) => openTabMenu(e, tab.key)}
			onclick={() => activateDock(tab.key)}>{tab.title}</button
		>
	{/each}
	<button
		id="dock-add-view"
		class="tab-note flex h-5.5 shrink-0 items-center justify-center bg-gray-900/70 px-3 text-gray-300 hover:text-white"
		title="Add a view (Flow Code, Animation, UV editor, Shader editor, HUD editor, Explorer)"
		aria-label="Add a view to the dock"
		onclick={openAdd}><Plus size={14} aria-hidden="true" /></button
	>
</div>

<!-- the dock's OWN chrome, pinned to the right edge of the dock (= of the window) -->
<div class="absolute -top-6 right-3 z-20 flex gap-0.5">
	<button
		id="dock-minimize"
		class="tab-note flex h-5.5 items-center justify-center bg-gray-900/70 px-3 text-gray-300 hover:text-white"
		title="Minimize the dock"
		aria-label="Minimize the dock"
		onclick={() => dockMinimized.set(true)}><PanelBottom size={14} aria-hidden="true" /></button
	>
</div>

{#if addMenu}
	<ContextMenu x={addMenu.x} y={addMenu.y} items={addItems} on:close={() => (addMenu = null)} />
{/if}
{#if tabMenu}
	<ContextMenu x={tabMenu.x} y={tabMenu.y} items={tabMenu.items} on:close={() => (tabMenu = null)} />
{/if}
