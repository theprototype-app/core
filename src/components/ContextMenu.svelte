<script lang="ts">
	import { createEventDispatcher } from 'svelte';
	import ContextMenuItems from './ContextMenuItems.svelte';

	// Generic context menu. items: [{ label, action?, disabled?, tooltip?, danger?, children?: items[] }]
	// Submenus (any depth) open on hover, marked with ▶. Flips up/left near screen edges.
	export let x: number;
	export let y: number;
	export let items: any[] = [];

	const dispatch = createEventDispatcher();

	// flip near the edges so the menu stays on screen. 124: position via
	// left/right/top/bottom — NO transform. A transformed ancestor becomes the
	// containing block for its position:fixed submenus, which mis-placed them.
	// A too-tall menu is capped to the viewport and scrolls (visible bar) — the
	// fixed submenus escape this scroll box, so they never grow a horizontal bar.
	$: vh = typeof window !== 'undefined' ? window.innerHeight : 800;
	$: vw = typeof window !== 'undefined' ? window.innerWidth : 1200;
	$: flipY = y > vh - 240;
	$: flipX = x > vw - 320;
	$: availH = flipY ? y - 8 : vh - y - 8;
	$: rootStyle =
		(flipX ? `right: ${vw - x}px;` : `left: ${x}px;`) +
		(flipY ? `bottom: ${vh - y}px;` : `top: ${y}px;`) +
		` max-height: ${availH}px;`;

	function run(item: any) {
		if (item.disabled || item.children) return;
		item.action?.();
		dispatch('close');
	}

	// Portal to <body> so the menu escapes any z-indexed/stacking-context ancestor
	// (e.g. the Flow editor's docked/floating window) and its z-index:1000 ranks
	// above other windows instead of being trapped at the host window's z-tier.
	function portal(node: HTMLElement) {
		document.body.appendChild(node);
		return { destroy: () => node.remove() };
	}
</script>

<!-- backdrop to catch outside clicks -->
<div
	use:portal
	class="fixed inset-0"
	style="z-index: 999;"
	role="presentation"
	on:click={() => dispatch('close')}
	on:contextmenu|preventDefault={() => dispatch('close')}
></div>

<div
	use:portal
	class="ctx-scroll fixed min-w-36 overflow-y-auto overflow-x-hidden rounded-lg border border-gray-200 bg-white py-1 text-xs shadow-lg dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200"
	style="{rootStyle} z-index: 1000;"
	role="menu"
>
	<ContextMenuItems {items} onrun={run} {flipX} {flipY} />
</div>

<style>
	/* a slim but VISIBLE vertical scrollbar for a too-tall menu/submenu */
	:global(.ctx-scroll) {
		scrollbar-width: thin;
	}
	:global(.ctx-scroll::-webkit-scrollbar) {
		width: 8px;
	}
	:global(.ctx-scroll::-webkit-scrollbar-thumb) {
		background: rgb(148 163 184 / 0.7);
		border-radius: 4px;
	}
	:global(.ctx-scroll::-webkit-scrollbar-track) {
		background: transparent;
	}
</style>
