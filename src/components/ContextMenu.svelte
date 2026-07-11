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
	// containing block for its position:fixed submenus, which mis-placed them
	// and let the root grow scrollbars. No context menu scrolls (node search,
	// a separate component, keeps its own results scroll).
	$: flipY = typeof window !== 'undefined' && y > window.innerHeight - 240;
	$: flipX = typeof window !== 'undefined' && x > window.innerWidth - 320;
	$: rootStyle =
		(flipX ? `right: ${(typeof window !== 'undefined' ? window.innerWidth : 0) - x}px;` : `left: ${x}px;`) +
		(flipY ? `bottom: ${(typeof window !== 'undefined' ? window.innerHeight : 0) - y}px;` : `top: ${y}px;`);

	function run(item: any) {
		if (item.disabled || item.children) return;
		item.action?.();
		dispatch('close');
	}
</script>

<!-- backdrop to catch outside clicks -->
<div
	class="fixed inset-0"
	style="z-index: 999;"
	role="presentation"
	on:click={() => dispatch('close')}
	on:contextmenu|preventDefault={() => dispatch('close')}
></div>

<div
	class="fixed min-w-36 rounded-lg border border-gray-200 bg-white py-1 text-xs shadow-lg dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200"
	style="{rootStyle} z-index: 1000;"
	role="menu"
>
	<ContextMenuItems {items} onrun={run} {flipX} {flipY} />
</div>
