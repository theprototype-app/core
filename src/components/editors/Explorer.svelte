<script lang="ts">
	import { Box, Boxes, Download, ExternalLink, Folder, FolderTree, Gift, Globe, House, LayoutGrid, List, LoaderCircle, PackageOpen } from '@lucide/svelte';
	import Icon from '../ui/Icon.svelte';
	// Explorer (95, tree v2 in 106): dockable asset browser — real file-manager
	// tree on the left (inline create/rename, expand/collapse, drag re-parent,
	// cascade delete, resizable), thumbnail grid on the right (subfolder cards
	// + items), drag files in to import. It is an ordinary bottom-dock TAB beside
	// the Flow-family views (bottomDock.js), sharing their strip and their height;
	// undocks into a floating window.
	import { get } from 'svelte/store';
	import { tick, untrack } from 'svelte';
	import { explorerClose, mobileUndockAllowed, explorerSceneSaveArm, explorerDockArm, peers } from '../../stores/appStore.js';
	import { showToast, enable3dPreview, stackOnDrop, confirmPrefabUpdate } from '../../stores/appStore.js';
	import {
		explorerFolders,
		explorerItems,
		hiddenItems,
		activeFolder,
		loadExplorer,
		createFolder,
		renameFolder,
		deleteFolder,
		folderCounts,
		folderSubtree,
		moveFolder,
		moveItem,
		importFiles,
		revealItemId,
		deleteItem,
		renameItem,
		isValidName,
		itemBlob,
		itemByHash,
		inspectedFile,
		setItemHidden,
		updateItemBytes,
		parseObjectFile
	} from '$lib/explorer';
	import { openTextEditor, openImagePreview, openModelPreview, previewSuspended } from '$lib/fileWindows';
	// 21-F4: scenes as LEVELS — .tpscene items in a Levels folder, saved from here
	// 21-G9: `currentLevel` is WHERE WE ARE — the header breadcrumb's scene half and
	// the accent on the open scene's own card.
	// 21-I4: double-click OPENS a scene — `publishCurrentIfChanged` is the save half of
	// the unsaved-changes guard (see `openSceneItem`).
	import {
		saveSceneAsLevel,
		newLevel,
		renameOpenLooseScene,
		travelToLevel,
		publishCurrentIfChanged,
		currentLevel
	} from '$lib/levels';
	// 21-I4: 21-G9 already computes "does the open scene differ from the version its name
	// points at", behind a throttle, because the answer costs a whole-scene
	// serialization. This READS that flag and never recomputes it.
	import { sceneDirty, recomputeSceneDirty } from '$lib/sceneIdentity';
	import { showChoice, showConfirm } from '$lib/confirmDialog';
	import VersionHistory from './VersionHistory.svelte';
	// 21-G2: the "update available" dot on old scene versions. The manifest store is
	// passed as the reactive dependency — a helper reading through get() registers none
	// (the documented rule), so the badge would otherwise never appear live.
	// R22-R1/R2: the shared library — Share/Unshare, the adoption marks, and the rows
	// whose bytes are not on this device. `remoteSharedRows`/`sharedIndexInUse` take the
	// manifest as an argument on purpose: a helper reading a store through get()
	// registers no svelte dependency (the documented rule), so the badges would never
	// appear live.
	import {
		shareItem,
		unshareItem,
		shareFolder,
		unshareFolder,
		remoteSharedRows,
		pullSharedItem,
		pendingPulls,
		sharedIndexInUse,
		unshareHash,
		canUnshare,
		deleteSharedItem,
		deletedLog,
		restoreDeletedItem,
		purgeDeletedItem,
		emptyDeletedLog,
		deletedThumb,
		logLocalDeletion,
		deleteWithoutConfirm
	} from '$lib/sharedLibrary';
	// R22 round 2: a shared file's PICTURE travels on its own tiny channel, so a card can
	// show a thumbnail before anybody downloads the bytes (see assetShare).
	import { sharedThumbs, requestAssetThumb, unavailableHashes } from '$lib/assetShare';
	// R22 round 9: THUMBNAILS OR A LIST. The comparator and the column model live in a
	// pure leaf ($lib/explorerView): the MODE is global, columns and sort are per view.
	import {
		explorerViewMode,
		explorerColumns,
		explorerSort,
		explorerDeletedGroup,
		columnsFor,
		columnVisible,
		toggleColumn,
		sortBy,
		sortEntries,
		groupByDeleter
	} from '$lib/explorerView';
	import {
		projectManifest,
		staleSceneHash,
		manifestInUse,
		setProjectName,
		sceneOfHash,
		sceneEntry
	} from '$lib/projectManifest';
	const staleScene = (_manifest: any, hash: string) => staleSceneHash(hash);
	// 21-I5 REVISED: the ONE filesystem sanitiser, plus the version-date stamp the zip
	// entries and the panel's per-row download both name their files with.
	import { fileNameBase, versionStamp } from '$lib/saveName';
	// 21-G3: the whole project as ONE .tp file (manifest + scenes + assets).
	import { downloadProject } from '$lib/projectFile';
	import ModelPreview from './ModelPreview.svelte';
	// R22-R8: the transfer indicator and the Logs pane, one component in two modes
	import TransferLog from './TransferLog.svelte';
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
	import { importFile, exportObjectsAsGltf } from '$lib/fileHandler.svelte';
	// 21-H2: the Explorer is the prefab HOME (the Library modal is gone), so it owns
	// their whole CRUD — add, export both ways, update, rename, properties, delete.
	import {
		prefabs,
		loadPrefabs,
		prefabById,
		prefabObject,
		prefabFacts,
		instantiatePrefab,
		removePrefab,
		renamePrefab,
		updatePrefab,
		prefabSnapshot,
		restorePrefabBytes,
		savePrefabSelection,
		exportPrefab
	} from '$lib/prefabs';
	// 21-I3: Export ▸ scene (.tpscene) — a scene containing just this prefab. Built from
	// the EMPTY payload plus this one object, never a capture of the live scene.
	import { emptySessionPayload, exportSessionZip } from '$lib/sessions';
	import { selectedObjects, objectsGroup } from '../../stores/sceneStore.js';
	import { sceneAssets } from '$lib/sceneAssets';
	import { setNodeData } from '$lib/nodesHandler';
	import { findNodeAnyGraph } from '../../stores/flowStore';
	import { bottomDockActive, visibleDockKey, dockMinimized, setDockOccupant, dockHeight } from '$lib/bottomDock';
	import { dragWindow } from '$lib/dragWindow';
	import { focusStack } from '$lib/windowFocus';
	import { tabbable, resizeGroup, tabGroups } from '$lib/windowTabs';
	import { dockable } from '$lib/docking';
	import ContextMenu from '../ContextMenu.svelte';
	import DockTabs from '../DockTabs.svelte';
	import WindowShell from '../shared/WindowShell.svelte';
	import { clampWinSize, clampResize, anchorOf } from '$lib/windowSize';
	import { fly } from 'svelte/transition';

	const clampH = (h: number) =>
		Math.min(Math.max(h || 300, 200), Math.round(window.innerHeight * 0.8));

	// 18-B: floating-window size limits, shared with the clamp helpers
	const WIN_MIN = { minW: 420, minH: 280 };
	const WIN_DEFAULT = { w: 720, h: 440 };

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
		// one-shot migration: the Explorer used to keep a docked height of its own
		// ('explorerHeight'). It is a dock TAB now, so the dock's shared height owns
		// it — adopt the old value once, then drop the key.
		try {
			const legacyH = localStorage.getItem('explorerHeight');
			if (legacyH) {
				dockHeight.set(clampH(parseInt(legacyH) || 300));
				localStorage.removeItem('explorerHeight');
			}
		} catch {}
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

	// 4b: CONSUME the dock arm. The Controls toolbar's Explorer menu offers "Open as
	// dock tab" / "Open as floating window", and `docked` above is read from
	// localStorage exactly ONCE, at mount — so the toolbar writing that flag would be
	// inert at a live panel and the row would read as a dead button. It asks through
	// the store instead and `setDocked` (which owns the flag, this branch and the dock
	// occupancy together) is what acts. Same write-once shape as `explorerSceneSaveArm`.
	$effect(() => {
		const arm = $explorerDockArm;
		if (!arm) return;
		explorerDockArm.set(null);
		untrack(() => {
			if (arm.docked !== docked) setDocked(arm.docked);
			explorerClose.set(false); // the rows say "Open as …", so open it
		});
	});

	// A dock tab like any other: report docked+open (+ the SHARED dock height, which
	// feeds --bottom-inset) so the strip lists it, and render only while it is the
	// visible tab. Being covered by another tab closes nothing — this stays open.
	$effect(() => {
		setDockOccupant('explorer', !$explorerClose && docked, $dockHeight);
		return () => setDockOccupant('explorer', false);
	});
	// W2: a MINIMIZED dock renders nothing while every tab stays open (the occupant
	// report above is untouched, so the strip comes back with its tabs intact)
	const dockVisible = $derived($visibleDockKey === 'explorer' && !$dockMinimized);

	// tab-grouped windows share one size: show the group's rect so a resize on any
	// member updates every tab, not just the active one.
	const myGroup = $derived($tabGroups.find((g: any) => g.members.includes('explorer')) ?? null);
	const effW = $derived(myGroup ? myGroup.rect.width : winW);
	const effH = $derived(myGroup ? myGroup.rect.height : winH);

	// --- docked: top-edge resize (shared dock height, persisted by the store) ---
	let resizing = $state(false);
	function startResize(e: any) {
		resizing = true;
		e.currentTarget.setPointerCapture(e.pointerId);
		e.preventDefault();
	}
	function doResize(e: any) {
		if (!resizing) return;
		dockHeight.update((h) => clampH(h - e.movementY));
	}
	function endResize(e: any) {
		if (!resizing) return;
		resizing = false;
		e.currentTarget.releasePointerCapture?.(e.pointerId);
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

	// ---- R22-R7: FILTERS -----------------------------------------------------------
	//
	// Two axes, because they answer two different questions a library gets asked: WHAT
	// IS IT (kind) and WHO CAN SEE IT (share state). The kind half has no dependency on
	// anything in this batch; the share half only means something once R1 exists.
	//
	// LOCAL COMPONENT STATE, not a store and not a saved pref: a filter is a thing you
	// do for a minute while looking for something, and one that survived a reload would
	// hide files from a user who had forgotten setting it — the same reasoning that keeps
	// `search` local.
	/** empty = every kind. @type {Set<string>} */
	let kindFilter = $state(new Set<string>());
	/**
	 * R22-R8 (user): a TOGGLE named "Local only", not a three-way. "Shared only" was the
	 * weaker half of the pair — the shared files are the ones with a dot, so they are
	 * already findable, while the local ones are exactly what you cannot pick out of a
	 * grid. One switch, one question: show me what is NOT in the project yet.
	 */
	let localOnly = $state(false);

	/** R22-R8: is the Logs pane showing? LOCAL and session-only — it is a debugging
	 * view, and one that came back on every reload would be clutter. */
	let logOpen = $state(false);
	const filtering = $derived(kindFilter.size > 0 || localOnly);

	/** R22-R2: the share state of a card, and the ONE place the vocabulary is read. A
	 * derived remote row is shared BY DEFINITION — it is in the index and that is the
	 * only reason we know about it. */
	function shareOf(item: any) {
		if (item?.remoteItem) return 'peer';
		return item?.share ?? '';
	}
	const isShared = (item: any) => {
		const v = shareOf(item);
		return v === 'mine' || v === 'peer';
	};

	/** Applied to the assembled grid list. A card with no library record of its own (a
	 * pack entry, a scene asset, a project scene) is exempt from the SHARE axis rather
	 * than being filtered out by it — it has no share state to be wrong about. */
	function passesFilter(item: any) {
		if (kindFilter.size && !kindFilter.has(item.kind)) return false;
		if (localOnly) {
			// a card with no library record of its own has no share state to be wrong about,
			// and a REMOTE row is by definition not local — both are out
			if (!isOwnedItem(item)) return false;
			if (isShared(item)) return false;
		}
		return true;
	}

	/**
	 * R22-R8 (user): "make sure local only applies to folders also (and shows only local
	 * files in those folders)". Two halves, and the second one falls out of `passesFilter`
	 * already scoping the grid. This is the first: a SHARED folder is not a local thing,
	 * so it goes. A folder that merely CONTAINS local files stays, or the filter would
	 * hide the way to reach them.
	 */
	function folderPassesFilter(folder: any) {
		// R22 round 10 (user): "should not show folders where no filtered items exist". It IS
		const subtree = folderSubtree(folder.id);
		// the standard — a filter narrows to what you asked for, and a folder you can open
		// only to find it empty is a dead end the filter itself created. Applied at ANY DEPTH,
		// so a match three folders down keeps the whole route to it visible: hiding an
		// ancestor would strand exactly the file the filter exists to show.
		if (kindFilter.size) {
			const inside = $explorerItems.filter((i) => subtree.includes(i.folderId ?? ''));
			if (!inside.some((i) => passesFilter(i))) return false;
		}
		if (!localOnly) return true;
		if (folder?.share === 'mine' || folder?.share === 'peer') {
			// ...unless something local is inside it, in which case it is a route rather than
			// a result, and hiding it would strand the files the filter exists to show
			return $explorerItems.some((i) => subtree.includes(i.folderId ?? '') && !isShared(i));
		}
		return true;
	}

	/** R22-R2: is the local/shared distinction worth drawing at all? In a project that
	 * has never shared a thing, muting every card would be pure noise. */
	/**
	 * R22 round 5 — WHEN IS THE LOCAL/SHARED DISTINCTION WORTH DRAWING?
	 *
	 * Whenever there is somebody to be distinguished FROM. The first rule was "once
	 * something in this project is shared", which produced the reported oddity: connect,
	 * drop one file, and it is not greyed — but drop a second after anything at all has
	 * been shared and both are. The question a session makes urgent is "can my peers see
	 * this?", and that question exists from the first file.
	 *
	 * Still off in a SOLO library, where every file is local and muting all of them says
	 * nothing while costing legibility everywhere.
	 */
	const sharingOn = $derived(
		// `openedPeers` is a SET, so this is `.size` — `.length` is undefined on one, which
		// is a silent always-false and exactly the bug this rule was written to fix
		($peers?.openedPeers?.size ?? 0) > 0 || sharedIndexInUse($projectManifest) || filtering
	);

	/** The owner of a shared row, in cloudHooks' three tiers. The checkmark is the whole
	 * point of the third one: only a plugin-vouched account earns it. */
	function ownerLabel(item: any) {
		const o = item?.owner;
		if (!o) return '';
		if (o.account) return o.account + ' ✓';
		// R22 round 9: with no name AND no id there is nobody to name — the old fallback
		// produced a bare "peer", which reads as a label rather than as the gap it is
		if (!o.name && !o.id) return '';
		return o.name || 'peer ' + String(o.id ?? '').slice(0, 4);
	}

	/**
	 * R22 round 2 (user) — THE MUTED TREATMENT, in one place because it lands on four
	 * different things: a file's icon, a file's thumbnail, a folder's icon and a name. A
	 * local file is not broken or absent, so this is a TINT and a fade rather than a
	 * different colour — the same reading the remote `.tpscene` cards already had.
	 *
	 * Only while `sharingOn`: in a project that has never shared anything there is no
	 * distinction to draw, and muting everything would cost legibility for no information.
	 */
	function mutedItem(item: any) {
		return sharingOn && isOwnedItem(item) && !isShared(item);
	}
	/** the same question for a folder (no `kind`, so no isOwnedItem) */
	function mutedFolder(folder: any) {
		return sharingOn && folder?.share !== 'mine' && folder?.share !== 'peer';
	}
	/** a thumbnail cannot be recoloured, so it is desaturated and faded instead */
	const MUTED_IMG = 'opacity-50 saturate-50';
	/** an icon is a glyph in currentColor, so it just goes quiet */
	const MUTED_ICON = 'text-gray-600';

	/**
	 * R22 round 2 (user): the PICTURE for a card. A file we hold renders its own
	 * thumbnail; a shared file we do NOT hold renders the one its owner pushed over the
	 * thumbnail channel, and asks for it if it has not arrived. Requesting from inside a
	 * getter is safe: `requestAssetThumb` carries the one-ask-per-session guard, so a grid
	 * of fifty remote cards asks fifty times once and never again.
	 */
	function thumbFor(item: any) {
		if (item?.thumbnail) return item.thumbnail;
		if (!item?.hash) return null;
		const cached = $sharedThumbs[item.hash];
		if (cached) return cached;
		if (item.remoteItem || item.remoteScene) requestAssetThumb(item.hash);
		return null;
	}

	/** The tooltip a card's share dot carries. */
	function shareTitle(item: any) {
		const who = ownerLabel(item);
		// R22 round 5: nobody in this session holds the bytes. Say so — a card that looks
		// like a download which never finishes is worse than one that admits the file is
		// out of reach, and this clears itself the moment a new peer arrives.
		if (item?.remoteItem && $unavailableHashes.has(item.hash))
			return (
				'Nobody here has this file' +
				(who ? ' \u2014 ' + who + ' shared it and has left' : '') +
				'. It will be fetched if they come back.'
			);
		if (item?.remoteItem)
			return 'Shared' + (who ? ' by ' + who : '') + ' — not on this device yet. Open it to download it.';
		if (shareOf(item) === 'mine') return 'Shared by you — peers can see and download this';
		if (shareOf(item) === 'peer') return 'Shared' + (who ? ' by ' + who : '') + ' — you have a copy';
		if (item?.wasShared) return 'No longer shared — your copy is still here';
		return 'Local — only on this device';
	}
	let dropActive = $state(false);
	// R22 round 10: where the drop band goes — the scroller's own offset and visible
	// height, re-read on every dragover so a drag that also scrolls stays correct
	let dropBandTop = $state(4);
	let dropBandH = $state(0);
	function markDropActive() {
		dropActive = true;
		dropBandTop = (gridEl?.scrollTop ?? 0) + 4;
		dropBandH = Math.max(0, (gridEl?.clientHeight ?? 0) - 8);
	}
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
	// 21-G8: the "Import project as folder (.tp)…" menu entry's hidden picker
	let tpImportInput: HTMLInputElement | undefined = $state();
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
	/** R22-R7: what a kind is CALLED in the filter. The store values are internal
	 * (`object` is a 3D model, `text` covers configs), so the raw key is not a label. */
	const KIND_LABELS: Record<string, string> = {
		image: 'Images',
		audio: 'Audio',
		text: 'Text and config',
		object: '3D models',
		prefab: 'Prefabs',
		scene: 'Scenes'
	};
	/** R22-R7: the filter's fixed order. Every kind the Explorer can hold, so the menu is
	 * a statement about the app rather than about this library's current contents. */
	const FILTER_KINDS = ['image', 'object', 'audio', 'text', 'scene', 'prefab'];
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
		$explorerFolders
			.filter((f) => (f.parentId ?? null) === ($activeFolder === 'prefabs' ? '__none__' : ($activeFolder ?? null)))
			// R22-R8: the Local-only filter reaches FOLDERS too, not just their contents
			.filter(folderPassesFilter)
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
		// R22 round 4: THE RECYCLE BIN, a derived view like the Scene manifest — the log is
		// the truth and these cards are a reading of it, so there is no CRUD to keep in step.
		if ($activeFolder === 'deleted') {
			// R22 round 9, THE REPORTED BUG ("Delete permanently does not remove the file").
			// The purge always worked — it freed the blob and dropped the record — but this
			// branch asked `canRestoreDeleted`, which reaches the two shelves through `get()`,
			// so it registered NO dependency on them (the documented reactivity rule). The
			// derived re-ran only when the MANIFEST changed, and a purge deliberately leaves
			// the log alone — so the card and its menu stayed byte-identical, still offering a
			// Restore that could no longer work. Nothing observable changed, which is exactly
			// what "it does not remove the file" describes. Read the shelves HERE instead.
			const heldBytes = new Set([...$explorerItems, ...$hiddenItems].map((i) => i.hash));
			return deletedLog($projectManifest).map((r: any) => ({
				id: 'deleted:' + r.hash,
				name: r.name,
				kind: r.kind || 'text',
				hash: r.hash,
				folderId: null,
				size: 0,
				createdAt: r.at,
				// R22 round 7: the picture was recorded when the file was deleted, because once
				// the bytes are reclaimed it can never be derived again
				thumbnail: deletedThumb(r),
				owner: r.by ?? null,
				deletedEntry: true,
				restorable: heldBytes.has(r.hash)
			}));
		}
		if (typeof $activeFolder === 'string' && $activeFolder.startsWith('scene')) {
			const group = $activeFolder.split(':')[1] ?? null;
			return $sceneAssets
				.filter((entry) => !group || entry.group === group)
				.map((entry) => ({ ...entry, sceneEntry: true, thumbnail: entry.dataUrl ?? null }));
		}
		const inFolder = $explorerItems.filter((item) => (item.folderId ?? null) === ($activeFolder ?? null));
		const q = search.trim().toLowerCase();
		const scoped = q ? $explorerItems.filter((item) => item.name.toLowerCase().includes(q)) : inFolder;
		// P2a: PROJECT SCENES THIS PEER DOES NOT HOLD. Reported as "when a user connects
		// they will not see project scenes" and "if peers create a scene in the project it
		// disappears" — both the same gap: the manifest replicates and names every scene,
		// while the library (placement + bytes) is local, so a joiner could TRAVEL to a
		// scene it could not SEE. These cards are DERIVED from the manifest, never stored:
		// no message type, nothing to migrate, and the moment the bytes land the real item
		// takes over (the card is keyed by the same pointer hash). Opening one pulls it
		// through travel's existing hash pull. The `sceneEntry` precedent, one view over:
		// a derived card carries no CRUD.
		const held = new Set([...$explorerItems, ...$hiddenItems].map((i) => i.hash));
		const missing = Object.entries($projectManifest.scenes)
			.map(([name, entry]: [string, any]) => ({
				name,
				hash: entry.history[entry.history.length - 1]
			}))
			.filter((r) => r.hash && !held.has(r.hash))
			.filter((r) => !q || r.name.toLowerCase().includes(q))
			.sort((a, b) => a.name.localeCompare(b.name))
			.map((r) => ({
				id: 'remote:' + r.hash,
				name: r.name + '.tpscene',
				kind: 'scene',
				hash: r.hash,
				folderId: null,
				size: 0,
				thumbnail: null,
				createdAt: 0,
				// the marker every consumer branches on. `remoteScene` and not a reuse of
				// `sceneEntry`: that one means the Scene ASSET view, and conflating them would
				// put this card in a menu written for a different thing.
				remoteScene: true
			}));
		// R22-R1: THE SHARED ROWS WHOSE BYTES ARE NOT HERE. Same idea as `missing` above and
		// deliberately the same shape — an index row is not a library record, so writing one
		// would leave a phantom card behind the moment its owner unshared it. Unlike a
		// project scene these DO have a folder, because the row carries placement, so they
		// appear inside the shared folder they belong to.
		const remoteShared = remoteSharedRows($projectManifest)
			.filter((r: any) => !missing.some((m) => m.hash === r.hash))
			.filter((r: any) => (q ? r.name.toLowerCase().includes(q) : (r.folderId ?? null) === ($activeFolder ?? null)))
			.sort((a: any, b: any) => String(a.name).localeCompare(String(b.name)))
			.map((r: any) => ({
				id: 'shared:' + r.hash,
				name: r.name,
				kind: r.kind || 'text',
				hash: r.hash,
				folderId: r.folderId ?? null,
				size: 0,
				thumbnail: null,
				createdAt: 0,
				owner: r.owner ?? null,
				// its own marker rather than a reuse of `remoteScene`: that one means a project
				// SCENE the manifest names, and its menu is written for travelling there
				remoteItem: true
			}));
		// they belong to the PROJECT rather than to a folder, so they show at the library
		// root (and in any search) — never inside a folder they were never placed in
		const atRoot = !q && ($activeFolder ?? null) === null;
		const all = atRoot || q ? [...scoped, ...missing, ...remoteShared] : [...scoped, ...remoteShared];
		return all.filter(passesFilter);
	});

	// ---- 21-G9: IDENTITY (who am I / where am I), above the LOCATION crumbs -----------
	// Two different questions, deliberately two rows: the crumbs below say which FOLDER
	// you are browsing, this one says which PROJECT and SCENE you are in. The project
	// name is editable in place (the file's own inline-rename convention: Enter and blur
	// commit, Escape cancels) — never a window.prompt (fork 14).
	// The scene half reads `currentLevel`, the manifest's authoritative NAME, and not
	// the item's filename: `renameItem` can rename the file under it, and travel-by-name
	// resolves the name, so the filename is not the identity.
	// 21-H1 (locked answer 7): blur COMMITS here too — `commitProjectEdit` is the blur
	// handler, and Escape nulls the state before any blur can read it, so cancelling and
	// then losing focus cannot re-commit the name Escape just dropped.
	let projectEdit: string | null = $state(null);
	const projectLabel = $derived($projectManifest.name || 'Untitled project');
	const openSceneHash = $derived($currentLevel?.hash ?? null);
	function startProjectEdit() {
		projectEdit = $projectManifest.name ?? '';
	}
	function commitProjectEdit() {
		if (projectEdit === null) return;
		setProjectName(projectEdit);
		projectEdit = null;
	}
	function projectKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter') commitProjectEdit();
		else if (e.key === 'Escape') projectEdit = null;
		e.stopPropagation();
	}
	/**
	 * 21-I2: clicking the SCENE half of the chip finds its card — navigate to the folder
	 * the file lives in, select it and scroll it into view. It does NOT open or travel:
	 * you are already in that scene, and the question the chip answers is "where IS it".
	 * The card it lands on already wears 21-G9's emerald accent, so the answer is visible
	 * the moment the grid redraws.
	 *
	 * The two ticks are load-bearing: changing `activeFolder` fires the view-change effect
	 * that WIPES the selection (21-H3), so a selection written before it flushes is thrown
	 * away — and `activeFolder.set` notifies even when the id is unchanged, so the
	 * already-here case needs the same wait.
	 */
	async function revealOpenScene() {
		const hash = openSceneHash;
		if (!hash) return;
		const item = $explorerItems.find((i) => i.hash === hash);
		if (!item) {
			showToast('The open scene has no file in this library');
			return;
		}
		await revealItem(item);
	}

	/**
	 * The body of the above, taking the ITEM rather than finding it — the same walk is
	 * what the import-duplicates modal's Reveal asks for, and that asker is a modal at the
	 * App root which cannot reach any of this component's state.
	 * @param item the library item to land on
	 */
	async function revealItem(item: any) {
		if (search) search = '';
		activeFolder.set(item.folderId ?? null);
		await tick();
		await tick();
		setSel([item.id]);
		inspectItem(item);
		await tick();
		document
			.querySelector(`[data-card-id="${item.id}"]`)
			?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
	}

	// loose-scenes fix (bug 2a): Reveal, asked for from the import-duplicates modal.
	// A request store rather than a callback because the asker lives at the App root
	// and this component may not even be mounted; the id is CLEARED on the way through
	// so a second Reveal of the same item still fires.
	$effect(() => {
		const id = $revealItemId;
		if (!id) return;
		untrack(() => {
			revealItemId.set(null);
			const item = [...$explorerItems].find((i) => i.id === id);
			if (item) void revealItem(item);
			else showToast('That file is no longer in your library');
		});
	});

	/**
	 * 21-G9: the active folder AS A REAL LIBRARY FOLDER, or null. `activeFolder` also
	 * holds pseudo locations — `prefabs`, `packs`, `pack:<name>`, `scene…` — which are
	 * views, not places a file can be written to. levels.js validates the id it is given
	 * as well (a folder can be deleted between here and there); this is the cheap half.
	 */
	function activeLibraryFolder(): string | null {
		const a = $activeFolder;
		if (typeof a !== 'string' || !a) return null;
		if (a === 'prefabs' || a === 'packs' || a.startsWith('pack:') || a.startsWith('scene')) return null;
		return a;
	}

	// 197d: breadcrumb trail for the current location (click a crumb to navigate)
	const crumbs = $derived.by(() => {
		const a = $activeFolder;
		if (a === 'prefabs') return [{ label: 'Prefabs', id: 'prefabs' as string | null }];
		if (a === 'packs') return [{ label: 'Packs', id: 'packs' as string | null }];
		// R22 round 7: the bin is its own place, so the breadcrumb has to say so — it read
		// "Library", which is exactly where these files are not
		if (a === 'deleted') return [{ label: 'Deleted', id: 'deleted' as string | null }];
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
	// 21-H2: a prefab's facts. `$prefabs` is passed as an UNUSED first argument for the
	// same reason `staleScene` above takes the manifest — a helper reading a store
	// through get() registers no dependency, and the comma-operator workaround does not
	// typecheck (the documented rule). So the pane re-reads after a rename or an update.
	const factsFor = (_list: any, id: string) => prefabFacts(id);
	const selPrefab = $derived(selItem?.kind === 'prefab' ? factsFor($prefabs, selItem.prefabId) : null);
	let itemDetails = $state('');
	$effect(() => {
		const item = selItem;
		itemDetails = '';
		if (!item) return;
		if (item.kind === 'prefab') return; // 21-H2: no stored blob — its facts come from prefabFacts
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
		// R22 round 9: a GB tier, because the storage estimate reads a whole browser QUOTA
		// and "10240.1 MB" is a number nobody parses at a glance
		if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
		return (bytes / 1024 / 1024 / 1024).toFixed(1) + ' GB';
	}

	// ---- R22 round 9: THE LIST VIEW ---------------------------------------------------
	/**
	 * WHICH COLUMN SET AND SORT THIS VIEW USES. Two views, not one — see $lib/explorerView
	 * for why a bin and a library cannot share a column set. Declared ABOVE everything that
	 * reads it: a `$derived` referenced by an earlier one is a use-before-declaration, the
	 * same family as the module-level TDZ trap one scope out.
	 */
	const listView = $derived($activeFolder === 'deleted' ? 'deleted' : 'library');
	/** a date a column can hold: short, sortable-looking, and locale-correct */
	function fmtDate(t: number) {
		if (!t) return '—';
		const d = new Date(t);
		return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
	}
	/**
	 * What one cell SHOWS. The pure leaf answers what a cell sorts BY; this answers what
	 * it reads as, and the two are deliberately different functions — sorting on a
	 * formatted date string would order March before February.
	 */
	function cellText(row: any, key: string): string {
		if (row.kind === 'folder')
			return key === 'kind' ? 'Folder' : key === 'name' ? row.folder?.name : '—';
		const item = row.item;
		switch (key) {
			case 'kind':
				return String(item?.kind ?? '—');
			case 'size':
				// a row we do not hold has no size to report, and a zero would read as an empty
				// file rather than as an unknown one
				return item?.remoteItem || item?.remoteScene || item?.deletedEntry
					? '—'
					: fmtSize(item?.size);
			case 'added':
			case 'deletedAt':
				return fmtDate(Number(item?.createdAt) || 0);
			case 'owner':
			case 'deletedBy':
				// MY OWN row reads "Me", matching the group header one control over. `ownerLabel`
				// falls back to 'peer ' + the first four characters of an id, which offline is
				// the empty string — so a solo user's own deletions all read a bare "peer".
				if (!item?.owner?.id) return ownerLabel(item) || '—';
				return String(item.owner.id) === String($peers?.peer?.id ?? '')
					? 'Me'
					: ownerLabel(item) || '—';
			default:
				return String(item?.name ?? '');
		}
	}
	/** the columns actually drawn, in their canonical order */
	const shownColumns = $derived(
		columnsFor(listView).filter((c: any) => columnVisible(listView, c.key, $explorerColumns))
	);
	/**
	 * Right-click the header: which columns show. One entry per column with a checkmark,
	 * the `checked` item style the Grid/Snapping menus established — and NAME is offered
	 * as a disabled row rather than omitted, so the list is complete and it says why.
	 */
	function columnMenu(e: MouseEvent) {
		e.preventDefault();
		e.stopPropagation();
		menu = {
			x: e.clientX,
			y: e.clientY,
			items: columnsFor(listView).map((c: any) =>
				c.always
					? {
							label: c.label,
							checked: true,
							tooltip: 'A row has to be identifiable — this column cannot be hidden',
							action: () => {}
						}
					: {
							label: c.label,
							checked: columnVisible(listView, c.key, $explorerColumns),
							action: () => toggleColumn(listView, c.key)
						}
			)
		};
	}
	/**
	 * `navigator.storage.estimate()` in the header — how much of this origin's quota the
	 * library is using. Sampled rather than watched: there is no event for it, and the
	 * number moves only when bytes are written, so the library's own store is the signal.
	 * Absent on a browser that does not implement it, which is why it renders nothing at
	 * all rather than a zero.
	 */
	let storage: { used: number; quota: number } | null = $state(null);
	/** the tooltip, as a function so the markup stays readable */
	function storageTitle(s: { used: number; quota: number }) {
		return (
			'Browser storage for this app: ' +
			fmtSize(s.used) +
			' used of ' +
			fmtSize(s.quota) +
			' granted. That covers everything this origin stores, not the library alone.'
		);
	}
	async function sampleStorage() {
		try {
			const est = await navigator.storage?.estimate?.();
			if (est && typeof est.usage === 'number')
				storage = { used: est.usage ?? 0, quota: est.quota ?? 0 };
		} catch {}
	}
	$effect(() => {
		// the library changing is the only thing that moves the number
		void $explorerItems;
		void $hiddenItems;
		untrack(() => void sampleStorage());
	});

	// 197: keyboard navigation in the grid (focused region) — arrows move the
	// selection, Enter opens, Backspace goes up a level, Esc closes the window.
	let gridEl: any = $state(null);
	/**
	 * The grid's rows in VISUAL ORDER, and the one array everything downstream reads:
	 * Shift-ranges, the arrow keys, Ctrl+A/I and the marquee all derive their order from
	 * here. Sorting HERE rather than in the list markup is what keeps those four agreeing
	 * with what is on screen — a list sorted only where it is drawn would leave a
	 * Shift-range selecting cards from two rows away.
	 *
	 * The sort applies in LIST MODE ONLY: the thumbnail grid has never had a sort control,
	 * so leaving its order alone keeps it byte-identical to before this existed.
	 */
	const gridEntries = $derived.by(() => {
		const base = [
			...(!search &&
			$activeFolder !== 'prefabs' &&
			!(typeof $activeFolder === 'string' && $activeFolder.startsWith('scene'))
				? childFolders.map((f: any) => ({ kind: 'folder', folder: f }))
				: []),
			...gridItems.map((it: any) => ({ kind: 'item', item: it }))
		];
		if ($explorerViewMode !== 'list') return base;
		// project each entry onto the flat shape the pure comparator reads, sort, then hand
		// back the ORIGINAL entries — the leaf never learns the Explorer's two-kind wrapper
		const rows = base.map((e: any) =>
			e.kind === 'folder'
				? { folder: true, id: e.folder.id, name: e.folder.name, kind: 'folder', entry: e }
				: {
						folder: false,
						id: e.item.id,
						name: e.item.name,
						kind: e.item.kind,
						size: e.item.size,
						createdAt: e.item.createdAt,
						owner: e.item.owner,
						entry: e
					}
		);
		const sort = $explorerSort[listView] ?? { key: 'name', dir: 1 };
		return sortEntries(rows, sort, { ownerLabel }).map((r: any) => r.entry);
	});
	/**
	 * The bin, grouped by whoever deleted each row. Rendered as collapsible SECTIONS
	 * rather than navigable folders: a bin is read by comparing (who threw what away),
	 * and a folder you have to walk into and back out of to compare is the one shape that
	 * makes that harder. Nothing is minted — there is no folder record and no CRUD, the
	 * same reasoning the bin's cards already follow.
	 */
	const deletedGroups = $derived.by(() => {
		if (listView !== 'deleted' || $explorerDeletedGroup !== 'deleter') return null;
		const rows = gridEntries.filter((e: any) => e.kind === 'item').map((e: any) => e.item);
		// read the id off the STORE, not through a sharedLibrary helper: a get() inside a
		// helper registers no dependency, so the groups would not re-label when the mesh
		// comes up (the documented reactivity rule)
		return groupByDeleter(rows, { ownerLabel, myId: $peers?.peer?.id ?? '' });
	});
	let collapsedGroups = $state(new Set<string>());
	function toggleGroup(id: string) {
		const next = new Set(collapsedGroups);
		next.has(id) ? next.delete(id) : next.add(id);
		collapsedGroups = next;
	}

	// ---- 21-H3: MULTI-SELECT ---------------------------------------------------------
	// `selected` (the single anchor) is UNCHANGED: it still drives the Properties pane,
	// and it is the Shift-range anchor. `selectedIds` is the SET beside it, keyed by the
	// card's own id — which already exists and is already unique for every kind the grid
	// can draw (library item / 'prefab:<id>' / 'pack:<pack>:<name>' / 'packfolder:<name>'
	// / a folder's uuid), so nothing had to be minted for this.
	//
	// THE RULE: a Set mutated in place gives a `$derived` (and this component's own
	// template reads) no signal at all — everything compares with `===`. Every write
	// therefore REPLACES it, which is what `setSel` is for.
	let selectedIds = $state(new Set<string>());
	/** the card id of a grid ENTRY — the one place the two kinds are folded together */
	const entryId = (entry: any): string =>
		entry.kind === 'folder' ? entry.folder.id : entry.item.id;
	function setSel(ids: Iterable<string>) {
		selectedIds = new Set(ids);
	}
	/** read through a helper so the template's `selectedIds` argument is the dependency */
	const inSel = (ids: Set<string>, id: string) => ids.has(id);
	/** the anchor as a card id (the Shift range's fixed end) */
	function anchorId(): string | null {
		if (!selected) return null;
		return (selected.kind === 'folder' ? selected.folder?.id : selected.item?.id) ?? null;
	}
	/**
	 * The ids between the anchor and `toId` in the CURRENT VISUAL ORDER. That order is
	 * read off `gridEntries` — the ONE array the grid is built from — rather than
	 * reasoned about across the two `{#each}` blocks that render it, which is how a
	 * range silently starts skipping the folder row at the top.
	 */
	function rangeIds(fromId: string | null, toId: string): string[] {
		const order = gridEntries.map(entryId);
		const b = order.indexOf(toId);
		if (b < 0) return [toId];
		const a = fromId ? order.indexOf(fromId) : -1;
		if (a < 0) return [toId];
		return a <= b ? order.slice(a, b + 1) : order.slice(b, a + 1);
	}
	/**
	 * The selection half of a MODIFIED card click. Ctrl/Cmd toggles and MOVES the anchor
	 * (so the next Shift range starts where you last clicked); Shift ranges and leaves
	 * the anchor where it is, because a second Shift-click has to be able to re-range
	 * from the same card rather than from its own previous end.
	 */
	function modifierSelect(e: MouseEvent, id: string, moveAnchor: () => void) {
		if (e.shiftKey) {
			const range = rangeIds(anchorId(), id);
			setSel(e.ctrlKey || e.metaKey ? [...selectedIds, ...range] : range);
			return;
		}
		const next = new Set(selectedIds);
		next.has(id) ? next.delete(id) : next.add(id);
		selectedIds = next;
		moveAnchor();
	}
	/** the selected grid entries, in visual order (stale ids simply do not match) */
	function selectedEntries(): any[] {
		return gridEntries.filter((entry: any) => selectedIds.has(entryId(entry)));
	}
	/**
	 * A view change wipes the set. Ctrl+A in one folder followed by Delete in another
	 * would otherwise act on cards nobody can see — and a search narrows the grid the
	 * same way a folder does, so both are the trigger.
	 */
	$effect(() => {
		void $activeFolder;
		void search;
		untrack(() => {
			if (selectedIds.size) selectedIds = new Set();
		});
	});

	/**
	 * THREE states have to stay apart on one card: the INSPECTED card (whose facts the
	 * Properties pane is showing), the OPEN SCENE's emerald ring (21-G9, drawn as a ring
	 * so it composes with either), and now a multi-selected member. The anchor keeps the
	 * primary treatment it has always had — a single selection is therefore byte-identical
	 * to before this phase — and the rest of the set takes the sky tint.
	 */
	function cardClass(ids: Set<string>, inspected: string | null, sel: any, id: string): string {
		const picked = ids.has(id);
		const isAnchor =
			inspected === id || (sel?.kind === 'item' ? sel.item?.id : sel?.folder?.id) === id;
		// The anchor keeps the primary treatment it has always had — but only while it is
		// PART of the set, or while nothing is selected at all (the pre-21-H3 "this is what
		// Properties is showing" state, which the tree's own menu still reaches). A card
		// Ctrl-clicked OUT of a set must stop looking picked even though the anchor stays
		// on it, or the highlight and the set disagree about what Delete would take.
		const tint =
			isAnchor && (ids.size === 0 || picked)
				? 'border-primary-600 bg-primary-600/10'
				: picked
					? 'border-sky-400 bg-sky-400/20'
					: 'border-transparent hover:border-gray-600 hover:bg-gray-700/60';
		// `explorer-selected` marks MEMBERSHIP independently of which of the two tints the
		// card ended up with, so nothing has to infer the set from a colour
		return picked ? 'explorer-selected ' + tint : tint;
	}

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
		// 21-H3: an arrow step is a fresh single selection, so the SET follows the
		// anchor — leaving it behind would make Delete act on the card you walked away
		// from while the highlight sits somewhere else
		setSel([entryId(e)]);
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
		// 21-H3: the selection keys. `stopPropagation` as well as `preventDefault`,
		// because shortcuts.js listens on WINDOW — svelte delegates this handler to the
		// app root, which is BELOW window, so stopping here is what keeps Ctrl+A from
		// ALSO selecting every object in the scene behind the panel.
		const mod = e.ctrlKey || e.metaKey;
		if (mod && e.code === 'KeyA') {
			e.preventDefault();
			e.stopPropagation();
			setSel(gridEntries.map(entryId));
		} else if (mod && e.code === 'KeyI') {
			e.preventDefault();
			e.stopPropagation();
			setSel(gridEntries.map(entryId).filter((id: string) => !selectedIds.has(id)));
		} else if (e.key === 'Escape') {
			// only when there IS a selection: Escape belongs to a dozen local handlers in
			// this app, and swallowing it while nothing is selected steals it from them
			if (!selectedIds.size) return;
			e.preventDefault();
			e.stopPropagation();
			setSel([]);
		} else if (e.key === 'Delete') {
			if (!selectedIds.size) return;
			e.preventDefault();
			e.stopPropagation();
			deleteSelection();
		} else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') (e.preventDefault(), moveSel(1));
		else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') (e.preventDefault(), moveSel(-1));
		else if (e.key === 'Enter') {
			e.preventDefault();
			if (selected?.kind === 'item') openItem(selected.item);
			else if (selected?.kind === 'folder') openFolder(selected.folder.id);
		} else if (e.key === 'Backspace') (e.preventDefault(), goUp());
	}

	// --- inline create/rename (106.1/2) ---
	// 21-G10: `inGrid` says WHICH view hosts the input. The tree and the grid can both
	// be showing the same parent folder, so without it a "New folder" started from the
	// grid mounted a SECOND input in the tree — the duplicate focus/blur that
	// startRename already documents, one mode over.
	/**
	 * REPORTED (bug 1, second half): "when I create a new scene the filename renames
	 * back in Explorer to what it was". Every opener below ASSIGNED `editing`
	 * directly, so opening a second inline editor threw the first one's typed value
	 * away - the card simply reverted to its old name with no message. Clicking away
	 * already commits (21-H1 locked answer 7); opening another editor is the same
	 * intent and now commits too.
	 */
	function settlePendingEdit() {
		if (editing) void commitEdit();
	}
	function startCreate(parentId: string | null, inGrid = false) {
		// R22 round 7 (user): pressing New folder again must not COMMIT the pending one and
		// open another — that is how you end up with "New folder", "New folder (2)"… from
		// a double-press. An edit already open for the same place is the same intent, so
		// keep it and put the caret back in it.
		if (editing?.mode === 'create' && editing.parentId === parentId && editing.inGrid === inGrid) {
			queueMicrotask(() => {
				const el = document.querySelector<HTMLInputElement>('#explorer-new-card input, .explorer-edit-input');
				el?.focus();
				el?.select();
			});
			return;
		}
		settlePendingEdit();
		if (parentId) {
			const next = new Set(expanded);
			next.add(parentId);
			expanded = next;
		}
		editing = { mode: 'create', parentId, value: 'New folder', inGrid };
	}
	// inGrid keeps the tree + thumbnail inputs from BOTH mounting for a root folder
	// (it shows in both), whose duplicate focus/blur would tear the edit down instantly
	function startRename(folder: any, inGrid = false) {
		settlePendingEdit();
		editing = { mode: 'rename', folderId: folder.id, parentId: folder.parentId ?? null, value: folder.name, inGrid };
	}
	// 170: inline item rename (replaces the browser prompt), works in either view
	function startRenameItem(item: any) {
		settlePendingEdit();
		editing = { mode: 'rename-item', itemId: item.id, value: item.name };
	}
	// 21-H2: a PREFAB renames through the SAME inline editor — never window.prompt(),
	// which is what the deleted Library modal used (fork 14's rule, one surface over).
	// Its own mode because the id addresses the prefab library, not `explorerItems`.
	function startRenamePrefab(item: any) {
		settlePendingEdit();
		editing = { mode: 'rename-prefab', prefabId: item.prefabId, value: item.name };
	}
	// 21-G1: a PACK row renames too — same inline editor, and it writes the pack's
	// display TITLE only (its `name` is the identity every cache and view key uses;
	// packs.js carries the reasoning)
	function startRenamePack(pack: any) {
		settlePendingEdit();
		editing = { mode: 'rename-pack', packName: pack.name, value: pack.title || pack.name };
	}
	// 21-G10 (fork 14): naming a SCENE is a create like any other, so it goes through
	// the same inline editor rather than window.prompt() — the one input in this panel
	// that no theme reaches, that blocks the page while it is up, and whose Escape is
	// the browser's rather than ours. It always shows in the GRID: both entries live on
	// the grid background's menu, and the tree has no row to hang a scene name on.
	function startSceneName(mode: 'save-scene' | 'new-scene') {
		settlePendingEdit();
		editing = { mode, value: mode === 'save-scene' ? 'Scene' : 'New scene', inGrid: true };
	}
	// 21-H1 (locked answer 7): CLICKING AWAY COMMITS. Every inline name in this panel —
	// scene save/new, folder create, item/folder/pack rename, and the project name —
	// used to be thrown away by its own blur, which is the opposite of what every file
	// browser does and of what typing a name then reaching for the mouse means. ESCAPE
	// is the only cancel now.
	//
	// The ordering hazard, and why Escape clears the state FIRST: unmounting the input
	// can deliver a blur, and `commitEdit`/`commitProjectEdit` are the same functions
	// that blur calls — so both bail on null state, and Escape nulls it before anything
	// else can read it. That also makes Enter safe, since it closes before awaiting.
	// An INVALID name (empty, or carrying `* \ /`) is the one thing blur cannot commit,
	// and leaving the input mounted after focus has gone would strand it on screen with
	// no way back to it. Clicking away from a name that cannot exist discards it.
	function blurCommit() {
		if (!editing) return;
		if (!isValidName(editing.value)) {
			editing = null;
			return;
		}
		void commitEdit();
	}
	async function commitEdit() {
		if (!editing || !isValidName(editing.value)) return;
		// snapshot and CLOSE first: the scene modes await, and an input still mounted over
		// an in-flight save is one blur away from committing the same name twice
		const edit = editing;
		editing = null;
		if (edit.mode === 'create') createFolder(edit.value, edit.parentId);
		else if (edit.mode === 'rename-item') {
			renameItem(edit.itemId, edit.value);
			// REPORTED (bug 1): a file rename never reached `currentLevel.name`, so the
			// next save of a LOOSE scene filed it under the old name and a second
			// .tpscene appeared beside the renamed one
			const renamed = $explorerItems.find((i) => i.id === edit.itemId);
			if (renamed?.kind === 'scene') renameOpenLooseScene(renamed.hash, edit.value);
		}
		else if (edit.mode === 'rename-prefab') renamePrefab(edit.prefabId, edit.value);
		else if (edit.mode === 'rename-pack') renamePack(edit.packName, edit.value);
		// 21-G9 (union): land the scene where the user is looking — Scenes when the
		// active folder is a pseudo view or a stale id
		else if (edit.mode === 'save-scene') await saveSceneAsLevel(edit.value, activeLibraryFolder());
		else if (edit.mode === 'new-scene') await newLevel(edit.value, activeLibraryFolder());
		else renameFolder(edit.folderId, edit.value);
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
	// 21-H1 (locked answer 5): CONSUME the arm store. projectFile's empty-library
	// bootstrap ("Save a scene" on the export refusal) opens this panel and asks for the
	// inline save input, in a folder it premade. A write-once store rather than a
	// callback, because that module must not import a component — and it is consumed
	// (cleared) as it is acted on, so a stale request cannot re-open the input the next
	// time this panel mounts.
	$effect(() => {
		const arm = $explorerSceneSaveArm;
		if (!arm) return;
		explorerSceneSaveArm.set(null);
		untrack(() => {
			openFolder(arm.folderId);
			startSceneName('save-scene');
		});
	});

	// 21-G10: which inline edit the GRID hosts, rendered as a placeholder CARD sitting
	// where the thing being named will land. A `create` qualifies only when it was
	// started from the grid — the tree keeps its own row editor for its own button.
	const pendingCard = $derived(
		editing &&
			(editing.mode === 'save-scene' ||
				editing.mode === 'new-scene' ||
				(editing.mode === 'create' && editing.inGrid))
			? (editing.mode as string)
			: null
	);

	// --- 21-G10: the tree's roots section resizes -------------------------------------
	// The pinned block under "New folder" (Prefabs / Packs / Scene, each expandable) used
	// to grow without limit and shove the folder list off the top of the pane. The grip
	// is GraphTree's verbatim with the SIGN FLIPPED: it sits ABOVE what it sizes, so
	// dragging DOWN gives the folder list the room. The ceiling comes from the MEASURED
	// column and never a constant — a flat cap is how a grip ends up off-screen on a
	// short dock (18-B).
	const ROOTS_MIN = 56;
	const ROOTS_RESERVE = 120; // the folder list + the New folder button keep this much
	let treeColH = $state(0);
	let rootsResizing = $state(false);
	let rootsH = $state(
		(typeof localStorage !== 'undefined' && parseInt(localStorage.getItem('explorerRootsH') ?? '')) ||
			160
	);
	const rootsMax = $derived(Math.max(ROOTS_MIN, (treeColH || 320) - ROOTS_RESERVE));
	// re-clamp whenever the column SHRINKS (dock resize, undock, or a height stored on a
	// taller pane): a size that was legal before must not strand the grip off the bottom
	$effect(() => {
		const max = rootsMax;
		if (rootsH > max) rootsH = max;
	});
	function startRootsResize(e: PointerEvent) {
		rootsResizing = true;
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		e.preventDefault();
	}
	function doRootsResize(e: PointerEvent) {
		if (!rootsResizing) return;
		rootsH = Math.min(Math.max(ROOTS_MIN, rootsH - e.movementY), rootsMax);
	}
	function endRootsResize(e: PointerEvent) {
		if (!rootsResizing) return;
		rootsResizing = false;
		(e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
		localStorage.setItem('explorerRootsH', String(rootsH));
	}
	// 18-B's rule for every grip in the app: a double-click restores a size you might
	// otherwise have no way to get back
	function resetRootsH() {
		rootsH = Math.min(160, rootsMax);
		localStorage.setItem('explorerRootsH', String(rootsH));
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
	/**
	 * R22 round 10, THE REPORTED BUG: "when I ctrl click some selected files I should be
	 * able to move them within explorer... for now only the latest clicked is moved".
	 *
	 * The drag ALREADY carried the whole selection — `dragPayloadFor` has attached an
	 * `items` array since 21-H3, because the VIEWPORT drop needs it to place N objects. This
	 * function simply never read it: it moved `payload.id` and nothing else. So the feature
	 * existed on the wire and was dropped on arrival.
	 *
	 * A MIXED selection moves too, folders included, which is why both drag starts publish
	 * the same `folders`/`items` block: dragging any member of a set means the set.
	 * @param {DragEvent} e @param {string | null} target
	 */
	function dropInto(e: DragEvent, target: string | null) {
		const payload = payloadOf(e);
		dropFolder = null;
		if (!payload) return;
		e.preventDefault();
		e.stopPropagation();
		// a PREFAB card carries no library record, so there is nothing to re-file
		const items = (payload.items?.length ? payload.items : payload.type === 'item' ? [payload] : [])
			.filter((p: any) => p && !p.prefabId && p.id)
			.map((p: any) => p.id);
		const folders = payload.folders?.length
			? payload.folders
			: payload.type === 'folder'
				? [payload.id]
				: [];
		let refused = 0;
		for (const id of folders) if (!moveFolder(id, target)) refused++;
		for (const id of items) moveItem(id, target);
		if (refused)
			showToast(
				refused === 1 && folders.length === 1
					? "A folder can't move into its own subtree"
					: `${refused} folder${refused === 1 ? '' : 's'} could not move into their own subtree`
			);
	}
	function dragOverInto(e: DragEvent, target: string | 'root' | null) {
		if (!canAccept(e)) return;
		e.preventDefault();
		e.stopPropagation();
		dropFolder = target;
	}

	function folderMenu(e: MouseEvent, folder: any, inTree = true) {
		e.preventDefault();
		// 21-H3: the grid's folder cards join the selection like any other card (the TREE
		// row is a different surface — it is a navigator, and it always means one folder)
		if (!inTree) {
			if (!selectedIds.has(folder.id)) setSel([folder.id]);
			if (selectedIds.size > 1) return batchMenu(e);
		}
		menu = {
			x: e.clientX,
			y: e.clientY,
			items: [
				// R22-R2: A FOLDER IS THE UNIT OF INTENT. Sharing one shares its subtree and its
				// contents, and — the rule the user asked for — anything dropped into it LATER.
				// Only the peer who shared a folder can stop sharing it, so a peer's folder gets
				// a statement rather than a button that could not work.
				...(folder.share === 'peer'
					? [
							{
								label: 'Shared by ' + (ownerLabel(folder) || 'a peer'),
								icon: 'users',
								tooltip: 'Only whoever shared this folder can stop sharing it',
								action: () => {}
							}
						]
					: [
							folder.share === 'mine'
								? {
										label: 'Unshare folder',
										icon: 'eye-off',
										tooltip:
											'Stop offering this folder and its files to peers. Copies they already have stay theirs.',
										action: () => {
											unshareFolder(folder.id);
											showToast(folder.name + ' is no longer shared');
										}
									}
								: {
										label: 'Share folder',
										icon: 'users',
										tooltip:
											'Peers see this folder and its files, and anything you add to it later',
										action: () => {
											shareFolder(folder.id);
											showToast('Sharing ' + folder.name + ' with peers');
										}
									}
						]),
				{ label: 'Properties', action: () => showProperties({ kind: 'folder', folder }) },
				// 170: "New subfolder" only makes sense in the tree; the thumbnail grid drops it
				...(inTree ? [{ label: 'New subfolder', action: () => startCreate(folder.id) }] : []),
				{ label: 'Rename', action: () => startRename(folder, !inTree) },
				// 21-I4 (locked answer 3): the folder's SUBTREE as a project file. The
				// folder becomes that project's root and gives it its name, so what comes
				// back out of an import is this folder, not a folder inside a folder.
				{
					label: 'Export folder as .tp',
					icon: 'arrow-down-to-line',
					tooltip:
						'This folder and everything under it as a project file — its scenes, their version history and the assets they use',
					action: () => downloadProject({ folderId: folder.id })
				},
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

	/** the anchor + object-URL download, factored out of `downloadItem` for the zip */
	function saveBlob(blob: Blob, filename: string) {
		const a = document.createElement('a');
		document.body.appendChild(a);
		a.style.display = 'none';
		const url = URL.createObjectURL(blob);
		a.href = url;
		a.download = filename;
		a.click();
		URL.revokeObjectURL(url);
		a.remove();
	}

	// ---- 21-H3: BATCH OPERATIONS -----------------------------------------------------
	// Everything here answers the same two questions: which of the selected cards can
	// this actually act on, and what happens to the rest. A pack card and a Scene-manifest
	// entry are VIEWS of something else — a pack item is a remote URL with no stored blob,
	// a Scene entry is derived from the live scene — so they are skipped and SAID to be
	// skipped, never quietly dropped from a count the user is reading.

	const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

	/** a real, deletable library thing: a stored item, a prefab, or a folder */
	const isOwnedItem = (item: any) =>
		!!item &&
		!item.packEntry &&
		!item.sceneEntry &&
		!item.remoteScene &&
		// R22-R1: a shared row whose bytes are not here has no local record either — it is
		// a card built from the index, so every batch op (download, delete, GLTF export)
		// would be addressing an id that does not exist
		!item.remoteItem &&
		item.kind !== 'pack-folder';

	/** what the selection breaks down into, once and for every batch entry point */
	function selectionParts() {
		const entries = selectedEntries();
		const folders = entries.filter((e: any) => e.kind === 'folder').map((e: any) => e.folder);
		const items = entries
			.filter((e: any) => e.kind === 'item' && isOwnedItem(e.item))
			.map((e: any) => e.item);
		return { entries, folders, items, skipped: entries.length - folders.length - items.length };
	}

	/**
	 * ONE confirm naming the count. A folder brings its subtree with it, so its existing
	 * `folderCounts` numbers go into the same sentence — otherwise "delete 2 folders"
	 * hides however many files that is.
	 */
	function deleteSelection() {
		const { folders, items, skipped } = selectionParts();
		if (!folders.length && !items.length)
			return showToast(
				skipped
					? `Nothing to delete — ${plural(skipped, 'card')} here ${skipped === 1 ? 'is a view' : 'are views'} of something else (pack or scene contents)`
					: 'Nothing selected'
			);
		let subFolders = 0;
		let subItems = 0;
		for (const folder of folders) {
			const counts = folderCounts(folder.id);
			subFolders += counts.folders - 1; // folderCounts includes the folder itself
			subItems += counts.items;
		}
		const parts: string[] = [];
		if (items.length) parts.push(plural(items.length, 'item'));
		if (folders.length) parts.push(plural(folders.length, 'folder'));
		const cascade =
			subFolders || subItems
				? ` — with ${plural(subFolders, 'subfolder')} and ${plural(subItems, 'item')} inside`
				: '';
		const note = skipped ? ` (${plural(skipped, 'pack/scene card')} will be skipped)` : '';
		showToast(`Delete ${parts.join(' and ')}${cascade}?${note}`, [
			{ label: 'Delete', action: () => void runDeleteSelection(folders, items) },
			{ label: 'Cancel', action: () => {} }
		]);
	}
	async function runDeleteSelection(folders: any[], items: any[]) {
		for (const item of items) {
			if (item.kind === 'prefab') await removePrefab(item.prefabId);
			else await deleteItem(item.id);
		}
		for (const folder of folders) await deleteFolder(folder.id);
		setSel([]);
		deselect();
	}

	/** a name no other entry in the zip has yet ("a.png" -> "a (2).png") */
	function uniqueZipName(taken: Record<string, any>, name: string) {
		if (!taken[name]) return name;
		const dot = name.lastIndexOf('.');
		const stem = dot > 0 ? name.slice(0, dot) : name;
		const ext = dot > 0 ? name.slice(dot) : '';
		let n = 2;
		while (taken[`${stem} (${n})${ext}`]) n++;
		return `${stem} (${n})${ext}`;
	}

	/** the name a batch download takes — the folder you are looking at */
	function currentFolderName() {
		const id = activeLibraryFolder();
		return (id && $explorerFolders.find((f: any) => f.id === id)?.name) || 'Library';
	}

	/**
	 * ONE item = today's direct download, byte for byte. N = ONE .zip, because N
	 * simultaneous anchor clicks are a download prompt storm in every browser and an
	 * outright block in some. fflate is already a dependency (the .tpscene / .tp
	 * precedent), and the menu LABEL says .zip so nobody wonders where their files went.
	 */
	async function downloadSelection() {
		const files = selectionParts().items.filter((item: any) => item.kind !== 'prefab' && item.id);
		if (!files.length) return showToast('Nothing in this selection has stored bytes to download');
		if (files.length === 1) return downloadItem(files[0]);
		const { zipSync } = await import('fflate');
		/** @type {Record<string, Uint8Array>} */
		const entries: Record<string, Uint8Array> = {};
		let missing = 0;
		for (const item of files) {
			const blob = await itemBlob(item.id);
			if (!blob) {
				missing++;
				continue;
			}
			entries[uniqueZipName(entries, item.name || 'file')] = new Uint8Array(
				await blob.arrayBuffer()
			);
		}
		const count = Object.keys(entries).length;
		if (!count) return showToast('None of those files still have stored bytes');
		saveBlob(
			new Blob([zipSync(entries, { level: 6 })], { type: 'application/zip' }),
			fileStem(currentFolderName()) + '.zip'
		);
		showToast(
			`Downloaded ${plural(count, 'file')} as a .zip` + (missing ? ` (${missing} had no bytes)` : '')
		);
	}

	// ---- 21-I5 REVISED: DOWNLOADING A SCENE'S VERSIONS -------------------------------
	// The interim 21-I5 build bundled versions into the working .tpscene from an Export
	// Settings checkbox, and it could not work: that path exports whatever is in the
	// viewport, so a scene that is not a NAMED project scene has no manifest entry, no
	// history to look up, and the box silently produced nothing. HERE the scene card
	// makes both unambiguous, which is the whole reason the action moved.

	/** The DISTINCT versions the manifest records for the scene a card points at, newest
	 * last (history order). A restore RE-APPENDS a hash it already had — the manifest's
	 * own rule — so one history can name the same version twice and it is one file either
	 * way. Empty for anything that is not a scene card of ours. */
	function sceneVersionHashes(item: any): string[] {
		if (!item || item.kind !== 'scene' || item.packEntry || item.sceneEntry || item.remoteScene)
			return [];
		const scene = sceneOfHash(item.hash);
		const entry = scene ? sceneEntry(scene) : null;
		return [...new Set((entry?.history ?? []).filter(Boolean))];
	}

	/**
	 * Every version of ONE scene as a single .zip of .tpscene files.
	 *
	 * ONE archive rather than N downloads for the reason `downloadSelection` already
	 * documents: a burst of anchor clicks is a prompt storm in every browser and an
	 * outright block in some. `itemByHash` reaches the HIDDEN shelf (21-G7), so the
	 * folded-away older versions resolve here with nothing extra.
	 *
	 * A version whose bytes this machine no longer holds is COUNTED and reported — the
	 * `exportProject` rule, because a lossy export you are not told about is how a gap
	 * gets discovered a month later. The manifest keeps such a hash regardless (fork 4):
	 * a peer who still has it can serve it back.
	 */
	async function downloadSceneVersions(item: any) {
		const scene = sceneOfHash(item.hash);
		const hashes = sceneVersionHashes(item);
		if (!scene || hashes.length < 2)
			return showToast('That scene has only one version — use Download for it');
		const { zipSync } = await import('fflate');
		const entries: Record<string, Uint8Array> = {};
		let missing = 0;
		for (const hash of hashes) {
			const record: any = itemByHash(hash);
			const blob = record ? await itemBlob(record.id) : null;
			if (!blob) {
				missing++;
				continue;
			}
			// ISO date FIRST so a file listing sorts chronologically, then a short hash so
			// two versions written in the same millisecond still differ. `uniqueZipName` is
			// the backstop for a collision even that cannot rule out.
			const name = `${versionStamp(record.createdAt)}-${String(hash).slice(0, 8)}.tpscene`;
			entries[uniqueZipName(entries, name)] = new Uint8Array(await blob.arrayBuffer());
		}
		const count = Object.keys(entries).length;
		if (!count)
			return showToast(
				`None of ${scene}'s ${plural(hashes.length, 'version')} still have stored bytes here`
			);
		saveBlob(
			new Blob([zipSync(entries, { level: 6 })], { type: 'application/zip' }),
			`${fileNameBase(scene) || 'scene'}-versions.zip`
		);
		showToast(
			`Downloaded ${plural(count, 'version')} of ${scene} as a .zip` +
				(missing
					? ` — ${missing} whose bytes are not on this machine ${missing === 1 ? 'was' : 'were'} left out`
					: '')
		);
	}

	/**
	 * N prefabs / 3D objects as ONE file. `exportGltf` has always taken an ARRAY of roots
	 * (that is how the viewport's multi-selection export works), so this reuses 21-H2's
	 * `exportObjectsAsGltf` seam — with its park, its origin bake and its animation bake —
	 * rather than growing a second exporter here.
	 */
	async function exportSelectionGltf() {
		const roots: any[] = [];
		let failed = 0;
		for (const item of selectionParts().items) {
			if (item.kind === 'prefab') {
				const object = prefabObject(item.prefabId);
				object ? roots.push(object) : failed++;
			} else if (item.kind === 'object') {
				const blob = await itemBlob(item.id);
				if (!blob) {
					failed++;
					continue;
				}
				try {
					roots.push(
						await parseObjectFile(await blob.arrayBuffer(), item.name.split('.').pop()?.toLowerCase() ?? 'glb')
					);
				} catch {
					failed++;
				}
			}
		}
		if (!roots.length) return showToast('Select prefabs or 3D objects to export as GLTF');
		exportObjectsAsGltf(roots, fileStem(currentFolderName()) + '.gltf');
		showToast(`Exported ${plural(roots.length, 'object')} as one GLTF` + (failed ? ` (${failed} could not be read)` : ''));
	}

	/** how many of the selected cards each batch entry can actually act on */
	function batchCounts() {
		const { items, folders, skipped } = selectionParts();
		return {
			files: items.filter((item: any) => item.kind !== 'prefab' && item.id).length,
			models: items.filter((item: any) => item.kind === 'prefab' || item.kind === 'object').length,
			deletable: items.length + folders.length,
			skipped
		};
	}

	/** the menu a right-click gets while several cards are selected */
	function batchMenu(e: MouseEvent) {
		const n = selectedIds.size;
		const counts = batchCounts();
		const items: any[] = [];
		if (counts.files)
			items.push({
				label: counts.files === 1 ? 'Download' : `Download ${plural(counts.files, 'file')} as .zip`,
				icon: 'arrow-down-to-line',
				tooltip: 'Save them to your computer — several files come down as one .zip',
				action: () => void downloadSelection()
			});
		if (counts.models)
			items.push({
				label: `Export ${plural(counts.models, 'object')} as GLTF`,
				tooltip: 'One .gltf file containing every selected prefab and 3D object',
				action: () => void exportSelectionGltf()
			});
		// R22-R2: the SET, and only the members we are actually the writer for. Counting
		// them separately is what lets the two entries state a number the press will
		// honour — offering "Share 6" over a selection containing three of a peer's files
		// would be a lie in the label rather than a silent partial action.
		const parts = selectionParts();
		const shareable = parts.items.filter((i: any) => shareOf(i) !== 'mine' && shareOf(i) !== 'peer');
		const unshareable = parts.items.filter((i: any) => shareOf(i) === 'mine');
		const shareableFolders = parts.folders.filter((f: any) => f.share !== 'mine' && f.share !== 'peer');
		const unshareableFolders = parts.folders.filter((f: any) => f.share === 'mine');
		if (shareable.length || shareableFolders.length)
			items.push({
				label: 'Share ' + plural(shareable.length + shareableFolders.length, 'item'),
				icon: 'users',
				tooltip: 'Let peers in this session see and download them',
				action: () => {
					for (const f of shareableFolders) shareFolder(f.id);
					for (const i of shareable) shareItem(i.id);
					showToast('Sharing ' + plural(shareable.length + shareableFolders.length, 'item') + ' with peers');
				}
			});
		if (unshareable.length || unshareableFolders.length)
			items.push({
				label: 'Unshare ' + plural(unshareable.length + unshareableFolders.length, 'item'),
				icon: 'eye-off',
				tooltip: 'Stop offering them. Copies peers already downloaded stay theirs.',
				action: () => {
					for (const f of unshareableFolders) unshareFolder(f.id);
					for (const i of unshareable) unshareItem(i.id);
					showToast(plural(unshareable.length + unshareableFolders.length, 'item') + ' no longer shared');
				}
			});
		if (counts.deletable)
			items.push({
				label: `Delete ${plural(counts.deletable, 'item')}`,
				danger: true,
				action: deleteSelection
			});
		items.push({ label: `Clear selection (${n})`, action: () => setSel([]) });
		menu = { x: e.clientX, y: e.clientY, items };
	}

	// ---- 21-H2: prefab CRUD ----------------------------------------------------------
	// A prefab card used to have NO menu at all (`itemMenu` early-returned on the kind,
	// "derived views have no CRUD") while a second surface — the Library modal, which
	// nothing could open — carried export/delete/rename for the same prefabs. The kind is
	// derived, but a prefab is not: it is a real stored asset, and this is its home.

	/**
	 * What is selected RIGHT NOW, for the two prefab entries that write from a selection.
	 *
	 * 21-I3: this used to fold in the sticky primary (`$selectedObject`) the way
	 * fileHandler's `selectedRoots` does. That is wrong for a menu entry that has to
	 * REFUSE: `deselectObject` clears only the SET — the primary is kept on purpose,
	 * because the open inspector binds to it and would crash on an empty value — so a
	 * fold-in answers "something was selected at some point" and never goes back to
	 * empty. An instant prefab replace off that would overwrite the library from an empty
	 * viewport with whatever was last clicked. Same finding as 21-G1's recipe menu, one
	 * domain over: act on the SET, never `selectionUuids`.
	 */
	const selectedSet = (): string[] => [...($selectedObjects ?? [])];

	/** A filename stem safe on every OS, matching the old Library download */
	const fileStem = (name: string) => String(name || 'prefab').replace(/[^\w-]+/g, '_');

	/** Export ▸ prefab (.json): the same bytes `importPrefab` reads back */
	function downloadPrefabJson(prefab: any) {
		const blob = new Blob([exportPrefab(prefab)], { type: 'application/json' });
		const a = document.createElement('a');
		document.body.appendChild(a);
		a.style.display = 'none';
		const url = URL.createObjectURL(blob);
		a.href = url;
		a.download = fileStem(prefab.name) + '.prefab.json';
		a.click();
		URL.revokeObjectURL(url);
		a.remove();
	}

	/** Export ▸ GLTF: the parsed tree through fileHandler's own exporter (park + origin
	 *  bake + animation bake), never a second copy of that ritual here. */
	function downloadPrefabGltf(prefab: any) {
		const object = prefabObject(prefab.id);
		if (!object) return showToast('This prefab could not be loaded');
		exportObjectsAsGltf(object, fileStem(prefab.name) + '.gltf');
	}

	/**
	 * 21-I3 — Export ▸ scene (.tpscene): a SCENE CONTAINING JUST THIS PREFAB, so a prefab
	 * can be handed to someone who has no import-a-prefab habit and opened like any other
	 * scene file.
	 *
	 * Built from `emptySessionPayload` + this one object's `toJSON()`, never
	 * `buildSessionPayload` — that captures whatever scene happens to be OPEN (its
	 * environment, its flow, its HUD, its game), and a prefab export must not smuggle the
	 * author's current world into the file. For the same reason `assets: false`: the asset
	 * bundle is derived from the LIVE scene manifest, which has nothing to do with this
	 * prefab, and a prefab's own textures already ride inside its `toJSON` as data URLs.
	 */
	async function downloadPrefabScene(prefab: any) {
		const object = prefabObject(prefab.id);
		if (!object) return showToast('This prefab could not be loaded');
		const payload: any = emptySessionPayload(prefab.name);
		payload.objects = [object.toJSON()];
		payload.count = 1;
		payload.thumbnail = prefab.thumbnail ?? null; // the card's own picture, so the file has one
		const bytes = await exportSessionZip(payload, { assets: false, packs: false, flow: true });
		saveBlob(new Blob([bytes], { type: 'application/zip' }), fileStem(prefab.name) + '.tpscene');
		showToast(`Exported "${prefab.name}" as a scene`);
	}

	/**
	 * 21-I3 (locked answer 6) — REPLACE INSTANTLY, REPORT WITH AN UNDO.
	 *
	 * The confirm toast this replaces asked a question the user had already answered by
	 * choosing the menu entry, and it asked it every single time. What made the dialog
	 * defensible was that the replace could not be taken back; giving the report an Undo
	 * removes the reason for it.
	 *
	 * THE CONSTRAINT that shapes everything here: **that Undo belongs to the toast and
	 * must never enter the scene history stack.** Ctrl+Z is expected to undo viewport
	 * changes and nothing else, and a prefab is a LIBRARY edit, not a scene edit — so
	 * there is no `recordEntry` and no history kind anywhere in this path. The previous
	 * bytes live in a closure for exactly as long as the toast that offers to put them
	 * back (prefabs.js `prefabSnapshot` carries the reasoning).
	 *
	 * Still refused WITH THE REASON when nothing is selected — that is not a dialog, it
	 * is the difference between a menu entry that explains itself and a dead one.
	 */
	function updatePrefabFromSelection(prefab: any) {
		// the SET, not `selectionUuids()`: an instant replace off a STICKY primary would
		// overwrite a prefab from an empty viewport with whatever was last clicked
		const uuids = selectedSet();
		if (!uuids.length)
			return showToast('Select the object (or objects) to save into this prefab first');
		// the opt-in prompt for people who want to be asked (default OFF)
		if ($confirmPrefabUpdate)
			return showToast(
				`Replace "${prefab.name}" with ${uuids.length === 1 ? 'the selected object' : uuids.length + ' selected objects'}?`,
				[
					{ label: 'Update', action: () => void applyPrefabUpdate(prefab, uuids) },
					{ label: 'Cancel', action: () => {} }
				]
			);
		void applyPrefabUpdate(prefab, uuids);
	}

	/** @see updatePrefabFromSelection — the replace itself, shared by both routes. */
	async function applyPrefabUpdate(prefab: any, uuids: string[]) {
		const before = prefabSnapshot(prefab.id); // captured BEFORE, held in this closure
		const next = await updatePrefab(prefab.id, uuids, { toast: false });
		if (!next) return; // updatePrefab already said why (missing object / too large)
		showToast(
			`Updated "${next.name}" from ${uuids.length === 1 ? 'the selection' : uuids.length + ' selected objects'}`,
			// `undefined`, never `[]` — showToast treats any array as an action toast, and an
			// action toast with no buttons is a card the user cannot dismiss by acting on it
			before ? [{ label: 'Undo', action: () => void undoPrefabUpdate(before, next.name) }] : undefined
		);
	}

	async function undoPrefabUpdate(snapshot: any, name: string) {
		const back = await restorePrefabBytes(snapshot);
		showToast(back ? `Restored the previous "${back.name}"` : `"${name}" is no longer in your library`);
	}

	/** 21-I3: the Prefabs grid's own background entry — the one way to MAKE a prefab from
	 *  inside the view that holds them. Same refusal shape as the update entry. */
	async function createPrefabFromSelection() {
		const uuids = selectedSet();
		if (!uuids.length) return showToast('Select the object (or objects) to save as a prefab first');
		await savePrefabSelection(uuids);
	}

	function confirmDeletePrefab(prefab: any) {
		showToast(`Delete the prefab "${prefab.name}"?`, [
			{ label: 'Delete', action: () => void removePrefab(prefab.id) },
			{ label: 'Cancel', action: () => {} }
		]);
	}

	function prefabMenu(e: MouseEvent, item: any) {
		const prefab = prefabById(item.prefabId);
		if (!prefab) return;
		menu = {
			x: e.clientX,
			y: e.clientY,
			items: [
				{
					label: 'Add to scene',
					icon: 'boxes',
					tooltip: 'Place a copy of this prefab in the scene (every peer gets it)',
					action: () => instantiatePrefab(prefab)
				},
				{
					label: 'Export',
					icon: 'arrow-down-to-line', // Icon.svelte's MAP falls back to a plain Box for an unknown name
					children: [
						{
							label: 'GLTF',
							tooltip: 'A .gltf model file other tools can open',
							action: () => downloadPrefabGltf(prefab)
						},
						{
							label: 'prefab (.json)',
							tooltip: 'This prefab as a file — import it back on any machine',
							action: () => downloadPrefabJson(prefab)
						},
						{
							// 21-I3: the third format, and the only one this app itself can OPEN —
							// a scene whose entire content is this prefab
							label: 'scene (.tpscene)',
							tooltip: 'A scene containing just this prefab — opens like any other scene file',
							action: () => void downloadPrefabScene(prefab)
						}
					]
				},
				{
					label: 'Update from selection',
					tooltip: 'Re-save this prefab from the objects selected in the scene',
					action: () => updatePrefabFromSelection(prefab)
				},
				{ label: 'Properties', action: () => showProperties({ kind: 'item', item }) },
				{ label: 'Rename', action: () => startRenamePrefab(item) },
				{ label: 'Delete', danger: true, action: () => void deletePrefabToBin(prefab) }
			]
		};
	}

	function itemMenu(e: MouseEvent, item: any) {
		e.preventDefault();
		e.stopPropagation();
		// 21-H3: right-clicking a card OUTSIDE the selection replaces the selection with
		// it — every file manager does this, and the alternative is a batch menu acting
		// on cards nowhere near the one you pointed at. Inside it, the whole set gets the
		// BATCH menu instead of the single-card one.
		if (!selectedIds.has(item.id)) setSel([item.id]);
		if (selectedIds.size > 1) return batchMenu(e);
		// 21-G1: a PACK CARD in the Packs grid is not an item at all — it is the same
		// registry row the tree draws, so it gets the same menu. Without this it fell
		// through to Properties/Rename/Delete, every one of which addressed an item id
		// ('packfolder:<name>') that does not exist.
		if (item.kind === 'pack-folder') {
			const pack = packByName(item.packName);
			if (pack) packRowMenu(e, pack);
			return;
		}
		// 21-H2: a PREFAB has its own menu — it is a stored asset, not a derived view.
		if (item.kind === 'prefab') {
			prefabMenu(e, item);
			return;
		}
		// R22 round 4: a row in the recycle bin. Restore is offered only when the bytes are
		// actually here — the documented rule about not offering a gesture that cannot work.
		if (item.deletedEntry) {
			const who = ownerLabel(item);
			menu = {
				x: e.clientX,
				y: e.clientY,
				items: [
					item.restorable
						? {
								label: 'Restore',
								icon: 'rotate-ccw',
								tooltip: 'Put it back in the project and share it again',
								action: () => {
									restoreDeletedItem(item.hash);
									showToast('Restored ' + item.name);
								}
							}
						: {
								label: 'Nobody here holds the bytes',
								tooltip:
									'This machine emptied its copy. A peer that still has it can restore it.',
								action: () => {}
							},
					...(item.restorable
						? [
								{
									label: 'Delete permanently',
									danger: true,
									tooltip: 'Free the disk on THIS machine. Peers keep their own copies.',
									action: () => {
										void purgeDeletedItem(item.hash);
										showToast(item.name + ' removed from this device');
									}
								}
							]
						: []),
					{
						label: 'Deleted by ' + (who || 'someone') + ' · ' + new Date(item.createdAt).toLocaleString(),
						action: () => {}
					}
				]
			};
			return;
		}
		if (item.sceneEntry) return; // the Scene manifest IS a derived view — no CRUD
		// P2a: so is a project scene we do not hold — there is no record to rename or
		// delete here, only a scene to open. One entry, and it says what it will do.
		// R22-R1: a shared file whose bytes are not on this device. Same reasoning as the
		// project scene below — there is no record to rename or delete, only bytes to
		// fetch — and the two are kept apart because a scene's one entry TRAVELS there
		// while this one only downloads.
		if (item.remoteItem) {
			const who = ownerLabel(item);
			menu = {
				x: e.clientX,
				y: e.clientY,
				items: [
					{
						label: 'Download from peers',
						icon: 'download',
						tooltip:
							'Shared' +
							(who ? ' by ' + who : '') +
							' — the bytes are not here yet. This asks the mesh for them.',
						action: () => {
							if (pullSharedItem(item.hash)) showToast('Fetching ' + item.name + ' from peers…');
						}
					},
					...(canUnshare(item)
						? [
								{
									label: 'Unshare',
									icon: 'eye-off',
									tooltip:
										'Take it out of the project. You do not hold this file, so there is nothing here to lose.',
									action: () => {
										unshareHash(item.hash);
										showToast(item.name + ' is no longer shared');
									}
								}
							]
						: []),
					{ label: 'Properties', action: () => showProperties({ kind: 'item', item }) }
				]
			};
			return;
		}
		if (item.remoteScene) {
			menu = {
				x: e.clientX,
				y: e.clientY,
				items: [
					{
						label: 'Open here (downloads it)',
						icon: 'download',
						tooltip: 'This project scene is not on this device yet — opening it fetches it from a peer',
						action: () => void openSceneItem(item)
					}
				]
			};
			return;
		}
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
								// 21-I4: the same fix as `openSceneItem` — the FILE name is not
								// the scene name, and `currentLevel.name` is the manifest key.
								// REPORTED: this called travelToLevel DIRECTLY, so the menu route skipped
								// the unsaved-changes guard the double-click route has - the one action in
								// this grid that can destroy work was reachable two ways and guarded one.
								action: () => void openSceneItem(item)
							},
							{
								// 21-G7: the scene's past. It lives in the file PROPERTIES (that is where a
								// file's facts are), so this entry is a signpost to it rather than a second
								// place the history could drift into.
								label: 'Version history',
								icon: 'history',
								tooltip: 'Earlier versions of this scene — restore, pin or free their bytes',
								action: () => showProperties({ kind: 'item', item })
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
								icon: 'download',
								tooltip: 'Save this file to your computer',
								action: () => downloadItem(item)
							}
						]),
				// 21-I5 REVISED / user: the scene's PAST, as files, used to be a menu row here.
				// It moved INTO the Version history panel: its subject IS that history, the row
				// sat one line under Download and read as a second Download, and the panel is
				// where the version count it acts on is already shown.
				// R22-R2: SHARE / UNSHARE, the objectPermissions vocabulary one domain over.
				// A file a PEER shares gets neither: we are not its writer, and an Unshare that
				// silently did nothing would be worse than no entry at all.
				// R22 round 2 (locked answer): ANYONE may unshare — a project's library belongs
				// to the project, not to whoever happened to press the button first. The old
				// owner-only rule survives as a setting, so this asks `canUnshare` rather than
				// testing ownership itself. When it refuses, the row still NAMES the owner,
				// because "you cannot" is only useful with "they can".
				...(shareOf(item) === 'peer'
					? [
							canUnshare(item)
								? {
										label: 'Unshare',
										icon: 'eye-off',
										tooltip:
											'Take it out of the project for everyone. Owner: ' +
											(ownerLabel(item) || 'unknown') +
											'. Nobody loses the copy they already have.',
										action: () => {
											unshareItem(item.id);
											showToast(item.name + ' is no longer shared');
										}
									}
								: {
										label: 'Owner: ' + (ownerLabel(item) || 'a peer'),
										icon: 'users',
										tooltip:
											'Settings has this project set so only the owner may unshare. Your copy stays either way.',
										action: () => {}
									}
						]
					: [
							shareOf(item) === 'mine'
								? {
										label: 'Unshare',
										icon: 'eye-off',
										tooltip:
											'Stop offering this to peers. Copies they already downloaded stay theirs.',
										action: () => {
											unshareItem(item.id);
											showToast(item.name + ' is no longer shared');
										}
									}
								: {
										label: 'Share',
										icon: 'users',
										tooltip: 'Let peers in this session see and download this file',
										action: () => {
											shareItem(item.id);
											showToast('Sharing ' + item.name + ' with peers');
										}
									}
						]),
				{ label: 'Properties', action: () => showProperties({ kind: 'item', item }) },
				{
					label: 'Rename',
					action: () => startRenameItem(item)
				},
				// R22 round 4: deleting a SHARED file removes it from the project for everyone,
				// and every peer's copy goes to their recycle bin rather than being destroyed.
				// A LOCAL file keeps the plain delete — there is nobody else to tell.
				isShared(item)
					? {
							label: 'Delete for everyone',
							danger: true,
							tooltip:
								'Removes it from the project. Every copy moves to Deleted files, where it can be restored.',
							action: () => {
								deleteSharedItem(item.id);
								showToast(item.name + ' deleted for everyone — restore it from Deleted files');
							}
						}
					: {
							label: 'Delete',
							danger: true,
							tooltip: 'Moves it to Deleted, where you can restore it',
							action: () => void deleteLocalItem(item)
						}
			]
		};
	}

	// right-click on the grid background = new folder HERE (106.7)
	/**
	 * R22-R7. Kinds come from what the library ACTUALLY HOLDS rather than from the full
	 * EXTENSIONS table: a filter offering `Audio` in a project with no sounds in it is a
	 * row that can only ever produce an empty grid.
	 */
	/**
	 * R22 round 7 (user) — DELETING MY OWN FILE GOES TO THE BIN TOO, and it asks INSIDE
	 * the Explorer rather than throwing a toast. A toast for a question is the wrong
	 * shape: it appears somewhere else on screen, it can be missed, and it cannot block.
	 * `showConfirm` is the app's modal and it is what every other destructive file action
	 * already uses (folder delete, Open project).
	 */
	async function deleteLocalItem(item: any) {
		if (!$deleteWithoutConfirm) {
			const ok = await showConfirm({
				title: 'Delete \u201c' + item.name + '\u201d',
				message:
					'It moves to Deleted, where you can restore it or free the disk. Nobody else has this file, so nobody else is affected.',
				confirmLabel: 'Delete'
			});
			if (!ok) return;
		}
		logLocalDeletion({ hash: item.hash, name: item.name, kind: item.kind, thumb: item.thumbnail });
		setItemHidden(item.id, true);
		showToast(item.name + ' moved to Deleted');
	}

	/** ...and a PREFAB, which is local by nature and was simply gone before. */
	async function deletePrefabToBin(prefab: any) {
		if (!$deleteWithoutConfirm) {
			const ok = await showConfirm({
				title: 'Delete prefab \u201c' + (prefab?.name ?? '') + '\u201d',
				// R22 round 9: it says "a record of it" because that is all that survives. A
				// prefab has no hidden shelf — `removePrefab` drops the record and
				// `canRestoreDeleted` asks the two ITEM shelves, so a binned prefab can never be
				// restored and the old wording promised exactly the button the bin then refuses
				// to offer. See the round-9 report: making it true needs a prefab shelf.
				message:
					'The prefab is removed. A record of it stays in Deleted, but a prefab cannot be restored from there yet.',
				confirmLabel: 'Delete'
			});
			if (!ok) return;
		}
		// a prefab's identity is its id, not a content hash — prefix it so the two can
		// never collide in one log
		logLocalDeletion({
			hash: 'prefab:' + prefab.id,
			name: prefab.name ?? 'Prefab',
			kind: 'prefab',
			thumb: prefab.thumbnail ?? null
		});
		removePrefab(prefab.id);
		showToast((prefab.name ?? 'Prefab') + ' moved to Deleted');
	}

	/** R22 round 7: emptying the bin is destructive and LOCAL, so it confirms and says
	 * which of those two it is — peers keep their own copies either way. */
	async function emptyBin() {
		const n = deletedLog($projectManifest).length;
		if (!n) return;
		const ok = await showConfirm({
			title: 'Empty Deleted',
			message:
				'Reclaim the disk for ' +
				n +
				' deleted file' +
				(n === 1 ? '' : 's') +
				' and clear the record. This machine only — every peer keeps its own bin, and nothing already restored is affected.',
			confirmLabel: 'Empty'
		});
		if (!ok) return;
		const gone = await emptyDeletedLog();
		showToast('Emptied ' + gone + ' file' + (gone === 1 ? '' : 's') + ' from Deleted');
	}

	/**
	 * R22 round 9: the two VIEW controls the bin owns, shared by its tree row and its own
	 * background menu. Group-by is a `checked` PAIR rather than one toggle, because "off"
	 * is a choice here and a lone checked row leaves you guessing what unchecking gives
	 * you; sort-by-date is offered as the two directions for the same reason.
	 */
	function deletedViewItems() {
		const sort = $explorerSort['deleted'] ?? { key: 'deletedAt', dir: -1 };
		const byDate = sort.key === 'deletedAt';
		return [
			{ section: 'Group' },
			{
				label: 'No grouping',
				checked: $explorerDeletedGroup === 'none',
				action: () => explorerDeletedGroup.set('none')
			},
			{
				label: 'By who deleted it',
				checked: $explorerDeletedGroup === 'deleter',
				tooltip: 'One section per person, yours first',
				action: () => explorerDeletedGroup.set('deleter')
			},
			{ section: 'Sort' },
			{
				label: 'Newest deleted first',
				checked: byDate && sort.dir === -1,
				action: () => explorerSort.update((a) => ({ ...a, deleted: { key: 'deletedAt', dir: -1 } }))
			},
			{
				label: 'Oldest deleted first',
				checked: byDate && sort.dir === 1,
				action: () => explorerSort.update((a) => ({ ...a, deleted: { key: 'deletedAt', dir: 1 } }))
			},
			{
				label: 'By name',
				checked: sort.key === 'name',
				action: () => explorerSort.update((a) => ({ ...a, deleted: { key: 'name', dir: 1 } }))
			}
		];
	}

	/** the Deleted tree row's own menu */
	function deletedRowMenu(e: MouseEvent) {
		e.preventDefault();
		const n = deletedLog($projectManifest).length;
		menu = {
			x: e.clientX,
			y: e.clientY,
			items: [
				{ label: 'Open', action: () => openFolder('deleted') },
				...deletedViewItems(),
				...(n
					? [
							{ section: 'Disk' },
							{
								label: 'Empty Deleted (' + n + ')',
								danger: true,
								icon: 'trash-2',
								action: () => void emptyBin()
							}
						]
					: [])
			]
		};
	}

	function filterMenu(e: MouseEvent) {
		e.preventDefault();
		e.stopPropagation();
		// R22 round 2 (user): EVERY category, not only the ones the library happens to hold.
		// The first version listed present kinds on the reasoning that an absent one can only
		// produce an empty grid — but a filter is also how you learn what the app sorts files
		// INTO, and three of the six were missing from a fresh library, which reads as a bug
		// rather than as a tidy-up. Fixed order, so the menu does not reshuffle as files land.
		const kinds = FILTER_KINDS;
		const toggleKind = (k: string) => {
			const next = new Set(kindFilter);
			if (next.has(k)) next.delete(k);
			else next.add(k);
			// REPLACE the Set — an in-place mutation gives svelte no signal (the documented
			// rule this component already follows for `selectedIds`)
			kindFilter = next;
		};
		const items: any[] = kinds.map((k) => ({
			label: KIND_LABELS[k] ?? k,
			checked: kindFilter.has(k),
			action: () => toggleKind(k)
		}));
		// two axes answering two different questions, so they get a divider: ContextMenu's
		// own `section` label, which is what the rest of the app uses for exactly this
		items.unshift({ section: 'Type' });
		items.push({ section: 'Visibility' });
		items.push({
			label: 'Local only',
			checked: localOnly,
			icon: 'eye-off',
			tooltip: 'Show only the files nobody else can see yet — folders included',
			action: () => (localOnly = !localOnly)
		});
		if (filtering)
			items.push({
				label: 'Clear filters',
				action: () => {
					kindFilter = new Set();
					localOnly = false;
				}
			});
		menu = { x: e.clientX, y: e.clientY, items };
	}

	function gridMenu(e: MouseEvent) {
		if ((e.target as HTMLElement)?.closest('.explorer-card, .explorer-folder-card')) return;
		// R22 round 7: the bin is not a folder you put things in, so New folder / Save scene
		// are meaningless here. What IS meaningful is emptying it.
		if ($activeFolder === 'deleted') {
			e.preventDefault();
			const n = deletedLog($projectManifest).length;
			menu = {
				x: e.clientX,
				y: e.clientY,
				// R22 round 9: group and sort belong HERE as well as on the tree row — this is the
				// surface you are looking at when you decide you want them
				items: n
					? [
							...deletedViewItems(),
							{ section: 'Disk' },
							{
								label: 'Empty Deleted (' + n + ')',
								danger: true,
								icon: 'trash-2',
								tooltip:
									'Reclaim the disk on THIS machine and clear the record. Peers keep their own bins.',
								action: () => void emptyBin()
							}
						]
					: [{ label: 'The bin is empty', action: () => {} }]
			};
			return;
		}
		const inPacks =
			$activeFolder === 'packs' || (typeof $activeFolder === 'string' && $activeFolder.startsWith('pack:'));
		const inPrefabs = !inPacks && $activeFolder === 'prefabs';
		// 21-I3: the Prefabs view gets its OWN small menu. It used to fall into the same
		// early return as the derived Scene view — but a prefab library is not a derived
		// view: prefabs are stored things you CREATE, and the one surface that owns them
		// offered no way to make one. The New-folder / scene / project entries below stay
		// out, because none of them means anything in a virtual folder.
		if (!inPacks && !inPrefabs && typeof $activeFolder === 'string' && $activeFolder.startsWith('scene')) return;
		e.preventDefault();
		if (inPrefabs) {
			menu = {
				x: e.clientX,
				y: e.clientY,
				items: [
					{
						label: 'Create from selection',
						icon: 'boxes',
						tooltip: 'Save the objects selected in the scene as a new prefab',
						action: () => void createPrefabFromSelection()
					}
				]
			};
			return;
		}
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
						{ label: 'New folder', action: () => startCreate($activeFolder ?? null, true) },
						// 21-F4: a saved scene is an ordinary content-hashed .tpscene item —
						// a Travel node loads it by hash. 21-G1: the `Scenes` folder is only
						// where a save LANDS; discovery is BY KIND, so that folder can be
						// renamed, moved or deleted without stranding a single scene.
						{
							label: 'Save scene…',
							tooltip: 'Save this scene as a .tpscene asset a Travel node can load',
							// 21-G10 fork 14: the name is typed INLINE (commitEdit lands it in
							// the active folder — the G9 half of this union)
							action: () => startSceneName('save-scene')
						},
						{
							label: 'New scene…',
							tooltip: 'An EMPTY scene asset — it captures nothing from what is open',
							action: () => startSceneName('new-scene')
						},
						// 21-G3: the whole project as ONE file. Offered only once there IS
						// something to export — an entry that can only produce nothing is
						// worse than no entry.
						// 21-G8: OPENING one (replace everything) rides the Sidebar's Load;
						// this menu's import MERGES the file in as a folder (fork 12).
						// 21-H1: the same widened gate `downloadProject` now uses — fork 11
						// made a .tp the WHOLE Explorer, so a library of models with no scene
						// in it is a real project. Only a genuinely empty one hides this.
						// 21-I4 (locked answer 3): the background menu means WHERE YOU ARE.
						// At the library root that is the project; INSIDE a folder it is that
						// folder, and offering "Export project" there would hand the user a
						// file of everything they are not looking at.
						...($activeFolder
							? [
									{
										label: 'Export folder as .tp',
										tooltip:
											'This folder and everything under it as a project file — its scenes, their version history and the assets they use',
										action: () => downloadProject({ folderId: $activeFolder })
									}
								]
							: manifestInUse() || $explorerItems.length > 0 || $explorerFolders.length > 0
								? [
										{
											label: 'Export project (.tp)',
											tooltip:
												'The project manifest, every scene version still stored here, and the assets it uses — as one file',
											action: () => downloadProject()
										}
									]
								: []),
						{
							label: 'Import project as folder (.tp)…',
							tooltip:
								'Adds a .tp file’s contents to your library as one folder — nothing opens, your project stays',
							action: () => tpImportInput?.click()
						}
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
		// 21-G8 fork 12: a dropped .tp is an IMPORT — it merges in as a folder named
		// after the project and never opens anything (the Sidebar's Load is the OPEN
		// path). Everything else takes the ordinary item import, .tpscene included —
		// a scene file is an ordinary kind-'scene' item in the active folder.
		const rest: File[] = [];
		for (const f of Array.from(files)) {
			if (f.name.toLowerCase().endsWith('.tp')) void importTpAsFolder(f);
			else rest.push(f);
		}
		// loose-scenes fix (bug 2a): a DROP is a person importing, so bytes we already
		// hold get the visible treatment — the setting decides ask / skip / copy. Every
		// other importFiles caller (the texture pickers, a generated mesh) leaves this
		// off and silently reuses the item it finds, which is what they want.
		if (rest.length)
			importFiles(rest, folder === 'prefabs' ? null : folder, { duplicates: 'ask' });
	}

	/** 21-G8: route a .tp file to the merge-as-folder import (never OPEN from a drop).
	 *  21-I (user): it lands WHERE THE COMMAND WAS STARTED, in a folder named after the
	 *  FILE. Both facts are read HERE — "where I am" belongs to this component, and the
	 *  filename only exists on the File the caller holds. */
	async function importTpAsFolder(file: File) {
		const { importProjectAsFolder } = await import('$lib/projectFile');
		await importProjectAsFolder(await file.arrayBuffer(), {
			fileName: file.name,
			parentId: activeLibraryFolder()
		});
	}
	async function onImportTpFile(e: Event) {
		const input = e.currentTarget as HTMLInputElement; // capture BEFORE any await
		const file = input?.files?.[0];
		if (file) await importTpAsFolder(file);
		if (input) input.value = '';
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
	/**
	 * 21-H3: the payload for a drag STARTING on `item`. A single drag keeps EXACTLY its
	 * old top-level shape and gains nothing, so `dropExplorerItem`, the Inspector's
	 * texture target and every other consumer of this payload are byte-compatible; the
	 * `items` array appears only when the dragged card is part of a multi-selection.
	 * A card OUTSIDE the selection drags alone and leaves the selection untouched — it
	 * is a drag, not a click, so it has no business changing what is picked.
	 */
	function dragPayloadFor(item: any) {
		const base = itemDragPayload(item);
		if (!selectedIds.has(item.id) || selectedIds.size < 2) return base;
		const carried = selectedEntries()
			.filter((entry: any) => entry.kind === 'item')
			.map((entry: any) => itemDragPayload(entry.item));
		// R22 round 10: the FOLDERS in the same selection travel with it, so an
		// Explorer-internal move re-files everything the user picked rather than the items
		// only. The viewport drop ignores the key, which is why this is additive.
		const folders = selectedFolderIds();
		const out: any = carried.length > 1 ? { ...base, items: carried } : { ...base };
		if (folders.length) out.folders = folders;
		return out;
	}
	/** every FOLDER id in the current multi-selection (empty unless there is a real set) */
	function selectedFolderIds(): string[] {
		if (selectedIds.size < 2) return [];
		return selectedEntries()
			.filter((entry: any) => entry.kind === 'folder')
			.map((entry: any) => entry.folder.id);
	}
	/** the payload a FOLDER card drags, carrying its selection the same way an item does */
	function folderDragPayload(folder: any) {
		const out: any = { id: folder.id };
		if (!selectedIds.has(folder.id) || selectedIds.size < 2) return out;
		const folders = selectedFolderIds();
		if (folders.length > 1) out.folders = folders;
		const items = selectedEntries()
			.filter((entry: any) => entry.kind === 'item')
			.map((entry: any) => itemDragPayload(entry.item));
		if (items.length) out.items = items;
		return out;
	}
	function onItemDragStart(e: DragEvent, item: any) {
		// 96 consumes these payloads (viewport placement / texture drop). N6: a
		// default-pack item carries a `url` so the drop can fetch+place it without
		// first storing it in the Explorer library.
		e.dataTransfer?.setData('application/x-explorer-item', JSON.stringify(dragPayloadFor(item)));
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
		// 21-H3: the touch path carries the SET too, on the same rule as the HTML5 drag —
		// press a card that is part of the selection and the whole set comes; press one
		// outside it and only that card does
		const payload: any = dragPayloadFor(item);
		const carried = payload.items?.length ?? 1;
		const label = carried > 1 ? `${item.name} + ${carried - 1} more` : item.name;
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
	function onCardClick(e: MouseEvent, item: any) {
		if (tSuppressClick) {
			tSuppressClick = false;
			return;
		}
		// 21-H3: a MODIFIED click is a selection gesture and never an open — a pack card
		// would otherwise navigate away from the set you are still building
		if (e.shiftKey || e.ctrlKey || e.metaKey) {
			modifierSelect(e, item.id, () => (selected = { kind: 'item', item }));
			return;
		}
		setSel([item.id]);
		inspectItem(item);
	}
	/** the folder card's twin of `onCardClick` (single-click-open stays a plain click) */
	function onFolderCardClick(e: MouseEvent, folder: any) {
		if (e.shiftKey || e.ctrlKey || e.metaKey) {
			modifierSelect(e, folder.id, () => selectFolder(folder));
			return;
		}
		setSel([folder.id]);
		if (singleClickOpen) openFolder(folder.id);
		else selectFolder(folder);
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
		if (item.kind === 'prefab') {
			// 21-H2: a prefab inspects like any other card — the highlight reads off
			// `inspectedFile`, so it takes the card's own ('prefab:<id>') id
			inspectedFile.set(item.id);
			selected = { kind: 'item', item };
			return;
		}
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
		if (item.remoteScene) {
			// P2a: a project scene we do not hold. It selects (so the card reads as picked)
			// but claims no `inspectedFile`, because there is no library record behind it —
			// every panel that reads one would be reading a card we invented.
			inspectedFile.set(null);
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
	// ---- 21-H3: the MARQUEE ----------------------------------------------------------
	// A rubber band over empty grid space. Three hazards, all of them already paid for
	// elsewhere in this codebase, are called out at the line that answers them.
	//
	// MOUSE ONLY, and that is a decision rather than an oversight: on touch a drag
	// across the background must keep SCROLLING the grid, and touch already has its own
	// pick-up gesture (the long press below), so a marquee there would take both away.
	let mq = $state<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
	let mqBase = new Set<string>();
	let mqMoved = false;
	let mqSuppressClick = false;
	const MQ_SLOP = 4;

	/** the band in the grid's own coordinates — CLIENT coords are what the gesture
	 *  tracks (the list scrolls under it), converted only for drawing */
	const mqRect = $derived.by(() => {
		if (!mq || !gridEl) return null;
		const box = gridEl.getBoundingClientRect();
		return {
			left: Math.min(mq.x0, mq.x1) - box.left + gridEl.scrollLeft,
			top: Math.min(mq.y0, mq.y1) - box.top + gridEl.scrollTop,
			width: Math.abs(mq.x1 - mq.x0),
			height: Math.abs(mq.y1 - mq.y0)
		};
	});

	/** every card the band touches, hit-tested where the cards actually are */
	function cardsInBand(band: { x0: number; y0: number; x1: number; y1: number }): string[] {
		const left = Math.min(band.x0, band.x1);
		const right = Math.max(band.x0, band.x1);
		const top = Math.min(band.y0, band.y1);
		const bottom = Math.max(band.y0, band.y1);
		const hit: string[] = [];
		for (const el of gridEl?.querySelectorAll('[data-card-id]') ?? []) {
			const box = (el as HTMLElement).getBoundingClientRect();
			if (box.right >= left && box.left <= right && box.bottom >= top && box.top <= bottom)
				hit.push((el as HTMLElement).dataset.cardId ?? '');
		}
		return hit.filter(Boolean);
	}

	function onGridPointerDown(e: PointerEvent) {
		if (e.pointerType !== 'mouse' || e.button !== 0) return;
		const target = e.target as HTMLElement;
		if (target?.closest('.explorer-card, .explorer-folder-card, input, button, textarea')) return;
		// HAZARD 1: without this, a sweep across the card LABELS starts a native text
		// drag — after which Chromium delivers dragstart/drag/dragend and NO pointermove
		// or pointerup at all, so the gesture hangs with its box on screen and its window
		// listeners attached (the HUD artboard bug, verbatim). `select-none` on the grid
		// is the other half of that cure.
		e.preventDefault();
		gridEl?.focus(); // preventDefault also suppresses the implicit focus
		mqBase = e.ctrlKey || e.metaKey ? new Set(selectedIds) : new Set();
		mqMoved = false;
		mq = { x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY };
		// HAZARD 2: on WINDOW for the duration, so a release outside the grid — or
		// outside the panel entirely — still ends the gesture.
		window.addEventListener('pointermove', onMarqueeMove);
		window.addEventListener('pointerup', onMarqueeUp);
		window.addEventListener('pointercancel', onMarqueeUp);
	}
	function onMarqueeMove(e: PointerEvent) {
		if (!mq) return;
		const band = { ...mq, x1: e.clientX, y1: e.clientY };
		mq = band;
		if (Math.abs(band.x1 - band.x0) > MQ_SLOP || Math.abs(band.y1 - band.y0) > MQ_SLOP)
			mqMoved = true;
		// a plain drag REPLACES the selection, Ctrl+drag ADDS to what was already there
		if (mqMoved) setSel([...mqBase, ...cardsInBand(band)]);
	}
	function onMarqueeUp() {
		window.removeEventListener('pointermove', onMarqueeMove);
		window.removeEventListener('pointerup', onMarqueeUp);
		window.removeEventListener('pointercancel', onMarqueeUp);
		// HAZARD 3: `gridBackgroundClick` deselects, and a click follows every drag that
		// began on the background — so a marquee that TRAVELLED would undo itself the
		// instant it ended (the file's own `tSuppressClick` precedent, one gesture over).
		if (mqMoved) mqSuppressClick = true;
		mq = null;
		mqMoved = false;
	}

	// 197b: single-click empty grid space clears the selection + closes the ⓘ panel
	function deselect() {
		selected = null;
		setSel([]);
		inspectedFile.set(null);
		// keep the panel if the user pinned it (opened via the ⓘ tab) — just clear
		// the selection; close it only if it auto-opened from a pick (197 note)
		const st = shell?.secondaryStatus?.();
		if (st?.open && st.mode === 'props' && !st.pinned) shell.hideSecondary();
	}
	function gridBackgroundClick(e: MouseEvent) {
		gridEl?.focus(); // focus the region so keyboard nav works after any grid click
		if ((e.target as HTMLElement)?.closest('.explorer-card, .explorer-folder-card')) return;
		// 21-H3 (hazard 3): the click that ENDS a marquee must not clear what it picked
		if (mqSuppressClick) {
			mqSuppressClick = false;
			return;
		}
		deselect();
	}
	/**
	 * 21-I4 — DOUBLE-CLICK A SCENE, AND IT OPENS. The right-click menu has offered this
	 * ("Open here") since 21-F4; the double-click every other card answers to did
	 * nothing at all, which reads as a broken card rather than as a missing feature.
	 *
	 * It is `travelToLevel`, and that is a LOCAL, SILENT scene replace: the replicated
	 * half of travel is the travel NODE's pulse, so opening a scene out of your own file
	 * browser broadcasts nothing and moves nobody else. Authoring, not a game move.
	 *
	 * THE GUARD, and why it is a three-way. This replaces the world, so an unsaved
	 * current scene asks first — the DCC standard, and the reason `sceneDirty` exists.
	 * That flag is READ, never recomputed: 21-G9 keeps it behind a throttle precisely
	 * because the answer costs a whole-scene serialization. Two consequences worth
	 * knowing: the verdict can lag a very recent edit by up to `SIGNATURE_THROTTLE_MS`,
	 * and a scene that has never been NAMED is never "dirty" (there is no version to be
	 * dirty against) — in both cases the ordinary autosave is what protects the work,
	 * and travel's own writer-side auto-publish usually catches the first anyway.
	 */
	async function openSceneItem(item: any) {
		// the scene you are standing in. Re-applying the file over your own edits is not
		// what a double-click means, and it is the one "open" that can only lose work.
		if ($currentLevel?.hash === item.hash) {
			showToast(`"${item.name}" is the scene you are already in`);
			return;
		}
		// REPORTED (bug 2): this used to read `$sceneDirty` — the THROTTLED verdict,
		// which 21-G9 deliberately lets lag a very recent edit by up to
		// SIGNATURE_THROTTLE_MS (2s) because recomputing costs a whole-scene
		// serialization. That is the right trade for a TITLE BAR and the wrong one
		// here: edit, immediately double-click another scene, and the guard read a
		// stale `false`, so no dialog appeared and the work was gone. The one place
		// the answer must be current is the action that destroys it, so it is
		// recomputed synchronously; everywhere else keeps the throttle.
		//
		// The second half is a scene with NO IDENTITY to be dirty against.
		// recomputeSceneDirty answers false for it by construction ("nothing to be
		// dirty AGAINST"), which is honest but leaves the newest, least-saved work in
		// the app completely unguarded. If there is no identity and the world is not
		// empty, opening still destroys something, so it asks.
		const identified =
			!!$currentLevel?.name && typeof $currentLevel?.signature === 'string';
		const risky = identified
			? recomputeSceneDirty()
			: ($objectsGroup?.children?.length ?? 0) > 0;
		if (risky) {
			const here = $currentLevel?.name ?? 'This scene';
			const choice = await showChoice({
				title: `Open "${item.name}"?`,
				message: identified
					? `"${here}" has unsaved changes, and opening a scene replaces what is on screen.`
					: 'The scene on screen has never been saved, and opening a scene replaces it.',
				// "Open anyway", NOT "Open without saving": travel's own writer-side
				// auto-publish (fork 9) runs inside `travelToLevel` whatever is chosen
				// here, so a named scene normally banks a version on the way out and the
				// stronger label would be a lie. What "Save and open" adds is the cases
				// that rule excludes — a viewer, a loose .tpscene, auto-versions switched
				// off — and a deliberate one rather than an automatic one.
				choices: [
					{ value: 'save', label: 'Save and open' },
					{ value: 'open', label: 'Open anyway', color: 'red' }
				]
			});
			if (!choice) return;
			if (choice === 'save') {
				// the ordinary write-back first — it lands the new version BESIDE the one it
				// supersedes and under the project's own rules. It answers false for the
				// three cases those rules exclude (a viewer, a loose .tpscene opened from
				// disk, an unnamed scene), and there an explicit save is what the user just
				// asked for: it always writes a local item, and for a loose scene it is
				// exactly the "Save into project" offer of fork 12.
				const published = await publishCurrentIfChanged({ force: true });
				if (published) showToast(`Saved a version of "${here}" first`);
				else await saveSceneAsLevel(here, $activeFolder ?? null);
			}
		}
		// NO name is passed, and that is a fix rather than an omission. `currentLevel.name`
		// is the MANIFEST KEY — travel-away publishes under it — and an item name carries
		// the `.tpscene` extension, so handing it over filed every version of "Arena"
		// under a second scene called "Arena.tpscene": a duplicate card per open, and a
		// history split in two. `travelToLevel` falls back to the payload's own `name`,
		// which is the name the scene saved itself under and the key the manifest uses.
		await travelToLevel(item.hash);
	}
	async function openItem(item: any) {
		// R22-R1: opening a shared file we do not hold means FETCHING it. There is nothing
		// else a double-click could sensibly do — the card exists because the index says the
		// file does, and the bytes are one ask away.
		if (item.remoteItem) {
			if (pullSharedItem(item.hash)) showToast('Fetching ' + item.name + ' from peers…');
			else showToast(item.name + ' is already here');
			return;
		}
		if (item.kind === 'pack-folder') {
			openFolder('pack:' + item.packName);
			return;
		}
		if (item.kind === 'prefab') {
			// 21-H2: full model parity — double-click opens the POP-OUT preview. The
			// inline one in Properties stands down while it is open (previewSuspended).
			openModelPreview({
				title: item.name,
				prefabId: item.prefabId,
				name: item.name,
				onClose: () => gridEl?.focus()
			});
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
		// 21-I4: a SCENE opens. Every other kind here opens a viewer; this one opens a
		// world, which is why it has a guard and they do not.
		if (item.kind === 'scene' && !item.packEntry) {
			await openSceneItem(item);
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
			onblur={blurCommit}
		/>
		{#if !isValidName(editing.value)}
			<span class="text-[10px] text-red-400">names can't contain * \ /</span>
		{/if}
	</div>
{/snippet}

<!-- 170: inline rename input sized for a thumbnail card (folders + items) -->
{#snippet cardEdit()}
	<!-- `select-text`: the grid is `select-none` (the marquee's text-drag cure), which
	     would otherwise reach into the one input that lives inside it -->
	<input
		class="ui-input w-full select-text py-0 text-center text-[10px] {isValidName(editing.value) ? '' : 'border-red-500'}"
		value={editing.value}
		use:focusSelect
		oninput={(e) => (editing = { ...editing, value: e.currentTarget.value })}
		onkeydown={editKeydown}
		onclick={(e) => e.stopPropagation()}
		onblur={blurCommit}
	/>
{/snippet}

<!--
	R22-R7: THE FILTER. One snippet rendered in both headers (docked and undocked never
	both mount), beside the search box because it narrows the same question a different
	way. The shared ContextMenu rather than a ThemedSelect: the kind list grows, and a
	select cannot shrink below its longest option — the documented trap that pushed the
	post-stack's add control off a narrow panel.
-->
{#snippet filterChip()}
	<button
		id="explorer-filter"
		class="ui-button-quiet shrink-0 {filtering ? 'text-primary-400' : ''}"
		title={filtering
			? 'Filtering — click to change or clear'
			: 'Filter by type, and by who can see it'}
		aria-label="Filter files"
		onclick={(e) => filterMenu(e)}>☷{filtering ? ' •' : ''}</button
	>
	<!-- R22 round 6: AFTER the filter, and always visible. An indicator that comes and
	     goes reflows the header and trains nobody where to look; a permanent one has to
	     be honest in every state instead — see the four in TransferLog. -->
	<TransferLog bind:open={logOpen} />
{/snippet}

<!--
	R22 round 9: THUMBNAILS | LIST. A SEGMENTED control rather than a menu entry, for the
	reason the toolbox contract already gives: this is a mode you flip often and want to
	see the state of at a glance, and burying a frequently-used two-state switch behind two
	clicks costs more than the 52px it takes. Icon-only, so it survives the narrow header.
-->
{#snippet viewChip()}
	<div class="tp-seg shrink-0" role="group" aria-label="View mode">
		<button
			id="explorer-view-thumbnails"
			class="tp-seg-btn"
			aria-pressed={$explorerViewMode === 'thumbnails'}
			title="Thumbnails"
			aria-label="Thumbnails"
			onclick={() => explorerViewMode.set('thumbnails')}><LayoutGrid size={14} aria-hidden="true" /></button
		>
		<button
			id="explorer-view-list"
			class="tp-seg-btn"
			aria-pressed={$explorerViewMode === 'list'}
			title="List — sortable columns; right-click the header to choose them"
			aria-label="List"
			onclick={() => explorerViewMode.set('list')}><List size={14} aria-hidden="true" /></button
		>
	</div>
{/snippet}

<!--
	R22 round 9: HOW FULL IS THE DISK. `navigator.storage.estimate()` is a quota for the
	whole ORIGIN and not for the library alone, which is why it reads "used / quota" rather
	than claiming the library is responsible for all of it. Nothing renders where the
	browser does not implement it — a zero would be a claim, an absence is the truth.
-->
{#snippet storageChip()}
	{#if storage}
		<span
			id="explorer-storage"
			class="shrink-0 whitespace-nowrap text-[10px] text-gray-500"
			title={storageTitle(storage)}>{fmtSize(storage.used)} / {fmtSize(storage.quota)}</span
		>
	{/if}
{/snippet}

<!--
	R22 round 9: ONE ROW OF THE LIST. Deliberately rendered here rather than in a separate
	component: a card and a row share nine handlers, six helpers and the inline-rename
	snippet, so a component would need thirty props to say the same thing — and the two
	would then drift on the next behaviour added to either. Every interaction below is the
	SAME function the card calls, so drag, touch-drag, the context menus, multi-select and
	double-click-to-open are the same behaviour by construction and not by imitation.
-->
{#snippet listRow(entry: any)}
	{@const isFolder = entry.kind === 'folder'}
	{@const item = entry.item}
	{@const folder = entry.folder}
	{@const id = isFolder ? folder.id : item.id}
	<!--
		`explorer-card` / `explorer-folder-card` are BEHAVIOURAL markers, not styling —
		nothing in any stylesheet matches them. Three handlers on #explorer-grid ask
		`closest('.explorer-card, .explorer-folder-card')` to tell a card from the
		background, so without them a row WAS background: a plain click selected it and
		`gridBackgroundClick` immediately deselected it, a press started a marquee on top
		of it, and a right-click opened the item menu only to have the background one
		replace it. A row IS a card in this view.
	-->
	<tr
		data-card-id={id}
		class="ex-row {isFolder ? 'explorer-folder-card' : 'explorer-card'} {cardClass(selectedIds, $inspectedFile, selected, id)} {!isFolder &&
		openSceneHash &&
		item.hash === openSceneHash
			? 'explorer-open-scene'
			: ''} {!isFolder && (item.remoteScene || item.remoteItem || (item.deletedEntry && !item.restorable)) ? 'explorer-remote opacity-60' : ''} {dropFolder ===
			id && isFolder
			? 'ex-row-drop'
			: ''}"
		draggable="true"
		title={isFolder ? folder.name : item.name}
		style:touch-action={tDragging ? 'none' : 'pan-y'}
		ondragstart={(e) =>
			isFolder
				? e.dataTransfer?.setData('application/x-explorer-folder', JSON.stringify(folderDragPayload(folder)))
				: onItemDragStart(e, item)}
		ondragover={(e) => isFolder && dragOverInto(e, folder.id)}
		ondragleave={() => isFolder && (dropFolder = null)}
		ondrop={(e) => isFolder && dropInto(e, folder.id)}
		onpointerdown={(e) => !isFolder && onCardPointerDown(e, item)}
		onpointermove={(e) => !isFolder && onCardPointerMove(e)}
		onpointerup={(e) => !isFolder && onCardPointerUp(e)}
		oncontextmenu={(e) => (isFolder ? folderMenu(e, folder, false) : itemMenu(e, item))}
		onclick={(e) => (isFolder ? onFolderCardClick(e, folder) : onCardClick(e, item))}
		ondblclick={() => (isFolder ? openFolder(folder.id) : openItem(item))}
	>
		{#each shownColumns as col (col.key)}
			<td class="ex-cell {col.numeric ? 'text-right tabular-nums' : ''}" style:width={col.width}>
				{#if col.key === 'name'}
					<span class="flex min-w-0 items-center gap-1.5">
						{#if isFolder}
							<span class="shrink-0 {mutedFolder(folder) ? MUTED_ICON : 'ico-folder'}"
								><Folder size={14} aria-hidden="true" /></span
							>
						{:else if thumbFor(item)}
							<img
								src={thumbFor(item)}
								alt=""
								class="h-4 w-4 shrink-0 rounded-sm object-cover {mutedItem(item) ? MUTED_IMG : ''}"
							/>
						{:else}
							<span
								class="shrink-0 {mutedItem(item) ? MUTED_ICON : (KIND_COLORS[item.kind] ?? 'text-gray-400')}"
								><Icon name={KIND_ICONS[item.kind] ?? 'package'} size={14} /></span
							>
						{/if}
						{#if (editing?.mode === 'rename' && editing.inGrid && editing.folderId === id) || (editing?.mode === 'rename-item' && editing.itemId === id) || (editing?.mode === 'rename-prefab' && editing.prefabId === item?.prefabId)}
							{@render cardEdit()}
						{:else}
							<span
								class="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap {(
									isFolder ? mutedFolder(folder) : mutedItem(item)
								)
									? 'text-gray-500'
									: 'text-gray-300'}">{isFolder ? folder.name : item.name}</span
							>
						{/if}
						<!-- the same status the card carries in its corners, folded into ONE inline dot:
						     a row has no corners, and four possible dots on one line is noise. The
						     precedence is the card's own, top to bottom. -->
						{#if !isFolder}
							{#if openSceneHash && item.hash === openSceneHash}
								<span class="ex-dot bg-emerald-400" title="The scene you have open"></span>
							{:else if item.remoteScene}
								<span
									class="ex-dot bg-sky-400"
									title="In this project, not on this device yet — open it to download it"
								></span>
							{:else if item.remoteItem}
								<span
									class="ex-dot {$unavailableHashes.has(item.hash)
										? 'bg-red-400'
										: $pendingPulls.has(item.hash)
											? 'animate-pulse bg-amber-400'
											: 'bg-sky-400'}"
									title={$pendingPulls.has(item.hash) ? 'Downloading from peers…' : shareTitle(item)}
								></span>
							{:else if sharingOn && isShared(item)}
								<span
									class="ex-dot {shareOf(item) === 'mine' ? 'bg-teal-400' : 'bg-sky-400'}"
									title={shareTitle(item)}
								></span>
							{:else if sharingOn && item.wasShared}
								<span class="ex-dot border border-gray-500" title={shareTitle(item)}></span>
							{/if}
							{#if item.kind === 'scene' && !item.remoteScene && staleScene($projectManifest, item.hash)}
								<span
									class="ex-dot bg-amber-400"
									title={'An update of "' +
										staleScene($projectManifest, item.hash) +
										'" exists — this file is an older version'}
								></span>
							{/if}
						{:else if sharingOn && (folder.share === 'mine' || folder.share === 'peer')}
							<span
								class="ex-dot {folder.share === 'mine' ? 'bg-teal-400' : 'bg-sky-400'}"
								title={folder.share === 'mine'
									? 'Shared by you — peers see this folder, and anything you add to it'
									: 'Shared — a peer offered this folder'}
							></span>
						{/if}
					</span>
				{:else}
					<span class="overflow-hidden text-ellipsis whitespace-nowrap text-gray-400"
						>{cellText(entry, col.key)}</span
					>
				{/if}
			</td>
		{/each}
	</tr>
{/snippet}

<!-- R22 round 9: the column header. Click sorts, right-click chooses columns. -->
{#snippet listHead()}
	<thead>
		<tr id="explorer-list-head" class="ex-head" oncontextmenu={(e) => columnMenu(e)}>
			{#each shownColumns as col (col.key)}
				<th class="ex-th {col.numeric ? 'text-right' : ''}" style:width={col.width}>
					<button
						class="ex-th-btn"
						data-col={col.key}
						title={'Sort by ' + col.label.toLowerCase()}
						onclick={() => sortBy(listView, col.key)}
					>
						{col.label}<!--
							the indicator sits on the ACTIVE column only, so "which column is this
							sorted by" is answerable without reading a preference
						-->{#if ($explorerSort[listView] ?? {}).key === col.key}<span class="ex-sort"
								>{($explorerSort[listView] ?? {}).dir === -1 ? '▾' : '▴'}</span
							>{/if}
					</button>
				</th>
			{/each}
		</tr>
	</thead>
{/snippet}

{#snippet identityChip()}
	<!-- 21-I2 (locked answer 4): WHO AM I, compact and beside the search box —
	     Project ▸ Scene ●. It RETIRES 21-G9's own row, which spent a whole line
	     of a bottom dock on two words. The LOCATION crumbs inside the shell stay exactly
	     as they were: they answer a different question (which folder am I browsing).

	     `min-w-0` is what makes it TRUNCATE instead of shoving the search box off a
	     narrow dock (the documented flex trap: a flex item's min-width is `auto`, so it
	     refuses to shrink below its content). The search keeps its width; this absorbs
	     the shrinkage, and every segment carries a title so the full text is still
	     readable once it is clipped. -->
	<div id="explorer-identity" class="flex min-w-0 flex-1 items-center gap-0.5 text-[11px] font-normal">
		{#if projectEdit !== null}
			<input
				id="explorer-project-input"
				class="ui-input w-40 shrink py-0 text-[11px]"
				aria-label="Project name"
				value={projectEdit}
				use:focusSelect
				oninput={(e) => (projectEdit = e.currentTarget.value)}
				onkeydown={projectKeydown}
				onblur={commitProjectEdit}
			/>
		{:else}
			<button
				id="explorer-project"
				class="min-w-0 truncate rounded-sm px-1 py-0.5 font-medium hover:bg-gray-700 {$projectManifest.name
					? 'text-gray-200'
					: 'italic text-gray-500'}"
				title={projectLabel + ' — click to rename this project'}
				onclick={startProjectEdit}>{projectLabel}</button
			>
		{/if}
		{#if $currentLevel?.name}
			<span class="shrink-0 px-0.5 text-gray-600" aria-hidden="true">▸</span>
			<button
				id="explorer-scene"
				class="min-w-0 truncate rounded-sm px-1 py-0.5 text-white hover:bg-gray-700"
				title={'The scene you have open: ' + $currentLevel.name + ' — click to find its file'}
				onclick={revealOpenScene}>{$currentLevel.name}</button
			>
			{#if $sceneDirty}
				<!-- the same signal the window title's asterisk uses (sceneIdentity.js) -->
				<span
					id="explorer-dirty"
					class="shrink-0 text-[9px] leading-none text-amber-400"
					title="This scene has changes that are not in the version its name points at"
					aria-label="Unsaved changes">●</span
				>
			{/if}
		{/if}
	</div>
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
			<!-- 21-I2: the identity row that used to sit here is now the CHIP beside the
			     search box. What is left is the LOCATION trail — which folder am I in —
			     which is a different question and keeps its own ⚙ toggle. -->
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
		<div id="explorer-tree" class="flex h-full flex-col text-xs" bind:clientHeight={treeColH}>
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
			{#if editing?.mode === 'create' && !editing.inGrid && editing.parentId === null}
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
								e.dataTransfer?.setData('application/x-explorer-folder', JSON.stringify(folderDragPayload(row.folder)))}
							oncontextmenu={(e) => folderMenu(e, row.folder)}
							onclick={() => openFolder(row.folder.id)}
							ondblclick={() => toggleExpand(row.folder.id)}
						>
							<Folder size={16} class="ico-folder mr-1.5 w-4 text-center" aria-hidden="true" />{row.folder.name}
						</button>
					</div>
				{/if}
				{#if editing?.mode === 'create' && !editing.inGrid && editing.parentId === row.folder.id}
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
				<!-- 21-G10: the divider became the grip. GraphTree's shape verbatim (pointer
				     events, capture, a MEASURED ceiling, dblclick to reset) — startRootsResize
				     carries the reasoning, including why dragging DOWN shrinks this. -->
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div
					id="explorer-roots-resize"
					class="my-0.5 h-1.5 shrink-0 cursor-ns-resize border-t border-gray-700/40 {rootsResizing
						? 'bg-primary-600/60'
						: 'hover:bg-gray-600/60'}"
					style="touch-action: none"
					title="Drag to resize this section (double-click to reset)"
					onpointerdown={startRootsResize}
					onpointermove={doRootsResize}
					onpointerup={endRootsResize}
					onpointercancel={endRootsResize}
					ondblclick={resetRootsH}
				></div>
				<div id="explorer-roots" class="flex flex-col gap-0.5 overflow-y-auto" style="max-height: {rootsH}px">
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
					<!-- R22 round 7: the bin sits BELOW Scene. It is the least-used pinned row,
					     and a destructive place belongs under the things you reach for rather
					     than above them. Still hidden while empty. -->
					{#if deletedLog($projectManifest).length}
						<button
							id="deleted-folder"
							class="whitespace-nowrap rounded px-2 py-1 text-left {$activeFolder === 'deleted'
								? 'bg-primary-700 text-white'
								: 'text-gray-300 hover:bg-gray-700'}"
							title="Files removed from the project — restore them, or free the disk"
							onclick={() => openFolder('deleted')}
							oncontextmenu={deletedRowMenu}
							><Icon name="trash-2" size={16} class="mr-1.5 w-4 text-center text-gray-400" aria-hidden="true" />Deleted
							<span class="text-gray-500">({deletedLog($projectManifest).length})</span></button
						>
					{/if}
				</div>
			</div>
		</div>
		{/snippet}
		{#snippet main()}
		<!-- item grid (+ subfolder cards, 106.7); click empty space to deselect (197b) -->
		<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_noninteractive_element_interactions a11y_no_noninteractive_tabindex a11y_no_static_element_interactions -->
		<!-- 21-H3: `select-none` is half the cure for the native text drag (see
		     onGridPointerDown); the inline name inputs opt back in with `select-text`. -->
		<div
			bind:this={gridEl}
			id="explorer-grid"
			class="relative h-full min-w-0 select-none overflow-y-auto p-1 outline-hidden"
			style="scrollbar-gutter: stable"
			tabindex="-1"
			oncontextmenu={gridMenu}
			onclick={gridBackgroundClick}
			onpointerdown={onGridPointerDown}
			onkeydown={gridKeydown}
			role="region"
		>
			{#if !pendingCard && childFolders.length === 0 && gridItems.length === 0}
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
				<!--
					R22-R8: with the Logs pane open the body becomes two columns — the cards and the
					log. The split is CSS rather than measured JS: `.ex-split` is a flex row, the log
					takes a fixed 300px, and at <=640px the cards hide and the log takes the whole
					drawer ("if limited space, then it takes entire explorer drawer"). No
					ResizeObserver, and nothing to get wrong on a re-dock.
				-->
				<div class="ex-split" class:ex-split-on={logOpen}>
				{#if $explorerViewMode === 'list'}
					<!--
						R22 round 9: THE LIST. A real <table>, because that is what a sortable grid of
						columns IS — the header/row relationship comes with it, and so does column
						width agreement between the head and every row, which a flexbox imitation has
						to keep in step by hand.
					-->
					<div class="ex-list">
						{#if pendingCard}
							<!-- 21-G10: name it where it will appear, in this view too — a placeholder
							     that only exists in one of two layouts is a trap. -->
							<div id="explorer-new-card" class="ex-new flex items-center gap-1.5">
								<span class={pendingCard === 'create' ? 'ico-folder' : 'text-gray-400'}>
									{#if pendingCard === 'create'}
										<Folder size={14} aria-hidden="true" />
									{:else}
										<Icon name={KIND_ICONS.scene} size={14} />
									{/if}
								</span>
								{@render cardEdit()}
							</div>
						{/if}
						<table class="ex-table">
							{@render listHead()}
							{#if deletedGroups}
								<!-- grouped bin: one SECTION per deleter, collapsible. The rows inside a
								     section are the same rows in the same order the sort produced. -->
								{#each deletedGroups as group (group.id)}
									<tbody>
										<tr class="ex-group">
											<td colspan={shownColumns.length}>
												<button class="ex-group-btn" onclick={() => toggleGroup(group.id)}>
													<span class="ex-group-caret">{collapsedGroups.has(group.id) ? '▸' : '▾'}</span>
													{group.name}<span class="ex-group-n">{group.rows.length}</span>
												</button>
											</td>
										</tr>
										{#if !collapsedGroups.has(group.id)}
											{#each group.rows as row (row.id)}
												{@render listRow({ kind: 'item', item: row })}
											{/each}
										{/if}
									</tbody>
								{/each}
							{:else}
								<tbody>
									{#each gridEntries as entry (entry.kind === 'folder' ? 'f:' + entry.folder.id : 'i:' + entry.item.id)}
										{@render listRow(entry)}
									{/each}
								</tbody>
							{/if}
						</table>
						{#if !gridEntries.length && !pendingCard}
							<p class="px-2 py-3 text-[11px] text-gray-500">Nothing here.</p>
						{/if}
					</div>
				{:else}
				<div class="ex-cards grid grid-cols-[repeat(auto-fill,96px)] justify-start gap-1">
					{#if pendingCard}
						<!-- 21-G10: name it where it will appear. A placeholder card, not a modal and
						     not a browser prompt — Esc removes it having created nothing. -->
						<div
							id="explorer-new-card"
							class="explorer-folder-card flex flex-col items-center gap-1 rounded border border-dashed border-primary-600/70 bg-primary-600/5 p-1.5"
						>
							<span class="flex h-14 w-14 items-center justify-center {pendingCard === 'create' ? 'ico-folder' : 'text-gray-400'}">
								{#if pendingCard === 'create'}
									<Folder size={32} aria-hidden="true" />
								{:else}
									<Icon name={KIND_ICONS.scene} size={32} />
								{/if}
							</span>
							{@render cardEdit()}
						</div>
					{/if}
					{#if !search && $activeFolder !== 'prefabs'}
						{#each childFolders as folder (folder.id)}
							<div
								data-card-id={folder.id}
								class="explorer-folder-card relative flex cursor-pointer flex-col items-center gap-1 rounded border p-1.5 {dropFolder === folder.id
									? 'border-primary-500 bg-primary-500/10'
									: cardClass(selectedIds, null, selected, folder.id)}"
								role="button"
								tabindex="0"
								draggable="true"
								ondragstart={(e) =>
									e.dataTransfer?.setData('application/x-explorer-folder', JSON.stringify(folderDragPayload(folder)))}
								ondragover={(e) => dragOverInto(e, folder.id)}
								ondragleave={() => (dropFolder = null)}
								ondrop={(e) => dropInto(e, folder.id)}
								oncontextmenu={(e) => folderMenu(e, folder, false)}
								onclick={(e) => onFolderCardClick(e, folder)}
								ondblclick={() => openFolder(folder.id)}
								onkeydown={(e) => e.key === 'Enter' && openFolder(folder.id)}
							>
								{#if sharingOn && (folder.share === 'mine' || folder.share === 'peer')}
									<!-- R22-R2: a SHARED folder, same two colours as an item's dot. It matters
									     more here than on a file, because a shared folder also shares whatever
									     you drop into it later. -->
									<span
										class="explorer-share-dot absolute bottom-1 left-1 h-2 w-2 rounded-full {folder.share === 'mine' ? 'bg-teal-400' : 'bg-sky-400'}"
										title={folder.share === 'mine'
											? 'Shared by you — peers see this folder, and anything you add to it'
											: 'Shared' + (ownerLabel(folder) ? ' by ' + ownerLabel(folder) : '') + ' — a peer offered this folder'}
									></span>
								{/if}
								<!-- R22 round 2 (user): an unshared folder is quiet too — the ICON, not
								     just the name, because the icon is what the eye lands on in a grid. -->
								<span
									class="flex h-14 w-14 items-center justify-center {mutedFolder(folder)
										? MUTED_ICON
										: 'ico-folder'}"><Folder size={32} aria-hidden="true" /></span
								>
								{#if editing?.mode === 'rename' && editing.inGrid && editing.folderId === folder.id}
									{@render cardEdit()}
								{:else}
									<span
										class="w-full overflow-hidden text-ellipsis whitespace-nowrap text-center text-[10px] {mutedFolder(folder) ? 'text-gray-500' : 'text-gray-300'}"
									>
										{folder.name}
									</span>
								{/if}
							</div>
						{/each}
					{/if}
					{#each gridItems as item (item.id)}
						<div
							data-card-id={item.id}
							class="explorer-card group relative flex cursor-grab flex-col items-center gap-1 rounded border p-1.5 {cardClass(
								selectedIds,
								$inspectedFile,
								selected,
								item.id
							)} {openSceneHash && item.hash === openSceneHash
								? 'explorer-open-scene ring-1 ring-emerald-400'
								: ''} {item.remoteScene || item.remoteItem || (item.deletedEntry && !item.restorable) ? 'explorer-remote opacity-60' : ''}"
							draggable="true"
							role="listitem"
							title={item.name}
							style:touch-action={tDragging ? 'none' : 'pan-y'}
							ondragstart={(e) => onItemDragStart(e, item)}
							onpointerdown={(e) => onCardPointerDown(e, item)}
							onpointermove={onCardPointerMove}
							onpointerup={onCardPointerUp}
							oncontextmenu={(e) => itemMenu(e, item)}
							onclick={(e) => onCardClick(e, item)}
							ondblclick={() => openItem(item)}
						>
							{#if openSceneHash && item.hash === openSceneHash}
								<!-- 21-G9: THIS is the scene you have open. The ring alone reads as a
								     selection at a glance, so the dot carries the meaning in words. -->
								<span
									class="explorer-open-dot absolute left-1 top-1 h-2.5 w-2.5 rounded-full bg-emerald-400"
									title="The scene you have open"
								></span>
							{/if}
							{#if item.remoteScene}
							<!-- P2a: a project scene whose bytes are not on this device. Dimmed rather
							     than hidden: the project agrees it exists, and opening it fetches it. -->
							<span
								class="explorer-remote-dot absolute right-1 top-1 h-2.5 w-2.5 rounded-full bg-sky-400"
								title="In this project, not on this device yet — open it to download it"
							></span>
						{/if}
						{#if item.remoteItem}
							<!-- R22-R1: a SHARED file whose bytes are not on this device. Same treatment
						     as a project scene one branch up, and for the same reason: the session
						     agrees it exists, so hiding it would be a worse lie than dimming it.
						     `$pendingPulls` is the only thing that distinguishes "not here" from "on
						     its way", which is what stops the card reading as dead when clicked. -->
							<span
								class="explorer-remote-dot absolute right-1 top-1 h-2.5 w-2.5 rounded-full {$unavailableHashes.has(item.hash) ? 'bg-red-400' : $pendingPulls.has(item.hash) ? 'animate-pulse bg-amber-400' : 'bg-sky-400'}"
								title={$pendingPulls.has(item.hash) ? 'Downloading from peers…' : shareTitle(item)}
							></span>
						{:else if sharingOn && isShared(item)}
							<!-- R22-R2: WHO CAN SEE THIS. Teal = shared by you, sky = a peer's. Bottom
						     LEFT because both top corners are taken (the open scene; the remote/stale
						     pair), and drawn only once something in the project is actually shared —
						     in a solo project the distinction is pure noise. -->
							<span
								class="explorer-share-dot absolute bottom-1 left-1 h-2 w-2 rounded-full {shareOf(item) === 'mine' ? 'bg-teal-400' : 'bg-sky-400'}"
								title={shareTitle(item)}
							></span>
						{:else if sharingOn && item.wasShared}
							<!-- R22-R2: a copy whose owner stopped sharing it. Hash-addressing means we
						     never lost the file, and this says so rather than leaving it looking
						     identical to something that was never shared at all. -->
							<span
								class="explorer-unshared-dot absolute bottom-1 left-1 h-2 w-2 rounded-full border border-gray-500"
								title={shareTitle(item)}
							></span>
						{/if}
						{#if item.kind === 'scene' && !item.remoteScene && staleScene($projectManifest, item.hash)}
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
							{:else if thumbFor(item)}
								<!-- R22: the picture may be the item's OWN thumbnail or one a peer pushed
							     for a file we have not downloaded. Muted for a local file, so the
							     shared/local distinction reads on the artwork and not only on a dot. -->
								<img
									src={thumbFor(item)}
									alt={item.name}
									class="h-14 w-14 rounded-sm object-cover {mutedItem(item) ? MUTED_IMG : ''}"
								/>
							{:else}
								<span
									class="flex h-14 w-14 items-center justify-center rounded-sm bg-gray-700 {mutedItem(item)
										? MUTED_ICON
										: (KIND_COLORS[item.kind] ?? 'text-gray-400')}"
								>
									<Icon name={KIND_ICONS[item.kind] ?? 'package'} size={28} />
								</span>
							{/if}
							{#if (editing?.mode === 'rename-item' && editing.itemId === item.id) || (editing?.mode === 'rename-prefab' && editing.prefabId === item.prefabId)}
								{@render cardEdit()}
							{:else}
								<!-- R22-R2: the plan asks for local items in a distinct colour. Drawn only
							     while `sharingOn` — muting every name in a project that has never shared
							     anything would say nothing and cost legibility everywhere. -->
								<span
									class="w-full overflow-hidden text-ellipsis whitespace-nowrap text-center text-[10px] {mutedItem(item) ? 'text-gray-500' : 'text-gray-300'}"
									title={item.name + ' — ' + shareTitle(item)}
								>
									{item.name}
								</span>
							{/if}
						</div>
					{/each}
				</div>
				{/if}
				{#if logOpen}
					<div class="ex-log"><TransferLog mode="pane" bind:open={logOpen} /></div>
				{/if}
				</div>
			{/if}
			{#if mqRect}
				<!-- 21-H3: the band. An absolutely-positioned child of the (already
				     `relative`) grid, so it scrolls with the cards it is picking. -->
				<div
					id="explorer-marquee"
					class="pointer-events-none absolute z-20 rounded-xs border border-sky-400 bg-sky-400/15"
					style="left: {mqRect.left}px; top: {mqRect.top}px; width: {mqRect.width}px; height: {mqRect.height}px"
				></div>
			{/if}
			{#if dropActive}
				<!--
					R22 round 10, REPORTED: with the grid scrolled down, this band stayed at the
					top. It is an absolutely-positioned child of #explorer-grid, which is the
					SCROLLER — so `inset-1` pins it to the top of the CONTENT, not of the visible
					area, and at 800px down it is drawn 800px above what you can see.

					The marquee above is absolute for the OPPOSITE reason (it must scroll with the
					cards it is picking), so the two cannot share a rule. Offsetting by scrollTop
					and taking the visible height keeps this one in view without `position: fixed`,
					which would be measured against any transformed or backdrop-filtered ancestor
					(the documented containing-block trap).
				-->
				<div
					id="explorer-drop-band"
					class="pointer-events-none absolute left-1 right-1 z-20 rounded-lg border-2 border-dashed border-primary-500 bg-primary-500/10"
					style="top: {dropBandTop}px; height: {dropBandH}px"
				></div>
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
					{#if selItem.kind === 'prefab'}
						<!-- 21-H2: a prefab's own facts. Size/Folder/Hash say nothing about it (it
						     is not a file in a folder), so it gets the numbers that do: what it
						     holds, and when it was last saved. -->
						<div id="prefab-facts" class="flex flex-col gap-1">
							<div class="flex gap-2"><span class="w-14 shrink-0 text-gray-500">Kind</span><span>prefab</span></div>
							<div class="flex gap-2">
								<span class="w-14 shrink-0 text-gray-500">Objects</span>
								<span id="prefab-objects">{selPrefab?.objects ?? 0}</span>
							</div>
							<div class="flex gap-2">
								<span class="w-14 shrink-0 text-gray-500">Mesh</span>
								<span id="prefab-tris"
									>{(selPrefab?.tris ?? 0).toLocaleString()} tris · {(selPrefab?.verts ?? 0).toLocaleString()} verts
									· {selPrefab?.meshes ?? 0} mesh{selPrefab?.meshes === 1 ? '' : 'es'}</span
								>
							</div>
							{#if selPrefab?.createdAt}
								<div class="flex gap-2">
									<span class="w-14 shrink-0 text-gray-500">Saved</span>
									<span id="prefab-saved">{new Date(selPrefab.createdAt).toLocaleString()}</span>
								</div>
							{/if}
							{#if selPrefab?.updatedAt}
								<div class="flex gap-2">
									<span class="w-14 shrink-0 text-gray-500">Updated</span>
									<span id="prefab-updated">{new Date(selPrefab.updatedAt).toLocaleString()}</span>
								</div>
							{/if}
						</div>
					{:else}
					<div class="flex flex-col gap-1">
						<div class="flex gap-2"><span class="w-14 shrink-0 text-gray-500">Kind</span><span>{selItem.kind}</span></div>
						<div class="flex gap-2"><span class="w-14 shrink-0 text-gray-500">Size</span><span>{fmtSize(selItem.size)}</span></div>
						<div class="flex gap-2">
							<span class="w-14 shrink-0 text-gray-500">Folder</span>
							<span class="min-w-0 truncate" title={itemFolderPath}>{itemFolderPath}</span>
						</div>
						<!--
							R22 round 2 (user) — OWNER. "Owner" rather than "Created by" or "Author", on
							the DCC convention: Perforce, ShotGrid and ftrack all use owner for the person
							RESPONSIBLE for an asset, and keep created-by for provenance — which is
							exactly the distinction that matters here, because nothing in this app can say
							who MADE a file, only who put it into the project. The checkmark is the point
							of the third tier: it appears only when a cloud plugin vouched for an account.
						-->
						<div class="flex gap-2">
							<span class="w-14 shrink-0 text-gray-500">Owner</span>
							<span class="min-w-0 truncate" title={shareTitle(selItem)}>
								{ownerLabel(selItem) || 'You'}
							</span>
						</div>
						<div class="flex gap-2">
							<span class="w-14 shrink-0 text-gray-500">Sharing</span>
							<span class="min-w-0 truncate">
								{selItem.remoteItem
									? 'Shared \u2014 not downloaded'
									: shareOf(selItem) === 'mine'
										? 'Shared by you'
										: shareOf(selItem) === 'peer'
											? 'Shared'
											: selItem.wasShared
												? 'No longer shared'
												: 'Local only'}
							</span>
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
					{/if}
					<!-- N4: rotatable inline 3D preview + poly stats (behind the global toggle).
					     21-H2: prefabs render here too (the `prefabId` source), and the whole
					     block stands down while the POP-OUT window is open — two WebGL contexts
					     on the same tree is the reported double-click hang. `previewSuspended` is
					     RUNTIME state; `enable3dPreview` is the user's stored preference and is
					     never written here (fileWindows.js carries the reasoning). -->
					{#if (selItem.kind === 'object' || selItem.kind === 'prefab') && $enable3dPreview && !selItem.packEntry && $previewSuspended}
						<!-- 21-I3: the STILL, at the live preview's own size, instead of H2's text
						     note. One live viewport per asset is the DCC-standard answer and it is
						     what makes the suspension read as a deliberate hand-off rather than a
						     hole in the panel — the pane keeps its shape, and what it shows is
						     still this item. The id is unchanged: it is the anchor for "the pane
						     says where the preview went", which is still exactly what this is. -->
						<div id="preview-suspended" class="relative mt-1 overflow-hidden rounded-sm bg-[#0d1117]" style="height: 150px">
							{#if selItem.thumbnail}
								<img id="preview-suspended-thumb" src={selItem.thumbnail} alt={selItem.name} class="h-full w-full object-contain" />
							{:else}
								<div class="flex h-full w-full items-center justify-center text-gray-600">
									<Box size={40} aria-hidden="true" />
								</div>
							{/if}
							<div class="pointer-events-none absolute inset-x-0 bottom-0 bg-black/60 px-2 py-1 text-center text-[10px] text-gray-300">
								Previewing in its own window
							</div>
						</div>
					{:else if (selItem.kind === 'object' || selItem.kind === 'prefab') && $enable3dPreview && !selItem.packEntry}
						<div id="inline-preview" class="mt-1 overflow-hidden rounded-sm bg-[#0d1117]" style="height: 150px">
							{#key selItem.id}
								<ModelPreview
									itemId={selItem.kind === 'prefab' ? '' : selItem.id}
									prefabId={selItem.kind === 'prefab' ? selItem.prefabId : ''}
									name={selItem.name}
									onStats={(s) => (inlineStats = s)}
								/>
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
					<div class="mt-1 flex flex-wrap gap-2">
						{#if selItem.kind === 'prefab'}
							<!-- 21-H2: the two things you actually do with a prefab, one click away;
							     the rest live on the card's right-click menu -->
							<button
								id="prefab-add"
								class="ui-button-quiet"
								onclick={() => {
									const p = prefabById(selItem.prefabId);
									if (p) instantiatePrefab(p);
								}}>Add to scene</button
							>
							<button id="prefab-rename" class="ui-button-quiet" onclick={() => startRenamePrefab(selItem)}>Rename</button>
							{#if $enable3dPreview}
								<button id="prefab-preview" class="ui-button-quiet" onclick={() => openItem(selItem)}>3D preview</button>
							{/if}
						{:else if selItem.packEntry}
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
					<!-- 21-G7: a scene file's PAST belongs with the rest of its facts. Renders
					     itself away for every other kind, and for a pack card (no history to have). -->
					<VersionHistory item={selItem} onDownloadAll={downloadSceneVersions} />
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
						class="tp-check"
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
						class="tp-check"
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
						class="tp-check"
						type="checkbox"
						checked={$enable3dPreview}
						onchange={(e) => enable3dPreview.set(e.currentTarget.checked)}
					/>
					3D model preview
				</label>
				<!-- 21-H3: what a MULTI-selection does when it lands in the viewport -->
				<label
					class="flex items-center gap-2"
					title="Drop several selected cards on the same spot instead of spreading them out"
				>
					<input
						id="explorer-stack-on-drop"
						type="checkbox"
						checked={$stackOnDrop}
						onchange={(e) => stackOnDrop.set(e.currentTarget.checked)}
					/>
					Stack multiple drops on one spot
				</label>
				<!-- 21-I3 (locked answer 6): "Update from selection" replaces instantly and
				     offers an Undo. This puts the old prompt back for anyone who wants to be
				     asked — default OFF, and it lives beside the other Explorer prefs because
				     that is where the thing it governs lives. -->
				<label
					class="flex items-center gap-2"
					title="Ask before 'Update from selection' replaces a prefab's stored bytes"
				>
					<input
						id="explorer-confirm-prefab-update"
						class="tp-check"
						type="checkbox"
						checked={$confirmPrefabUpdate}
						onchange={(e) => confirmPrefabUpdate.set(e.currentTarget.checked)}
					/>
					Confirm before updating a prefab
				</label>
				<label class="flex items-center gap-2" title="Hide the bundled packs, showing only your imported ones">
					<input
						class="tp-check"
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
	<!-- 21-G8: the "Import project as folder (.tp)…" picker — mounted whenever the
	     Explorer is open (the menu entry that clicks it can open from any view) -->
	<input bind:this={tpImportInput} type="file" accept=".tp" class="hidden" onchange={onImportTpFile} />
	{#if docked}
		<div
			id="explorer-list"
			transition:fly={{ y: 300, duration: 200 }}
			class="fixed inset-x-0 bottom-0 bg-white p-2 dark:bg-gray-800 {dockVisible ? '' : 'hidden'}"
			style="z-index: var(--z-bottom); height: {$dockHeight}px; border-top: 1px solid rgb(55 65 81 / 0.6)"
			ondragover={(e) => {
				if (canAccept(e)) return;
				e.preventDefault();
				markDropActive();
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
			<DockTabs />
			<div class="mb-1 flex items-center gap-2">
				<span class="shrink-0 text-xs font-semibold text-gray-200"><FolderTree size={16} class="mr-1" aria-hidden="true" />Explorer</span>
				<!-- `shrink-0`: the identity chip beside it is the flex item that gives way -->
				<input
					id="explorer-search"
					class="ui-input w-48 shrink-0 py-0.5"
					placeholder="Search assets…"
					bind:value={search}
				/>
				{@render filterChip()}
				{@render viewChip()}
				{@render storageChip()}
				{@render identityChip()}
				<button
					id="explorer-undock"
					class="ui-button-quiet shrink-0"
					title="Undock into a floating window"
					onclick={() => setDocked(false)}>⧉</button
				>
			</div>
			<div style="height: {$dockHeight - 44}px">
				{@render content()}
			</div>
		</div>
	{:else}
		<div
			id="explorer-window"
			class="ui-panel fixed flex flex-col overflow-hidden"
			use:dragWindow={{ key: 'explorerWin', defaultRect: { left: 160, top: 120 } }}
			use:focusStack={'explorer'}
			use:tabbable={{ key: 'explorer', title: 'Explorer', openStore: explorerClose, isOpen: (v) => !v, close: () => explorerClose.set(true) }}
			use:dockable={{ key: 'explorer' }}
			style="z-index: var(--z-window)"
			style:width="{effW}px"
			style:height="{effH}px"
			ondragover={(e) => {
				if (canAccept(e)) return;
				e.preventDefault();
				markDropActive();
			}}
			ondragleave={() => (dropActive = false)}
			ondrop={onDrop}
			role="region"
		>
			<div class="ui-panel-header move-handle shrink-0 cursor-move select-none py-1.5">
				<span class="shrink-0"><FolderTree size={16} class="mr-1" aria-hidden="true" />Explorer</span>
				<input
					id="explorer-search"
					class="ui-input w-44 shrink-0 py-0.5 font-normal"
					placeholder="Search assets…"
					bind:value={search}
				/>
				{@render filterChip()}
				{@render viewChip()}
				{@render storageChip()}
				{@render identityChip()}
				<button id="explorer-dock" class="ui-button-quiet shrink-0" title="Dock to the bottom" onclick={() => setDocked(true)}>
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

<style>
	/*
		R22-R8 — THE SPLIT. A flex row holding the cards and the Logs pane. Each half keeps
		its own scroll, and the log takes a FIXED width so the card grid’s auto-fill
		columns reflow around it rather than the two fighting over the remainder.
	*/
	.ex-split {
		display: block;
		min-height: 0;
	}
	.ex-split-on {
		display: flex;
		height: 100%;
		align-items: stretch;
		gap: 6px;
	}
	.ex-split-on .ex-cards,
	.ex-split-on .ex-list {
		min-width: 0;
		flex: 1;
		align-content: start;
		overflow-y: auto;
	}
	.ex-log {
		min-height: 0;
		flex: 0 0 300px;
	}

	/*
		R22 round 9 — THE LIST VIEW.

		The surface is owned EXPLICITLY (`var(--surface, ...)`) wherever a header row has to
		sit over scrolling content: the documented `ui-panel` trap is that an `@apply`-built
		utility is compiled onto the class, so a theme's `.bg-gray-800` remap never reaches
		it and the row would stay dark in every theme but one. A sticky header over a
		transparent background shows the rows sliding under it, so this one cannot be left
		to inherit.
	*/
	.ex-list {
		min-width: 0;
		overflow: auto;
	}
	.ex-table {
		width: 100%;
		border-collapse: collapse;
		font-size: 11px;
		table-layout: fixed;
	}
	.ex-head {
		position: sticky;
		top: 0;
		z-index: 1;
	}
	.ex-th {
		background: var(--surface, #1f2937);
		border-bottom: 1px solid var(--border, #374151);
		padding: 0;
		text-align: left;
		font-weight: 600;
		white-space: nowrap;
	}
	.ex-th.text-right .ex-th-btn {
		justify-content: flex-end;
	}
	.ex-th-btn {
		display: flex;
		width: 100%;
		align-items: center;
		gap: 3px;
		padding: 3px 6px;
		color: #9ca3af;
		text-align: inherit;
	}
	.ex-th-btn:hover {
		color: #e5e7eb;
	}
	.ex-sort {
		font-size: 9px;
		line-height: 1;
		color: var(--accent, #3b82f6);
	}
	.ex-row {
		cursor: pointer;
		border-left: 2px solid transparent;
	}
	/* the selection tints come from `cardClass`, which paints a BORDER on a card; on a
	   row the border would draw a box round every cell, so only the background is wanted */
	.ex-row {
		border-top: 0;
		border-right: 0;
		border-bottom: 0;
	}
	.ex-row-drop {
		outline: 1px solid var(--accent, #3b82f6);
		outline-offset: -1px;
	}
	.ex-cell {
		max-width: 0;
		overflow: hidden;
		padding: 2px 6px;
		white-space: nowrap;
	}
	.ex-dot {
		flex: 0 0 auto;
		height: 7px;
		width: 7px;
		border-radius: 9999px;
	}
	.ex-group td {
		padding: 0;
	}
	.ex-group-btn {
		display: flex;
		width: 100%;
		align-items: center;
		gap: 4px;
		padding: 3px 6px;
		background: color-mix(in srgb, var(--surface, #1f2937) 70%, transparent);
		font-size: 10px;
		font-weight: 600;
		letter-spacing: 0.02em;
		color: #d1d5db;
		text-transform: uppercase;
	}
	.ex-group-caret {
		width: 8px;
		color: #9ca3af;
	}
	.ex-group-n {
		color: #6b7280;
		font-weight: 400;
	}
	.ex-new {
		padding: 2px 6px;
	}

	/* the view toggle uses the shared `tp-seg` / `tp-seg-btn` utilities — the Sessions
	   filter wanted the same control in the same round, which is when it stopped being
	   local (see ui.utilities.css) */
	/* "if limited space, then it takes entire explorer drawer": under this width there
	   is no room for two columns, so the log becomes the view rather than a sliver */
	@media (max-width: 640px) {
		.ex-split-on .ex-cards,
		.ex-split-on .ex-list {
			display: none;
		}
		.ex-log {
			flex: 1;
		}
	}
</style>
