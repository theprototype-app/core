<script>
	import {
		Drawer,
		Spinner,
		CloseButton,
		Select,
		Modal
	} from 'flowbite-svelte';
	import { peers, chatHidden, libraryClose, toggleExpand, loadingFile } from '../../stores/appStore.js';
	import { sineIn } from 'svelte/easing';
	import { loadFile } from '$lib/fileHandler.svelte';
	import { prefabs, loadPrefabs, instantiatePrefab, removePrefab, renamePrefab, exportPrefab, importPrefab } from '$lib/prefabs';
	import { onMount } from 'svelte';

	function downloadPrefab(prefab) {
		const blob = new Blob([exportPrefab(prefab)], { type: 'application/json' });
		const link = document.createElement('a');
		link.href = URL.createObjectURL(blob);
		link.download = prefab.name.replace(/[^\w-]+/g, '_') + '.prefab.json';
		link.click();
		URL.revokeObjectURL(link.href);
	}

	async function importPrefabFile(event) {
		const file = event.target.files?.[0];
		if (!file) return;
		await importPrefab(await file.text());
		event.target.value = '';
	}

	let item = $state();
	let attributionModal = $state(false);
	let select = $state();
	let selected = $state([]);
	let libraries = $state();
	let attribution = $state();

	onMount(async () => {
		loadPrefabs();
		// load library list on mount
		libraries = await loadFile('/library/libraryList.json');
		item = await loadFile('/library/cube_diorama/default.json');
		attribution = await loadFile('/library/cube_diorama/attribution.html');
		selected.name = 'cube_diorama';
		select = libraries[0].value;
	});

	let transitionParamsRight = {
		x: 320,
		duration: 200,
		easing: sineIn
	};

	// Drawer show full screen
	let drawerStyle = $state();

	$effect(() => {
		if ($chatHidden === '') {
			drawerStyle = 'bottom: 350px; z-index: 48; border-bottom-left-radius: 0.5rem;';
		} else {
			drawerStyle = 'bottom: 0px; z-index: 48';
		}
	});
</script>

<Drawer
	style={drawerStyle}
	activateClickOutside={false}
	backdrop={false}
	placement="right"
	height="full"
	position="fixed"
	rightOffset="end-0 top-16"
	leftOffset="start-0 "
	topOffset="top-16"
	transitionType="fly"
	transitionParams={transitionParamsRight}
	bind:hidden={$libraryClose}
	class="rounded-tl-lg"
	id="sidebar-light"
>
	<div class="flex items-center">
		<h5
			id="drawer-label"
			class="mb-4 inline-flex items-center text-base font-semibold text-gray-500 dark:text-gray-400"
		>
			Library
		</h5>
		<CloseButton
			on:click={() => {
				libraryClose.set(true);
				
			}}
			class="mb-4 dark:text-white"
		/>
	</div>

	<div class="mb-3">
		<div class="flex items-center justify-between">
			<p class="text-sm font-semibold text-gray-500 dark:text-gray-300">Your prefabs</p>
			<button
				class="rounded bg-gray-600 px-2 py-0.5 text-xs text-white"
				title="Import a .prefab.json file"
				onclick={() => document.getElementById('import-prefab').click()}
			>
				Import
			</button>
			<input type="file" id="import-prefab" style="display: none" accept=".json" onchange={importPrefabFile} />
		</div>
		{#if $prefabs.length === 0}
			<p class="pt-1 text-xs italic text-gray-400">
				Right-click an object → "Save as prefab" to collect reusable assets here.
			</p>
		{:else}
			<div class="grid grid-cols-3 gap-2 pt-2">
				{#each $prefabs as prefab (prefab.id)}
					<div class="prefab-card relative">
						<button title="Add to scene" onclick={() => instantiatePrefab(prefab)}>
							{#if prefab.thumbnail}
								<img src={prefab.thumbnail} alt={prefab.name} class="h-14 w-14 rounded dark:border-gray-800" />
							{:else}
								<div class="flex h-14 w-14 items-center justify-center rounded bg-gray-600">📦</div>
							{/if}
						</button>
						<p
							class="max-w-14 overflow-hidden text-ellipsis whitespace-nowrap text-xs text-white dark:text-slate-200"
							title="Double-click to rename"
							ondblclick={() => {
								const name = prompt('Prefab name', prefab.name);
								if (name) renamePrefab(prefab.id, name);
							}}
						>
							{prefab.name}
						</p>
						<div class="absolute -right-1 -top-1 flex gap-0.5">
							<button class="rounded bg-gray-700 px-1 text-[10px]" title="Export" onclick={() => downloadPrefab(prefab)}>⬇</button>
							<button class="rounded bg-gray-700 px-1 text-[10px]" title="Delete" onclick={() => removePrefab(prefab.id)}>✕</button>
						</div>
					</div>
				{/each}
			</div>
		{/if}
	</div>

	<div class="mb-4 inline-flex w-full items-center rounded-md shadow-sm">
		<Select
			underline
			class="mt-2"
			items={libraries}
			bind:value={select}
			placeholder="Select Library"
			onchange={async (event) => {
				item = await loadFile(event.srcElement.value);
				selected = libraries.find((item) => item.value === event.srcElement.value);
				if (selected) {
					attribution = await loadFile(selected.attribution);
				}
			}}
		/>
		<input
			type="file"
			id="load-library"
			style="display: none"
			onchange={(e) => loadFile(e.target.files[0])}
			accept=".json, .gltf"
		/>
		<!-- <button
			type="button"
			class="inline-flex rounded-md shadow-sm"
			onclick={() => document.getElementById('load-library').click()}
		>
			📁
		</button> -->
	</div>

	<p class="items-center pb-4 italic text-white dark:text-slate-200">
		{selected?.copyright ? selected.copyright : 'Library details'}
		<i
			onclick={() => (attributionModal = true)}
			class="fa-solid fa-circle-info rounded-full border-2 border-blue-400 text-blue-500"
		></i>
	</p>

	{#each item as object}
		{#if object.variants['glTF-Binary']}
			<br />
			{#if $loadingFile.includes(object.name)}
				<button>
					<div class="h-14 w-14 dark:border-gray-800 animate-pulse">
						<Spinner size={14}  />
					</div>
					<p class="pb-4 text-white dark:text-slate-200 animate-pulse">{object.name}</p>
				</button>
			{:else}
			<button
				onclick={() => {
					let url = `/library/${selected.name}/${object.name}/glTF-Binary/${object.variants['glTF-Binary']}`;
					$loadingFile.push(object.name);
					$loadingFile = $loadingFile
					loadFile(url, object.name);
				}}
			>
				<img
					src={`/library/${selected.name}/${object.name}/${object.screenshot}`}
					class="h-14 w-14 dark:border-gray-800"
				/>
				<p class="pb-4 text-white dark:text-slate-200">{object.name}</p>
			</button>
			{/if}
		{/if}
	{/each}
</Drawer>

<Modal title={selected?.name} bind:open={attributionModal} autoclose>
	<div class="modal-content max-h-[90vh] overflow-y-auto p-4">
		<p class="pb-4 text-white dark:text-slate-200">{@html attribution}</p>
	</div>
</Modal>
