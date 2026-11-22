<script>
	// panel-gestures item 5 — the menu of a hideable chrome button (right-click / a long press on touch):
	// $lib/chromeButtons builds the rows and decides when it opens; this only renders it.
	import ContextMenu from '../ContextMenu.svelte';
	import { chromeButtonMenu, chromeButtonMenuItems, hiddenChromeIds } from '$lib/chromeButtons';
</script>

{#if $chromeButtonMenu}
	<ContextMenu
		x={$chromeButtonMenu.x}
		y={$chromeButtonMenu.y}
		items={[$hiddenChromeIds, chromeButtonMenuItems($chromeButtonMenu.id)][1]}
		sizeKey="chromebutton"
		onclose={() => chromeButtonMenu.set(null)}
	/>
{/if}
