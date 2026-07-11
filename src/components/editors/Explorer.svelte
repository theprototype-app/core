<script lang="ts">
	// Explorer (phase 95): dockable asset browser — folder tree on the left,
	// thumbnail grid on the right, drag files in to import. Shares the bottom
	// dock with the Flow editor as notebook tabs (bottomDock.js); undocks into
	// a floating window exactly like Flow.svelte.
	import { explorerClose, flowGraphClose } from '../../stores/appStore.js';
	import {
		explorerFolders,
		explorerItems,
		activeFolder,
		loadExplorer,
		createFolder,
		renameFolder,
		deleteFolder,
		moveItem,
		importFiles,
		deleteItem,
		renameItem,
		itemBlob
	} from '$lib/explorer';
	import { prefabs, loadPrefabs } from '$lib/prefabs';
	import { bottomDockActive, dockShared, setDockOccupant } from '$lib/bottomDock';
	import { dragWindow } from '$lib/dragWindow';
	import { focusStack } from '$lib/windowFocus';
	import { tabbable } from '$lib/windowTabs';
	import { dockable } from '$lib/docking';
	import ContextMenu from '../ContextMenu.svelte';
	import { fly } from 'svelte/transition';

	const clampH = (h: number) =>
		Math.min(Math.max(h || 300, 200), Math.round(window.innerHeight * 0.8));

	let height = $state(300);
	let docked = $state(true);
	let winW = $state(720);
	let winH = $state(440);
	if (typeof localStorage !== 'undefined') {
		height = clampH(parseInt(localStorage.getItem('explorerHeight') ?? '300'));
		docked = localStorage.getItem('explorerDocked') !== 'false';
		winW = parseInt(localStorage.getItem('explorerWinW') ?? '720') || 720;
		winH = parseInt(localStorage.getItem('explorerWinH') ?? '440') || 440;
	}
	loadExplorer();
	loadPrefabs();

	function setDocked(v: boolean) {
		docked = v;
		localStorage.setItem('explorerDocked', String(v));
	}

	// tabbed dock coexistence: report "docked + open" (+height for the 105
	// --bottom-inset), hide when Flow owns it
	$effect(() => {
		setDockOccupant('explorer', !$explorerClose && docked, height);
		return () => setDockOccupant('explorer', false);
	});
	const dockVisible = $derived(!$dockShared || $bottomDockActive === 'explorer');

	// --- docked: top-edge resize (Flow pattern) ---
	let resizing = $state(false);
	function startResize(e: any) {
		resizing = true;
		e.currentTarget.setPointerCapture(e.pointerId);
		e.preventDefault();
	}
	function doResize(e: any) {
		if (!resizing) return;
		height = clampH(height - e.movementY);
	}
	function endResize(e: any) {
		if (!resizing) return;
		resizing = false;
		e.currentTarget.releasePointerCapture?.(e.pointerId);
		localStorage.setItem('explorerHeight', String(height));
	}

	// --- undocked: corner resize ---
	let winResizing = $state(false);
	function startWinResize(e: any) {
		winResizing = true;
		e.currentTarget.setPointerCapture(e.pointerId);
		e.preventDefault();
		e.stopPropagation();
	}
	function doWinResize(e: any) {
		if (!winResizing) return;
		winW = Math.min(Math.max(420, winW + e.movementX), window.innerWidth);
		winH = Math.min(Math.max(280, winH + e.movementY), window.innerHeight);
	}
	function endWinResize(e: any) {
		if (!winResizing) return;
		winResizing = false;
		e.currentTarget.releaseCapture?.(e.pointerId);
		localStorage.setItem('explorerWinW', String(winW));
		localStorage.setItem('explorerWinH', String(winH));
	}

	// --- content state ---
	let search = $state('');
	let dropActive = $state(false);
	let menu: any = $state(null); // {x, y, items}

	const KIND_ICONS: Record<string, string> = {
		image: '🖼️',
		audio: '🎵',
		text: '📄',
		object: '🧊',
		prefab: '🧱'
	};

	// folders shown as a flat indented tree (parentId nesting, depth-first)
	const folderTree = $derived.by(() => {
		const list = $explorerFolders;
		const out: { folder: any; depth: number }[] = [];
		const walk = (parentId: string | null, depth: number) => {
			for (const folder of list.filter((f) => (f.parentId ?? null) === parentId))
				out.push({ folder, depth }), walk(folder.id, depth + 1);
		};
		walk(null, 0);
		return out;
	});

	const gridItems = $derived.by(() => {
		if ($activeFolder === 'prefabs')
			return $prefabs.map((p) => ({
				id: 'prefab:' + p.id,
				name: p.name,
				kind: 'prefab',
				thumbnail: p.thumbnail,
				prefabId: p.id
			}));
		const inFolder = $explorerItems.filter((item) => (item.folderId ?? null) === ($activeFolder ?? null));
		const q = search.trim().toLowerCase();
		const scoped = q ? $explorerItems.filter((item) => item.name.toLowerCase().includes(q)) : inFolder;
		return scoped;
	});

	function onDrop(e: DragEvent) {
		e.preventDefault();
		dropActive = false;
		// internal item move onto the panel root = no-op (tree rows handle moves)
		if (e.dataTransfer?.files?.length)
			importFiles(e.dataTransfer.files, $activeFolder === 'prefabs' ? null : $activeFolder);
	}

	function folderMenu(e: MouseEvent, folder: any) {
		e.preventDefault();
		menu = {
			x: e.clientX,
			y: e.clientY,
			items: [
				{ label: 'New subfolder', action: () => createFolder('New folder', folder.id) },
				{
					label: 'Rename',
					action: () => {
						const name = prompt('Folder name', folder.name);
						if (name) renameFolder(folder.id, name);
					}
				},
				{ label: 'Delete folder', danger: true, action: () => deleteFolder(folder.id) }
			]
		};
	}

	function itemMenu(e: MouseEvent, item: any) {
		e.preventDefault();
		if (item.kind === 'prefab') return; // prefab cards are managed in the Library
		menu = {
			x: e.clientX,
			y: e.clientY,
			items: [
				...(item.kind === 'text'
					? [
							{
								label: 'Copy contents',
								tooltip: 'Copy the file text to the clipboard (96)',
								action: async () => {
									const blob = await itemBlob(item.id);
									if (blob) navigator.clipboard?.writeText(await blob.text());
								}
							}
						]
					: []),
				{
					label: 'Rename',
					action: () => {
						const name = prompt('Item name', item.name);
						if (name) renameItem(item.id, name);
					}
				},
				{ label: 'Delete', danger: true, action: () => deleteItem(item.id) }
			]
		};
	}

	function onItemDragStart(e: DragEvent, item: any) {
		// 96 consumes these payloads (viewport placement / texture drop)
		e.dataTransfer?.setData(
			'application/x-explorer-item',
			JSON.stringify({ id: item.id, kind: item.kind, name: item.name, prefabId: item.prefabId ?? null })
		);
	}
