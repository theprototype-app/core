<script module>
	import { registerSettingsKeywords } from '$lib/settingsSearch';
	const ROW_WORDS = {
		'cached downloads': [
			'cache',
			'opfs',
			'offline',
			'packs',
			'skies',
			'hdri',
			'textures',
			'downloads',
			'clear'
		],
		'cache size limit': ['cap', 'limit', 'quota', 'lru', 'size'],
		'keep on this device': ['persist', 'persistent', 'eviction', 'storage'],
		'storage breakdown': ['disk', 'space', 'quota', 'storage']
	};
	for (const [row, words] of Object.entries(ROW_WORDS)) registerSettingsKeywords(row, words);
</script>

<script>
	// 60 Q6 — Settings ▸ Storage: the LOCAL ASSET CACHE (assetCache.js, OPFS) — what it holds,
	// its size limit, Clear, and whether the browser was asked to keep it. LOCAL, never replicated.
	import { onMount } from 'svelte';
	import Section from '../../ui/Section.svelte';
	import SettingRow from '../../ui/SettingRow.svelte';
	import Segmented from '../../ui/Segmented.svelte';
	import Button from '../../ui/Button.svelte';
	import { settingsOpen } from '../../../stores/appStore.js';
	import {
		assetCacheIndex,
		assetCacheBackend,
		assetCacheCapMB,
		assetCacheReady,
		clearAssetCache,
		persistState,
		refreshPersistState,
		requestPersist
	} from '$lib/assetCache';
	import { usageOf, CAP_CHOICES_MB } from '$lib/assetCacheCore.js';
	import { fmtBytes, openStorageModal } from '$lib/storageUsage';

	const CAPS = CAP_CHOICES_MB.map((mb) => ({
		value: String(mb),
		label: mb >= 1024 ? mb / 1024 + ' GB' : mb + ' MB'
	}));
	const KIND_LABELS = /** @type {Record<string, string>} */ ({
		pack: 'packs',
		sky: 'skies',
		texture: 'converted textures',
		import: 'downloads'
	});

	const usage = $derived(usageOf($assetCacheIndex));
	const parts = $derived(
		Object.entries(usage.byKind)
			.filter(([, b]) => b > 0)
			.map(([k, b]) => KIND_LABELS[k] + ' ' + fmtBytes(b))
			.join(' · ')
	);
	let busy = $state(false);
	let cleared = $state('');

	onMount(() => {
		void assetCacheReady();
		void refreshPersistState();
	});

	async function clear() {
		busy = true;
		try {
			const freed = await clearAssetCache();
			cleared = 'Freed ' + fmtBytes(freed) + '.';
		} finally {
			busy = false;
		}
	}
</script>

<div class="settings-page-body" data-keywords="storage cache offline opfs">
	<Section variant="card" label="Asset cache" badge="This device">
		<SettingRow id="row-asset-cache" label="Cached downloads" wide>
			{#snippet desc()}
				<span id="asset-cache-usage">
					{#if $assetCacheBackend === 'none'}
						This browser gives the page no storage to keep files in, so everything is downloaded
						each time.
					{:else}
						{fmtBytes(usage.bytes)} in {usage.blobs}
						{usage.blobs === 1 ? 'file' : 'files'}{parts ? ' — ' + parts : ''}. Packs, skies,
						converted textures and downloads are kept so they load again without the network. The
						app itself is never kept here, so updates always arrive.
					{/if}
					{#if cleared}<span class="asset-cache-cleared"> {cleared}</span>{/if}
				</span>
			{/snippet}
			<Button
				id="asset-cache-clear"
				size="sm"
				variant="outline"
				disabled={busy || usage.keys === 0}
				onclick={clear}>Clear</Button
			>
		</SettingRow>
		<SettingRow
			id="row-asset-cache-cap"
			label="Cache size limit"
			description="When the cache grows past this, the files used longest ago are removed first."
			wide
		>
			<Segmented
				id="asset-cache-cap"
				label="Cache size limit"
				options={CAPS}
				value={String($assetCacheCapMB)}
				onchange={(v) => assetCacheCapMB.set(Number(v))}
			/>
		</SettingRow>
		<SettingRow id="row-asset-cache-persist" label="Keep on this device" wide>
			{#snippet desc()}
				<span id="asset-cache-persist-state">
					{#if $persistState === 'granted'}
						The browser keeps this storage even when it is short of space.
					{:else if $persistState === 'unsupported'}
						This browser decides by itself when to clear site storage.
					{:else}
						The browser may clear the cache when it is short of space. Asking lets it keep it; some
						browsers decide by how often you visit.
					{/if}
				</span>
			{/snippet}
			{#if $persistState === 'not-granted'}
				<Button
					id="asset-cache-persist"
					size="sm"
					variant="outline"
					onclick={() => void requestPersist()}>Ask the browser</Button
				>
			{/if}
		</SettingRow>
		<SettingRow
			id="row-storage-breakdown"
			label="Storage breakdown"
			description="Everything this app keeps on the device, with ticks to reclaim what you no longer want."
		>
			<Button
				id="settings-storage-breakdown"
				size="sm"
				variant="outline"
				onclick={() => {
					settingsOpen.set(false);
					openStorageModal();
				}}>Show breakdown</Button
			>
		</SettingRow>
	</Section>
</div>

<style>
	.settings-page-body {
		display: contents;
	}
	.asset-cache-cleared {
		color: var(--text-muted);
	}
</style>
