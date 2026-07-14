<script lang="ts">
	// Explorer (95, tree v2 in 106): dockable asset browser — real file-manager
	// tree on the left (inline create/rename, expand/collapse, drag re-parent,
	// cascade delete, resizable), thumbnail grid on the right (subfolder cards
	// + items), drag files in to import. Shares the bottom dock with the Flow
	// editor as notebook tabs (bottomDock.js); undocks into a floating window.
	import { get } from 'svelte/store';
	import { explorerClose } from '../../stores/appStore.js';
	import { showToast, libraryClose, enable3dPreview } from '../../stores/appStore.js';
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
	import { openTextEditor, openImagePreview, openModelPreview } from '$lib/fileWindows';
	import ModelPreview from './ModelPreview.svelte';
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
	let inlineStats: any = $state(null); // N4: poly stats for the Properties inline preview
	let docked = $state(true);
	let winW = $state(720);
	let winH = $state(440);
	// 197: LOCAL explorer prefs (persisted). Folder-tree width/collapse/side now
	// live in WindowShell (keyed 'explorer'); these are Explorer-specific toggles.
	let singleClickOpen = $state(false);
	let showBreadcrumb = $state(true);
	// 197b: the WindowShell instance (imperative showSecondary) + what's selected
	// for the Properties (ⓘ) inspector: { kind:'item'|'folder', ... } | null
	let shell = $state<any>(null);
	let selected = $state<any>(null);
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

	// 197: Library is always open (no caret). Scene is pinned at the bottom and
	// collapsed by default; double-click it to reveal audio/config/textures.
	let sceneExpanded = $state(
		typeof localStorage !== 'undefined' && localStorage.getItem('explorerSceneExpanded') === 'true'
	);
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

	// 197d: breadcrumb trail for the current location (click a crumb to navigate)
	const crumbs = $derived.by(() => {
		const a = $activeFolder;
		if (a === 'prefabs') return [{ label: '🧱 Prefabs', id: 'prefabs' as string | null }];
		if (typeof a === 'string' && a.startsWith('scene')) {
			const sub = a.split(':')[1];
			const out = [{ label: '🌐 Scene', id: 'scene' as string | null }];
			if (sub) out.push({ label: sub, id: a });
			return out;
		}
		const out = [{ label: '🏠 Library', id: null as string | null }];
		if (typeof a === 'string') {
			const chain: any[] = [];
			let cur: any = $explorerFolders.find((f: any) => f.id === a);
			while (cur) {
				chain.unshift(cur);
				cur = cur.parentId ? $explorerFolders.find((f: any) => f.id === cur.parentId) : undefined;
			}
			for (const f of chain) out.push({ label: f.name, id: f.id });
		}
		return out;
	});

	// 197: rich Properties for the selected item (Kind/Size/Folder/Added/Hash +
	// per-kind Details) — ported from the old file inspector.
	const selItem = $derived(selected?.kind === 'item' ? selected.item : null);
	const itemFolderPath = $derived.by(() => {
		if (!selItem) return '';
		const parts: string[] = [];
		let parent: any = selItem.folderId ?? null;
		while (parent) {
			const f = $explorerFolders.find((x: any) => x.id === parent);
			if (!f) break;
			parts.unshift(f.name);
			parent = f.parentId ?? null;
		}
		return 'Library' + (parts.length ? ' / ' + parts.join(' / ') : '');
	});
	let itemDetails = $state('');
	$effect(() => {
		const item = selItem;
		itemDetails = '';
		if (!item) return;
		itemBlob(item.id).then(async (blob: any) => {
			if (!blob || selItem?.id !== item.id) return;
			try {
				if (item.kind === 'image') {
					const bitmap = await createImageBitmap(blob);
					itemDetails = bitmap.width + ' × ' + bitmap.height + ' px';
				} else if (item.kind === 'text') {
					itemDetails = (await blob.text()).split('\n').length + ' lines';
				} else if (item.kind === 'audio') {
					const ctx = new AudioContext();
					const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
					itemDetails = decoded.duration.toFixed(2) + ' s · ' + decoded.numberOfChannels + ' ch';
					ctx.close();
				}
			} catch {}
		});
	});
	function fmtSize(bytes: number) {
		if (bytes == null || isNaN(bytes)) return '—';
		if (bytes < 1024) return bytes + ' B';
		if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
		return (bytes / 1024 / 1024).toFixed(1) + ' MB';
	}

	// 197: keyboard navigation in the grid (focused region) — arrows move the
	// selection, Enter opens, Backspace goes up a level, Esc closes the window.
	let gridEl: any = $state(null);
	const gridEntries = $derived([
		...(!search &&
		$activeFolder !== 'prefabs' &&
		!(typeof $activeFolder === 'string' && $activeFolder.startsWith('scene'))
			? childFolders.map((f: any) => ({ kind: 'folder', folder: f }))
			: []),
		...gridItems.map((it: any) => ({ kind: 'item', item: it }))
	]);
	function gridIndex() {
		if (!selected) return -1;
		return gridEntries.findIndex((e: any) =>
			e.kind !== selected.kind
				? false
				: e.kind === 'folder'
					? e.folder.id === selected.folder?.id
					: e.item.id === selected.item?.id
		);
	}
	function moveSel(delta: number) {
		if (!gridEntries.length) return;
		let i = gridIndex();
		i = i < 0 ? (delta > 0 ? 0 : gridEntries.length - 1) : Math.min(Math.max(i + delta, 0), gridEntries.length - 1);
		const e: any = gridEntries[i];
		if (e.kind === 'folder') selectFolder(e.folder);
		else inspectItem(e.item);
	}
	function goUp() {
		const a = $activeFolder;
		if (a == null) return;
		if (a === 'prefabs' || (typeof a === 'string' && a.startsWith('scene'))) return openFolder(null);
		const f = $explorerFolders.find((x: any) => x.id === a);
		openFolder(f?.parentId ?? null);
	}
	function gridKeydown(e: KeyboardEvent) {
		const tag = (e.target as HTMLElement)?.tagName;
		if (tag === 'INPUT' || tag === 'TEXTAREA') return; // don't hijack typing
		if (e.key === 'ArrowRight' || e.key === 'ArrowDown') (e.preventDefault(), moveSel(1));
		else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') (e.preventDefault(), moveSel(-1));
		else if (e.key === 'Enter') {
			e.preventDefault();
			if (selected?.kind === 'item') openItem(selected.item);
			else if (selected?.kind === 'folder') openFolder(selected.folder.id);
		} else if (e.key === 'Backspace') (e.preventDefault(), goUp());
	}

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
				{ label: 'Properties', action: () => showProperties({ kind: 'folder', folder }) },
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
				{ label: 'Properties', action: () => showProperties({ kind: 'item', item }) },
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

	// 197b: single-click = select + show properties in the ⓘ panel; double-click
	// opens/previews (openItem). Right-click Properties routes here too.
	function inspectItem(item: any) {
		if (item.kind === 'prefab') return;
		if (item.sceneEntry) {
			// hash-backed Scene entries inspect the real library item (108)
			const backing = item.itemId ? $explorerItems.find((i) => i.id === item.itemId) : null;
			if (backing) inspectItem(backing);
			return;
		}
		inspectedFile.set(item.id);
		selected = { kind: 'item', item };
	}
	function selectFolder(folder: any) {
		inspectedFile.set(null);
		selected = { kind: 'folder', folder };
	}
	// right-click Properties: select AND open the panel. A plain single-click only
	// selects — it never forces the (closed) Properties panel open (197 note).
	function showProperties(t: any) {
		if (t.kind === 'item') inspectItem(t.item);
		else selectFolder(t.folder);
		shell?.showSecondary('props');
	}
	function openFolder(id: string | null) {
		search = '';
		activeFolder.set(id);
	}
	// 197b: single-click empty grid space clears the selection + closes the ⓘ panel
	function deselect() {
		selected = null;
		inspectedFile.set(null);
		// keep the panel if the user pinned it (opened via the ⓘ tab) — just clear
		// the selection; close it only if it auto-opened from a pick (197 note)
		const st = shell?.secondaryStatus?.();
		if (st?.open && st.mode === 'props' && !st.pinned) shell.hideSecondary();
	}
	function gridBackgroundClick(e: MouseEvent) {
		gridEl?.focus(); // focus the region so keyboard nav works after any grid click
		if ((e.target as HTMLElement)?.closest('.explorer-card, .explorer-folder-card')) return;
		deselect();
	}
	async function openItem(item: any) {
		if (item.sceneEntry) {
			// derived Scene entries open live views (108): textures preview,
			// scripts edit the NODE code (replicated via setNodeData)
			if (item.kind === 'image' && item.dataUrl) openImagePreview({ title: item.name, url: item.dataUrl, onClose: () => gridEl?.focus() });
			else if (item.kind === 'text' && item.nodeId) {
				let nodes: any[] = [];
				flowNodes.subscribe((v: any) => (nodes = v))();
				const node = nodes.find((n) => n.id === item.nodeId);
				if (node)
					openTextEditor({
						title: item.name + ' (live script)',
						code: node.data?.code ?? '',
						onSave: (code: string) => setNodeData(item.nodeId, { code }),
						onClose: () => gridEl?.focus()
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
				onSave: (code: string) => updateItemBytes(item.id, code),
				onClose: () => gridEl?.focus()
			});
		} else if (item.kind === 'image') {
			const blob = await itemBlob(item.id);
			if (blob) openImagePreview({ title: item.name, url: URL.createObjectURL(blob), onClose: () => gridEl?.focus() });
		} else if (item.kind === 'object' && get(enable3dPreview)) {
			// N4: open the rotatable 3D preview popup (only when the global toggle is on)
			openModelPreview({ title: item.name, itemId: item.id, name: item.name, onClose: () => gridEl?.focus() });
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
	<WindowShell
		key="explorer"
		bind:this={shell}
		primaryLabel="folder tree"
		secondaryModes={[
			{ key: 'props', icon: 'ⓘ', label: 'Properties' },
			{ key: 'settings', icon: '⚙', label: 'Settings' }
		]}
	>
		{#snippet topbar()}
			{#if showBreadcrumb}
				<div class="flex items-center gap-0.5 overflow-x-auto whitespace-nowrap border-b border-gray-700/60 px-2 py-1 text-[11px] text-gray-300">
					{#each crumbs as c, i (c.id ?? 'root')}
						{#if i > 0}<span class="px-0.5 text-gray-600">/</span>{/if}
						<button
							class="rounded px-1 py-0.5 hover:bg-gray-700 {i === crumbs.length - 1 ? 'text-white' : ''}"
							onclick={() => openFolder(c.id)}>{c.label}</button
						>
					{/each}
				</div>
			{/if}
		{/snippet}
		{#snippet primary()}
		<!-- folder tree (106.6); width/collapse/side owned by WindowShell (197) -->
		<div id="explorer-tree" class="flex h-full flex-col text-xs">
			<!-- scrollable folder list; the roots below stay pinned to the bottom -->
			<div class="flex min-h-0 flex-1 flex-col gap-0.5 overflow-x-auto overflow-y-auto p-1">
			<button
				class="whitespace-nowrap rounded px-2 py-1 text-left {$activeFolder === null && !search
					? 'bg-primary-700 text-white'
					: 'text-gray-300 hover:bg-gray-700'} {dropFolder === 'root' ? 'outline outline-2 outline-primary-500' : ''}"
				ondragover={(e) => dragOverInto(e, 'root')}
				ondragleave={() => (dropFolder = null)}
				ondrop={(e) => dropInto(e, null)}
				onclick={() => openFolder(null)}>🏠 Library</button
			>
			{#if editing?.mode === 'create' && editing.parentId === null}
				{@render editRow(0)}
			{/if}
			{#each folderTree as row (row.folder.id)}
				{#if editing?.mode === 'rename' && !editing.inGrid && editing.folderId === row.folder.id}
					{@render editRow(row.depth)}
				{:else}
					<div
						class="flex items-center whitespace-nowrap"
						style="padding-left: {2 + row.depth * 14}px"
						role="treeitem"
						aria-selected={$activeFolder === row.folder.id}
						tabindex="-1"
						ondragover={(e) => dragOverInto(e, row.folder.id)}
						ondragleave={() => (dropFolder = null)}
						ondrop={(e) => dropInto(e, row.folder.id)}
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
								: 'text-gray-300 hover:bg-gray-700'} {dropFolder === row.folder.id ? 'outline outline-2 outline-primary-500' : ''}"
							draggable="true"
							ondragstart={(e) =>
								e.dataTransfer?.setData('application/x-explorer-folder', JSON.stringify({ id: row.folder.id }))}
							oncontextmenu={(e) => folderMenu(e, row.folder)}
							onclick={() => openFolder(row.folder.id)}
							ondblclick={() => toggleExpand(row.folder.id)}
						>
							📁 {row.folder.name}
						</button>
					</div>
				{/if}
				{#if editing?.mode === 'create' && editing.parentId === row.folder.id}
					{@render editRow(row.depth + 1)}
				{/if}
			{/each}
			<!-- New folder + the read-only roots are pinned to the bottom together -->
			</div>
			<div class="flex shrink-0 flex-col gap-0.5 border-t border-gray-700/60 p-1">
				<button
					id="new-folder"
					class="whitespace-nowrap rounded border border-dashed border-gray-600 px-2 py-1 text-left text-gray-400 hover:border-gray-400 hover:text-gray-200"
					onclick={() => startCreate(typeof $activeFolder === 'string' && ($activeFolder === 'prefabs' || $activeFolder.startsWith('scene')) ? null : $activeFolder)}>＋ New folder</button
				>
				<div class="my-0.5 border-t border-gray-700/40"></div>
				<button
					id="prefabs-folder"
					class="whitespace-nowrap rounded px-2 py-1 text-left {$activeFolder === 'prefabs'
						? 'bg-primary-700 text-white'
						: 'text-gray-300 hover:bg-gray-700'}"
					onclick={() => openFolder('prefabs')}>🧱 Prefabs</button
				>
				<button
					id="packs-folder"
					class="whitespace-nowrap rounded px-2 py-1 text-left text-gray-300 hover:bg-gray-700"
					title="Browse the built-in asset packs"
					onclick={() => libraryClose.set(false)}>📦 Packs</button
				>
				<button
					id="scene-folder"
					class="whitespace-nowrap rounded px-2 py-1 text-left {$activeFolder === 'scene'
						? 'bg-primary-700 text-white'
						: 'text-gray-300 hover:bg-gray-700'}"
					title="Assets the shared scene uses right now — identical on every peer"
					onclick={() => openFolder('scene')} ondblclick={toggleScene}>🌐 Scene {sceneExpanded ? '▾' : '▸'}</button
				>
				{#if sceneExpanded}
				{#each ['audio', 'config', 'textures'] as sub}
					<button
						class="whitespace-nowrap rounded px-2 py-1 text-left {$activeFolder === 'scene:' + sub
							? 'bg-primary-700 text-white'
							: 'text-gray-400 hover:bg-gray-700'}"
						style="padding-left: 22px"
						onclick={() => openFolder('scene:' + sub)}
					>
						📁 {sub} ({$sceneAssets.filter((a) => a.group === sub).length})
					</button>
				{/each}
				{/if}
			</div>
		</div>
		{/snippet}
		{#snippet main()}
		<!-- item grid (+ subfolder cards, 106.7); click empty space to deselect (197b) -->
		<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_noninteractive_element_interactions a11y_no_noninteractive_tabindex a11y_no_static_element_interactions -->
		<div
			bind:this={gridEl}
			class="relative h-full min-w-0 overflow-y-auto p-1 outline-none"
			style="scrollbar-gutter: stable"
			tabindex="-1"
			oncontextmenu={gridMenu}
			onclick={gridBackgroundClick}
			onkeydown={gridKeydown}
			role="region"
		>
			{#if childFolders.length === 0 && gridItems.length === 0}
				<p class="p-4 text-center text-xs italic text-gray-500">
					{$activeFolder === 'prefabs'
						? 'No prefabs yet — right-click an object and Save as prefab.'
						: typeof $activeFolder === 'string' && $activeFolder.startsWith('scene') ? 'No shared assets in this scene group yet.' : 'Drop images, audio, text or 3D files here to import them.'}
				</p>
			{:else}
				<!-- fixed-width columns (not 1fr) so cards don't resize/jiggle when the
				     Properties sidebar toggles main's width -->
				<div class="grid grid-cols-[repeat(auto-fill,96px)] justify-start gap-1">
					{#if !search && $activeFolder !== 'prefabs'}
						{#each childFolders as folder (folder.id)}
							<div
								class="explorer-folder-card flex cursor-pointer flex-col items-center gap-1 rounded border p-1.5 {dropFolder === folder.id
									? 'border-primary-500 bg-primary-500/10'
									: selected?.kind === 'folder' && selected.folder?.id === folder.id
										? 'border-primary-600 bg-primary-600/10'
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
								onclick={() => (singleClickOpen ? openFolder(folder.id) : selectFolder(folder))}
								ondblclick={() => openFolder(folder.id)}
								onkeydown={(e) => e.key === 'Enter' && openFolder(folder.id)}
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
		{#snippet secondary(mode)}
		{#if mode === 'props'}
			<div class="flex flex-col gap-2 p-2 text-xs text-gray-200">
				{#if selItem}
					<div class="flex items-center gap-2">
						{#if selItem.thumbnail}
							<img src={selItem.thumbnail} alt="" class="h-12 w-12 rounded object-cover" />
						{:else}
							<span class="flex h-12 w-12 items-center justify-center rounded bg-gray-700 text-2xl"
								>{KIND_ICONS[selItem.kind] ?? '📦'}</span
							>
						{/if}
						<span class="min-w-0 flex-1 break-words font-semibold">{selItem.name}</span>
					</div>
					<div class="flex flex-col gap-1">
						<div class="flex gap-2"><span class="w-14 shrink-0 text-gray-500">Kind</span><span>{selItem.kind}</span></div>
						<div class="flex gap-2"><span class="w-14 shrink-0 text-gray-500">Size</span><span>{fmtSize(selItem.size)}</span></div>
						<div class="flex gap-2">
							<span class="w-14 shrink-0 text-gray-500">Folder</span>
							<span class="min-w-0 truncate" title={itemFolderPath}>{itemFolderPath}</span>
						</div>
						{#if selItem.createdAt}
							<div class="flex gap-2">
								<span class="w-14 shrink-0 text-gray-500">Added</span>
								<span>{new Date(selItem.createdAt).toLocaleString()}</span>
							</div>
						{/if}
						{#if selItem.hash}
							<div class="flex items-center gap-2">
								<span class="w-14 shrink-0 text-gray-500">Hash</span>
								<span class="min-w-0 flex-1 truncate font-mono text-[10px]" title={selItem.hash}>{selItem.hash.slice(0, 16)}…</span>
								<button class="ui-button-quiet shrink-0" title="Copy full hash" onclick={() => navigator.clipboard?.writeText(selItem.hash)}>⧉</button>
							</div>
						{/if}
						{#if itemDetails}
							<div class="flex gap-2"><span class="w-14 shrink-0 text-gray-500">Details</span><span>{itemDetails}</span></div>
						{/if}
					</div>
					<!-- N4: rotatable inline 3D preview + poly stats (behind the global toggle) -->
					{#if selItem.kind === 'object' && $enable3dPreview}
						<div class="mt-1 overflow-hidden rounded bg-[#0d1117]" style="height: 150px">
							{#key selItem.id}
								<ModelPreview itemId={selItem.id} name={selItem.name} onStats={(s) => (inlineStats = s)} />
							{/key}
						</div>
						{#if inlineStats}
							<div class="flex gap-2 text-[11px]">
								<span class="w-14 shrink-0 text-gray-500">Mesh</span>
								<span class="text-gray-300"
									>{inlineStats.tris.toLocaleString()} tris · {inlineStats.verts.toLocaleString()} verts · {inlineStats.meshes}
									mesh{inlineStats.meshes === 1 ? '' : 'es'}</span
								>
							</div>
						{/if}
					{/if}
					<div class="mt-1 flex gap-2">
						<button class="ui-button-quiet" onclick={() => startRenameItem(selItem)}>Rename</button>
						{#if selItem.kind === 'text' || selItem.kind === 'image'}
							<button class="ui-button-quiet" onclick={() => openItem(selItem)}>{selItem.kind === 'text' ? 'Edit' : 'Preview'}</button>
						{:else if selItem.kind === 'object' && $enable3dPreview}
							<button class="ui-button-quiet" onclick={() => openItem(selItem)}>3D preview</button>
						{/if}
					</div>
				{:else if selected?.kind === 'folder'}
					{@const counts = folderCounts(selected.folder.id)}
					<div class="flex items-center gap-2">
						<span class="text-2xl">📁</span>
						<span class="min-w-0 flex-1 break-words font-semibold">{selected.folder.name}</span>
					</div>
					<p class="text-gray-400">
						{counts.folders} folder{counts.folders === 1 ? '' : 's'}, {counts.items} item{counts.items === 1
							? ''
							: 's'}
					</p>
					<div class="mt-1 flex gap-2">
						<button class="ui-button-quiet" onclick={() => openFolder(selected.folder.id)}>Open</button>
						<button class="ui-button-quiet" onclick={() => startRename(selected.folder, false)}>Rename</button>
					</div>
				{:else}
					<p class="leading-relaxed text-gray-400">
						Select a folder or file (or right-click ▸ Properties) to see its details here.
					</p>
				{/if}
			</div>
		{:else}
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
				<label class="flex items-center gap-2" title="Show a rotatable 3D preview for model items in Properties + on open">
					<input
						type="checkbox"
						checked={$enable3dPreview}
						onchange={(e) => enable3dPreview.set(e.currentTarget.checked)}
					/>
					3D model preview
				</label>
			</div>
		{/if}
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
