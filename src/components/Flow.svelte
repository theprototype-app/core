<script lang="ts">
	// Flow host: the Node editor. DOCKED mode is a Flow-family TAB in the shared bottom
	// dock (DockTabs strip; shares dockHeight with Flow Code + Animation; only the
	// visible tab renders). UNDOCKED mode is a floating, resizable window. Both persist.
	import { flowGraphClose, flowCodeClose, animationClose } from '../stores/appStore.js';
	import { onMount } from 'svelte';
	import { SvelteFlowProvider } from '@xyflow/svelte';
	import ContextMenu from './ContextMenu.svelte';
	import Nodes from './editors/Nodes.svelte';
	import ScriptPanel from './editors/ScriptPanel.svelte';
	import NodeDesigner from './editors/NodeDesigner.svelte';
	import DockTabs from './DockTabs.svelte';
	import { dragWindow } from '$lib/dragWindow';
	import { focusStack } from '$lib/windowFocus';
	import { tabbable } from '$lib/windowTabs';
	import { dockable } from '$lib/docking';
	import { setDockOccupant, dockHeight, visibleDockKey, activateDock } from '$lib/bottomDock';
	import { fly } from 'svelte/transition';

	const clampH = (h: number) => Math.min(Math.max(h || 320, 200), Math.round(window.innerHeight * 0.8));
	let docked = $state(true);
	let winW = $state(760);
	let winH = $state(480);
	// keep the floating window within the viewport (a persisted wide rect used to push
	// the header buttons off a narrow screen)
	function clampWin() {
		if (typeof window === 'undefined') return;
		winW = Math.min(winW, window.innerWidth - 8);
		winH = Math.min(winH, Math.round(window.innerHeight * 0.9));
	}
	if (typeof localStorage !== 'undefined') {
		docked = localStorage.getItem('flowDocked') !== 'false';
		winW = parseInt(localStorage.getItem('flowWinW') ?? '760') || 760;
		winH = parseInt(localStorage.getItem('flowWinH') ?? '480') || 480;
		clampWin();
	}
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

	// Flow "+" (floating window only — docked mode uses the DockTabs strip): open
	// another Flow-family view. They start docked, so they appear as dock tabs.
	let addMenu: { x: number; y: number } | null = $state(null);
	const addItems = [
		{ label: '＋ Flow Code', tooltip: 'Edit the graph as JSON', action: () => { flowCodeClose.set(false); activateDock('flowcode'); } },
		{ label: '＋ Animation', tooltip: 'Animate the selected object', action: () => { animationClose.set(false); activateDock('animation'); } }
	];
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
	const dockVisible = $derived($visibleDockKey === 'flow');

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
		winW = Math.min(Math.max(280, winW + e.movementX), window.innerWidth - 8);
		winH = Math.min(Math.max(240, winH + e.movementY), window.innerHeight);
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
				class="resize-cue absolute -top-1 left-0 right-0 z-10 h-2 cursor-ns-resize"
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
					<Nodes />
				</SvelteFlowProvider>
			</div>
		</div>
	{:else}
		<div
			id="flow-window"
			class="ui-panel fixed flex flex-col overflow-hidden"
			use:dragWindow={{ key: 'flowWin', defaultRect: { left: 120, top: 90 } }}
			use:focusStack
			use:tabbable={{ key: 'flow', title: 'Node editor', openStore: flowGraphClose, isOpen: (v) => !v, close: () => flowGraphClose.set(true) }}
			use:dockable={{ key: 'flow' }}
			style="z-index: var(--z-window)"
			style:width="{winW}px"
			style:height="{winH}px"
		>
			<div class="ui-panel-header move-handle shrink-0 cursor-move select-none py-1.5">
				<span>Node editor</span>
				<span class="flex-1"></span>
				<button id="flow-add-view" class="ui-button-quiet" title="Add a view (Flow Code, Animation)" onclick={openAddMenu}>＋</button>
				<button id="flow-dock" class="ui-button-quiet" title="Dock to the bottom" onclick={() => setDocked(true)}>⇩ Dock</button>
				<button class="ui-button-quiet" title="Close (N)" onclick={() => flowGraphClose.set(true)}>✕</button>
			</div>
			<div class="min-h-0 flex-1">
				<SvelteFlowProvider>
					<Nodes />
				</SvelteFlowProvider>
			</div>
			<div
				class="resize-cue absolute bottom-0 right-0 z-10 h-3.5 w-3.5 cursor-se-resize rounded-tl bg-gray-500/40"
				style="touch-action: none"
				title="Drag to resize"
				onpointerdown={startWinResize}
				onpointermove={doWinResize}
				onpointerup={endWinResize}
			></div>
		</div>
	{/if}
{/if}

<ScriptPanel />
<NodeDesigner />

{#if addMenu}
	<ContextMenu x={addMenu.x} y={addMenu.y} items={addItems} on:close={() => (addMenu = null)} />
{/if}
