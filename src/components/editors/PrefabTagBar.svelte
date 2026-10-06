<script>
	// 37 R4: the tag FILTER of the Library's prefab tab — one chip per tag in use, pressed
	// chips combine with AND. Drawn only while some prefab carries a tag: an empty strip is
	// a row of height that says nothing.
	import { Tag } from '@lucide/svelte';
	import { prefabs } from '$lib/prefabs';
	import { prefabTagFilter, toggleTagFilter } from '$lib/prefabLibrary';
	import { allTags } from '$lib/prefabLibraryCore';

	const tags = $derived(allTags($prefabs));
</script>

{#if tags.length}
	<div id="prefab-tag-bar" class="flex flex-wrap items-center gap-1 border-b border-gray-700/60 px-2 py-1 text-[11px] text-gray-300">
		<span class="text-gray-500" title="Filter prefabs by tag"><Tag size={12} aria-hidden="true" /></span>
		{#each tags as t (t.tag)}
			<button
				class="prefab-tag-chip"
				data-tag={t.tag}
				aria-pressed={$prefabTagFilter.includes(t.tag)}
				title={'Show only prefabs tagged "' + t.tag + '"'}
				onclick={() => toggleTagFilter(t.tag)}>{t.tag}<span class="prefab-tag-count">{t.count}</span></button
			>
		{/each}
		{#if $prefabTagFilter.length}
			<button id="prefab-tag-clear" class="rounded-sm px-1 text-gray-400 hover:bg-gray-700" onclick={() => prefabTagFilter.set([])}
				>Clear</button
			>
		{/if}
	</div>
{/if}

<style>
	.prefab-tag-chip {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		border: 1px solid rgb(75 85 99);
		border-radius: 9999px;
		padding: 0 0.4rem;
		line-height: 1.25rem;
	}
	.prefab-tag-chip:hover {
		border-color: var(--accent-fill, #2563eb);
	}
	.prefab-tag-chip[aria-pressed='true'] {
		background: var(--accent-fill, #2563eb);
		border-color: var(--accent-fill, #2563eb);
		color: var(--on-accent, #fff);
	}
	.prefab-tag-count {
		opacity: 0.65;
	}
</style>