</script>

{#snippet tabStrip()}
	{#if $dockShared}
		<div class="absolute -top-6 left-3 z-20 flex gap-0.5">
			<button
				class="tab-note px-4 pb-0.5 pt-1 text-xs font-semibold {$bottomDockActive === 'flow'
					? 'bg-gray-700 text-white'
					: 'bg-gray-900/70 text-gray-400 hover:text-gray-200'}"
				onclick={() => bottomDockActive.set('flow')}>Flow</button
			>
			<button
				class="tab-note px-4 pb-0.5 pt-1 text-xs font-semibold {$bottomDockActive === 'explorer'
					? 'bg-gray-700 text-white'
					: 'bg-gray-900/70 text-gray-400 hover:text-gray-200'}"
				onclick={() => bottomDockActive.set('explorer')}>Explorer</button
			>
		</div>
	{/if}
{/snippet}

{#snippet content()}
	<div class="flex h-full min-h-0">
		<!-- folder tree -->
		<div class="flex w-44 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-gray-700/60 pr-1 text-xs">
			<button
				class="rounded px-2 py-1 text-left {$activeFolder === null && !search
					? 'bg-primary-700 text-white'
					: 'text-gray-300 hover:bg-gray-700'}"
				onclick={() => ((search = ''), activeFolder.set(null))}>🏠 Library</button
			>
			<button
				id="prefabs-folder"
				class="rounded px-2 py-1 text-left {$activeFolder === 'prefabs'
					? 'bg-primary-700 text-white'
					: 'text-gray-300 hover:bg-gray-700'}"
				onclick={() => ((search = ''), activeFolder.set('prefabs'))}>🧱 Prefabs</button
			>
			{#each folderTree as row (row.folder.id)}
				<button
					class="rounded px-2 py-1 text-left {$activeFolder === row.folder.id
						? 'bg-primary-700 text-white'
						: 'text-gray-300 hover:bg-gray-700'}"
					style="padding-left: {8 + row.depth * 14}px"
					oncontextmenu={(e) => folderMenu(e, row.folder)}
					ondragover={(e) => {
						if (e.dataTransfer?.types.includes('application/x-explorer-item')) e.preventDefault();
					}}
					ondrop={(e) => {
						const raw = e.dataTransfer?.getData('application/x-explorer-item');
						if (!raw) return;
						e.preventDefault();
						const payload = JSON.parse(raw);
						if (!payload.prefabId) moveItem(payload.id, row.folder.id);
					}}
					onclick={() => ((search = ''), activeFolder.set(row.folder.id))}
				>
					📁 {row.folder.name}
				</button>
			{/each}
			<button
				id="new-folder"
				class="mt-1 rounded border border-dashed border-gray-600 px-2 py-1 text-left text-gray-400 hover:border-gray-400 hover:text-gray-200"
				onclick={() => {
					const name = prompt('Folder name', 'New folder');
					if (name) createFolder(name, $activeFolder === 'prefabs' ? null : $activeFolder);
				}}>＋ New folder</button
			>
		</div>
		<!-- item grid -->
		<div class="relative min-w-0 flex-1 overflow-y-auto p-1">
			{#if gridItems.length === 0}
				<p class="p-4 text-center text-xs italic text-gray-500">
					{$activeFolder === 'prefabs'
						? 'No prefabs yet — right-click an object and Save as prefab.'
						: 'Drop images, audio, text or 3D files here to import them.'}
				</p>
			{:else}
				<div class="grid grid-cols-[repeat(auto-fill,minmax(96px,1fr))] gap-1">
					{#each gridItems as item (item.id)}
						<div
							class="explorer-card group flex cursor-grab flex-col items-center gap-1 rounded border border-transparent p-1.5 hover:border-gray-600 hover:bg-gray-700/60"
							draggable="true"
							role="listitem"
							title={item.name}
							ondragstart={(e) => onItemDragStart(e, item)}
							oncontextmenu={(e) => itemMenu(e, item)}
						>
							{#if item.thumbnail}
								<img src={item.thumbnail} alt={item.name} class="h-14 w-14 rounded object-cover" />
							{:else}
								<span class="flex h-14 w-14 items-center justify-center rounded bg-gray-700 text-2xl">
									{KIND_ICONS[item.kind] ?? '📦'}
								</span>
							{/if}
							<span class="w-full overflow-hidden text-ellipsis whitespace-nowrap text-center text-[10px] text-gray-300">
								{item.name}
							</span>
						</div>
					{/each}
				</div>
			{/if}
			{#if dropActive}
				<div class="pointer-events-none absolute inset-1 rounded-lg border-2 border-dashed border-primary-500 bg-primary-500/10"></div>
			{/if}
		</div>
	</div>
{/snippet}

{#if !$explorerClose}
	{#if docked}
		<div
			id="explorer-list"
			transition:fly={{ y: 300, duration: 200 }}
			class="fixed inset-x-0 bottom-0 bg-white p-2 dark:bg-gray-800 {dockVisible ? '' : 'hidden'}"
			style="z-index: var(--z-bottom); height: {height}px; border-top: 1px solid rgb(55 65 81 / 0.6)"
			ondragover={(e) => {
				e.preventDefault();
				dropActive = true;
			}}
			ondragleave={() => (dropActive = false)}
			ondrop={onDrop}
			role="region"
		>
			<div
				class="resize-cue absolute -top-1 left-0 right-0 z-10 h-2 cursor-ns-resize"
				style="touch-action: none"
				title="Drag to resize"
				onpointerdown={startResize}
				onpointermove={doResize}
				onpointerup={endResize}
			></div>
			{@render tabStrip()}
			<div class="mb-1 flex items-center gap-2">
				<span class="text-xs font-semibold text-gray-200">🗂️ Explorer</span>
				<input
					id="explorer-search"
					class="ui-input w-48 py-0.5"
					placeholder="Search assets…"
					bind:value={search}
				/>
				<span class="flex-1"></span>
				<button
					id="explorer-undock"
					class="ui-button-quiet"
					title="Undock into a floating window"
					onclick={() => setDocked(false)}>⧉</button
				>
			</div>
			<div style="height: {height - 44}px">
				{@render content()}
			</div>
		</div>
	{:else}
		<div
			id="explorer-window"
			class="ui-panel fixed flex flex-col overflow-hidden"
			use:dragWindow={{ key: 'explorerWin', defaultRect: { left: 160, top: 120 } }}
			use:focusStack
			use:tabbable={{ key: 'explorer', title: '🗂️ Explorer', openStore: explorerClose, isOpen: (v) => !v, close: () => explorerClose.set(true) }}
			use:dockable={{ key: 'explorer' }}
			style="z-index: var(--z-window); width: {winW}px; height: {winH}px"
			ondragover={(e) => {
				e.preventDefault();
				dropActive = true;
			}}
			ondragleave={() => (dropActive = false)}
			ondrop={onDrop}
			role="region"
		>
			<div class="ui-panel-header move-handle shrink-0 cursor-move select-none py-1.5">
				<span>🗂️ Explorer</span>
				<input
					class="ui-input w-44 py-0.5 font-normal"
					placeholder="Search assets…"
					bind:value={search}
				/>
				<span class="flex-1"></span>
				<button id="explorer-dock" class="ui-button-quiet" title="Dock to the bottom" onclick={() => setDocked(true)}>
					⇩ Dock
				</button>
				<button class="ui-button-quiet" title="Close" onclick={() => explorerClose.set(true)}>✕</button>
			</div>
			<div class="min-h-0 flex-1 p-1">
				{@render content()}
			</div>
			<div
				class="resize-cue absolute bottom-0 right-0 z-10 h-3.5 w-3.5 cursor-se-resize rounded-tl bg-gray-500/40"
				style="touch-action: none"
				title="Drag to resize"
				onpointerdown={startWinResize}
				onpointermove={doWinResize}
				onpointerup={endWinResize}
			></div>
		</div>
	{/if}
{/if}

{#if menu}
	<ContextMenu x={menu.x} y={menu.y} items={menu.items} on:close={() => (menu = null)} />
{/if}
