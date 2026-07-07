<script lang="ts">
	import { createEventDispatcher } from 'svelte';

	// Generic context menu. items: [{ label, action?, disabled?, tooltip?, danger?, children?: items[] }]
	// Submenus (one level) open on hover, marked with ▶. Flips up/left near screen edges.
	export let x: number;
	export let y: number;
	export let items: any[] = [];

	const dispatch = createEventDispatcher();
	let openSub: string | null = null;

	// flip near the edges so the menu stays on screen
	$: flipY = typeof window !== 'undefined' && y > window.innerHeight - 240;
	$: flipX = typeof window !== 'undefined' && x > window.innerWidth - 320;

	function run(item: any) {
		if (item.disabled || item.children) return;
		item.action?.();
		dispatch('close');
	}

	const itemClass =
		'cursor-pointer px-3 py-1.5 hover:bg-gray-100 dark:hover:bg-gray-600 whitespace-nowrap';
	const disabledClass = 'cursor-default px-3 py-1.5 text-gray-400 dark:text-gray-500 whitespace-nowrap';
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
	style="left: {x}px; top: {y}px; transform: {flipY ? 'translateY(-100%)' : 'none'}; z-index: 1000;"
	role="menu"
>
	{#each items as item}
		{#if item.children}
			<div
				class="relative {itemClass}"
				role="menuitem"
				on:mouseenter={() => (openSub = item.label)}
			>
				<span class="flex items-center justify-between gap-4">
					{item.label}
					<span class="text-gray-400">&#9654;</span>
				</span>
				{#if openSub === item.label}
					<div
						class="absolute min-w-36 rounded-lg border border-gray-200 bg-white py-1 shadow-lg dark:border-gray-600 dark:bg-gray-700"
						style="{flipX ? 'right' : 'left'}: 100%; {flipY ? 'bottom' : 'top'}: 0;"
					>
						{#each item.children as child}
							<div
								class={child.disabled ? disabledClass : itemClass}
								role="menuitem"
								title={child.tooltip ?? ''}
								on:click={() => run(child)}
							>
								{child.label}
							</div>
						{/each}
					</div>
				{/if}
			</div>
		{:else}
			<div
				class="{item.disabled ? disabledClass : itemClass} {item.danger && !item.disabled ? 'text-red-500' : ''}"
				role="menuitem"
				title={item.tooltip ?? ''}
				on:mouseenter={() => (openSub = null)}
				on:click={() => run(item)}
			>
				{item.label}
			</div>
		{/if}
	{/each}
</div>
