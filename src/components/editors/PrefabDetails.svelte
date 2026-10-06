<script>
	// 37 R4: the Library's own facts about a prefab in its Properties pane — where it is
	// filed, its tags, its placed copies in this scene, and the flow logic it carries.
	import { X } from '@lucide/svelte';
	import { prefabs } from '$lib/prefabs';
	import { setPrefabTags, prefabFolder, prefabTagFilter } from '$lib/prefabLibrary';
	import { parseTags } from '$lib/prefabLibraryCore';
	import { prefabInstanceCounts, updateInstances, selectInstances } from '$lib/prefabLinks';
	import { buildTpnode, tpnodeFileName } from '$lib/tpnode';

	/** @type {{ prefabId: string }} */
	let { prefabId } = $props();

	const prefab = $derived($prefabs.find((p) => p.id === prefabId) ?? null);
	const count = $derived($prefabInstanceCounts[prefabId] ?? 0);
	const graphs = $derived(Object.entries(prefab?.graphs ?? {}));
	const nodeCount = $derived(graphs.reduce((n, [, g]) => n + (g?.nodes?.length ?? 0), 0));
	let draft = $state('');

	function addTags() {
		if (!prefab) return;
		const add = parseTags(draft);
		draft = '';
		if (add.length) void setPrefabTags(prefab.id, [...(prefab.tags ?? []), ...add]);
	}
	/** @param {string} tag */
	function dropTag(tag) {
		if (prefab) void setPrefabTags(prefab.id, (prefab.tags ?? []).filter((/** @type {string} */ t) => t !== tag));
	}
	/** a carried graph as a .tpnode file — the same payload a node group saves */
	function exportLogic() {
		if (!prefab || !graphs.length) return;
		const nodes = graphs.flatMap(([, g]) => g.nodes ?? []);
		const edges = graphs.flatMap(([, g]) => g.edges ?? []);
		const doc = buildTpnode({ nodes, edges }, prefab.name + ' logic', { app: 'theprototype.app' });
		const url = URL.createObjectURL(new Blob([JSON.stringify(doc, null, 1)], { type: 'application/json' }));
		const a = document.createElement('a');
		a.href = url;
		a.download = tpnodeFileName(prefab.name + ' logic');
		a.click();
		setTimeout(() => URL.revokeObjectURL(url), 1000);
	}
</script>

{#if prefab}
	<div id="prefab-details" class="flex flex-col gap-1">
		<div class="flex gap-2">
			<span class="w-14 shrink-0 text-gray-500">Folder</span>
			<button
				id="prefab-folder-path"
				class="min-w-0 truncate text-left hover:underline"
				title="Show this folder"
				onclick={() => {
					prefabTagFilter.set([]);
					prefabFolder.set(prefab.folder ?? '');
				}}>{prefab.folder ? 'Prefabs/' + prefab.folder : 'Prefabs'}</button
			>
		</div>
		<div class="flex gap-2">
			<span class="w-14 shrink-0 text-gray-500">Tags</span>
			<div class="flex min-w-0 flex-1 flex-wrap items-center gap-1">
				{#each prefab.tags ?? [] as tag (tag)}
					<span class="prefab-tag" data-tag={tag}
						>{tag}<button class="prefab-tag-x" aria-label={'Remove the tag ' + tag} onclick={() => dropTag(tag)}
							><X size={10} aria-hidden="true" /></button
						></span
					>
				{/each}
				<input
					id="prefab-tag-input"
					class="min-w-16 flex-1 rounded-sm border border-gray-600 bg-transparent px-1 text-[11px]"
					placeholder="Add tags…"
					title="Type a tag (or several, separated by commas) and press Enter"
					bind:value={draft}
					onkeydown={(e) => {
						e.stopPropagation();
						if (e.key === 'Enter') addTags();
					}}
					onblur={addTags}
				/>
			</div>
		</div>
		<div class="flex gap-2">
			<span class="w-14 shrink-0 text-gray-500">In scene</span>
			<span id="prefab-instances" class="flex min-w-0 flex-wrap items-center gap-1"
				>{count} cop{count === 1 ? 'y' : 'ies'} · version {(prefab.rev ?? 0) + 1}
				{#if count}
					<button class="text-primary-400 hover:underline" onclick={() => void updateInstances(prefab.id)}>Update all</button>
					<button class="text-primary-400 hover:underline" onclick={() => selectInstances(prefab.id)}>Select</button>
				{/if}</span
			>
		</div>
		{#if graphs.length}
			<div class="flex gap-2">
				<span class="w-14 shrink-0 text-gray-500">Logic</span>
				<span id="prefab-logic" class="flex min-w-0 flex-wrap items-center gap-1"
					>{nodeCount} node{nodeCount === 1 ? '' : 's'} in {graphs.length} flow{graphs.length === 1 ? '' : 's'}
					<button id="prefab-logic-export" class="text-primary-400 hover:underline" title="Save the logic as a node group (.tpnode)" onclick={exportLogic}
						>Export .tpnode</button
					></span
				>
			</div>
		{/if}
	</div>
{/if}

<style>
	.prefab-tag {
		display: inline-flex;
		align-items: center;
		gap: 0.15rem;
		border: 1px solid rgb(75 85 99);
		border-radius: 9999px;
		padding: 0 0.15rem 0 0.4rem;
		line-height: 1.1rem;
	}
	.prefab-tag-x {
		border-radius: 9999px;
		padding: 0.1rem;
		opacity: 0.7;
	}
	.prefab-tag-x:hover {
		opacity: 1;
		background: rgb(75 85 99);
	}
</style>
