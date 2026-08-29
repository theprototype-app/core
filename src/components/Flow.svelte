<script lang="ts">
	// Flow host: the Node editor. DOCKED mode is a Flow-family TAB in the shared bottom
	// dock (DockTabs strip; shares dockHeight with Flow Code + Animation; only the
	// visible tab renders). UNDOCKED mode is a floating, resizable window. Both persist.
	import { flowGraphClose, mobileUndockAllowed } from '../stores/appStore.js';
	import { get } from 'svelte/store';
	import { onMount, untrack } from 'svelte';
	import { SvelteFlowProvider } from '@xyflow/svelte';
	import ContextMenu from './ContextMenu.svelte';
	import Nodes from './editors/Nodes.svelte';
	import ScriptPanel from './editors/ScriptPanel.svelte';
	import NodeDesigner from './editors/NodeDesigner.svelte';
	import DockTabs from './DockTabs.svelte';
	import { dragWindow } from '$lib/dragWindow';
	import { focusStack } from '$lib/windowFocus';
	import { tabbable, resizeGroup, tabGroups } from '$lib/windowTabs';
	import { clampWinSize, clampResize, anchorOf } from '$lib/windowSize';
	import { dockable } from '$lib/docking';
	import { setDockOccupant, dockHeight, visibleDockKey, dockMinimized, activateDock, dockModeArm } from '$lib/bottomDock';
	import { dockAddItems } from '$lib/dockMenu';
	import { fly } from 'svelte/transition';

	const clampH = (h: number) => Math.min(Math.max(h || 320, 200), Math.round(window.innerHeight * 0.8));
	// 18-B: floating-window size limits, shared with the clamp helpers
	const WIN_MIN = { minW: 280, minH: 240 };
	const WIN_DEFAULT = { w: 760, h: 480 };
	let docked = $state(true);
	// mirrors Nodes' palette-open (bound below) so the docked content only insets above
	// the Controls HUD when the node palette is actually shown (overlapping the HUD)
	let paletteOpen = $state(
		typeof localStorage !== 'undefined' ? localStorage.getItem('flowPaletteOpen') !== 'false' : true
	);
	let winW = $state(760);
	let winH = $state(480);
	// keep the floating window within the viewport (a persisted wide rect used to push
	// the header buttons off a narrow screen)
	function clampWin() {
		if (typeof window === 'undefined') return;
		const fit = clampWinSize(winW, winH, WIN_MIN);
		winW = fit.w;
		winH = Math.min(fit.h, Math.round(window.innerHeight * 0.9));
	}
	if (typeof localStorage !== 'undefined') {
		docked = localStorage.getItem('flowDocked') !== 'false';
		winW = parseInt(localStorage.getItem('flowWinW') ?? '760') || 760;
		winH = parseInt(localStorage.getItem('flowWinH') ?? '480') || 480;
		clampWin();
	}
	// touch / limited-width: keep the editor docked (no room to float; undock hidden),
	// unless the user opted into undocking on touch (Settings > Allow undocking)
	if (
		typeof window !== 'undefined' &&
		window.matchMedia?.('(pointer: coarse)').matches &&
		!get(mobileUndockAllowed)
	)
		docked = true;
	onMount(() => {
		clampWin();
		const onResize = () => clampWin();
		window.addEventListener('resize', onResize);
		return () => window.removeEventListener('resize', onResize);
	});

	function setDocked(v: boolean) {
		docked = v;
		localStorage.setItem('flowDocked', String(v));
		if (v) activateDock('flow'); // re-docking makes it the visible tab
	}

	// W5: consume the shared dock-mode arm — the tab strip's right-click menu asks
	// through it (the Explorer has had this exact effect since 4b). `docked` is read
	// from localStorage ONCE at mount, so writing that flag from outside is inert;
	// `setDocked` owns the mode and is what has to run. Cleared as it is acted on.
	$effect(() => {
		const arm = $dockModeArm;
		if (!arm || arm.key !== 'flow') return;
		dockModeArm.set(null);
		untrack(() => {
			if (arm.docked !== docked) setDocked(arm.docked);
			flowGraphClose.set(false);
		});
	});

	// tab-grouped windows share one size: show the group's rect so a resize on any
	// member updates every tab, not just the active one.
	const myGroup = $derived($tabGroups.find((g: any) => g.members.includes('flow')) ?? null);
	const effW = $derived(myGroup ? myGroup.rect.width : winW);
	const effH = $derived(myGroup ? myGroup.rect.height : winH);

	// Flow "+" (floating window only — docked mode uses the DockTabs strip): open
	// another dock view. They start docked, so they appear as dock tabs. Same list the
	// strip's "+" renders ($lib/dockMenu) — they used to be two copies that drifted.
	let addMenu: { x: number; y: number } | null = $state(null);
	const addItems = dockAddItems();
	function openAddMenu(e: MouseEvent) {
		const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
		addMenu = { x: r.left, y: r.bottom + 4 };
	}

	// report docked+open (+ the shared dock height) so the dock knows this tab exists;
	// only the visible Flow-family tab actually renders
	$effect(() => {
		setDockOccupant('flow', !$flowGraphClose && docked, $dockHeight);
		return () => setDockOccupant('flow', false);
	});
	// W2: a MINIMIZED dock renders nothing while every tab stays open (the occupant
	// report above is untouched, so the strip comes back with its tabs intact)
	const dockVisible = $derived($visibleDockKey === 'flow' && !$dockMinimized);

	// --- docked: top-edge resize (shared dock height, persisted by the store) ---
	let resizing = $state(false);
	function startResize(e: any) {
		resizing = true;
		e.currentTarget.setPointerCapture(e.pointerId);
		e.preventDefault();
	}
	function doResize(e: any) {
		if (!resizing) return;
		dockHeight.update((h) => clampH(h - e.movementY));
	}
	function endResize(e: any) {
		if (!resizing) return;
		resizing = false;
		e.currentTarget.releasePointerCapture?.(e.pointerId);
	}

	// --- undocked: corner resize ---
	let winResizing = $state(false);
	function startWinResize(e: any) {
		winResizing = true;
		e.currentTarget.setPointerCapture(e.pointerId);
		e.preventDefault();
		e.stopPropagation();
	}
	function doWinResize(e: any) {
		if (!winResizing) return;
		const baseW = myGroup ? myGroup.rect.width : winW;
		const baseH = myGroup ? myGroup.rect.height : winH;
		// 18-B: the corner stops at the viewport edge, so this grip stays reachable
		const at = anchorOf(e.currentTarget.parentElement);
		const fit = clampResize(baseW + e.movementX, baseH + e.movementY, at.left, at.top, WIN_MIN);
		winW = fit.w;
		winH = fit.h;
		resizeGroup('flow', winW, winH); // if grouped, resize the whole group
	}
	/** 18-B: double-click the grip — back to the default size, position kept */
	function resetWinSize() {
		const fit = clampWinSize(WIN_DEFAULT.w, WIN_DEFAULT.h, WIN_MIN);
		winW = fit.w;
		winH = fit.h;
		resizeGroup('flow', winW, winH);
		localStorage.setItem('flowWinW', String(winW));
		localStorage.setItem('flowWinH', String(winH));
	}
	function endWinResize(e: any) {
		if (!winResizing) return;
		winResizing = false;
		e.currentTarget.releasePointerCapture?.(e.pointerId);
		localStorage.setItem('flowWinW', String(winW));
		localStorage.setItem('flowWinH', String(winH));
	}
