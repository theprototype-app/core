<script>
	import { Boxes, Download, Upload } from '@lucide/svelte';
	// Library (phase 65): tabs for user prefabs and built-in packs, one uniform
	// card grid, search, skeleton loading states. All prefab/pack flows are the
	// same functions as before — this is chrome only.
	import { Modal } from 'flowbite-svelte';
	import { fly } from 'svelte/transition';
	import { libraryClose, loadingFile } from '../../stores/appStore.js';
	import { sineIn } from 'svelte/easing';
	import { loadFile } from '$lib/fileHandler.svelte';
	import {
		prefabs,
		loadPrefabs,
		instantiatePrefab,
		removePrefab,
		renamePrefab,
		exportPrefab,
		importPrefab
	} from '$lib/prefabs';
	import PanelHeader from '../ui/PanelHeader.svelte';
	import { onMount } from 'svelte';

	/** @param {any} prefab */
	function downloadPrefab(prefab) {
		const blob = new Blob([exportPrefab(prefab)], { type: 'application/json' });
		const link = document.createElement('a');
		link.href = URL.createObjectURL(blob);
		link.download = prefab.name.replace(/[^\w-]+/g, '_') + '.prefab.json';
		link.click();
		URL.revokeObjectURL(link.href);
	}

	/** @param {any} event */
	async function importPrefabFile(event) {
		const file = event.target.files?.[0];
		if (!file) return;
		await importPrefab(await file.text());
		event.target.value = '';
	}

	// 126: prefabs live in the Explorer now — the Library opens on Packs
	let tab = $state('packs'); // 'prefabs' | 'packs'
	let query = $state('');
	let attributionModal = $state(false);

	/** @type {any} pack item list of the selected pack */
	let item = $state();
	/** @type {any[]} */
	let libraries = $state([]);
	/** @type {any} entry of libraryList.json currently shown */
	let selected = $state(null);
	/** @type {any} */
	let attribution = $state();
	let packError = $state('');

	/** @param {any} entry */
	async function openPack(entry) {
		selected = entry;
		packError = '';
		item = null;
		try {
			item = await loadFile(entry.value);
			attribution = await loadFile(entry.attribution);
		} catch (e) {
			packError = 'This pack failed to load. Check your connection and try again.';
		}
	}

	onMount(async () => {
		loadPrefabs();
		try {
			libraries = (await loadFile('/library/libraryList.json')) ?? [];
			if (libraries.length) openPack(libraries[0]);
		} catch (e) {
			packError = 'The pack list failed to load.';
		}
	});

	const match = (/** @type {string} */ name) =>
		!query || name?.toLowerCase().includes(query.toLowerCase());
	const filteredPrefabs = $derived(($prefabs ?? []).filter((p) => match(p.name)));
	const packItems = $derived(
		(Array.isArray(item) ? item : []).filter(
			(o) => o.variants?.['glTF-Binary'] && match(o.name)
		)
	);

	let transitionParamsRight = {
		x: 320,
		duration: 200,
		easing: sineIn
	};

	// side drawers live on the --z-drawer tier (68); chat floats on its own now.
	// bottom follows the docked Flow/Explorer height (105)
	const drawerStyle = 'bottom: var(--bottom-inset, 0px); z-index: var(--z-drawer); height: auto';

	const tabClass = (/** @type {boolean} */ active) =>
		'flex-1 rounded-md px-2 py-1 text-xs font-semibold ' +
		(active ? 'bg-primary-700 text-white' : 'bg-gray-700/60 text-gray-300 hover:bg-gray-600');
</script>

