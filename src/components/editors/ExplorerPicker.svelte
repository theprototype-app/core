<script>
	// 105 T1: THE Explorer picker — thumbnails, search, folders and recent picks over the library, one
	// component for every "From Explorer" in the app (lazy: $lib/explorerPick mounts it for one pick).
	// It only CHOOSES a record; the caller decides what the file becomes (a texture, a button image, ...).
	import ModalDialog from '../ui/ModalDialog.svelte';
	import SearchField from '../ui/SearchField.svelte';
	import ThemedSelect from '../ui/ThemedSelect.svelte';
	import EmptyState from '../ui/EmptyState.svelte';
	import Icon from '../ui/Icon.svelte';
	import { explorerItems, explorerFolders } from '$lib/explorer';
	import { filterPickerItems, pickerFolders, recentItems } from '$lib/explorerPickerCore.js';

	/** @type {{title: string, accept: string[], dialogId: string, recent: string[], done: (item: any) => void}} */
	let { title, accept, dialogId, recent, done } = $props();

	let open = $state(true);
	let query = $state('');
	let folder = $state('all');

	const folders = $derived(pickerFolders($explorerItems, $explorerFolders, accept));
	const folderItems = $derived([
		{ value: 'all', name: 'All folders' },
		{ value: 'root', name: 'Library (top level)' },
		...folders.map((f) => ({ value: f.id, name: f.path }))
	]);
	const everything = $derived(filterPickerItems($explorerItems, $explorerFolders, { accept }));
	const listed = $derived(filterPickerItems($explorerItems, $explorerFolders, { accept, query, folderId: folder }));
	const recents = $derived(query || folder !== 'all' ? [] : recentItems(recent, everything).slice(0, 6));

	// closing by Esc, the close button or an outside click is a cancel
	$effect(() => {
		if (!open) done(null);
	});

	/** @param {any} item */
	function choose(item) {
		open = false;
		done(item);
	}
</script>

{#snippet card(/** @type {any} */ item, /** @type {string} */ group)}
	<button type="button" class="xp-card" data-pick-id={item.id} data-pick-group={group} title={item.name} aria-label={'Use ' + item.name} onclick={() => choose(item)}>
		<span class="xp-thumb">
			{#if item.thumbnail}
				<img src={item.thumbnail} alt="" loading="lazy" />
			{:else}
				<Icon name="image" size={24} aria-hidden="true" />
			{/if}
		</span>
		<span class="xp-name">{item.name}</span>
	</button>
{/snippet}

<ModalDialog bind:open modal width="md" {title} id={dialogId} bodyClass="xp-body">
	{#snippet bar()}
		<div class="xp-bar">
			<div class="xp-search"><SearchField id={dialogId + '-search'} bind:value={query} placeholder="Search images" size="sm" data-autofocus /></div>
			<ThemedSelect id={dialogId + '-folder'} items={folderItems} bind:value={folder} clip={false} title="Folder" />
		</div>
	{/snippet}
	{#if !everything.length}
		<EmptyState icon="image" title="No images in the Explorer yet" description="Drop pictures into the Explorer, then pick them here." compact />
	{:else}
		{#if recents.length}
			<p class="ui-section-label">Recent</p>
			<div class="xp-grid" id={dialogId + '-recent'}>
				{#each recents as item (item.id)}{@render card(item, 'recent')}{/each}
			</div>
			<p class="ui-section-label">All images</p>
		{/if}
		{#if listed.length}
			<div class="xp-grid" id={dialogId + '-grid'}>
				{#each listed as item (item.id)}{@render card(item, 'all')}{/each}
			</div>
		{:else}
			<p id={dialogId + '-none'} class="py-6 text-center text-sm text-text-muted">Nothing here matches.</p>
		{/if}
	{/if}
</ModalDialog>

<style>
	.xp-bar {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 8px 12px;
		border-bottom: 1px solid var(--border);
	}
	.xp-search {
		flex: 1;
		min-width: 0;
	}
	.xp-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(88px, 1fr));
		gap: 8px;
		margin-bottom: 12px;
	}
	.xp-card {
		display: flex;
		flex-direction: column;
		align-items: stretch;
		gap: 4px;
		min-width: 0;
		padding: 4px;
		border: 1px solid transparent;
		border-radius: var(--radius-sm, 2px);
		background: transparent;
		color: var(--text-2);
		cursor: pointer;
	}
	.xp-card:hover {
		border-color: var(--border-strong);
		background: var(--surface-hover);
	}
	.xp-card:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}
	.xp-thumb {
		display: flex;
		align-items: center;
		justify-content: center;
		aspect-ratio: 1;
		overflow: hidden;
		border-radius: var(--radius-sm, 2px);
		background: var(--surface-inset);
		color: var(--text-faint);
	}
	.xp-thumb img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	.xp-name {
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
		font-size: var(--fs-badge);
		text-align: center;
	}
</style>
