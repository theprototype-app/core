<script context="module">
	// what the I4 settings search matches this section by, beyond its row names
	export const keywords = ['node', 'nodes', 'node types', 'node manager', 'palette', 'hide', 'disable', 'enable', 'flow', 'catalog'];
</script>

<script>
	// 36 B7: THE NODE MANAGER — switch node types off on this device. A switched-off type
	// leaves the node palette, the add menus and the node search; nodes of that type already
	// in a graph keep working (a graph is shared, this preference is not). The disabledModules
	// pattern: a persisted list, one switch per row, a group switch for the whole group.
	import { nodeCatalog } from '$lib/nodeCatalog';
	import { moduleNodeGroups } from '$lib/moduleSDK';
	import { disabledNodeTypes, setNodeTypesEnabled } from '$lib/nodeTypePrefs';
	import { flowGraphs } from '../../stores/flowStore';

	let filter = '';
	/** @type {{group: string, items: {type: string, label: string}[]}[]} */
	let groups = [];
	$: groups = [...nodeCatalog, ...$moduleNodeGroups];
	$: used = (() => {
		/** @type {Record<string, number>} */
		const counts = {};
		for (const g of Object.values($flowGraphs ?? {})) for (const n of /** @type {any} */ (g).nodes ?? []) counts[n.type] = (counts[n.type] ?? 0) + 1;
		return counts;
	})();
	$: q = filter.trim().toLowerCase();
	$: shown = groups
		.map((g) => ({ ...g, items: g.items.filter((i) => !q || (i.label + ' ' + i.type + ' ' + g.group).toLowerCase().includes(q)) }))
		.filter((g) => g.items.length);
	$: offCount = $disabledNodeTypes.length;

	/** @param {Event} e */
	const checked = (e) => /** @type {HTMLInputElement} */ (e.currentTarget).checked;
</script>

<div id="node-types-section" class="flex flex-col gap-2" data-keywords={keywords.join(' ')}>
	<p class="text-xs text-gray-500 dark:text-gray-400">
		Switch off the node types you never use — they leave the palette, the add menus and the node search
		on this device. Nodes already in a graph keep working.
	</p>
	<div class="flex items-center gap-2">
		<input id="node-types-filter" class="ui-input flex-1" placeholder="Filter node types…" bind:value={filter} />
		<button
			id="node-types-enable-all"
			class="shrink-0 rounded-sm bg-gray-600 px-2 py-1 text-xs text-white hover:bg-gray-500 disabled:opacity-50"
			disabled={!offCount}
			on:click={() => disabledNodeTypes.set([])}>Turn all on{offCount ? ` (${offCount} off)` : ''}</button
		>
	</div>
	<div class="grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2 lg:grid-cols-3">
		{#each shown as group (group.group)}
			{@const types = group.items.map((i) => i.type)}
			{@const allOn = types.every((t) => !$disabledNodeTypes.includes(t))}
			<div class="node-type-group mb-1" data-group={group.group}>
				<label class="flex items-center gap-2 text-xs font-semibold uppercase text-gray-400">
					<input
						class="tp-check node-type-group-toggle"
						type="checkbox"
						checked={allOn}
						on:change={(e) => setNodeTypesEnabled(types, checked(e))}
					/>
					{group.group}
				</label>
				{#each group.items as item (item.type)}
					<label class="ml-5 flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300" data-node-type={item.type}>
						<input
							class="tp-check node-type-toggle"
							type="checkbox"
							checked={!$disabledNodeTypes.includes(item.type)}
							on:change={(e) => setNodeTypesEnabled([item.type], checked(e))}
						/>
						<span>{item.label}</span>
						{#if used[item.type]}<span class="text-[10px] text-gray-500">· {used[item.type]} in use</span>{/if}
					</label>
				{/each}
			</div>
		{/each}
	</div>
</div>
