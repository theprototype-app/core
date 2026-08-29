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
	// W7 gave the strip its GESTURE half. A tab is draggable: inside the strip the drag
	// REORDERS (the order is user data now — `dockTabOrder`), and released clear of the
	// strip it UNDOCKS that view into a floating window. Both are the fast paths for
	// what the tab's right-click menu already offered in words, which is what keeps the
	// feature reachable on a device that cannot drag.
	import { dockTabs, bottomDockActive, activateDock, dockMinimized, reorderDockTabs, armDockMode } from '$lib/bottomDock';
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

	// --- W7: drag a tab -------------------------------------------------------------
	// THRESHOLD, not a timer: 6px of TRAVEL promotes a press into a drag. A press that
	// never travels stays a plain click that activates the tab, and — the reason it must
	// be movement — a STILL press is what Android turns into `contextmenu`, so a timer
	// here would race the long-press menu and eat it.
	const DRAG_PX = 6;
	// OUT = released clear of the strip by this much in any direction. The band itself is
	// only 22px tall, so "outside the rect" would undock on a stray wobble; inflating it
	// by the same 44px reach docking.js gives an edge means the pointer has to be down in
	// the panel body (or well past either end) before an undock is even considered.
	const OUT_MARGIN = 44;
	// touch stands down, like docking.js and the bottom-dock band: a horizontal drag
	// inside a 22px strip is exactly the gesture the strip's own `overflow-x-auto`
	// scrolling owns. The tab menu's Move left / Move right is the touch path.
	const coarse = typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia('(pointer: coarse)').matches;

	let stripEl = $state(/** @type {HTMLElement|null} */ (null));
	/** the key being dragged (null = no drag in progress) */
	let dragKey = $state(/** @type {string|null} */ (null));
	/** where the insertion bar sits, in the strip's own content coordinates */
	let dropX = $state(0);
	/** released here and the view undocks instead of moving */
	let dropOut = $state(false);
	/** a drag that just ended must not also activate the tab — self-expiring, because a
	 * pointer that left the button fires no click at all and a sticky flag would then eat
	 * the next real one */
	let draggedAt = 0;

	/** @type {{key: string, x: number, y: number, order: string[], rects: DOMRect[], strip: DOMRect, scroll: number}|null} */
	let pending = null;
	let dropIndex = 0;

	/** @param {HTMLElement} node @param {{key: string}} options */
	function tabDrag(node, options) {
		let key = options.key;
		// DIRECT listener: svelte delegates `onpointerdown` to the app root, and panel
		// chrome swallows delegated events on the way up (the repo's standing rule for
		// pointer gestures inside a panel).
		/** @param {PointerEvent} e */
		const down = (e) => {
			if (coarse || e.button !== 0 || !stripEl) return;
			// GEOMETRY IS FROZEN AT THE START. The insertion index is read against the tab
			// rects as they were when the gesture began, so a reorder preview cannot move
			// the boundaries that decide the next reorder — the feedback loop that makes a
			// live-measured drag oscillate between two positions.
			const tabs = [...stripEl.querySelectorAll('[data-dock-tab]')];
			pending = {
				key,
				x: e.clientX,
				y: e.clientY,
				order: tabs.map((el) => /** @type {HTMLElement} */ (el).dataset.dockTab ?? ''),
				rects: tabs.map((el) => el.getBoundingClientRect()),
				strip: stripEl.getBoundingClientRect(),
				scroll: stripEl.scrollLeft
			};
			window.addEventListener('pointermove', move);
			window.addEventListener('pointerup', up);
			window.addEventListener('pointercancel', cancel);
		};
		/** @param {PointerEvent} e */
		const move = (e) => {
			if (!pending) return;
			if (!dragKey) {
				if (Math.hypot(e.clientX - pending.x, e.clientY - pending.y) < DRAG_PX) return;
				dragKey = pending.key;
			}
			const { rects, strip, scroll } = pending;
			dropOut =
				e.clientX < strip.left - OUT_MARGIN ||
				e.clientX > strip.right + OUT_MARGIN ||
				e.clientY < strip.top - OUT_MARGIN ||
				e.clientY > strip.bottom + OUT_MARGIN;
			dropIndex = rects.filter((r) => e.clientX > r.left + r.width / 2).length;
			const at = dropIndex < rects.length ? rects[dropIndex].left : rects[rects.length - 1].right;
			dropX = at - strip.left + scroll;
		};
		/** @param {PointerEvent} e */
		const up = (e) => {
			// read the verdict BEFORE cleanup, which resets it — the drop is decided by
			// where the pointer WAS, not by the state the teardown leaves behind
			const state = pending;
			const dragged = dragKey;
			const out = dropOut;
			cleanup();
			if (!state || !dragged) return; // never travelled: the click activates the tab
			draggedAt = performance.now();
			if (out) {
				// the W5 seam every panel already consumes — the panel owns its own mode
				armDockMode(dragged, false);
				return;
			}
			const without = state.order.filter((k) => k !== dragged);
			const from = state.order.indexOf(dragged);
			without.splice(dropIndex > from ? dropIndex - 1 : dropIndex, 0, dragged);
			reorderDockTabs(without);
		};
		const cancel = () => cleanup();
		function cleanup() {
			pending = null;
			dragKey = null;
			dropOut = false;
			window.removeEventListener('pointermove', move);
			window.removeEventListener('pointerup', up);
			window.removeEventListener('pointercancel', cancel);
		}
		node.addEventListener('pointerdown', down);
		return {
			/** @param {{key: string}} next */
			update(next) {
				key = next.key;
			},
			destroy() {
				node.removeEventListener('pointerdown', down);
				cleanup();
			}
		};
	}

	/** @param {string} key */
	function tabClick(key) {
		if (performance.now() - draggedAt < 300) return; // that was a drag, not a click
		activateDock(key);
	}

</script>

<div bind:this={stripEl} class="absolute -top-6 left-3 right-24 z-20 flex gap-0.5 overflow-x-auto">
	{#each $dockTabs as tab (tab.key)}
		<button
			data-dock-tab={tab.key}
			class="tab-note h-5.5 shrink-0 select-none px-4 pb-0.5 pt-1 text-xs font-semibold {$bottomDockActive === tab.key
				? 'bg-gray-700 text-white'
				: 'bg-gray-900/70 text-gray-400 hover:text-gray-200'} {dragKey === tab.key
				? 'opacity-40 ring-1 ring-primary-400'
				: ''}"
			title="{tab.title} — drag to reorder, or out of the strip to undock"
			use:tabDrag={{ key: tab.key }}
			oncontextmenu={(/** @type {MouseEvent} */ e) => openTabMenu(e, tab.key)}
			onclick={() => tabClick(tab.key)}>{tab.title}</button
		>
	{/each}
	<!-- the insertion bar: where the dragged tab would land. Hidden once the pointer is
	     clear of the strip, because there the drop means UNDOCK, not "put it here". -->
	{#if dragKey && !dropOut}
		<div
			id="dock-tab-drop"
			class="pointer-events-none absolute bottom-0 top-0 w-0.5 bg-primary-400"
			style="left: {dropX}px"
		></div>
	{/if}
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
