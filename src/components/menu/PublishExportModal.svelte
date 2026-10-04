<script>
	// 36-export (U4) — THE PUBLISH / EXPORT MODAL: one burger item, three tabs.
	//   Publish  — the cloud plugin's flow, mounted into the tab (cloudApi `mountPublish`); the
	//              OSS app has none and says where publishing lives instead
	//   Export   — core's own: a self-contained static game (itch.io / static host / embed)
	//   Settings — the export defaults (ExportSettingsSection, also in Settings ▸ Export)
	// Non-modal like every app dialog (the chrome above --z-modal stays clickable).
	import { untrack } from 'svelte';
	import { Modal } from 'flowbite-svelte';
	import { publishExportOpen, publishExportTab, publishSlot } from '$lib/export/exportStores.js';
	import { hidePanels, restorePanels } from '../../stores/appStore.js';
	import CloudSlot from '../CloudSlot.svelte';
	import ExportPanel from './ExportPanel.svelte';
	import ExportSettingsSection from './ExportSettingsSection.svelte';

	const TABS = [
		{ id: 'publish', label: 'Publish' },
		{ id: 'export', label: 'Export' },
		{ id: 'settings', label: 'Settings' }
	];

	// App mounts this only while the modal is open (lazy, the Profiler idiom): hide the editor
	// panels for its life and put them back when it goes
	$effect(() => {
		untrack(() => hidePanels());
		return () => untrack(() => restorePanels());
	});
</script>

<Modal
	title="Publish / Export"
	bind:open={$publishExportOpen}
	modal={false}
	onkeydown={(/** @type {KeyboardEvent} */ e) => {
		if (e.key === 'Escape') publishExportOpen.set(false);
	}}
	outsideclose
	size="md"
	class="tp-modal-frame"
	classes={{ header: 'tp-modal-header', body: 'tp-modal-body flex-1' }}
>
	<!-- the tabs mount only while open, so a plugin's Publish flow starts fresh on every open -->
	{#if $publishExportOpen}
	<div id="publish-export-modal" class="pe-wrap" data-tab={$publishExportTab}>
		<div class="pe-tabs" role="tablist">
			{#each TABS as t (t.id)}
				<button
					id={'publish-export-tab-' + t.id}
					type="button"
					class="pe-tab"
					class:active={$publishExportTab === t.id}
					role="tab"
					aria-selected={$publishExportTab === t.id}
					onclick={() => publishExportTab.set(t.id)}>{t.label}</button
				>
			{/each}
		</div>
		{#if $publishExportTab === 'publish'}
			<div id="publish-tab" role="tabpanel">
				{#if $publishSlot}
					<CloudSlot mount={$publishSlot} />
				{:else}
					<div id="publish-oss" class="pe-oss">
						<p>Publishing — a share link that opens straight into Play, likes, comments and contests — lives on the hosted app at <a href="https://theprototype.app" target="_blank" rel="noopener">theprototype.app</a>.</p>
						<p>The <button type="button" class="pe-link" onclick={() => publishExportTab.set('export')}>Export</button> tab works everywhere: it turns this scene into a zip you can put on itch.io or any static host.</p>
					</div>
				{/if}
			</div>
		{:else if $publishExportTab === 'export'}
			<div role="tabpanel"><ExportPanel /></div>
		{:else}
			<div role="tabpanel"><ExportSettingsSection /></div>
		{/if}
	</div>
	{/if}
</Modal>

<style>
	.pe-wrap {
		padding: 0.25rem;
	}
	.pe-tabs {
		display: flex;
		gap: 0.25rem;
		margin-bottom: 0.85rem;
		border-bottom: 1px solid var(--border, rgb(75 85 99 / 0.6));
	}
	.pe-tab {
		padding: 0.4rem 1.1rem;
		font-size: 0.82rem;
		font-weight: 600;
		color: var(--muted, rgb(156 163 175));
		background: none;
		border: 0;
		border-bottom: 2px solid transparent;
		margin-bottom: -1px;
		cursor: pointer;
	}
	.pe-tab:hover {
		color: var(--text, rgb(229 231 235));
	}
	.pe-tab.active {
		color: var(--text, #fff);
		border-bottom-color: var(--accent, #2563eb);
	}
	.pe-oss {
		display: flex;
		flex-direction: column;
		gap: 8px;
		font-size: 13px;
		color: var(--text-2, #d1d5db);
		line-height: 1.45;
	}
	.pe-oss a,
	.pe-link {
		color: var(--accent, #60a5fa);
		text-decoration: underline;
		background: none;
		border: 0;
		padding: 0;
		cursor: pointer;
		font: inherit;
	}
</style>
