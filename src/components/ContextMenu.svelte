<script lang="ts">
	import { createEventDispatcher } from 'svelte';
	import ContextMenuItems from './ContextMenuItems.svelte';

	// Generic context menu. items: [{ label, action?, disabled?, tooltip?, danger?, children?: items[] }]
	// Submenus (any depth) open on hover, marked with ▶. Flips up/left near screen edges.
	export let x: number;
	export let y: number;
	export let items: any[] = [];

	const dispatch = createEventDispatcher();

	// The menu positions via left/top only — NO transform (a transform makes it the
	// containing block for its position:fixed submenus, which mis-placed them, 124).
	// It's portaled to <body>, measured + clamped into the viewport by `place`, and
	// caps + scrolls vertically when too tall; submenus place themselves.

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

	// Position by MEASURING the menu (no width/height guess): open from the click,
	// but clamp fully into the viewport so it never runs off any edge on a narrow
	// screen; too-tall menus cap + scroll (.ctx-scroll). Submenus place themselves.
	function place(node: HTMLElement) {
		const reposition = () => {
			const vw = window.innerWidth;
			const vh = window.innerHeight;
			node.style.maxHeight = vh - 8 + 'px';
			const w = node.offsetWidth;
			const h = node.offsetHeight;
			let left = x > vw - w - 4 ? x - w : x; // near the right edge -> open leftward
			left = Math.max(4, Math.min(left, vw - w - 4));
			let top = y > vh - h - 4 ? y - h : y;
			top = Math.max(4, Math.min(top, vh - h - 4));
			node.style.left = left + 'px';
			node.style.top = top + 'px';
			node.style.right = 'auto';
			node.style.bottom = 'auto';
		};
		reposition();
		requestAnimationFrame(reposition);
		window.addEventListener('resize', reposition);
		return { destroy: () => window.removeEventListener('resize', reposition) };
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
	use:place
	class="ctx-scroll fixed min-w-36 overflow-y-auto overflow-x-hidden rounded-lg border border-gray-200 bg-white py-1 text-xs shadow-lg dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200"
	style="left: 0; top: 0; z-index: 1000;"
	role="menu"
>
	<ContextMenuItems {items} onrun={run} />
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
