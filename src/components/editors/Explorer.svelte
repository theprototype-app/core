<script lang="ts">
	import { Boxes, Download, ExternalLink, Folder, FolderTree, Gift, Globe, House, LoaderCircle, PackageOpen } from '@lucide/svelte';
	import Icon from '../ui/Icon.svelte';
	// Explorer (95, tree v2 in 106): dockable asset browser — real file-manager
	// tree on the left (inline create/rename, expand/collapse, drag re-parent,
	// cascade delete, resizable), thumbnail grid on the right (subfolder cards
	// + items), drag files in to import. Shares the bottom dock with the Flow
	// editor as notebook tabs (bottomDock.js); undocks into a floating window.
	import { get } from 'svelte/store';
	import { explorerClose, mobileUndockAllowed } from '../../stores/appStore.js';
	import { showToast, enable3dPreview } from '../../stores/appStore.js';
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
	// 21-F4: scenes as LEVELS — .tpscene items in a Levels folder, saved from here
	import { saveSceneAsLevel, newLevel, travelToLevel } from '$lib/levels';
	// 21-G2: the "update available" dot on old scene versions. The manifest store is
	// passed as the reactive dependency — a helper reading through get() registers none
	// (the documented rule), so the badge would otherwise never appear live.
	import { projectManifest, staleSceneHash, manifestInUse } from '$lib/projectManifest';
	const staleScene = (_manifest: any, hash: string) => staleSceneHash(hash);
	// 21-G3: the whole project as ONE .tp file (manifest + scenes + assets).
	import { downloadProject } from '$lib/projectFile';
	import ModelPreview from './ModelPreview.svelte';
	import {
		packs,
		openPackItems,
		loadPacks,
		loadPackItems,
		packByName,
		importPackZip,
		installDefaultPackZip,
		removeImportedPack,
		renamePack,
		licenseLabel,
		rememberThumb,
		openPackLoading
	} from '$lib/packs';
	import { importFile } from '$lib/fileHandler.svelte';
	import { prefabs, loadPrefabs } from '$lib/prefabs';
	import { sceneAssets } from '$lib/sceneAssets';
	import { setNodeData } from '$lib/nodesHandler';
	import { findNodeAnyGraph } from '../../stores/flowStore';
	import { bottomDockActive, visibleDockKey, setDockOccupant } from '$lib/bottomDock';
	import { dragWindow } from '$lib/dragWindow';
	import { focusStack } from '$lib/windowFocus';
	import { tabbable, resizeGroup, tabGroups } from '$lib/windowTabs';
	import { dockable } from '$lib/docking';
	import ContextMenu from '../ContextMenu.svelte';
	import WindowShell from '../shared/WindowShell.svelte';
	import { clampWinSize, clampResize, anchorOf } from '$lib/windowSize';
	import { fly } from 'svelte/transition';

	const clampH = (h: number) =>
		Math.min(Math.max(h || 300, 200), Math.round(window.innerHeight * 0.8));

	// 18-B: floating-window size limits, shared with the clamp helpers
	const WIN_MIN = { minW: 420, minH: 280 };
	const WIN_DEFAULT = { w: 720, h: 440 };

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
		// 18-B: a size saved on a bigger screen must not come back oversized —
		// that is the state whose resize grip sits off-screen. Fitted BEFORE the
		// assignment so nothing reads $state during init (state_referenced_locally).
		const savedWin = clampWinSize(
			parseInt(localStorage.getItem('explorerWinW') ?? '720') || 720,
			parseInt(localStorage.getItem('explorerWinH') ?? '440') || 440,
			WIN_MIN
		);
		winW = savedWin.w;
		winH = savedWin.h;
		singleClickOpen = localStorage.getItem('explorerSingleClickOpen') === 'true';
		showBreadcrumb = localStorage.getItem('explorerBreadcrumb') !== 'false';
	}
	// touch / limited-width: keep the Explorer docked (no room to float; undock hidden),
	// unless the user opted into undocking on touch (Settings > Allow undocking)
	if (
		typeof window !== 'undefined' &&
		window.matchMedia?.('(pointer: coarse)').matches &&
		!get(mobileUndockAllowed)
	)
		docked = true;
	loadExplorer();
	loadPrefabs();

	function setDocked(v: boolean) {
		docked = v;
		localStorage.setItem('explorerDocked', String(v));
		if (v) bottomDockActive.set('explorer'); // re-docking makes it the visible panel
	}

	// The Explorer is the dock's separate (exclusive) panel — it reports docked+open
	// (+height for the --bottom-inset) and is visible only when it owns the dock. It is
	// mutually exclusive with the Flow-family tabs (activating a Flow tab closes it), so
	// it shows NO tab strip of its own.
	$effect(() => {
		setDockOccupant('explorer', !$explorerClose && docked, height);
		return () => setDockOccupant('explorer', false);
	});
	const dockVisible = $derived($visibleDockKey === 'explorer');

	// tab-grouped windows share one size: show the group's rect so a resize on any
	// member updates every tab, not just the active one.
	const myGroup = $derived($tabGroups.find((g: any) => g.members.includes('explorer')) ?? null);
	const effW = $derived(myGroup ? myGroup.rect.width : winW);
	const effH = $derived(myGroup ? myGroup.rect.height : winH);

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
		const baseW = myGroup ? myGroup.rect.width : winW;
		const baseH = myGroup ? myGroup.rect.height : winH;
		// 18-B: the corner stops at the viewport edge, so this grip stays reachable
		const at = anchorOf(e.currentTarget.parentElement);
		const fit = clampResize(baseW + e.movementX, baseH + e.movementY, at.left, at.top, WIN_MIN);
		winW = fit.w;
		winH = fit.h;
		resizeGroup('explorer', winW, winH); // if grouped, resize the whole group
	}
	function endWinResize(e: any) {
		if (!winResizing) return;
		winResizing = false;
		e.currentTarget.releaseCapture?.(e.pointerId);
		saveWinSize();
	}
	function saveWinSize() {
		localStorage.setItem('explorerWinW', String(winW));
		localStorage.setItem('explorerWinH', String(winH));
	}
	/** 18-B: double-click the grip — back to the default size, position kept */
	function resetWinSize() {
		const fit = clampWinSize(WIN_DEFAULT.w, WIN_DEFAULT.h, WIN_MIN);
		winW = fit.w;
		winH = fit.h;
		resizeGroup('explorer', winW, winH);
		saveWinSize();
	}
	/** a shrinking viewport must not strand the window at a size that no longer fits */
	function fitToViewport() {
		const fit = clampWinSize(winW, winH, WIN_MIN);
		if (fit.w === winW && fit.h === winH) return;
		winW = fit.w;
		winH = fit.h;
		resizeGroup('explorer', winW, winH);
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

	// N6: Packs section (mirror Scene) — expandable, lists packs; opening a pack
	// shows its items with lazily-resolved thumbnails.
	let packsExpanded = $state(
		typeof localStorage !== 'undefined' && localStorage.getItem('explorerPacksExpanded') === 'true'
	);
	function togglePacks() {
		packsExpanded = !packsExpanded;
		localStorage.setItem('explorerPacksExpanded', String(packsExpanded));
		if (packsExpanded && $packs.length === 0) loadPacks();
	}
	let thumbIdx: Record<string, number> = $state({}); // per pack-item webp->png->screenshot cursor
	let packZipInput: HTMLInputElement | undefined = $state();
	let hideBuiltinPacks = $state(
		typeof localStorage !== 'undefined' && localStorage.getItem('explorerHideBuiltinPacks') === 'true'
	);
	// P5: per-pack hide (built-ins can't be truly deleted — they're bundled/CDN — so
	// hiding is the reversible alternative; imported packs delete outright)
	let hiddenPacks = $state(new Set<string>(loadHiddenPacks()));
	function loadHiddenPacks(): string[] {
		try {
			return JSON.parse(localStorage.getItem('explorerHiddenPacks') || '[]');
		} catch {
			return [];
		}
	}
	function hidePack(name: string) {
		const s = new Set(hiddenPacks);
		s.add(name);
		hiddenPacks = s;
		localStorage.setItem('explorerHiddenPacks', JSON.stringify([...s]));
		if ($activeFolder === 'pack:' + name) openFolder('packs');
	}
	function showAllHiddenPacks() {
		hiddenPacks = new Set();
		localStorage.setItem('explorerHiddenPacks', '[]');
	}
	let shownPacks = $derived(
		$packs.filter(
			(p: any) => !(hideBuiltinPacks && p.source === 'default') && !hiddenPacks.has(p.name)
		)
	);
	loadPacks();
	async function importPackZipFile(file: File) {
		try {
			const pack = await importPackZip(file);
			packsExpanded = true;
			openFolder('pack:' + pack.name);
			showToast(`Imported pack "${pack.title}"`);
		} catch (err: any) {
			showToast('Pack import failed: ' + (err?.message ?? 'bad .zip'));
		}
	}
	async function onImportPackZip(e: Event) {
		const file = (e.target as HTMLInputElement).files?.[0];
		(e.target as HTMLInputElement).value = '';
		if (file) importPackZipFile(file);
	}
	// pack currently open (for the Properties attribution panel)
	let openPack = $derived(
		typeof $activeFolder === 'string' && $activeFolder.startsWith('pack:')
			? packByName($activeFolder.slice(5))
			: null
	);
	let packAttribModal = $state(false);
	let packAttribHtml = $state('');
	let packAttribLoading = $state(false);
	async function showPackAttribution(pack: any) {
		let html = pack.attributionHtml || '';
		if (!html && pack.attributionUrl) {
			// QW: the first fetch has a visible delay — open the modal immediately in a
			// loading state instead of leaving the click apparently ignored
			packAttribHtml = '';
			packAttribLoading = true;
			packAttribModal = true;
			try {
				const res = await fetch(pack.attributionUrl);
				if (res.ok) html = await res.text();
			} catch {}
			packAttribLoading = false;
			if (html) pack.attributionHtml = html; // second open is instant
		}
		if (!html)
			html =
				`<h3>${pack.title}</h3>` +
				(pack.copyright ? `<p>${pack.copyright}</p>` : '') +
				(pack.license ? `<p>License: ${licenseLabel(pack.license)}</p>` : '');
		packAttribHtml = html;
		packAttribModal = true;
	}
	// RP: where a pack's content comes from (index `source` field; imported packs
	// reuse their manifest homepage). Labelled with the repo slug for GitHub URLs,
	// the bare hostname otherwise.
	function packSourceUrl(pack: any): string {
		return pack?.sourceUrl || pack?.homepage || '';
	}
	function packSourceLabel(url: string): string {
		const gh = /github\.com\/([^/]+\/[^/#?]+)/.exec(url);
		if (gh) return gh[1].replace(/\.git$/, '');
		try {
			return new URL(url).hostname;
		} catch {
			return url;
		}
	}
	// M-2/RP: install a default-list .zip pack (audio/SFX). Shared by the row menu
	// AND the in-grid install card — a zip-only pack has no item list, so its open
	// view must offer the install itself (right-click-only was undiscoverable).
	let installingPack = $state(false);
	async function installZipPack(pack: any) {
		if (installingPack) return;
		installingPack = true;
		try {
			const imported = await installDefaultPackZip(pack);
			packsExpanded = true;
			openFolder('pack:' + imported.name);
			// the $activeFolder effect won't re-fire when we were ALREADY viewing this
			// pack (same value -> no rerun in svelte 5) — load the items explicitly
			loadPackItems(imported);
			showToast(`Installed "${imported.title}"`);
		} catch (err: any) {
			showToast('Install failed: ' + (err?.message ?? 'bad .zip'));
		} finally {
			installingPack = false;
		}
	}
	function packRowMenu(e: MouseEvent, pack: any) {
		e.preventDefault();
		const items: any[] = [
			// 21-G1: the missing entry. A pack row LOOKS like a folder row and carries the
			// same name as the library folder its install created — that folder always
			// renamed; this row had no rename at all, which is what got reported.
			{
				label: 'Rename',
				tooltip: 'Your name for this pack — local to you, and it survives a reload',
				action: () => {
					packsExpanded = true;
					startRenamePack(pack);
				}
			},
			{ label: 'Attribution / license', action: () => showPackAttribution(pack) }
		];
		if (packSourceUrl(pack))
			items.push({ label: 'Open source', action: () => window.open(packSourceUrl(pack), '_blank', 'noopener') });
		// M-2: a default-list .zip pack (e.g. audio/SFX) installs on demand
		if (pack.source === 'default' && pack.zip)
			items.push({ label: 'Install pack', action: () => installZipPack(pack) });
		if (pack.source === 'imported')
			items.push({
				label: 'Delete pack',
				danger: true,
				action: () => {
					removeImportedPack(pack.name);
					if ($activeFolder === 'pack:' + pack.name) openFolder('packs');
				}
			});
		else
			// P5: built-in packs are bundled/CDN — can't delete, so HIDE (reversible)
			items.push({ label: 'Hide pack', action: () => hidePack(pack.name) });
		menu = { x: e.clientX, y: e.clientY, items };
	}
	// fetch a pack's items when it's opened
	$effect(() => {
		const a = $activeFolder;
		if (typeof a === 'string' && a.startsWith('pack:')) {
			thumbIdx = {};
			loadPackItems(packByName(a.slice(5)));
		}
	});
	// pack-item thumbnail: imported items carry a dataURL; default items resolve
	// webp -> png -> screenshot via the <img> onerror cursor, else a placeholder icon
	function packThumb(item: any): string | null {
		if (item.resolvedThumb) return item.resolvedThumb; // P2: cached resolution
		if (item.thumbnail) return item.thumbnail;
		const cands = item.thumbs || [];
		return cands[thumbIdx[item.name] ?? 0] ?? null;
	}
	function packThumbError(item: any) {
		thumbIdx = { ...thumbIdx, [item.name]: (thumbIdx[item.name] ?? 0) + 1 };
	}
	// P2: the URL that actually loaded — remember it so switching packs doesn't re-probe
	function packThumbOk(item: any, src: string) {
		if (item.packName && !item.resolvedThumb && !item.thumbnail) {
			item.resolvedThumb = src;
			rememberThumb(item.packName, item.name, src);
		}
	}

	// icon-system: lucide kebab names, rendered through ui/Icon.svelte (data-driven)
	const KIND_ICONS: Record<string, string> = {
		image: 'image',
		audio: 'music',
		text: 'file-text',
		object: 'box',
		prefab: 'boxes',
		scene: 'map' // 21-F4: a level (.tpscene)
	};
	// semantic icon colors (ui.css classes over the --icon-* theme tokens)
	const KIND_COLORS: Record<string, string> = {
		image: 'ico-image',
		audio: 'ico-audio',
		text: 'ico-doc',
		object: 'ico-object',
		prefab: 'ico-prefab',
		scene: 'ico-prefab' // 21-F4: levels share the prefab tint
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
		// P4: the Packs root — one card per pack (single-click a pack card opens it)
		if ($activeFolder === 'packs') {
			return shownPacks.map((p: any) => ({
				id: 'packfolder:' + p.name,
				name: p.title,
				kind: 'pack-folder',
				packName: p.name
			}));
		}
		// N6: a pack's items (default packs from libraryList, imported from a manifest).
		// Give each a stable unique id — default items have none, and the keyed {#each}
		// needs one (duplicate undefined keys crash the block).
		if (typeof $activeFolder === 'string' && $activeFolder.startsWith('pack:')) {
			return $openPackItems.map((it) => ({ ...it, packEntry: true, id: it.id ?? `pack:${it.packName}:${it.name}` }));
		}
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
		if (a === 'prefabs') return [{ label: 'Prefabs', id: 'prefabs' as string | null }];
		if (a === 'packs') return [{ label: 'Packs', id: 'packs' as string | null }];
		if (typeof a === 'string' && a.startsWith('pack:')) {
			const p = packByName(a.slice(5));
			return [
				{ label: 'Packs', id: 'packs' as string | null },
				{ label: p?.title || a.slice(5), id: a as string | null }
			];
		}
		if (typeof a === 'string' && a.startsWith('scene')) {
			const sub = a.split(':')[1];
			const out = [{ label: 'Scene', id: 'scene' as string | null }];
			if (sub) out.push({ label: sub, id: a });
			return out;
		}
		const out = [{ label: 'Library', id: null as string | null }];
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
		if (typeof a === 'string' && a.startsWith('pack:')) return openFolder('packs'); // P4
		if (a === 'prefabs' || a === 'packs' || (typeof a === 'string' && a.startsWith('scene')))
			return openFolder(null);
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
	// 21-G1: a PACK row renames too — same inline editor, and it writes the pack's
	// display TITLE only (its `name` is the identity every cache and view key uses;
	// packs.js carries the reasoning)
	function startRenamePack(pack: any) {
		editing = { mode: 'rename-pack', packName: pack.name, value: pack.title || pack.name };
	}
	function commitEdit() {
		if (!editing || !isValidName(editing.value)) return;
		if (editing.mode === 'create') createFolder(editing.value, editing.parentId);
		else if (editing.mode === 'rename-item') renameItem(editing.itemId, editing.value);
		else if (editing.mode === 'rename-pack') renamePack(editing.packName, editing.value);
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

	// 21-G1: hand a library item back to the user as a file. fileHandler's own save
	// path verbatim (anchor + object URL + revoke) — there is no other way to start a
	// download from a page, and copying eight lines beats exporting a helper that would
	// pull fileHandler's whole export machinery into the Explorer.
	async function downloadItem(item: any) {
		const blob = await itemBlob(item.id);
		if (!blob) return showToast('That file has no stored bytes to download');
		const a = document.createElement('a');
		document.body.appendChild(a);
		a.style.display = 'none';
		const url = URL.createObjectURL(blob);
		a.href = url;
		a.download = item.name || 'download';
		a.click();
		URL.revokeObjectURL(url);
		a.remove();
	}

	function itemMenu(e: MouseEvent, item: any) {
		e.preventDefault();
		e.stopPropagation();
		// 21-G1: a PACK CARD in the Packs grid is not an item at all — it is the same
		// registry row the tree draws, so it gets the same menu. Without this it fell
		// through to Properties/Rename/Delete, every one of which addressed an item id
		// ('packfolder:<name>') that does not exist.
		if (item.kind === 'pack-folder') {
			const pack = packByName(item.packName);
			if (pack) packRowMenu(e, pack);
			return;
		}
		if (item.kind === 'prefab' || item.sceneEntry) return; // derived views have no CRUD
		menu = {
			x: e.clientX,
			y: e.clientY,
			items: [
				// 21-F4: a scene loads LOCALLY from here (authoring convenience) — the
				// travel NODE is how a game moves everyone together
				...(item.kind === 'scene'
					? [
							{
								label: 'Open here (this screen)',
								tooltip: 'Load this scene locally — use a Travel node to move every player together',
								action: () => travelToLevel(item.hash, item.name)
							}
						]
					: []),
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
				// 21-G1: get the bytes back OUT. Offered for every library kind, not just
				// scenes — the library already holds the only copy of an imported model or
				// a painted texture, and the code is identical whatever the kind, so
				// restricting it would be a decision with nothing behind it. A PACK-view
				// entry is excluded: a default pack's card is a remote URL with no stored
				// blob (its library copy, which does have one, offers this normally).
				...(item.packEntry
					? []
					: [
							{
								label: item.kind === 'scene' ? 'Download (.tpscene)' : 'Download',
								tooltip: 'Save this file to your computer',
								action: () => downloadItem(item)
							}
						]),
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
		const inPacks =
			$activeFolder === 'packs' || (typeof $activeFolder === 'string' && $activeFolder.startsWith('pack:'));
		if (!inPacks && ($activeFolder === 'prefabs' || (typeof $activeFolder === 'string' && $activeFolder.startsWith('scene')))) return;
		e.preventDefault();
		menu = {
			x: e.clientX,
			y: e.clientY,
			// P6: the Packs view adds pack-import affordances instead of New folder
			items: inPacks
				? [
						{ label: '＋ Import pack (.zip)', action: () => packZipInput?.click() },
						{ label: 'Load pack from URL', action: loadPackFromUrl }
					]
				: [
						{ label: 'New folder', action: () => startCreate($activeFolder ?? null) },
						// 21-F4: a saved scene is an ordinary content-hashed .tpscene item —
						// a Travel node loads it by hash. 21-G1: the `Scenes` folder is only
						// where a save LANDS; discovery is BY KIND, so that folder can be
						// renamed, moved or deleted without stranding a single scene.
						{
							label: 'Save scene…',
							tooltip: 'Save this scene as a .tpscene asset a Travel node can load',
							action: () => {
								const name = prompt('Scene name:', 'Scene');
								if (name) saveSceneAsLevel(name);
							}
						},
						{
							label: 'New scene…',
							tooltip: 'An EMPTY scene asset — it captures nothing from what is open',
							action: () => {
								const name = prompt('Scene name:', 'New scene');
								if (name) newLevel(name);
							}
						},
						// 21-G3: the whole project as ONE file. Offered only once there IS
						// a project — a pristine manifest would export an empty zip, and an
						// entry that can only produce nothing is worse than no entry.
						// Importing one rides the Sidebar's Open (a .tp in the file dialog).
						...(manifestInUse()
							? [
									{
										label: 'Export project (.tp)',
										tooltip:
											'The project manifest, every scene version still stored here, and the assets it uses — as one file',
										action: () => downloadProject()
									}
								]
							: [])
					]
		};
	}
	// P6: load a pack from a .zip URL (or a GitHub repo link -> codeload .zip). Remote
	// manifest.json / jsDelivr repos are the PACKS_BASE path (later). CORS-gated.
	async function loadPackFromUrl() {
		const url = prompt('Pack URL — a .zip, or a GitHub repo link:');
		if (!url) return;
		let fetchUrl = url.trim();
		const gh = fetchUrl.match(/^https?:\/\/github\.com\/([^/]+)\/([^/?#]+)\/?$/);
		if (gh) fetchUrl = `https://codeload.github.com/${gh[1]}/${gh[2].replace(/\.git$/, '')}/zip/refs/heads/main`;
		try {
			const res = await fetch(fetchUrl);
			if (!res.ok) return showToast(`Could not fetch that URL (HTTP ${res.status})`);
			const isZip = /\.zip($|\?)/i.test(fetchUrl) || !!gh || (res.headers.get('content-type') || '').includes('zip');
			if (!isZip) return showToast('Only .zip / GitHub-repo pack URLs are supported for now');
			const pack = await importPackZip(new File([await res.blob()], (fetchUrl.split('/').pop() || 'pack') + '.zip'));
			packsExpanded = true;
			openFolder('pack:' + pack.name);
			showToast(`Loaded pack "${pack.title}"`);
		} catch {
			showToast('Could not load the pack (network / CORS — try a direct .zip URL)');
		}
	}

	function onDrop(e: DragEvent) {
		dropActive = false;
		// internal payloads are handled by the row/card targets
		if (canAccept(e)) return;
		e.preventDefault();
		const files = e.dataTransfer?.files;
		if (!files?.length) return;
		const folder = $activeFolder;
		// B1.1: the Packs view accepts ONLY pack .zip files — anything else would
		// import with a bogus folderId and orphan (invisible). Mirror the Import path.
		if (folder === 'packs' || (typeof folder === 'string' && folder.startsWith('pack:'))) {
			const zip = Array.from(files).find((f) => f.name.toLowerCase().endsWith('.zip'));
			if (zip) importPackZipFile(zip);
			else showToast('Only pack .zip files can be dropped into Packs');
			return;
		}
		// the derived Scene view is read-only — don't orphan a drop here
		if (typeof folder === 'string' && folder.startsWith('scene')) {
			showToast('This view is read-only — drop files into a Library folder');
			return;
		}
		importFiles(files, folder === 'prefabs' ? null : folder);
	}

	function itemDragPayload(item: any) {
		return {
			id: item.id ?? null,
			kind: item.kind,
			name: item.name,
			prefabId: item.prefabId ?? null,
			url: item.glbUrl ?? null
		};
	}
	function onItemDragStart(e: DragEvent, item: any) {
		// 96 consumes these payloads (viewport placement / texture drop). N6: a
		// default-pack item carries a `url` so the drop can fetch+place it without
		// first storing it in the Explorer library.
		e.dataTransfer?.setData('application/x-explorer-item', JSON.stringify(itemDragPayload(item)));
	}

	// --- MOBILE drag-to-place (HTML5 DnD is desktop-only). On touch a LONG-PRESS on a
	// card picks the item up; dragging a ghost onto the viewport and releasing there
	// places it at that spot (dropExplorerItem raycasts the screen coords — same path
	// the desktop drop uses). A quick tap still selects; a swipe still scrolls the grid. ---
	let tDrag = $state<{ payload: any; label: string } | null>(null);
	let tDragging = $state(false);
	let tGhostX = $state(0);
	let tGhostY = $state(0);
	let tPressTimer = 0;
	let tStartX = 0;
	let tStartY = 0;
	let tSuppressClick = false;

	function onCardPointerDown(e: PointerEvent, item: any) {
		if (e.pointerType === 'mouse') return; // desktop uses native HTML5 drag
		tStartX = e.clientX;
		tStartY = e.clientY;
		const target = e.currentTarget as HTMLElement;
		const pid = e.pointerId;
		const payload = itemDragPayload(item);
		const label = item.name;
		clearTimeout(tPressTimer);
		tPressTimer = window.setTimeout(() => {
			tDrag = { payload, label };
			tDragging = true;
			tGhostX = tStartX;
			tGhostY = tStartY;
			try {
				target.setPointerCapture?.(pid);
			} catch {}
			try {
				navigator.vibrate?.(15);
			} catch {}
		}, 300);
	}
	function onCardPointerMove(e: PointerEvent) {
		if (e.pointerType === 'mouse') return;
		if (!tDragging) {
			// moved before the long-press fired -> it's a scroll, not a pick-up
			if (Math.abs(e.clientX - tStartX) > 10 || Math.abs(e.clientY - tStartY) > 10)
				clearTimeout(tPressTimer);
			return;
		}
		e.preventDefault();
		tGhostX = e.clientX;
		tGhostY = e.clientY;
	}
	function onCardPointerUp(e: PointerEvent) {
		clearTimeout(tPressTimer);
		if (tDragging && tDrag) {
			const el = document.elementFromPoint(e.clientX, e.clientY);
			// drop only when released over the viewport, not back onto the Explorer
			if (!el?.closest?.('#explorer-list') && !el?.closest?.('#explorer-window')) {
				const payload = tDrag.payload;
				const x = e.clientX;
				const y = e.clientY;
				import('$lib/explorerDrop').then((m) => m.dropExplorerItem(payload, x, y));
			}
			tSuppressClick = true; // the drag must not also fire the tap-select
		}
		tDragging = false;
		tDrag = null;
	}
	function onCardClick(item: any) {
		if (tSuppressClick) {
			tSuppressClick = false;
			return;
		}
		inspectItem(item);
	}

	// N6: place a default-pack item into the scene (double-click / Enter) at origin
	// 15-B3: the CDN fetch takes seconds — hold the SAME loading toast the drop
	// path shows (it used to look like nothing happened until the model popped in)
	async function placePackItem(item: any) {
		const { holdLoadingToast } = await import('$lib/explorerDrop');
		const dismiss = holdLoadingToast(String(item.name || 'model'));
		try {
			const res = await fetch(item.glbUrl);
			if (!res.ok) {
				dismiss();
				return showToast('Could not fetch the pack item');
			}
			await importFile(new File([await res.blob()], item.name + '.glb'), item.name, 'glb');
			dismiss();
		} catch {
			dismiss();
			showToast('Could not load the pack item (check the network / CORS)');
		}
	}

	// 197b: single-click = select + show properties in the ⓘ panel; double-click
	// opens/previews (openItem). Right-click Properties routes here too.
	function inspectItem(item: any) {
		if (item.kind === 'prefab') return;
		if (item.kind === 'pack-folder') {
			openFolder('pack:' + item.packName); // P4: single-click a pack card opens it
			return;
		}
		if (item.packEntry) {
			// pack items aren't library items (no inspectedFile highlight); just select
			// for the Properties panel
			selected = { kind: 'item', item };
			return;
		}
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
		if (item.kind === 'pack-folder') {
			openFolder('pack:' + item.packName);
			return;
		}
		if (item.packEntry && item.glbUrl) {
			// default-pack item: place it into the scene (double-click)
			placePackItem(item);
			return;
		}
		if (item.sceneEntry) {
			// derived Scene entries open live views (108): textures preview,
			// scripts edit the NODE code (replicated via setNodeData)
			if (item.kind === 'image' && item.dataUrl) openImagePreview({ title: item.name, url: item.dataUrl, onClose: () => gridEl?.focus() });
			else if (item.kind === 'text' && item.nodeId) {
				// H1: the script node can live in any graph document
				const found = findNodeAnyGraph((n: any) => n.id === item.nodeId);
				if (found)
					openTextEditor({
						title: item.name + ' (live script)',
						code: found.node.data?.code ?? '',
						onSave: (code: string) => setNodeData(item.nodeId, { code }, found.graphId),
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
		} else if (item.kind === 'object' && !item.packEntry) {
			// P1: double-click an object item ALWAYS opens the preview popup (the
			// enable3dPreview toggle only gates the inline Properties preview)
			openModelPreview({ title: item.name, itemId: item.id, name: item.name, onClose: () => gridEl?.focus() });
		}
	}
</script>


<svelte:window onresize={fitToViewport} />

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
							class="rounded-sm px-1 py-0.5 hover:bg-gray-700 {i === crumbs.length - 1 ? 'text-white' : ''}"
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
					: 'text-gray-300 hover:bg-gray-700'} {dropFolder === 'root' ? 'outline-solid outline-2 outline-primary-500' : ''}"
				ondragover={(e) => dragOverInto(e, 'root')}
				ondragleave={() => (dropFolder = null)}
				ondrop={(e) => dropInto(e, null)}
				onclick={() => openFolder(null)}><House size={16} class="mr-1.5 w-4 text-center text-gray-400" aria-hidden="true" />Library</button
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
								: 'text-gray-300 hover:bg-gray-700'} {dropFolder === row.folder.id ? 'outline-solid outline-2 outline-primary-500' : ''}"
							draggable="true"
							ondragstart={(e) =>
								e.dataTransfer?.setData('application/x-explorer-folder', JSON.stringify({ id: row.folder.id }))}
							oncontextmenu={(e) => folderMenu(e, row.folder)}
							onclick={() => openFolder(row.folder.id)}
							ondblclick={() => toggleExpand(row.folder.id)}
						>
							<Folder size={16} class="ico-folder mr-1.5 w-4 text-center" aria-hidden="true" />{row.folder.name}
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
					class="whitespace-nowrap rounded-sm border border-dashed border-gray-600 px-2 py-1 text-left text-gray-400 hover:border-gray-400 hover:text-gray-200"
					onclick={() => startCreate(typeof $activeFolder === 'string' && ($activeFolder === 'prefabs' || $activeFolder.startsWith('scene')) ? null : $activeFolder)}>＋ New folder</button
				>
				<div class="my-0.5 border-t border-gray-700/40"></div>
				<button
					id="prefabs-folder"
					class="whitespace-nowrap rounded px-2 py-1 text-left {$activeFolder === 'prefabs'
						? 'bg-primary-700 text-white'
						: 'text-gray-300 hover:bg-gray-700'}"
					onclick={() => openFolder('prefabs')}><Boxes size={16} class="ico-prefab mr-1.5 w-4 text-center" aria-hidden="true" />Prefabs</button
				>
				<button
					id="packs-folder"
					class="whitespace-nowrap rounded px-2 py-1 text-left {$activeFolder === 'packs'
						? 'bg-primary-700 text-white'
						: 'text-gray-300 hover:bg-gray-700'}"
					title="Asset packs — click to list them, double-click to expand the tree"
					onclick={() => openFolder('packs')} ondblclick={togglePacks}><PackageOpen size={16} class="mr-1.5 w-4 text-center text-gray-400" aria-hidden="true" />Packs {packsExpanded ? '▾' : '▸'}</button
				>
				{#if packsExpanded}
					{#each shownPacks as pack (pack.name)}
						{#if editing?.mode === 'rename-pack' && editing.packName === pack.name}
							{@render editRow(1)}
						{:else}
						<button
							data-pack={pack.name}
							class="whitespace-nowrap rounded px-2 py-1 text-left {$activeFolder === 'pack:' + pack.name
								? 'bg-primary-700 text-white'
								: 'text-gray-400 hover:bg-gray-700'}"
							style="padding-left: 22px"
							title={pack.license ? pack.title + ' · ' + pack.license : pack.title}
							oncontextmenu={(e) => packRowMenu(e, pack)}
							onclick={() => openFolder('pack:' + pack.name)}
						>
							<PackageOpen size={16} class="mr-1.5 w-4 text-center text-gray-500" aria-hidden="true" />{pack.title}
						</button>
						{/if}
					{/each}
					{#if shownPacks.length === 0}
						<span class="px-2 py-1 text-[10px] italic text-gray-500" style="padding-left: 22px">No packs</span>
					{/if}
				{/if}
				<button
					id="scene-folder"
					class="whitespace-nowrap rounded px-2 py-1 text-left {$activeFolder === 'scene'
						? 'bg-primary-700 text-white'
						: 'text-gray-300 hover:bg-gray-700'}"
					title="Assets the shared scene uses right now — identical on every peer"
					onclick={() => openFolder('scene')} ondblclick={toggleScene}><Globe size={16} class="mr-1.5 w-4 text-center text-gray-400" aria-hidden="true" />Scene {sceneExpanded ? '▾' : '▸'}</button
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
						<Folder size={16} class="ico-folder mr-1.5 w-4 text-center" aria-hidden="true" />{sub} ({$sceneAssets.filter((a) => a.group === sub).length})
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
			class="relative h-full min-w-0 overflow-y-auto p-1 outline-hidden"
			style="scrollbar-gutter: stable"
			tabindex="-1"
			oncontextmenu={gridMenu}
			onclick={gridBackgroundClick}
			onkeydown={gridKeydown}
			role="region"
		>
			{#if childFolders.length === 0 && gridItems.length === 0}
				{#if openPack && $openPackLoading}
					<!-- QW: first open of a pack fetches its item list from the CDN — show a
					     real loading state instead of "no items" (or the stale previous list) -->
					<div id="pack-loading" class="flex items-center justify-center gap-2 p-6 text-xs text-gray-400">
						<LoaderCircle size={16} class="animate-spin" aria-hidden="true" /> Loading pack contents…
					</div>
				{:else if openPack && openPack.source === 'default' && openPack.zip}
					<!-- RP: a zip-only pack (audio-essentials) has no browsable item list —
					     its open view IS the install prompt (right-click-only was undiscoverable) -->
					<div class="flex flex-col items-center gap-2 p-6 text-center">
						<span class="text-4xl text-gray-300"><Gift size={16} aria-hidden="true" /></span>
						<span class="text-sm text-gray-300">"{openPack.title}" installs into your local library.</span>
						<button
							id="pack-install"
							class="rounded-sm bg-primary-600 px-3 py-1.5 text-sm text-white hover:bg-primary-500 disabled:opacity-50"
							disabled={installingPack}
							onclick={() => installZipPack(openPack)}
						><Download size={16} class="mr-1" aria-hidden="true" />{installingPack ? 'Installing…' : `Install ${openPack.title}`}</button>
					</div>
				{:else}
				<p class="p-4 text-center text-xs italic text-gray-500">
					{$activeFolder === 'prefabs'
						? 'No prefabs yet — right-click an object and Save as prefab.'
						: $activeFolder === 'packs' ? 'No packs. Right-click here to import a pack (.zip) or load one from a URL.'
						: typeof $activeFolder === 'string' && $activeFolder.startsWith('pack:') ? 'This pack has no items.'
						: typeof $activeFolder === 'string' && $activeFolder.startsWith('scene') ? 'No shared assets in this scene group yet.' : 'Drop images, audio, text or 3D files here to import them.'}
				</p>
				{/if}
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
								<span class="ico-folder flex h-14 w-14 items-center justify-center"><Folder size={32} aria-hidden="true" /></span>
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
							class="explorer-card group relative flex cursor-grab flex-col items-center gap-1 rounded border p-1.5 {$inspectedFile === item.id
								? 'border-primary-600 bg-primary-600/10'
								: 'border-transparent hover:border-gray-600 hover:bg-gray-700/60'}"
							draggable="true"
							role="listitem"
							title={item.name}
							style:touch-action={tDragging ? 'none' : 'pan-y'}
							ondragstart={(e) => onItemDragStart(e, item)}
							onpointerdown={(e) => onCardPointerDown(e, item)}
							onpointermove={onCardPointerMove}
							onpointerup={onCardPointerUp}
							oncontextmenu={(e) => itemMenu(e, item)}
							onclick={() => onCardClick(item)}
							ondblclick={() => openItem(item)}
						>
							{#if item.kind === 'scene' && staleScene($projectManifest, item.hash)}
								<!-- 21-G2: this file is an OLD version — the project's pointer for its
								     scene moved past it. The manifest keeps every hash, so it still
								     opens; the dot just says "not the latest". -->
								<span
									class="absolute right-1 top-1 h-2.5 w-2.5 rounded-full bg-amber-400"
									title={'An update of "' + staleScene($projectManifest, item.hash) + '" exists — this file is an older version'}
								></span>
							{/if}
							{#if item.packEntry}
								{#if packThumb(item)}
									<!-- N6: lazily resolve webp -> png -> screenshot via onerror; P2: cache the winner -->
									<img
										src={packThumb(item)}
										alt={item.name}
										onerror={() => packThumbError(item)}
										onload={(e) => packThumbOk(item, (e.currentTarget as HTMLImageElement).src)}
										class="h-14 w-14 rounded-sm object-cover"
									/>
								{:else}
									<span class="flex h-14 w-14 items-center justify-center rounded-sm bg-gray-700 {KIND_COLORS[item.kind] ?? 'text-gray-400'}"><Icon name={KIND_ICONS[item.kind] ?? 'package'} size={28} /></span>
								{/if}
							{:else if item.thumbnail}
								<img src={item.thumbnail} alt={item.name} class="h-14 w-14 rounded-sm object-cover" />
							{:else}
								<span class="flex h-14 w-14 items-center justify-center rounded-sm bg-gray-700 {KIND_COLORS[item.kind] ?? 'text-gray-400'}">
									<Icon name={KIND_ICONS[item.kind] ?? 'package'} size={28} />
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
				{#if openPack}
					<!-- N6: pack-level properties + attribution -->
					<div class="flex flex-col gap-1 border-b border-gray-700/40 pb-2">
						<div class="flex items-center gap-2">
							<span class="text-gray-400"><PackageOpen size={18} aria-hidden="true" /></span>
							<span class="min-w-0 flex-1 wrap-break-word font-semibold">{openPack.title}</span>
						</div>
						{#if openPack.license}<div class="text-[11px] text-gray-400">License: {licenseLabel(openPack.license)}</div>{/if}
						{#if openPack.copyright}<div class="text-[11px] text-gray-400">{openPack.copyright}</div>{/if}
						<button id="pack-attribution" class="ui-button-quiet mt-1 self-start" onclick={() => showPackAttribution(openPack)}>ⓘ Attribution / license</button>
						{#if packSourceUrl(openPack)}
							<a
								id="pack-source"
								class="ui-button-quiet mt-1 inline-flex items-center gap-1.5 self-start"
								href={packSourceUrl(openPack)}
								target="_blank"
								rel="noopener"
								title="Open the content source"
							><ExternalLink size={14} aria-hidden="true" /> {packSourceLabel(packSourceUrl(openPack))}</a>
						{/if}
					</div>
				{/if}
				{#if selItem}
					<div class="flex items-center gap-2">
						{#if selItem.thumbnail}
							<img src={selItem.thumbnail} alt="" class="h-12 w-12 rounded-sm object-cover" />
						{:else}
							<span class="flex h-12 w-12 items-center justify-center rounded-sm bg-gray-700 {KIND_COLORS[selItem.kind] ?? 'text-gray-400'}"
								><Icon name={KIND_ICONS[selItem.kind] ?? 'package'} size={24} /></span
							>
						{/if}
						<span class="min-w-0 flex-1 wrap-break-word font-semibold">{selItem.name}</span>
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
					{#if selItem.kind === 'object' && $enable3dPreview && !selItem.packEntry}
						<div class="mt-1 overflow-hidden rounded-sm bg-[#0d1117]" style="height: 150px">
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
						{#if selItem.packEntry}
							<button class="ui-button-quiet" onclick={() => openItem(selItem)}>Place in scene</button>
						{:else}
							<button class="ui-button-quiet" onclick={() => startRenameItem(selItem)}>Rename</button>
							{#if selItem.kind === 'text' || selItem.kind === 'image'}
								<button class="ui-button-quiet" onclick={() => openItem(selItem)}>{selItem.kind === 'text' ? 'Edit' : 'Preview'}</button>
							{:else if selItem.kind === 'object' && $enable3dPreview}
								<button class="ui-button-quiet" onclick={() => openItem(selItem)}>3D preview</button>
							{/if}
						{/if}
					</div>
				{:else if selected?.kind === 'folder'}
					{@const counts = folderCounts(selected.folder.id)}
					<div class="flex items-center gap-2">
						<span class="ico-folder"><Folder size={22} aria-hidden="true" /></span>
						<span class="min-w-0 flex-1 wrap-break-word font-semibold">{selected.folder.name}</span>
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
				<label class="flex items-center gap-2" title="Hide the bundled packs, showing only your imported ones">
					<input
						type="checkbox"
						checked={hideBuiltinPacks}
						onchange={(e) => {
							hideBuiltinPacks = e.currentTarget.checked;
							localStorage.setItem('explorerHideBuiltinPacks', String(hideBuiltinPacks));
						}}
					/>
					Hide built-in packs
				</label>
				{#if hiddenPacks.size > 0}
					<button class="ui-button-quiet self-start text-[11px]" onclick={showAllHiddenPacks}
						>Show {hiddenPacks.size} hidden pack{hiddenPacks.size === 1 ? '' : 's'}</button
					>
				{/if}
				<div class="mt-1 border-t border-gray-700/40 pt-2">
					<button class="ui-button-quiet w-full" onclick={() => packZipInput?.click()}>＋ Import pack (.zip)</button>
					<input bind:this={packZipInput} type="file" accept=".zip" class="hidden" onchange={onImportPackZip} />
				</div>
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
			<div class="mb-1 flex items-center gap-2">
				<span class="text-xs font-semibold text-gray-200"><FolderTree size={16} class="mr-1" aria-hidden="true" />Explorer</span>
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
			<div style="height: calc({height - 44}px - var(--dock-inset, 0px))">
				{@render content()}
			</div>
		</div>
	{:else}
		<div
			id="explorer-window"
			class="ui-panel fixed flex flex-col overflow-hidden"
			use:dragWindow={{ key: 'explorerWin', defaultRect: { left: 160, top: 120 } }}
			use:focusStack
			use:tabbable={{ key: 'explorer', title: 'Explorer', openStore: explorerClose, isOpen: (v) => !v, close: () => explorerClose.set(true) }}
			use:dockable={{ key: 'explorer' }}
			style="z-index: var(--z-window)"
			style:width="{effW}px"
			style:height="{effH}px"
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
				<span><FolderTree size={16} class="mr-1" aria-hidden="true" />Explorer</span>
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
				title="Drag to resize · double-click to reset size"
				onpointerdown={startWinResize}
				onpointermove={doWinResize}
				onpointerup={endWinResize}
				ondblclick={resetWinSize}
			></div>
		</div>
	{/if}
{/if}

{#if menu}
	<ContextMenu x={menu.x} y={menu.y} items={menu.items} on:close={() => (menu = null)} />
{/if}

<!-- mobile touch-drag ghost that follows the finger onto the viewport -->
{#if tDragging && tDrag}
	<div
		class="pointer-events-none fixed z-1400 max-w-[160px] -translate-x-1/2 -translate-y-1/2 truncate rounded-sm border border-primary-400 bg-gray-800 px-2 py-1 text-center text-xs font-semibold text-gray-100 shadow-lg"
		style="left: {tGhostX}px; top: {tGhostY}px;"
	>
		{tDrag.label}
	</div>
{/if}

<!-- N6: pack attribution / license (raw HTML fragment, like the Library popup).
     Backdrop is a <button> so no div needs a click handler (a11y-clean). -->
{#if packAttribModal}
	<button
		class="fixed inset-0 z-(--z-window) cursor-default bg-black/50"
		aria-label="Close attribution"
		onclick={() => (packAttribModal = false)}
	></button>
	<div
		id="pack-attrib-modal"
		class="ui-panel fixed left-1/2 top-1/2 z-(--z-window) max-h-[70vh] w-96 -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg p-4 text-sm"
		style="z-index: calc(var(--z-window) + 1)"
	>
		{#if packAttribLoading}
			<div class="flex items-center gap-2 p-4 text-sm text-gray-400">
				<LoaderCircle size={16} class="animate-spin" aria-hidden="true" /> Loading attribution…
			</div>
		{:else}
			<div class="prose prose-invert prose-sm max-w-none">{@html packAttribHtml}</div>
		{/if}
		<div class="mt-3 flex justify-end">
			<button class="ui-button-quiet" onclick={() => (packAttribModal = false)}>Close</button>
		</div>
	</div>
{/if}