<!-- flowbite-svelte 1.x turned Drawer into a native <dialog> — this persistent side
     panel is a plain div reproducing the v0 drawer chrome exactly. -->
{#if !$libraryClose}
<div
	style={drawerStyle}
	transition:fly={transitionParamsRight}
	class="fixed inset-e-0 top-16 z-50 w-80 overflow-y-auto rounded-tl-lg bg-white p-4 dark:bg-gray-800"
	id="library-drawer"
>
	<PanelHeader title="Library" badge="Assets" onclose={() => libraryClose.set(true)} />

	<div class="flex flex-col gap-2">
		<input
			id="library-search"
			type="text"
			class="ui-input w-full"
			placeholder="Search assets…"
			value={query}
			oninput={(e) => (query = e.currentTarget.value)}
		/>

		<div class="flex gap-1">
			<button class={tabClass(tab === 'prefabs')} onclick={() => (tab = 'prefabs')}>
				Prefabs{$prefabs?.length ? ' (' + $prefabs.length + ')' : ''}
			</button>
			<button class={tabClass(tab === 'packs')} onclick={() => (tab = 'packs')}>Packs</button>
		</div>

		{#if tab === 'prefabs'}
			<div class="flex items-center justify-between pt-1">
				<p class="ui-section-label">Your prefabs</p>
				<button
					class="ui-button-quiet text-xs"
					title="Import a .prefab.json file"
					onclick={() => document.getElementById('import-prefab')?.click()}
				>
					<Upload size={16} class="mr-1" aria-hidden="true" />Import
				</button>
				<input
					type="file"
					id="import-prefab"
					style="display: none"
					accept=".json"
					onchange={importPrefabFile}
				/>
			</div>

			{#if !$prefabs?.length}
				<p class="rounded-lg border border-dashed border-gray-600 p-3 text-center text-xs italic text-gray-400">
					No prefabs yet — right-click an object → Save as prefab to collect reusable assets here.
				</p>
			{:else if !filteredPrefabs.length}
				<p class="p-2 text-center text-xs italic text-gray-400">No prefabs match “{query}”.</p>
			{:else}
				<div class="grid grid-cols-3 gap-2">
					{#each filteredPrefabs as prefab (prefab.id)}
						<div class="asset-card group relative flex flex-col items-center rounded-lg border border-gray-700/60 bg-gray-800/70 p-1.5 hover:border-gray-500">
							<button class="w-full" title="Add to scene" onclick={() => instantiatePrefab(prefab)}>
								{#if prefab.thumbnail}
									<img src={prefab.thumbnail} alt={prefab.name} class="aspect-square w-full rounded-sm object-cover" />
								{:else}
									<div class="ico-prefab flex aspect-square w-full items-center justify-center rounded-sm bg-gray-700"><Boxes size={24} aria-hidden="true" /></div>
								{/if}
							</button>
							<p
								class="w-full overflow-hidden text-ellipsis whitespace-nowrap pt-1 text-center text-[11px] text-gray-200"
								title="Double-click to rename"
								ondblclick={() => {
									const name = prompt('Prefab name', prefab.name);
									if (name) renamePrefab(prefab.id, name);
								}}
							>
								{prefab.name}
							</p>
							<div class="absolute -right-1 -top-1 hidden gap-0.5 group-hover:flex">
								<button class="rounded-sm bg-gray-700 px-1 text-[10px] hover:bg-gray-600" title="Export" onclick={() => downloadPrefab(prefab)}><Download size={16} aria-hidden="true" /></button>
								<button class="rounded-sm bg-gray-700 px-1 text-[10px] hover:bg-red-700" title="Delete" onclick={() => removePrefab(prefab.id)}>✕</button>
							</div>
						</div>
					{/each}
				</div>
			{/if}
		{:else}
			<div class="flex flex-wrap gap-1 pt-1">
				{#each libraries as entry}
					<button
						class={'ui-chip ' +
							(selected?.value === entry.value
								? 'bg-primary-600 text-white'
								: 'bg-gray-600 text-gray-200 hover:bg-gray-500')}
						onclick={() => openPack(entry)}
					>
						{entry.name}
					</button>
				{/each}
			</div>

			{#if selected}
				<div class="flex items-start justify-between gap-2">
					<p class="text-[10px] italic text-gray-400">{selected.copyright ?? ''}</p>
					<button
						class="ui-button-quiet shrink-0 text-xs"
						title="Attribution and license"
						onclick={() => (attributionModal = true)}
					>
						ⓘ
					</button>
				</div>
			{/if}

			{#if packError}
				<div class="rounded-lg border border-red-700/60 bg-red-900/20 p-3 text-center text-xs text-red-300">
					{packError}
					<button class="mt-1 block w-full text-primary-400 underline" onclick={() => selected && openPack(selected)}>
						Retry
					</button>
				</div>
			{:else if !item}
				<!-- pack list still loading: skeleton cards -->
				<div class="grid grid-cols-3 gap-2">
					{#each Array(6) as _}
						<div class="animate-pulse rounded-lg border border-gray-700/60 bg-gray-800/70 p-1.5">
							<div class="aspect-square w-full rounded-sm bg-gray-700"></div>
							<div class="mx-auto mt-1.5 h-2 w-2/3 rounded-sm bg-gray-700"></div>
						</div>
					{/each}
				</div>
			{:else if !packItems.length}
				<p class="p-2 text-center text-xs italic text-gray-400">
					{query ? 'No assets match “' + query + '”.' : 'This pack has no loadable assets.'}
				</p>
			{:else}
				<div class="grid grid-cols-3 gap-2">
					{#each packItems as object (object.name)}
						{#if $loadingFile.includes(object.name)}
							<div class="animate-pulse rounded-lg border border-gray-700/60 bg-gray-800/70 p-1.5">
								<div class="aspect-square w-full rounded-sm bg-gray-700"></div>
								<p class="overflow-hidden text-ellipsis whitespace-nowrap pt-1 text-center text-[11px] text-gray-400">
									{object.name}
								</p>
							</div>
						{:else}
							<button
								class="asset-card flex flex-col items-center rounded-lg border border-gray-700/60 bg-gray-800/70 p-1.5 hover:border-gray-500"
								title="Add to scene"
								onclick={() => {
									let url = `/library/${selected.name}/${object.name}/glTF-Binary/${object.variants['glTF-Binary']}`;
									$loadingFile.push(object.name);
									$loadingFile = $loadingFile;
									loadFile(url, object.name);
								}}
							>
								<img
									src={`/library/${selected.name}/${object.name}/${object.screenshot}`}
									alt={object.name}
									loading="lazy"
									class="aspect-square w-full rounded-sm object-cover"
								/>
								<p class="w-full overflow-hidden text-ellipsis whitespace-nowrap pt-1 text-center text-[11px] text-gray-200">
									{object.name}
								</p>
							</button>
						{/if}
					{/each}
				</div>
			{/if}
		{/if}
	</div>
</div>
{/if}

<Modal title={selected?.name} bind:open={attributionModal} autoclose>
	<div class="modal-content max-h-[90vh] overflow-y-auto p-4">
		<p class="pb-4 text-white dark:text-slate-200">{@html attribution}</p>
	</div>
</Modal>
