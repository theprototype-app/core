<script>
	// 44 M3 — the floating-window menu (right-click / long press on a window header or a group tab):
	// $lib/windowMenu builds the rows and decides when it opens; this only renders it.
	import { onMount } from 'svelte';
	import ContextMenu from '../ContextMenu.svelte';
	import { windowMenu, windowMenuItems, installWindowMenu } from '$lib/windowMenu';
	import { hiddenChromeButtons, showButtonsItems } from '$lib/chromeButtons';

	onMount(() => installWindowMenu());
</script>

{#if $windowMenu}
	<!-- panel-gestures item 5: a GROUP's menu (a group tab, its strip) lists the strip buttons hidden there -->
	<ContextMenu
		x={$windowMenu.x}
		y={$windowMenu.y}
		items={[...windowMenuItems($windowMenu), ...($windowMenu.grouped ? showButtonsItems('group', $hiddenChromeButtons) : [])]}
		sizeKey="window"
		onclose={() => windowMenu.set(null)}
	/>
{/if}
