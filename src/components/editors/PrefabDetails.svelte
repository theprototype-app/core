<script>
	// 37 R4: the Library's own facts about a prefab in its Properties pane — where it is
	// filed, its tags, its placed copies in this scene, and the flow logic it carries. Built
	// from the 38 kit (Badge, Button, Icon, tokens).
	import Badge from '../ui/Badge.svelte';
	import Button from '../ui/Button.svelte';
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
	/** the carried graphs as a .tpnode file — the same payload a node group saves */
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
	<div id="prefab-details" class="pd">
		<div class="pd-row">
			<span class="pd-label">Folder</span>
			<Button
				id="prefab-folder-path"
				variant="ghost"
				size="sm"
				icon="folder"
				title="Show this folder"
				text={prefab.folder ? 'Prefabs / ' + prefab.folder.split('/').join(' / ') : 'Prefabs'}
				onclick={() => {
					prefabTagFilter.set([]);
					prefabFolder.set(prefab.folder ?? '');
				}}
			/>
		</div>
		<div class="pd-row">
			<span class="pd-label">Tags</span>
			<div class="pd-tags">
				{#each prefab.tags ?? [] as tag (tag)}
					<span class="prefab-tag" data-tag={tag}>
						<Badge tone="neutral" text={tag} />
						<Button variant="icon" size="sm" icon="x" label={'Remove the tag ' + tag} onclick={() => dropTag(tag)} />
					</span>
				{/each}
				<input
					id="prefab-tag-input"
					class="pd-input"
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
		<div class="pd-row">
			<span class="pd-label">In scene</span>
			<span id="prefab-instances" class="pd-value">
				<Badge tone="count" text={String(count)} />
				<span>cop{count === 1 ? 'y' : 'ies'} · version {(prefab.rev ?? 0) + 1}</span>
				{#if count}
					<Button variant="ghost" size="sm" text="Update all" onclick={() => void updateInstances(prefab.id)} />
					<Button variant="ghost" size="sm" text="Select" onclick={() => selectInstances(prefab.id)} />
				{/if}
			</span>
		</div>
		{#if graphs.length}
			<div class="pd-row">
				<span class="pd-label">Logic</span>
				<span id="prefab-logic" class="pd-value">
					<span>{nodeCount} node{nodeCount === 1 ? '' : 's'} in {graphs.length} flow{graphs.length === 1 ? '' : 's'}</span>
					<Button id="prefab-logic-export" variant="ghost" size="sm" icon="arrow-down-to-line" text="Export .tpnode" title="Save the logic as a node group (.tpnode)" onclick={exportLogic} />
				</span>
			</div>
		{/if}
	</div>
{/if}

<style>
	.pd {
		display: flex;
		flex-direction: column;
		gap: var(--space-1, 4px);
	}
	.pd-row {
		display: flex;
		align-items: center;
		gap: var(--space-2, 8px);
		min-height: 28px;
	}
	.pd-label {
		width: 3.5rem;
		flex-shrink: 0;
		color: var(--text-faint);
	}
	.pd-value,
	.pd-tags {
		display: flex;
		min-width: 0;
		flex: 1;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-1, 4px);
		color: var(--text-2);
	}
	.prefab-tag {
		display: inline-flex;
		align-items: center;
	}
	.pd-input {
		min-width: 4rem;
		flex: 1;
		height: 26px;
		padding: 0 var(--space-2, 8px);
		border: 1px solid var(--border-input);
		border-radius: 6px;
		background: var(--surface-inset);
		color: var(--text);
		font: inherit;
		font-size: var(--fs-input);
	}
	.pd-input:focus {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}
</style>
