<script lang="ts">
	// Flow host (phase 68): a bottom-docked panel with top-edge drag-resize, or
	// an undocked floating window (same-context portal — stores, peers and VR
	// keep working because nothing leaves the page). Both states persist.
	import { flowGraphClose } from '../stores/appStore.js';
	import { SvelteFlowProvider } from '@xyflow/svelte';
	import Nodes from './editors/Nodes.svelte';
	import ScriptPanel from './editors/ScriptPanel.svelte';
	import NodeDesigner from './editors/NodeDesigner.svelte';
	import { dragWindow } from '$lib/dragWindow';
	import { focusStack } from '$lib/windowFocus';
	import { fly } from 'svelte/transition';

	const clampH = (h: number) =>
		Math.min(Math.max(h || 320, 200), Math.round(window.innerHeight * 0.8));

	let height = $state(320);
	let docked = $state(true);
	let winW = $state(760);
	let winH = $state(480);
	if (typeof localStorage !== 'undefined') {
		height = clampH(parseInt(localStorage.getItem('flowHeight') ?? '320'));
		docked = localStorage.getItem('flowDocked') !== 'false';
		winW = parseInt(localStorage.getItem('flowWinW') ?? '760') || 760;
		winH = parseInt(localStorage.getItem('flowWinH') ?? '480') || 480;
	}

	function setDocked(v: boolean) {
		docked = v;
		localStorage.setItem('flowDocked', String(v));
	}

	// --- docked: top-edge resize (min 200px, max 80vh, persisted) ---
	let resizing = $state(false);
	function startResize(e: any) {
		resizing = true;
		e.currentTarget.setPointerCapture(e.pointerId);
		e.preventDefault();
	}
	function doResize(e: any) {
		if (!resizing) return;
		height = clampH(height - e.movementY);
	}
	function endResize(e: any) {
		if (!resizing) return;
		resizing = false;
		e.currentTarget.releasePointerCapture?.(e.pointerId);
		localStorage.setItem('flowHeight', String(height));
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
		winW = Math.min(Math.max(420, winW + e.movementX), window.innerWidth);
		winH = Math.min(Math.max(300, winH + e.movementY), window.innerHeight);
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
			class="fixed inset-x-0 bottom-0 bg-white p-2 dark:bg-gray-800"
			style="z-index: var(--z-bottom); height: {height}px; border-top: 1px solid rgb(55 65 81 / 0.6)"
		>
			<!-- top-edge resize hot zone: cursor instant, cue after a hover delay (82) -->
			<div
				class="resize-cue absolute -top-1 left-0 right-0 z-10 h-2 cursor-ns-resize"
				style="touch-action: none"
				title="Drag to resize"
				onpointerdown={startResize}
				onpointermove={doResize}
				onpointerup={endResize}
			></div>
			<button
				id="flow-undock"
				class="ui-button-quiet absolute right-2 top-2 z-10"
				title="Undock into a floating window"
				onclick={() => setDocked(false)}>⧉</button
			>
			<div style="height: {height - 16}px">
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
			style="z-index: var(--z-window); width: {winW}px; height: {winH}px"
		>
			<div class="ui-panel-header move-handle shrink-0 cursor-move select-none py-1.5">
				<span>Node editor</span>
				<span class="flex-1"></span>
				<button id="flow-dock" class="ui-button-quiet" title="Dock to the bottom" onclick={() => setDocked(true)}>
					⇩ Dock
				</button>
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
