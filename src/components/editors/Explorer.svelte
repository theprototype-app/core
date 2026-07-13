<script lang="ts">
	// Explorer (95, tree v2 in 106): dockable asset browser — real file-manager
	// tree on the left (inline create/rename, expand/collapse, drag re-parent,
	// cascade delete, resizable), thumbnail grid on the right (subfolder cards
	// + items), drag files in to import. Shares the bottom dock with the Flow
	// editor as notebook tabs (bottomDock.js); undocks into a floating window.
	import { explorerClose } from '../../stores/appStore.js';
	import { showToast, libraryClose } from '../../stores/appStore.js';
	import {
		explorerFolders,
		explorerItems,
		activeFolder,
		loadExplorer,
		createFolder,
		renameFolder,
		deleteFolder,
		folderCounts,
		moveFolder,
		moveItem,
		importFiles,
		deleteItem,
		renameItem,
		isValidName,
		itemBlob,
		inspectedFile,
		updateItemBytes
	} from '$lib/explorer';
	import { inspectorKind, inspectorClose } from '../../stores/appStore.js';
	import { openTextEditor, openImagePreview } from '$lib/fileWindows';
	import { prefabs, loadPrefabs } from '$lib/prefabs';
	import { sceneAssets } from '$lib/sceneAssets';
	import { setNodeData } from '$lib/nodesHandler';
	import { flowNodes } from '../../stores/flowStore';
	import { bottomDockActive, dockShared, setDockOccupant } from '$lib/bottomDock';
	import { dragWindow } from '$lib/dragWindow';
	import { focusStack } from '$lib/windowFocus';
	import { tabbable } from '$lib/windowTabs';
	import { dockable } from '$lib/docking';
	import ContextMenu from '../ContextMenu.svelte';
	import WindowShell from '../shared/WindowShell.svelte';
	import { fly } from 'svelte/transition';

	const clampH = (h: number) =>
		Math.min(Math.max(h || 300, 200), Math.round(window.innerHeight * 0.8));

	let height = $state(300);
	let docked = $state(true);
	let winW = $state(720);
	let winH = $state(440);
	// 197: LOCAL explorer prefs (persisted). Folder-tree width/collapse/side now
	// live in WindowShell (keyed 'explorer'); these are Explorer-specific toggles.
	let singleClickOpen = $state(false);
	let showBreadcrumb = $state(true);
	if (typeof localStorage !== 'undefined') {
		height = clampH(parseInt(localStorage.getItem('explorerHeight') ?? '300'));
		docked = localStorage.getItem('explorerDocked') !== 'false';
		winW = parseInt(localStorage.getItem('explorerWinW') ?? '720') || 720;
		winH = parseInt(localStorage.getItem('explorerWinH') ?? '440') || 440;
		singleClickOpen = localStorage.getItem('explorerSingleClickOpen') === 'true';
		showBreadcrumb = localStorage.getItem('explorerBreadcrumb') !== 'false';
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
	/** highlighted drop target while dragging: folder id | 'root' | null (106.4) */
	let dropFolder: string | 'root' | null = $state(null);
	/** inline editor (106.1/2): {mode:'create'|'rename', parentId, folderId?, value} */
	let editing: any = $state(null);
	let expanded = $state(new Set<string>());
	if (typeof localStorage !== 'undefined') {
		try {
			expanded = new Set(JSON.parse(localStorage.getItem('explorerExpanded') ?? '[]'));
		} catch {}
	}
	function toggleExpand(id: string) {
		const next = new Set(expanded);
		next.has(id) ? next.delete(id) : next.add(id);
		expanded = next;
		localStorage.setItem('explorerExpanded', JSON.stringify([...next]));
	}

	// 178: collapse/expand the Library and Scene top-level sections (persisted)
	const loadSection = (key: string) =>
		typeof localStorage === 'undefined' ? true : localStorage.getItem(key) !== 'false';
	let libraryExpanded = $state(loadSection('explorerLibraryExpanded'));
	let sceneExpanded = $state(loadSection('explorerSceneExpanded'));
	function toggleLibrary() {
		libraryExpanded = !libraryExpanded;
		localStorage.setItem('explorerLibraryExpanded', String(libraryExpanded));
	}
	function toggleScene() {
		sceneExpanded = !sceneExpanded;
		localStorage.setItem('explorerSceneExpanded', String(sceneExpanded));
	}

	const KIND_ICONS: Record<string, string> = {
		image: '🖼️',
		audio: '🎵',
		text: '📄',
		object: '🧊',
		prefab: '🧱'
	};

	// folders as a flat indented tree, respecting expansion (106.6)
	const folderTree = $derived.by(() => {
		const list = $explorerFolders;
		const out: { folder: any; depth: number; hasChildren: boolean }[] = [];
		const walk = (parentId: string | null, depth: number) => {
			for (const folder of list.filter((f) => (f.parentId ?? null) === parentId)) {
				const hasChildren = list.some((f) => f.parentId === folder.id);
				out.push({ folder, depth, hasChildren });
				if (expanded.has(folder.id)) walk(folder.id, depth + 1);
			}
		};
		walk(null, 0);
		return out;
	});

	const childFolders = $derived(
		$explorerFolders.filter((f) => (f.parentId ?? null) === ($activeFolder === 'prefabs' ? '__none__' : ($activeFolder ?? null)))
	);

	const gridItems = $derived.by(() => {
		if ($activeFolder === 'prefabs')
			return $prefabs.map((p) => ({
				id: 'prefab:' + p.id,
				name: p.name,
				kind: 'prefab',
				thumbnail: p.thumbnail,
				prefabId: p.id
			}));
		// the Scene manifest (108): a derived, always-shared view — never editable
		if (typeof $activeFolder === 'string' && $activeFolder.startsWith('scene')) {
			const group = $activeFolder.split(':')[1] ?? null;
			return $sceneAssets
				.filter((entry) => !group || entry.group === group)
				.map((entry) => ({ ...entry, sceneEntry: true, thumbnail: entry.dataUrl ?? null }));
		}
		const inFolder = $explorerItems.filter((item) => (item.folderId ?? null) === ($activeFolder ?? null));
		const q = search.trim().toLowerCase();
		const scoped = q ? $explorerItems.filter((item) => item.name.toLowerCase().includes(q)) : inFolder;
		return scoped;
	});

	// --- inline create/rename (106.1/2) ---
	function startCreate(parentId: string | null) {
		if (parentId) {
			const next = new Set(expanded);
			next.add(parentId);
			expanded = next;
		}
		editing = { mode: 'create', parentId, value: 'New folder' };
	}
	// inGrid keeps the tree + thumbnail inputs from BOTH mounting for a root folder
	// (it shows in both), whose duplicate focus/blur would tear the edit down instantly
	function startRename(folder: any, inGrid = false) {
		editing = { mode: 'rename', folderId: folder.id, parentId: folder.parentId ?? null, value: folder.name, inGrid };
	}
	// 170: inline item rename (replaces the browser prompt), works in either view
	function startRenameItem(item: any) {
		editing = { mode: 'rename-item', itemId: item.id, value: item.name };
	}
	function commitEdit() {
		if (!editing || !isValidName(editing.value)) return;
		if (editing.mode === 'create') createFolder(editing.value, editing.parentId);
		else if (editing.mode === 'rename-item') renameItem(editing.itemId, editing.value);
		else renameFolder(editing.folderId, editing.value);
		editing = null;
	}
	function editKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter') commitEdit();
		else if (e.key === 'Escape') editing = null;
		e.stopPropagation();
	}
	function focusSelect(node: HTMLInputElement) {
		node.focus();
		node.select();
	}

	function confirmDeleteFolder(folder: any) {
		const counts = folderCounts(folder.id);
		showToast(
			`Delete "${folder.name}" (${counts.folders} folder${counts.folders === 1 ? '' : 's'}, ${counts.items} item${counts.items === 1 ? '' : 's'})?`,
			[
				{ label: 'Delete', action: () => deleteFolder(folder.id) },
				{ label: 'Cancel', action: () => {} }
			]
		);
	}

	// --- drag & drop (106.4): items AND folders move into folders/root ---
	function payloadOf(e: DragEvent) {
		const rawItem = e.dataTransfer?.getData('application/x-explorer-item');
		if (rawItem) return { type: 'item', ...JSON.parse(rawItem) };
		const rawFolder = e.dataTransfer?.getData('application/x-explorer-folder');
		if (rawFolder) return { type: 'folder', ...JSON.parse(rawFolder) };
		return null;
	}
	function canAccept(e: DragEvent) {
		const types = e.dataTransfer?.types ?? [];
		return types.includes('application/x-explorer-item') || types.includes('application/x-explorer-folder');
	}
	function dropInto(e: DragEvent, target: string | null) {
		const payload = payloadOf(e);
		dropFolder = null;
		if (!payload) return;
		e.preventDefault();
		e.stopPropagation();
		if (payload.type === 'folder') {
			if (!moveFolder(payload.id, target)) showToast("A folder can't move into its own subtree");
		} else if (!payload.prefabId) moveItem(payload.id, target);
	}
	function dragOverInto(e: DragEvent, target: string | 'root' | null) {
		if (!canAccept(e)) return;
		e.preventDefault();
		e.stopPropagation();
		dropFolder = target;
	}

	function folderMenu(e: MouseEvent, folder: any, inTree = true) {
		e.preventDefault();
		menu = {
			x: e.clientX,
			y: e.clientY,
			items: [
				// 170: "New subfolder" only makes sense in the tree; the thumbnail grid drops it
				...(inTree ? [{ label: 'New subfolder', action: () => startCreate(folder.id) }] : []),
				{ label: 'Rename', action: () => startRename(folder, !inTree) },
				{ label: 'Delete folder', danger: true, action: () => confirmDeleteFolder(folder) }
			]
		};
	}

	function itemMenu(e: MouseEvent, item: any) {
		e.preventDefault();
		e.stopPropagation();
		if (item.kind === 'prefab' || item.sceneEntry) return; // derived views have no CRUD
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
					action: () => startRenameItem(item)
				},
				{ label: 'Delete', danger: true, action: () => deleteItem(item.id) }
			]
		};
	}

	// right-click on the grid background = new folder HERE (106.7)
	function gridMenu(e: MouseEvent) {
		if ((e.target as HTMLElement)?.closest('.explorer-card, .explorer-folder-card')) return;
		if ($activeFolder === 'prefabs' || (typeof $activeFolder === 'string' && $activeFolder.startsWith('scene'))) return;
		e.preventDefault();
		menu = {
			x: e.clientX,
			y: e.clientY,
			items: [{ label: 'New folder', action: () => startCreate($activeFolder ?? null) }]
		};
	}

	function onDrop(e: DragEvent) {
		dropActive = false;
		// internal payloads are handled by the row/card targets
		if (canAccept(e)) return;
		e.preventDefault();
		if (e.dataTransfer?.files?.length)
			importFiles(e.dataTransfer.files, $activeFolder === 'prefabs' ? null : $activeFolder);
	}

	function onItemDragStart(e: DragEvent, item: any) {
		// 96 consumes these payloads (viewport placement / texture drop)
		e.dataTransfer?.setData(
			'application/x-explorer-item',
			JSON.stringify({ id: item.id, kind: item.kind, name: item.name, prefabId: item.prefabId ?? null })
		);
	}

	// click = properties in the Inspector; double-click = open/preview (107)
	function inspectItem(item: any) {
		if (item.kind === 'prefab') return;
		if (item.sceneEntry) {
			// hash-backed Scene entries inspect the real library item (108)
			const backing = item.itemId ? $explorerItems.find((i) => i.id === item.itemId) : null;
			if (backing) inspectItem(backing);
			return;
		}
		inspectedFile.set(item.id);
		inspectorKind.set('file');
		inspectorClose.set(false);
	}
	async function openItem(item: any) {
		if (item.sceneEntry) {
			// derived Scene entries open live views (108): textures preview,
			// scripts edit the NODE code (replicated via setNodeData)
			if (item.kind === 'image' && item.dataUrl) openImagePreview({ title: item.name, url: item.dataUrl });
			else if (item.kind === 'text' && item.nodeId) {
				let nodes: any[] = [];
				flowNodes.subscribe((v: any) => (nodes = v))();
				const node = nodes.find((n) => n.id === item.nodeId);
				if (node)
					openTextEditor({
						title: item.name + ' (live script)',
						code: node.data?.code ?? '',
						onSave: (code: string) => setNodeData(item.nodeId, { code })
					});
			} else if (item.kind === 'audio' && item.itemId) {
				const backing = $explorerItems.find((i) => i.id === item.itemId);
				if (backing) inspectItem(backing);
			}
			return;
		}
		if (item.kind === 'text') {
			const blob = await itemBlob(item.id);
			if (!blob) return;
			openTextEditor({
				title: item.name,
				code: await blob.text(),
				onSave: (code: string) => updateItemBytes(item.id, code)
			});
		} else if (item.kind === 'image') {
			const blob = await itemBlob(item.id);
			if (blob) openImagePreview({ title: item.name, url: URL.createObjectURL(blob) });
		}
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

{#snippet editRow(depth: number)}
	<div class="flex flex-col gap-0.5" style="padding-left: {8 + depth * 14}px">
		<input
			class="ui-input w-40 py-0.5 {isValidName(editing.value) ? '' : 'border-red-500'}"
			value={editing.value}
			use:focusSelect
			oninput={(e) => (editing = { ...editing, value: e.currentTarget.value })}
			onkeydown={editKeydown}
			onblur={() => (editing = null)}
		/>
		{#if !isValidName(editing.value)}
			<span class="text-[10px] text-red-400">names can't contain * \ /</span>
		{/if}
	</div>
{/snippet}

<!-- 170: inline rename input sized for a thumbnail card (folders + items) -->
{#snippet cardEdit()}
	<input
		class="ui-input w-full py-0 text-center text-[10px] {isValidName(editing.value) ? '' : 'border-red-500'}"
		value={editing.value}
		use:focusSelect
		oninput={(e) => (editing = { ...editing, value: e.currentTarget.value })}
		onkeydown={editKeydown}
		onclick={(e) => e.stopPropagation()}
		onblur={() => (editing = null)}
	/>
{/snippet}

{#snippet content()}
	<WindowShell key="explorer" primaryLabel="Folders" secondaryLabel="Explorer settings">
		{#snippet primary()}
		<!-- folder tree (106.6); width/collapse/side owned by WindowShell (197) -->
		<div
			id="explorer-tree"
			class="flex h-full flex-col gap-0.5 overflow-x-auto overflow-y-auto p-1 text-xs"
		>
			<div class="flex items-center whitespace-nowrap">
				<button
					id="library-caret"
					class="w-4 shrink-0 text-gray-500"
					title={libraryExpanded ? 'Collapse' : 'Expand'}
					onclick={toggleLibrary}>{libraryExpanded ? '▾' : '▸'}</button
				>
				<button
					class="flex-1 rounded px-2 py-1 text-left {$activeFolder === null && !search
						? 'bg-primary-700 text-white'
						: 'text-gray-300 hover:bg-gray-700'} {dropFolder === 'root' ? 'outline outline-2 outline-primary-500' : ''}"
					ondragover={(e) => dragOverInto(e, 'root')}
					ondragleave={() => (dropFolder = null)}
					ondrop={(e) => dropInto(e, null)}
					onclick={() => ((search = ''), activeFolder.set(null))}>🏠 Library</button
				>
			</div>
			<button
				id="prefabs-folder"
				class="whitespace-nowrap rounded px-2 py-1 text-left {$activeFolder === 'prefabs'
					? 'bg-primary-700 text-white'
					: 'text-gray-300 hover:bg-gray-700'}"
				onclick={() => ((search = ''), activeFolder.set('prefabs'))}>🧱 Prefabs</button
			>
			<!-- 126: built-in asset packs (moved off the sidebar) open their browser -->
			<button
				id="packs-folder"
				class="whitespace-nowrap rounded px-2 py-1 text-left text-gray-300 hover:bg-gray-700"
				title="Browse the built-in asset packs"
				onclick={() => libraryClose.set(false)}>📦 Packs</button
			>
			<!-- Scene manifest (108): derived, always shared, read-only structure -->
			<div class="flex items-center whitespace-nowrap">
				<button
					id="scene-caret"
					class="w-4 shrink-0 text-gray-500"
					title={sceneExpanded ? 'Collapse' : 'Expand'}
					onclick={toggleScene}>{sceneExpanded ? '▾' : '▸'}</button
				>
				<button
					id="scene-folder"
					class="flex-1 rounded px-2 py-1 text-left {$activeFolder === 'scene'
						? 'bg-primary-700 text-white'
						: 'text-gray-300 hover:bg-gray-700'}"
					title="Assets the shared scene uses right now — identical on every peer"
					onclick={() => ((search = ''), activeFolder.set('scene'))}>🌐 Scene</button
				>
			</div>
			{#if sceneExpanded}
				{#each ['audio', 'config', 'textures'] as sub}
					<button
						class="whitespace-nowrap rounded px-2 py-1 text-left {$activeFolder === 'scene:' + sub
							? 'bg-primary-700 text-white'
							: 'text-gray-400 hover:bg-gray-700'}"
						style="padding-left: 22px"
						onclick={() => activeFolder.set('scene:' + sub)}
					>
						📁 {sub} ({$sceneAssets.filter((a) => a.group === sub).length})
					</button>
				{/each}
			{/if}
			{#if libraryExpanded}
			{#if editing?.mode === 'create' && editing.parentId === null}
				{@render editRow(0)}
			{/if}
			{#each folderTree as row (row.folder.id)}
				{#if editing?.mode === 'rename' && !editing.inGrid && editing.folderId === row.folder.id}
					{@render editRow(row.depth)}
				{:else}
					<div
						class="flex items-center whitespace-nowrap {dropFolder === row.folder.id ? 'outline outline-2 outline-primary-500 rounded' : ''}"
						style="padding-left: {2 + row.depth * 14}px"
					>
						<button
							class="w-4 shrink-0 text-gray-500"
							onclick={() => toggleExpand(row.folder.id)}
							title={row.hasChildren ? (expanded.has(row.folder.id) ? 'Collapse' : 'Expand') : ''}
						>
							{row.hasChildren ? (expanded.has(row.folder.id) ? '▾' : '▸') : ''}
						</button>
						<button
							class="flex-1 rounded px-1.5 py-1 text-left {$activeFolder === row.folder.id
								? 'bg-primary-700 text-white'
								: 'text-gray-300 hover:bg-gray-700'}"
							draggable="true"
							ondragstart={(e) =>
								e.dataTransfer?.setData('application/x-explorer-folder', JSON.stringify({ id: row.folder.id }))}
							oncontextmenu={(e) => folderMenu(e, row.folder)}
							ondragover={(e) => dragOverInto(e, row.folder.id)}
							ondragleave={() => (dropFolder = null)}
							ondrop={(e) => dropInto(e, row.folder.id)}
							onclick={() => ((search = ''), activeFolder.set(row.folder.id))}
						>
							📁 {row.folder.name}
						</button>
					</div>
				{/if}
				{#if editing?.mode === 'create' && editing.parentId === row.folder.id}
					{@render editRow(row.depth + 1)}
				{/if}
			{/each}
			{/if}
			<button
				id="new-folder"
				class="mt-1 whitespace-nowrap rounded border border-dashed border-gray-600 px-2 py-1 text-left text-gray-400 hover:border-gray-400 hover:text-gray-200"
				onclick={() => startCreate($activeFolder === 'prefabs' ? null : $activeFolder)}>＋ New folder</button
			>
		</div>
		{/snippet}
		{#snippet main()}
		<!-- item grid (+ subfolder cards, 106.7) -->
		<div class="relative h-full min-w-0 overflow-y-auto p-1" oncontextmenu={gridMenu} role="region">
			{#if childFolders.length === 0 && gridItems.length === 0}
				<p class="p-4 text-center text-xs italic text-gray-500">
					{$activeFolder === 'prefabs'
						? 'No prefabs yet — right-click an object and Save as prefab.'
						: 'Drop images, audio, text or 3D files here to import them.'}
				</p>
			{:else}
				<div class="grid grid-cols-[repeat(auto-fill,minmax(96px,1fr))] gap-1">
					{#if !search && $activeFolder !== 'prefabs'}
						{#each childFolders as folder (folder.id)}
							<div
								class="explorer-folder-card flex cursor-pointer flex-col items-center gap-1 rounded border p-1.5 {dropFolder === folder.id
									? 'border-primary-500 bg-primary-500/10'
									: 'border-transparent hover:border-gray-600 hover:bg-gray-700/60'}"
								role="button"
								tabindex="0"
								draggable="true"
								ondragstart={(e) =>
									e.dataTransfer?.setData('application/x-explorer-folder', JSON.stringify({ id: folder.id }))}
								ondragover={(e) => dragOverInto(e, folder.id)}
								ondragleave={() => (dropFolder = null)}
								ondrop={(e) => dropInto(e, folder.id)}
								oncontextmenu={(e) => folderMenu(e, folder, false)}
								onclick={() => activeFolder.set(folder.id)}
								onkeydown={(e) => e.key === 'Enter' && activeFolder.set(folder.id)}
							>
								<span class="flex h-14 w-14 items-center justify-center text-4xl">📁</span>
								{#if editing?.mode === 'rename' && editing.inGrid && editing.folderId === folder.id}
									{@render cardEdit()}
								{:else}
									<span class="w-full overflow-hidden text-ellipsis whitespace-nowrap text-center text-[10px] text-gray-300">
										{folder.name}
									</span>
								{/if}
							</div>
						{/each}
					{/if}
					{#each gridItems as item (item.id)}
						<div
							class="explorer-card group flex cursor-grab flex-col items-center gap-1 rounded border p-1.5 {$inspectedFile === item.id
								? 'border-primary-600 bg-primary-600/10'
								: 'border-transparent hover:border-gray-600 hover:bg-gray-700/60'}"
							draggable="true"
							role="listitem"
							title={item.name}
							ondragstart={(e) => onItemDragStart(e, item)}
							oncontextmenu={(e) => itemMenu(e, item)}
							onclick={() => inspectItem(item)}
							ondblclick={() => openItem(item)}
						>
							{#if item.thumbnail}
								<img src={item.thumbnail} alt={item.name} class="h-14 w-14 rounded object-cover" />
							{:else}
								<span class="flex h-14 w-14 items-center justify-center rounded bg-gray-700 text-2xl">
									{KIND_ICONS[item.kind] ?? '📦'}
								</span>
							{/if}
							{#if editing?.mode === 'rename-item' && editing.itemId === item.id}
								{@render cardEdit()}
							{:else}
								<span class="w-full overflow-hidden text-ellipsis whitespace-nowrap text-center text-[10px] text-gray-300">
									{item.name}
								</span>
							{/if}
						</div>
					{/each}
				</div>
			{/if}
			{#if dropActive}
				<div class="pointer-events-none absolute inset-1 rounded-lg border-2 border-dashed border-primary-500 bg-primary-500/10"></div>
			{/if}
		</div>
		{/snippet}
		{#snippet secondary()}
		<div class="flex flex-col gap-2 p-2 text-xs text-gray-200">
			<label class="flex items-center gap-2">
				<input
					type="checkbox"
					checked={singleClickOpen}
					onchange={(e) => {
						singleClickOpen = e.currentTarget.checked;
						localStorage.setItem('explorerSingleClickOpen', String(singleClickOpen));
					}}
				/>
				Single-click opens folders
			</label>
			<label class="flex items-center gap-2">
				<input
					type="checkbox"
					checked={showBreadcrumb}
					onchange={(e) => {
						showBreadcrumb = e.currentTarget.checked;
						localStorage.setItem('explorerBreadcrumb', String(showBreadcrumb));
					}}
				/>
				Show path bar
			</label>
			<p class="mt-2 text-[10px] leading-relaxed text-gray-400">
				Click a folder or file to see its details here (coming next).
			</p>
		</div>
		{/snippet}
	</WindowShell>
{/snippet}

{#if !$explorerClose}
	{#if docked}
		<div
			id="explorer-list"
			transition:fly={{ y: 300, duration: 200 }}
			class="fixed inset-x-0 bottom-0 bg-white p-2 dark:bg-gray-800 {dockVisible ? '' : 'hidden'}"
			style="z-index: var(--z-bottom); height: {height}px; border-top: 1px solid rgb(55 65 81 / 0.6)"
			ondragover={(e) => {
				if (canAccept(e)) return;
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
				if (canAccept(e)) return;
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
