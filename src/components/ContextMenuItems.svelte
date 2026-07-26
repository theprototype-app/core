<script lang="ts">
	// Recursive item list for ContextMenu — nested `children` open as submenus
	// on hover to any depth (77 needs Add ▸ Mesh ▸ …). Legacy-mode component so
	// <svelte:self> keeps the recursion simple.
	// Submenus render position:FIXED at coordinates measured from their row
	// (103): they escape the scrollable menu container entirely, so long menus
	// can overflow-y without ever growing a horizontal scrollbar.
	export let items: any[] = [];
	export let onrun: (item: any) => void;

	let openSub: string | null = null;
	// the hovered row's rect — the submenu positions itself against it, then clamps
	let anchorRect: DOMRect | null = null;

	function openSubmenu(e: MouseEvent, item: any) {
		anchorRect = (e.currentTarget as HTMLElement).getBoundingClientRect();
		openSub = item.label;
	}

	// Position the submenu by MEASURING it (no width guess): prefer to the right of
	// the row, flip to the left if it would cross the right edge, and if it still
	// won't fit (narrow screen) clamp it fully into the viewport — even if that
	// covers the parent menu, which is better than running off-screen. Vertically
	// it aligns to the row then clamps; too-tall submenus cap + scroll (.ctx-scroll).
	function placeSubmenu(node: HTMLElement) {
		const reposition = () => {
			const a = anchorRect;
			if (!a) return;
			const vw = window.innerWidth;
			const vh = window.innerHeight;
			node.style.maxHeight = vh - 8 + 'px';
			const w = node.offsetWidth;
			const h = node.offsetHeight;
			let left = a.right; // prefer right of the row
			if (left + w > vw - 4) left = a.left - w; // flip to the left of the row
			if (left < 4 || left + w > vw - 4) left = Math.max(4, vw - w - 4); // clamp (may cover parent)
			let top = Math.min(a.top, vh - h - 4);
			top = Math.max(4, top);
			node.style.left = left + 'px';
			node.style.top = top + 'px';
			node.style.right = 'auto';
			node.style.bottom = 'auto';
		};
		reposition();
		requestAnimationFrame(reposition); // re-measure once content/scrollbar settle
		window.addEventListener('resize', reposition);
		return { destroy: () => window.removeEventListener('resize', reposition) };
	}

	const itemClass =
		'cursor-pointer px-3 py-1.5 hover:bg-gray-100 dark:hover:bg-gray-600 whitespace-nowrap';
	const disabledClass =
		'cursor-default px-3 py-1.5 text-gray-400 dark:text-gray-500 whitespace-nowrap';
</script>

{#each items as item}
	{#if item.children}
		<div class="relative {itemClass}" role="menuitem" on:mouseenter={(e) => openSubmenu(e, item)}>
			<span class="flex items-center justify-between gap-4">
				{item.label}
				<span class="text-[10px] text-gray-400">▸</span>
			</span>
			{#if openSub === item.label}
				<div
					use:placeSubmenu
					class="ctx-scroll fixed min-w-36 overflow-y-auto overflow-x-hidden rounded-lg border border-gray-200 bg-white py-1 shadow-lg dark:border-gray-600 dark:bg-gray-700"
					style="z-index: calc(var(--z-menu) + 2);"
				>
					<svelte:self items={item.children} {onrun} />
				</div>
			{/if}
		</div>
	{:else}
		<div
			class="{item.disabled ? disabledClass : itemClass} {item.danger && !item.disabled ? 'text-red-500' : ''}"
			role="menuitem"
			title={item.tooltip ?? ''}
			on:mouseenter={() => (openSub = null)}
			on:click={() => onrun(item)}
		>
			{item.label}
		</div>
	{/if}
{/each}