</script>

{#if !$flowGraphClose}
	{#if docked}
		<div
			id="flow-list"
			transition:fly={{ y: 320, duration: 200 }}
			class="fixed inset-x-0 bottom-0 bg-white p-2 dark:bg-gray-800 {dockVisible ? '' : 'hidden'}"
			style="z-index: var(--z-bottom); height: {$dockHeight}px; border-top: 1px solid rgb(55 65 81 / 0.6)"
		>
			<!-- top-edge resize hot zone -->
			<div
				class="resize-cue absolute -top-1 left-0 right-0 z-30 h-2 cursor-ns-resize hover:bg-primary-600/30"
				style="touch-action: none"
				title="Drag to resize"
				onpointerdown={startResize}
				onpointermove={doResize}
				onpointerup={endResize}
			></div>
			<DockTabs />
			<button
				id="flow-undock"
				class="ui-button-quiet absolute right-2 top-2 z-10"
				title="Undock into a floating window"
				onclick={() => setDocked(false)}>⧉</button
			>
			<div style="height: {$dockHeight - 16}px">
				<SvelteFlowProvider>
					<Nodes bind:paletteOpen />
				</SvelteFlowProvider>
			</div>
		</div>
	{:else}
		<div
			id="flow-window"
			class="ui-panel fixed flex flex-col overflow-hidden"
			use:dragWindow={{ key: 'flowWin', defaultRect: { left: 120, top: 90 } }}
			use:focusStack={'flow'}
			use:tabbable={{ key: 'flow', title: 'Node editor', openStore: flowGraphClose, isOpen: (v) => !v, close: () => flowGraphClose.set(true) }}
			use:dockable={{ key: 'flow' }}
			style="z-index: var(--z-window)"
			style:width="{effW}px"
			style:height="{effH}px"
		>
			<div class="ui-panel-header move-handle shrink-0 cursor-move select-none py-1.5">
				<span>Node editor</span>
				<span class="flex-1"></span>
				<button id="flow-add-view" class="ui-button-quiet" title="Add a view (Flow Code, Animation, UV editor, Shader editor)" onclick={openAddMenu}>＋</button>
				<button id="flow-dock" class="ui-button-quiet" title="Dock to the bottom" onclick={() => setDocked(true)}>⇩ Dock</button>
				<button class="ui-button-quiet" title="Close (N)" onclick={() => flowGraphClose.set(true)}>✕</button>
			</div>
			<div class="min-h-0 flex-1">
				<SvelteFlowProvider>
					<Nodes bind:paletteOpen />
				</SvelteFlowProvider>
			</div>
			<div
				class="resize-cue absolute bottom-0 right-0 z-10 h-3.5 w-3.5 cursor-se-resize rounded-tl bg-gray-500/40"
				style="touch-action: none"
				title="Drag to resize · double-click to reset size"
				onpointerdown={startWinResize}
				onpointermove={doWinResize}
				onpointerup={endWinResize}
				ondblclick={resetWinSize}
			></div>
		</div>
	{/if}
{/if}

<ScriptPanel />
<NodeDesigner />

{#if addMenu}
	<ContextMenu x={addMenu.x} y={addMenu.y} items={addItems} on:close={() => (addMenu = null)} />
{/if}
