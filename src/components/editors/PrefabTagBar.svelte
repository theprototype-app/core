<script>
	// 37 R4: the tag FILTER of the Library's prefab tab, on the 38 kit — one chip per tag in
	// use (Chips, multiple = AND), most used first. Drawn only while some prefab carries a tag:
	// an empty strip is a row of height that says nothing.
	import Chips from '../ui/Chips.svelte';
	import Button from '../ui/Button.svelte';
	import Icon from '../ui/Icon.svelte';
	import { prefabs } from '$lib/prefabs';
	import { prefabTagFilter } from '$lib/prefabLibrary';
	import { allTags } from '$lib/prefabLibraryCore';

	const options = $derived(
		allTags($prefabs).map((t) => ({ value: t.tag, label: t.tag, count: t.count, title: 'Show only prefabs tagged "' + t.tag + '"' }))
	);
</script>

{#if options.length}
	<div id="prefab-tag-bar" class="prefab-tag-bar">
		<span class="prefab-tag-bar-icon" title="Filter prefabs by tag"><Icon name="tag" size={16} /></span>
		<Chips
			label="Filter prefabs by tag"
			size="sm"
			multiple
			{options}
			values={$prefabTagFilter}
			onchange={(next) => prefabTagFilter.set(next)}
		/>
		{#if $prefabTagFilter.length}
			<Button id="prefab-tag-clear" variant="ghost" size="sm" text="Clear" onclick={() => prefabTagFilter.set([])} />
		{/if}
	</div>
{/if}

<style>
	.prefab-tag-bar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2, 8px);
		padding: var(--space-1, 4px) var(--space-2, 8px);
		border-bottom: 1px solid var(--border);
	}
	.prefab-tag-bar-icon {
		display: inline-flex;
		color: var(--text-faint);
	}
</style>
