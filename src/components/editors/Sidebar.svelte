<script lang="ts">
	import { nodeCatalog } from '$lib/nodeCatalog';
	import { moduleNodeGroups } from '$lib/moduleSDK';

	const onDragStart = (event: DragEvent, nodeType: string) => {
		if (!event.dataTransfer) {
			return null;
		}
		event.dataTransfer.setData('application/svelteflow', nodeType);
		event.dataTransfer.effectAllowed = 'move';
	};

	$: catalog = [...nodeCatalog, ...$moduleNodeGroups];
</script>

<aside class="flex flex-col gap-2 p-2">
	<p class="text-center text-xs italic text-gray-400">Drag a node to the canvas</p>
	{#each catalog as group}
		<p class="mt-1 text-xs font-semibold uppercase text-gray-400">{group.group}</p>
		{#each group.items as node}
			<div
				class="cursor-grab rounded-2xl border border-solid border-gray-200 bg-white/70 shadow-[0_7px_9px_0_rgba(0,0,0,0.02)]"
				role="listitem"
				on:dragstart={(event) => onDragStart(event, node.type)}
				draggable={true}
			>
				<div
					class="family-mono rounded-2xl px-3 py-2 text-center font-mono text-xs font-semibold text-[#0F172A] dark:bg-gray-700 dark:text-gray-200"
				>
					{node.label}
				</div>
			</div>
		{/each}
	{/each}
</aside>
