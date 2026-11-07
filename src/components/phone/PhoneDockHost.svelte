<script>
	// 41b H1 — THE PHONE DOCK'S CONTENT TABS: the frame Properties, Configure Scene, Objects, Notes
	// and Layouts sit in on a phone ($lib/phoneDock keeps the bookkeeping). It is the bottom dock's
	// own frame — the same `.tp-dock-panel` box, height and tab strip as the Explorer or the Node
	// editor (DockTabs, PhoneShell's grab bar over its top edge) — so a content tab and an editor
	// tab are one strip, one height, one grab bar.
	//
	// It REUSES the panels, the PhoneShell way: the Inspector, the object list and the notes list
	// stay the components they are (their ids, stores and handlers untouched) and are placed into
	// this frame's body by CSS (`[data-pd-host]`, phone.css + ui.css for the Inspector), so a
	// panel that is open but behind another tab stays mounted, exactly like a hidden dock tab.
	// The Layouts list has no element of its own to move (its wider-screen home is a dialog), so
	// it renders here.
	//
	// Always mounted with the editor chrome: the posture watcher has to see a fold / unfold while
	// the phone shell itself is unmounted (in Play, say).
	//
	// 42 I6 — THE HOST ON EVERY POSTURE. On a wider screen the same frame hosts the floating
	// windows that dock without a docked layout of their own ($lib/dockHost: Objects, Statistics,
	// the Live profiler, Chat, the AI assistant) — same re-seating rule, a desktop dock panel's
	// box (top-edge resize, full width), rendered only while one of them is the tab in front.
	import { onMount, tick } from 'svelte';
	import DockTabs from '../DockTabs.svelte';
	import ContextMenu from '../ContextMenu.svelte';
	import { dockAddMenuAt, dockAddItems, rebuildAfterPick } from '$lib/dockMenu';
	import EmptyState from '../ui/EmptyState.svelte';
	import WorkspaceLayouts from '../menu/WorkspaceLayouts.svelte';
	import { dockHeight, dockEmptyShown, dockSplitView, dockPaneOf, dockMinimized, visibleDockKey } from '$lib/bottomDock';
	import { registerBack } from '$lib/backStack.js';
	import DockSplit from '../DockSplit.svelte';
	import { phoneDockShown, phoneTabsOpen, startPhoneDock } from '$lib/phoneDock';
	import { HOSTED, hostedTabsOpen, hostedDockShown, hostedDockShownKeys, startDockHost } from '$lib/dockHost';
	import { phoneShell } from '$lib/ui/phoneShell.js';
	import { selectedObjects } from '../../stores/sceneStore';
	import { inspectorKind } from '../../stores/appStore';
	import { moduleSelection } from '$lib/moduleContent';
	import { minimalScroll } from '$lib/ui/minimalScroll.js';

	onMount(() => {
		const offHost = startDockHost();
		const offPhone = startPhoneDock();
		return () => {
			offPhone();
			offHost();
		};
	});

	const anyOpen = $derived(Object.values($phoneTabsOpen).some(Boolean));
	// phone-polish item 1: Android Back puts the bottom dock down — what a tap on the shown phone-bar
	// item does, and the strip's own "Minimize the dock": every tab stays open, the viewport clears;
	// the next Back is the user's. Both postures: a docked editor (Explorer, Flow …) draws its own
	// strip row instead of a WindowChrome, so the dock is the one surface that answers for it
	$effect(() => {
		if (!$visibleDockKey || $dockMinimized) return;
		return registerBack(() => dockMinimized.set(true), 'dock');
	});
	// 42 I6: a hosted window docked on a wider screen
	const anyHosted = $derived(Object.values($hostedTabsOpen).some(Boolean));
	// 44 M5: the EMPTY dock ("T" with nothing docked) is this frame too, on a wider screen — its strip
	// with only the "+", and a helper line where a tab's body would be
	const emptyDock = $derived(!$phoneShell && $dockEmptyShown);

	// 44 M8 — THE DOCK'S "+" MENU, drawn here for every strip (`dockAddMenuAt`): Ctrl/Shift-click picks
	// several windows and the rows rebuild after each pick (their checks and hints change)
	let addItems = $state(/** @type {any[]} */ ([]));
	$effect(() => {
		if ($dockAddMenuAt) addItems = dockAddItems({ pane: $dockAddMenuAt.pane });
	});
	/** the tab in front, whichever posture hosts it */
	const shownTab = $derived($phoneShell ? $phoneDockShown : ($hostedDockShownKeys[0] ?? $hostedDockShown));
	// 44 M9 — a SPLIT with one hosted half: this frame is that half's pane (the other half is an
	// editor's own frame, or the empty pane). Two hosted halves share one full-width frame, each
	// element placed in its own pane by windows.css.
	const framePane = $derived(!$phoneShell && $dockSplitView && $hostedDockShownKeys.length === 1 ? $dockPaneOf[$hostedDockShownKeys[0]] : undefined);
	// Properties with nothing selected has nothing to show (the Inspector would show the last
	// object, which the selection no longer holds): the frame says so instead
	const nothingSelected = $derived(
		$phoneDockShown === 'properties' && $inspectorKind !== 'file' && !($selectedObjects ?? []).length && !$moduleSelection
	);

	// ---- the reused elements -------------------------------------------------------------
	/** content tab -> the element it reuses (Layouts renders in the frame) */
	const HOST_OF = { properties: '#inspector', scene: '#inspector', objects: '#object-list', notes: '#notes-drawer', stats: '#stats-window' };
	/** 42 I6: hosted tab -> its window element, on a wider screen */
	const WIDE_HOST_OF = Object.fromEntries(Object.entries(HOSTED).map(([k, h]) => [k, h.sel]));
	function clearHosts() {
		for (const el of document.querySelectorAll('[data-pd-host]')) el.removeAttribute('data-pd-host');
	}
	function markHosts() {
		// 45 N5: measure the body BEFORE a hosted window is shown in it — the frame was hidden a moment
		// ago (an editor tab with a frame of its own was in front), so the last published top may be stale
		publishTop();
		const shown = shownTab;
		const hostOf = /** @type {Record<string, string>} */ ($phoneShell ? HOST_OF : WIDE_HOST_OF);
		const open = /** @type {Record<string, boolean>} */ ($phoneShell ? $phoneTabsOpen : $hostedTabsOpen);
		/** @type {Map<Element, string>} */
		const want = new Map();
		for (const [key, sel] of Object.entries(hostOf)) {
			if (!open[key]) continue;
			const el = document.querySelector(sel);
			if (!el) continue;
			const on = ($phoneShell ? shown === key : $hostedDockShownKeys.includes(key)) && !(key === 'properties' && nothingSelected);
			if (on || !want.has(el)) want.set(el, on ? 'shown' : 'hidden');
		}
		for (const el of document.querySelectorAll('[data-pd-host]')) if (!want.has(el)) el.removeAttribute('data-pd-host');
		for (const [el, v] of want) if (el.getAttribute('data-pd-host') !== v) el.setAttribute('data-pd-host', v);
		// 44 M9: which pane of a split each shown hosted window sits in (windows.css places it)
		const panes = /** @type {Record<string, string>} */ ($phoneShell ? {} : $dockPaneOf);
		for (const el of document.querySelectorAll('[data-pd-host-pane]')) {
			el.removeAttribute('data-pd-host-pane');
		}
		for (const [key, sel] of Object.entries(hostOf)) {
			const el = document.querySelector(sel);
			if (!el) continue;
			const pane = want.get(el) === 'shown' ? panes[key] : undefined;
			if (pane) el.setAttribute('data-pd-host-pane', pane);
		}
	}
	$effect(() => {
		void $phoneShell;
		void $phoneDockShown;
		void $phoneTabsOpen;
		void $hostedTabsOpen;
		void $hostedDockShown;
		void $hostedDockShownKeys;
		void $dockPaneOf;
		void nothingSelected;
		// an element may mount a frame after its store flips (the Inspector's fly-in, the object
		// list's chunked tree): try now, after the flush, on the next frame and once more
		markHosts();
		tick().then(markHosts);
		const raf = requestAnimationFrame(markHosts);
		const late = setTimeout(markHosts, 250);
		return () => {
			cancelAnimationFrame(raf);
			clearTimeout(late);
		};
	});
	onMount(() => () => clearHosts());

	// ---- 42 I6: the desktop dock's top-edge resize (every docked editor has the same one) --------
	let resizing = false;
	const clampH = (/** @type {number} */ h) => Math.min(Math.max(h || 320, 160), Math.round(window.innerHeight * 0.8));
	/** @param {PointerEvent} e */
	function startResize(e) {
		resizing = true;
		/** @type {HTMLElement} */ (e.currentTarget).setPointerCapture(e.pointerId);
		e.preventDefault();
	}
	/** @param {PointerEvent} e */
	function doResize(e) {
		if (resizing) dockHeight.update((h) => clampH(h - e.movementY));
	}
	/** @param {PointerEvent} e */
	function endResize(e) {
		if (!resizing) return;
		resizing = false;
		/** @type {HTMLElement} */ (e.currentTarget).releasePointerCapture?.(e.pointerId);
	}

	// ---- the body rect the reused elements are placed into ----------------------------------
	let bodyEl = $state(/** @type {HTMLElement | undefined} */ (undefined));
	/**
	 * 45 N5 — publish the body's top edge, but ONLY while the frame is on screen. A hidden frame (an
	 * editor with its own frame — the Image editor, the Node editor — is the tab in front) measures
	 * 0, and a hosted window shown against `--pd-top: 0px` spans the whole browser window
	 * (top 0 → bottom 0) until the next measurement: the one-frame full-screen flash on a tab switch.
	 */
	function publishTop() {
		const el = bodyEl;
		if (!el) return;
		const r = el.getBoundingClientRect();
		if (!r.width && !r.height) return; // display: none — keep the last real edge
		const root = document.documentElement.style;
		root.setProperty('--pd-top', Math.round(r.top) + 'px');
		// the frame's own top edge (a note card opened from the Notes tab covers the whole frame)
		if (el.parentElement) root.setProperty('--pd-frame-top', Math.round(el.parentElement.getBoundingClientRect().top) + 'px');
	}
	$effect(() => {
		const el = bodyEl;
		if (!el) return;
		const root = document.documentElement.style;
		const publish = publishTop;
		publish();
		// on the NEXT frame: the write moves the re-seated panel, which has observers of its own
		// (minimalScroll), and a synchronous write inside this callback re-entered them in the same
		// frame — "ResizeObserver loop completed with undelivered notifications", the app's error toast
		let raf = 0;
		const later = () => {
			cancelAnimationFrame(raf);
			raf = requestAnimationFrame(publish);
		};
		const ro = new ResizeObserver(later);
		ro.observe(el);
		window.addEventListener('resize', later);
		return () => {
			cancelAnimationFrame(raf);
			ro.disconnect();
			window.removeEventListener('resize', later);
			root.removeProperty('--pd-top');
			root.removeProperty('--pd-frame-top');
		};
	});
