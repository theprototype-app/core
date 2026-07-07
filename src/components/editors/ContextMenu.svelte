<script lang="ts">
	import { createEventDispatcher } from 'svelte';
	import { nodeCatalog } from '$lib/nodeCatalog';

	// menu: { kind: 'pane' | 'node' | 'edge', x, y, ... }
	export let menu: any;

	const dispatch = createEventDispatcher();
	let openGroup: string | null = null;
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
	style="left: {menu.x}px; top: {menu.y}px; transform: translateY(-100%); z-index: 1000;"
	role="menu"
>
	{#if menu.kind === 'pane'}
		{#each nodeCatalog as group}
			<div
				class="relative cursor-pointer px-3 py-1.5 hover:bg-gray-100 dark:hover:bg-gray-600"
				role="menuitem"
				on:mouseenter={() => (openGroup = group.group)}
			>
				<span class="flex items-center justify-between gap-4">
					{group.group}
					<span class="text-gray-400">&#9654;</span>
				</span>
				{#if openGroup === group.group}
					<div
						class="absolute bottom-0 left-full min-w-36 rounded-lg border border-gray-200 bg-white py-1 shadow-lg dark:border-gray-600 dark:bg-gray-700"
					>
						{#each group.items as item}
							<div
								class="cursor-pointer px-3 py-1.5 hover:bg-gray-100 dark:hover:bg-gray-600"
								role="menuitem"
								on:click={() => dispatch('addnode', item)}
							>
								{item.label}
							</div>
						{/each}
					</div>
				{/if}
			</div>
		{/each}
	{:else if menu.kind === 'node'}
		<div
			class="cursor-pointer px-3 py-1.5 hover:bg-gray-100 dark:hover:bg-gray-600"
			role="menuitem"
			on:click={() => dispatch('disconnectnode')}
		>
			Disconnect all
		</div>
		<div
			class="cursor-pointer px-3 py-1.5 text-red-500 hover:bg-gray-100 dark:hover:bg-gray-600"
			role="menuitem"
			on:click={() => dispatch('deletenode')}
		>
			Delete node
		</div>
	{:else if menu.kind === 'edge'}
		<div
			class="cursor-pointer px-3 py-1.5 hover:bg-gray-100 dark:hover:bg-gray-600"
			role="menuitem"
			on:click={() => dispatch('deleteedge')}
		>
			Disconnect
		</div>
	{/if}
</div>
