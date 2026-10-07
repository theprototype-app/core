<script>
	// 36-export (U4) — THE PUBLISH / EXPORT MODAL: one burger item, three tabs.
	//   Publish  — the cloud plugin's flow, mounted into the tab (cloudApi `mountPublish`); the
	//              OSS app has none and says where publishing lives instead
	//   Export   — core's own: a self-contained static game (itch.io / static host / embed)
	//   Community gallery — 36-share: a pull-request submission to the community-gallery repo
	//   Settings — the export defaults (ExportSettingsSection, also in Settings ▸ Export)
	// Non-modal like every app dialog (the chrome above --z-modal stays clickable).
	// 38 R7: the shared ModalDialog (WindowChrome size="modal") with the kit Tabs in the strip
	// under the header — ids `publish-export-tab-<id>` are the Tabs' own (idPrefix).
	import { untrack } from 'svelte';
	import ModalDialog from '../ui/ModalDialog.svelte';
	import Tabs from '../ui/Tabs.svelte';
	import { publishExportOpen, publishExportTab, publishSlot } from '$lib/export/exportStores.js';
	import { hidePanels, restorePanels } from '../../stores/appStore.js';
	import CloudSlot from '../CloudSlot.svelte';
	import ExportPanel from './ExportPanel.svelte';
	import ExportSettingsSection from './ExportSettingsSection.svelte';
	import GallerySubmitPanel from './GallerySubmitPanel.svelte';

	const TABS = [
		{ id: 'publish', label: 'Publish' },
		{ id: 'export', label: 'Export' },
		{ id: 'gallery', label: 'Community gallery' },
		{ id: 'settings', label: 'Settings' }
	];

	// App mounts this only while the modal is open (lazy, the Profiler idiom): hide the editor
	// panels for its life and put them back when it goes
	$effect(() => {
		untrack(() => hidePanels());
		return () => untrack(() => restorePanels());
	});
</script>

<ModalDialog
	title="Publish / Export"
	bind:open={$publishExportOpen}
	onkeydown={(/** @type {KeyboardEvent} */ e) => {
		if (e.key === 'Escape') publishExportOpen.set(false);
	}}
	width="md"
	id="publish-export-modal"
	data-tab={$publishExportTab}
>
	{#snippet bar()}
		<Tabs
			tabs={TABS}
			idPrefix="publish-export"
			label="Publish or export"
			value={$publishExportTab}
			onchange={(/** @type {string} */ id) => publishExportTab.set(id)}
		/>
	{/snippet}
	<!-- the tabs mount only while open, so a plugin's Publish flow starts fresh on every open -->
	{#if $publishExportOpen}
		{#if $publishExportTab === 'publish'}
			<div id="publish-tab" role="tabpanel" aria-labelledby="publish-export-tab-publish">
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
			<div role="tabpanel" aria-labelledby="publish-export-tab-export"><ExportPanel /></div>
		{:else if $publishExportTab === 'gallery'}
			<div role="tabpanel" aria-labelledby="publish-export-tab-gallery"><GallerySubmitPanel /></div>
		{:else}
			<div role="tabpanel" aria-labelledby="publish-export-tab-settings"><ExportSettingsSection /></div>
		{/if}
	{/if}
</ModalDialog>

<style>
	.pe-oss {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		font-size: var(--fs-body);
		line-height: 1.5;
		color: var(--text-2);
	}
	.pe-oss p {
		margin: 0;
	}
	.pe-oss a,
	.pe-link {
		padding: 0;
		border: 0;
		background: none;
		font: inherit;
		color: var(--accent-text);
		text-decoration: underline;
		cursor: pointer;
	}
</style>
