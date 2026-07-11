<script lang="ts">
	// Recursive item list for ContextMenu — nested `children` open as submenus
	// on hover to any depth (77 needs Add ▸ Mesh ▸ …). Legacy-mode component so
	// <svelte:self> keeps the recursion simple.
	// Submenus render position:FIXED at coordinates measured from their row
	// (103): they escape the scrollable menu container entirely, so long menus
	// can overflow-y without ever growing a horizontal scrollbar.
	export let items: any[] = [];
	export let onrun: (item: any) => void;
	export let flipX = false;
	export let flipY = false;

	let openSub: string | null = null;
	let subPos = { x: 0, y: 0 };

	function openSubmenu(e: MouseEvent, item: any) {
		const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
		subPos = { x: flipX ? rect.left : rect.right, y: flipY ? rect.bottom : rect.top };
		openSub = item.label;
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
					class="fixed max-h-[60vh] min-w-36 overflow-y-auto rounded-lg border border-gray-200 bg-white py-1 shadow-lg dark:border-gray-600 dark:bg-gray-700"
					style="left: {subPos.x}px; top: {subPos.y}px; transform: translate({flipX
						? '-100%'
						: '0'}, {flipY ? '-100%' : '0'}); z-index: 1001;"
				>
					<svelte:self items={item.children} {onrun} {flipX} {flipY} />
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