</script>

{#if ($phoneShell && anyOpen) || (!$phoneShell && (anyHosted || emptyDock))}
	<div
		id="phone-dock"
		class="tp-themed tp-ui tp-dock-panel pd-frame fixed inset-x-0 bottom-0 flex flex-col {shownTab || emptyDock ? '' : 'hidden'}"
		style="z-index: var(--z-dock); height: {$dockHeight}px; border-top: 1px solid var(--tp-line)"
		data-key-scope="panel"
		data-phone-tab={shownTab ?? ''}
		data-dock-host={$phoneShell ? 'phone' : 'wide'}
		data-dock-empty={emptyDock ? 'true' : undefined}
		data-dock-pane={framePane}
		role="region"
		aria-label="Docked panels"
	>
		{#if !$phoneShell}
			<!-- the desktop dock's shared top-edge resize (PhoneShell's grab bar does it on a phone) -->
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div
				class="resize-cue absolute -top-1 left-0 right-0 z-28 h-2 cursor-ns-resize hover:bg-accent/30"
				style="touch-action: none"
				title="Drag to resize"
				onpointerdown={startResize}
				onpointermove={doResize}
				onpointerup={endResize}
				onpointercancel={endResize}
			></div>
		{/if}
		<DockTabs />
		<div class="pd-body" bind:this={bodyEl}>
			{#if $phoneDockShown === 'layouts'}
				<div class="pd-layouts" id="phone-dock-layouts" use:minimalScroll>
					<WorkspaceLayouts idPrefix="layouts-menu" />
				</div>
			{:else if emptyDock}
				<div id="dock-empty" class="pd-empty">Press + or drag a tab here</div>
			{:else if nothingSelected}
				<EmptyState id="phone-dock-no-selection" icon="sliders-horizontal" title="Nothing selected" description="Select an object to see its properties here." />
			{/if}
		</div>
	</div>
{/if}

<DockSplit />

{#if $dockAddMenuAt}
	<ContextMenu
		x={$dockAddMenuAt.x}
		y={$dockAddMenuAt.y}
		items={addItems}
		onclose={() => dockAddMenuAt.set(null)}
		onpicked={() => rebuildAfterPick(() => $dockAddMenuAt && (addItems = dockAddItems({ pane: $dockAddMenuAt.pane })))}
	/>
{/if}

<style>
	.pd-frame {
		background: var(--surface-1);
	}
	.pd-body {
		display: flex;
		flex: 1;
		flex-direction: column;
		min-height: 0;
	}
	/* 44 M5: the empty dock's one quiet line (VS Code / Blender style), centred in the body */
	.pd-empty {
		flex: 1;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: var(--space-4);
		color: var(--text-faint);
		font-size: var(--fs-desc);
		user-select: none;
	}
	.pd-layouts {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		padding: var(--space-2) var(--space-3) var(--space-4);
	}
</style>
