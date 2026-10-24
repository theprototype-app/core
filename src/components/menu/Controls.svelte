<script lang="ts">
	import { onLayoutRestore } from '$lib/uiLayoutsCore';
	import { minimalScroll } from '$lib/ui/minimalScroll.js';
	import { objectsGroup, TControls, transformMode, editorMode, isLocked, lockedObjects, globalScene, vrPassthrough, selectedObject, selectedObjects } from '../../stores/sceneStore';
	import { chatUnread, chatMentioned } from '../../stores/appStore.js'; // 37 R15: the chat button's badge
	import { chatHidden, flowGraphClose, flowCodeClose, animationClose, uvEditorClose, shaderEditorClose, hudEditorClose, timelineClose, explorerClose, profilerClose, codeWorkspaceClose, objectListClose, objectContextMenu, renamingObject, advancedMode, showEnvInList, showLocalObjects, floatingToolbar, toolbarAlwaysOnTop, hudStackLift, showSimControls, expandedObjects } from '../../stores/appStore.js';
	// 24-B2: keyboard navigation in the object list (the Explorer's gridKeydown shape)
	import { visibleObjectRows, withExpanded, typeAheadIndex } from '$lib/objectListNav';
	import { sceneMetrics, statsOpen, worstTier, budgetRows } from '$lib/sceneBudget';
	import { qualityState, pinQuality, releaseQuality } from '$lib/qualityGovernor';
	import { showToast as showQualityToast } from '../../stores/appStore';
	import { keyOf } from '$lib/keyOf';
	import { setLastScope } from '$lib/keyScope';
	import { isHeaderDrag, startWindowDragGuard } from '$lib/windowGrip';
	import { bodyDrag } from '$lib/windowBodyDrag';
	import { systemGroupNames } from '$lib/moduleSDK';
	import { ENV_ROOT } from '$lib/environment';
	import { flyTo } from '$lib/objectActions';
	import { mutedFlowObjects } from '../../stores/flowStore';
	import { focusObject, duplicateObject, toggleObjectVisibility, moveObjectsToParent, setTransformMode, selectObject, toggleEditorMode } from '$lib/objectActions';
	import { registerWindowReset } from '$lib/dragWindow';
	import { enterEditMode } from '$lib/meshEdit';
	import { addAnnotation } from '$lib/annotationsHandler';
	import { requestControl, nameOf } from '$lib/lockControl';
	import { savePrefab } from '$lib/prefabs';
	import { sendPing } from '$lib/ping';
	import { buildObjectMenuItems } from '$lib/objectMenu';
	import * as THREE from 'three';
	import { onMount, setContext, tick } from 'svelte';
	import { createGesture } from '$lib/modalGrab';
	// 44 M12b: free but anchored placement of the clusters + rotation
	import { boxAt, fractionsOf, snapBox, nudgeFree, clampBox, overlaps } from '$lib/clusterPlace';
	import type { Box, Guide } from '$lib/clusterPlace';
	import { connectPinned, setConnectPinned } from '$lib/connectPin';
	import { connectDocked, connectBarHeight } from '../../stores/appStore.js';
	import { writable, get } from 'svelte/store';
	import { shareObject } from '$lib/objectPermissions';
	import Objects from './Objects.svelte';
	import LocalObjects from './LocalObjects.svelte';
	import ModuleContent from './ModuleContent.svelte';
	import ContextMenu from '../ContextMenu.svelte';
	import WindowChrome from '../ui/WindowChrome.svelte';
	import SearchField from '../ui/SearchField.svelte';
	import Badge from '../ui/Badge.svelte';
	import Icon from '../ui/Icon.svelte';
	import { createAttachmentKey, fromAction } from 'svelte/attachments';
	// 41 G1: MobileAddButton / AiHudButton (and VoiceChat's mic button) became roster entries
	import { aiAssistantHidden, settingsOpen, settingsSection, viewportMenuOpener } from '../../stores/appStore.js';
	// 42 I9: the top-right group's and the touch tools' buttons join the roster
	import { notesDrawerOpen, multiSelectMode, touchTools } from '../../stores/appStore.js';
	import { undo, redo } from '$lib/history';
	import { toolbarSlots, TOP_DEFAULT, TOUCH_DEFAULT, TOP_NATIVE, TOUCH_NATIVE } from '$lib/toolbarSlots';
	import { aiReady } from '$lib/ai/providers';
	import { canvasCenter } from '$lib/canvasRect';
	import { micActive, pttActive, toggleMic } from '$lib/voiceChat';
	import { phoneShell } from '$lib/ui/phoneShell.js';
	import SimControls from './SimControls.svelte';
	import { focusStack } from '$lib/windowFocus';
	// 53 A3: one tab stop per toolbar (arrows between its buttons) + Enter/Space on the <p> cells
	import { roving, pressOnKey } from '$lib/keyboardNav';
	import { tabbable, groupRectOf, moveGroupOf, resizeGroup } from '$lib/windowTabs';
	import { clampWinSize, clampResize, anchorOf, registerSizeReset } from '$lib/windowSize';
	import { dockable } from '$lib/docking';
	import { bottomDockable } from '$lib/bottomDockDrop';
	import { dockShownKeys, dockOccupants, bottomInset, FLOW_FAMILY, armDockMode, DOCK_TITLES } from '$lib/bottomDock';
	import { togglePanel } from '$lib/panelToggles';
	import { requestPlay, willEnterXR, willEnterAR, xrSessionFailed, playAsItems } from '$lib/playMode';
	// 30 P2: Test play — the play button's right-click row beside the game chip's button
	import { testPlay } from '$lib/gamePresence';
	import { hudIsGame } from '$lib/hudDocs';
	import { DOCK_VIEWS } from '$lib/dockMenu';
	import { safeStorage } from '$lib/safeStorage';
	// 41 G23/G1: the toolbar layout model (a pure leaf)
	import {
		PLAY as SPACER,
		defaultLayout as defaultToolbarLayout,
		normalizeLayout,
		visualRow,
		moveCell as moveToolbarCell,
		hideButton as hideToolbarButton,
		showButton as showToolbarButton,
		swapCell as swapToolbarCell,
		SIDE_MAX,
		placements,
		fromPlacements,
		placeAt,
		placeRemove,
		placeRegion,
		fillHole,
		isHole,
		stepItem,
		unplacedIds,
		regionOf,
		canPlace,
		foldToFit,
		CLUSTERS,
		UNROTATED,
		normalizeClusters
	} from '$lib/toolbarLayout';
	// 43 J8/J10: where the sidebars are (a pinned column bounds the bar; any open one bounds Edit positions)
	import { geometry as sidebarGeometry } from '$lib/sidebars';
	import type { ToolbarLayout, LayoutConfig, Placements, Region } from '$lib/toolbarLayout';
	import { pivotMode, pivotParentAvailable } from '$lib/multiTransform'; // 37 R1: the toolbar Pivot cell
	import { cssPx, scaledPx, uiScale } from '$lib/uiScale'; // 53 A1: hud.css px tokens read back as calc(...)
	import { VRButton, XRButton } from '@threlte/xr'

	// A panel is "shown" when it is open AND either the visible dock tab OR floating
	// (floating = open but not the docked occupant). The toolbar icon tints whenever its
	// panel is shown — docked OR as a floating window (this fixes the icon going dark
	// while a floating panel is clearly on screen). Clicking shows the panel in its
	// current mode (docked tab or floating window) or hides it; docking/undocking is on
	// each panel's own header buttons.
	// The Node editor button's behaviour follows the NODE EDITOR's own mode:
	//  - Node editor DOCKED   -> the button toggles the docked flow group (its docked tabs).
	//  - Node editor FLOATING -> the button only shows/hides that floating window and never
	//    touches the docked Flow Code / Animation group.
	// The icon is lit when a docked flow tab is the visible dock panel OR the Node editor
	// floating window is shown.
	// WHAT a click DOES now lives in $lib/panelToggles (`togglePanel`), one decision tree
	// shared with the O / N keyboard shortcuts; only the icon TINT is decided here.
	// 44 M9: a split shows two dock views at once — either half counts as on screen
	const flowDockVisible = $derived(FLOW_FAMILY.some((k) => $dockShownKeys.includes(k)));
	const flowFloatingShown = $derived(!$flowGraphClose && !$dockOccupants.flow?.present);
	const flowShown = $derived(flowDockVisible || flowFloatingShown);
	// W8b: the Explorer's rule, generalised to every dock view the roster can carry —
	// OPEN, and either the visible dock tab or not in the dock at all (i.e. floating).
	// It used to be one hand-written line for the Explorer alone, and five more copies
	// is exactly how five buttons end up disagreeing about what "shown" means. Every
	// close-store is read INSIDE the derived, which is what registers the dependency:
	// a plain map built outside it would go stale (the `get()`-registers-nothing rule).
	// The Node editor keeps its own two lines above — its button owns the whole docked
	// FLOW FAMILY, so any family tab counts as "its dock is on screen", which is a rule
	// none of the others has.
	const panelShown: Record<string, boolean> = $derived.by(() => {
		const shownKeys = $dockShownKeys;
		const occupants = $dockOccupants;
		const closed: Record<string, boolean> = {
			flowcode: $flowCodeClose,
			animation: $animationClose,
			uv: $uvEditorClose,
			shader: $shaderEditorClose,
			hud: $hudEditorClose,
			timeline: $timelineClose,
			explorer: $explorerClose,
			profiler: $profilerClose,
			code: $codeWorkspaceClose
		};
		const out: Record<string, boolean> = {};
		for (const key of Object.keys(closed))
			out[key] = !closed[key] && (shownKeys.includes(key) || !occupants[key]?.present);
		return out;
	});

	// CO4b: WHAT the play button is about to do, so it can show it — and, since 4a,
	// what a press DOES. Both now come from $lib/playMode: the support probes, the
	// desktop/XR decision and the exit cooldown used to be private to this component,
	// which is how the FAB ended up with two sources for one decision (the glyph read
	// the `isSessionSupported` probes; the click sniffed threlte's private button
	// label). The lib is the single truth, and the FAB, the mode menu below and the
	// coming keyboard shortcut are all just callers of `requestPlay`.
	let resizing = $state(false);
	// 132: toolbar icons tint when their panel is open / the transform mode is
	// active. Move/Rotate/Scale only tint with a real selection. 151: the mode
	// lives in the shared transformMode store so the 1/2/3 shortcuts tint too.
	// 151: tint follows the ACTIVE selection set (cleared on deselect), not the
	// sticky selectedObject (which keeps the last object for the inspector bind)
	const hasSel = $derived($selectedObjects.length > 0);
	// 37 R1: the pivot point only means something for a SET (one object turns about its own origin)
	const multiSel = $derived($selectedObjects.length > 1);
	// 38 R8: the armed state is painted on the CELL (`.hud-cell.on`, the accent's soft fill);
	// the glyph keeps `text-accent` only as the MARKER the controls/dock suites read
	// (hud.css lets the cell's colour win over it). ICON_OFF adds nothing.
	const ICON_ON = 'text-accent';
	const ICON_OFF = '';

	// --- object list search/filter: rows read the visible-uuid set via context ---
	// 80: type chips MULTI-select (union); All clears and, clicked again,
	// restores the previous chip set; System/Environment are exclusive VIEWS.
	const objectFilter = writable(null); // null = no filtering
	setContext('objectFilter', objectFilter);
	let searchTerm = $state('');
	let searchTypes: Set<string> = $state(new Set());
	let lastTypes: Set<string> = $state(new Set());
	let viewMode = $state(''); // '' | 'system' | 'environment'
	let matchCount = $state(0);
	const TYPE_TESTS = {
		mesh: (o) => o.isMesh && o.name !== 'Stroke',
		light: (o) => o.type.endsWith('Light'),
		group: (o) => o.type === 'Group',
		stroke: (o) => o.name === 'Stroke'
	};
	function toggleTypeChip(value: string) {
		viewMode = '';
		const next = new Set(searchTypes);
		if (next.has(value)) next.delete(value);
		else next.add(value);
		searchTypes = next;
	}
	function clickAll() {
		viewMode = '';
		if (searchTypes.size) {
			lastTypes = new Set(searchTypes); // remembered for the next All click
			searchTypes = new Set();
		} else if (lastTypes.size) {
			searchTypes = new Set(lastTypes);
		}
	}
	function refreshFilter() {
		if (viewMode) {
			// system/environment views render their own rows — filtering is off
			matchCount = 0;
			objectFilter.set(null);
			return;
		}
		const group = $objectsGroup;
		const term = searchTerm.trim().toLowerCase();
		if (!group || (!term && !searchTypes.size)) {
			matchCount = 0;
			objectFilter.set(null);
			return;
		}
		const visible = new Set();
		let count = 0;
		const walk = (object, ancestors) => {
			const name = (object.name || object.type).toLowerCase();
			const typeOk =
				!searchTypes.size || [...searchTypes].some((t) => TYPE_TESTS[t]?.(object));
			const ok = (!term || name.includes(term)) && typeOk;
			if (ok) {
				count++;
				visible.add(object.uuid);
				for (const ancestor of ancestors) visible.add(ancestor);
			}
			object.children.forEach((child) => walk(child, [...ancestors, object.uuid]));
		};
		group.children.forEach((child) => walk(child, []));
		matchCount = count;
		objectFilter.set(visible);
	}
	$effect(() => {
		searchTerm;
		viewMode;
		searchTypes;
		refreshFilter();
	});
	objectsGroup.subscribe(() => refreshFilter()); // re-filter on scene changes

	// --- 24-B2: keyboard navigation over the VISIBLE rows -----------------------------
	// The handler sits on the list container (role="tree", tabindex 0), so rows stay
	// simple; it stops the keys it consumes, because shortcuts.js listens on WINDOW and
	// Enter / F2 / letters mean other things there (the Explorer lesson). The rename
	// input keeps its own keys — it is a text field, so nothing here runs while it has
	// focus. Type-ahead reads the CHARACTER first (a name is text) and falls back to the
	// physical key (24-A's keyOf), so a Cyrillic layout still reaches "Box".
	let treeEl: HTMLElement | null = $state(null);
	let typeAhead = '';
	let typeAheadPhysical = '';
	let typeAheadAt = 0;
	function currentRowIndex(rows: { uuid: string }[]) {
		// the SET only: `selectedObject` keeps the last object after a deselect (the
		// Inspector binds to it), and walking from a row that is not highlighted reads
		// as the arrows skipping — from nothing, ↓ starts at the top
		const current = $selectedObjects.length ? $selectedObjects[$selectedObjects.length - 1] : null;
		return current ? rows.findIndex((r) => r.uuid === current) : -1;
	}
	function listKeydown(e: KeyboardEvent) {
		if (viewMode) return;
		const target = e.target as HTMLElement | null;
		if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) return;
		const rows = visibleObjectRows($objectsGroup, $expandedObjects, $objectFilter as any);
		if (!rows.length) return;
		const index = currentRowIndex(rows);
		const claim = () => {
			e.preventDefault();
			e.stopPropagation();
		};
		const go = (i: number, additive = false) => {
			const row = rows[Math.max(0, Math.min(rows.length - 1, i))];
			if (row) selectObject(row.uuid, false, additive);
		};
		switch (e.key) {
			case 'ArrowDown':
				claim();
				go(index < 0 ? 0 : index + 1, e.shiftKey);
				return;
			case 'ArrowUp':
				claim();
				go(index < 0 ? rows.length - 1 : index - 1, e.shiftKey);
				return;
			case 'Home':
				claim();
				go(0);
				return;
			case 'End':
				claim();
				go(rows.length - 1);
				return;
			case 'ArrowRight': {
				claim();
				const row = rows[index];
				if (!row || !row.hasKids) return;
				if (!$expandedObjects.has(row.uuid)) expandedObjects.update((set) => withExpanded(set, row.uuid, true));
				else go(index + 1); // already open: step into the first child
				return;
			}
			case 'ArrowLeft': {
				claim();
				const row = rows[index];
				if (!row) return;
				if (row.hasKids && $expandedObjects.has(row.uuid)) expandedObjects.update((set) => withExpanded(set, row.uuid, false));
				else if (row.parent) selectObject(row.parent);
				return;
			}
			case 'Enter':
				if (index < 0) return;
				claim();
				selectObject(rows[index].uuid, true); // Properties, the row's configure path
				return;
			case 'F2':
				if (index < 0) return;
				claim();
				renamingObject.set(rows[index].uuid);
				return;
			case 'Escape': {
				claim();
				// the keys go back to the viewport — whichever tree element holds focus
				const active = document.activeElement as HTMLElement | null;
				if (active && treeEl?.contains(active)) active.blur();
				else treeEl?.blur();
				// 36 F2: the Object list is a scope of its own now, so blurring alone would
				// leave its keys in charge — Escape hands them to the viewport, as it says
				setLastScope('viewport');
				return;
			}
		}
		if (e.ctrlKey || e.metaKey || e.altKey) return;
		const physical = keyOf(e);
		const character = e.key && e.key.length === 1 ? e.key : '';
		if (!character || physical.length !== 1) return;
		claim();
		const now = Date.now();
		if (now - typeAheadAt > 500) {
			typeAhead = '';
			typeAheadPhysical = '';
		}
		typeAheadAt = now;
		typeAhead += character;
		typeAheadPhysical += physical.toLowerCase();
		let hit = typeAheadIndex(rows, typeAhead, index);
		if (hit < 0 && typeAheadPhysical !== typeAhead.toLowerCase()) hit = typeAheadIndex(rows, typeAheadPhysical, index);
		if (hit >= 0) go(hit);
	}
	/** ↓ in the search box hands the keys to the tree (the ObjectSearch convention) */
	function searchKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			searchTerm = '';
			(e.currentTarget as HTMLInputElement).blur();
			return;
		}
		if (e.key === 'ArrowDown' && treeEl) {
			e.preventDefault();
			treeEl.focus();
			const rows = visibleObjectRows($objectsGroup, $expandedObjects, $objectFilter as any);
			if (rows.length && !$selectedObjects.length) selectObject(rows[0].uuid);
		}
	}
	/** clicking anywhere in the list focuses the tree, so the arrows work right after a
	 * row click — never when the click is on a field the browser is about to focus */
	function treePointerDown(e: PointerEvent) {
		const target = e.target as HTMLElement | null;
		if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) return;
		if (!treeEl?.contains(document.activeElement)) treeEl?.focus({ preventScroll: true });
	}
	/** the tree's listeners as an ACTION (the dragMe/focusStack shape) — this component
	 * still uses `on:` directives, and two more of those would grow the svelte-check
	 * warning baseline */
	function treeKeys(node: HTMLElement) {
		node.addEventListener('keydown', listKeydown);
		node.addEventListener('pointerdown', treePointerDown);
		return {
			destroy() {
				node.removeEventListener('keydown', listKeydown);
				node.removeEventListener('pointerdown', treePointerDown);
			}
		};
	}

	// 80.3: which chips show in the bar (⚙ popover), persisted
	let chipPopup = $state(false);
	let hiddenChips: Set<string> = $state(
		new Set(
			typeof localStorage !== 'undefined'
				? JSON.parse(safeStorage.getItem('hiddenListChips') ?? '[]')
				: []
		)
	);
	function toggleChipVisible(value: string) {
		const next = new Set(hiddenChips);
		if (next.has(value)) next.delete(value);
		else {
			next.add(value);
			// hiding an ACTIVE chip also deactivates it
			if (searchTypes.has(value)) toggleTypeChip(value);
			if (viewMode === value) viewMode = '';
		}
		hiddenChips = next;
		safeStorage.setItem('hiddenListChips', JSON.stringify([...next]));
	}
	function resetAllFilters() {
		searchTerm = '';
		searchTypes = new Set();
		lastTypes = new Set();
		viewMode = '';
		hiddenChips = new Set();
		safeStorage.setItem('hiddenListChips', '[]');
		chipPopup = false;
	}

	// 80.2: the chip row scrolls horizontally (wheel + drag), never overflows
	function chipScroll(node: HTMLElement) {
		const onWheel = (e: WheelEvent) => {
			if (!e.deltaY) return;
			node.scrollLeft += e.deltaY;
			e.preventDefault();
		};
		let dragging = false;
		let startX = 0;
		let startScroll = 0;
		const down = (e: PointerEvent) => {
			dragging = true;
			startX = e.clientX;
			startScroll = node.scrollLeft;
		};
		const move = (e: PointerEvent) => {
			if (dragging) node.scrollLeft = startScroll - (e.clientX - startX);
		};
		const up = () => (dragging = false);
		node.addEventListener('wheel', onWheel, { passive: false });
		node.addEventListener('pointerdown', down);
		window.addEventListener('pointermove', move);
		window.addEventListener('pointerup', up);
		return {
			destroy() {
				node.removeEventListener('wheel', onWheel);
				node.removeEventListener('pointerdown', down);
				window.removeEventListener('pointermove', move);
				window.removeEventListener('pointerup', up);
			}
		};
	}

	// Drop-to-share: dragging a LOCAL object anywhere over the shared object-list body
	// shares it to the scene root (a shared object just moves to root). Uses an action
	// so it adds no on:-directive/a11y warnings in this on:-style component.
	/** 37 R1: the set a row drag carries (Objects.svelte), else its single uuid */
	function listDropUuids(e: DragEvent): string[] {
		try {
			const list = JSON.parse(e.dataTransfer?.getData('application/x-object-uuids') || 'null');
			if (Array.isArray(list) && list.length) return list.filter((id: any) => typeof id === 'string');
		} catch {}
		const one = e.dataTransfer?.getData('application/x-object-uuid');
		return one ? [one] : [];
	}
	/** a list-body drop: local objects are shared to the root, the rest move there as ONE undo + batch */
	function dropToRoot(uuids: string[]) {
		const moves: string[] = [];
		for (const uuid of uuids) {
			const obj: any = ($objectsGroup as any)?.getObjectByProperty('uuid', uuid);
			if (obj?.userData?.__localOnly) shareObject(obj);
			else moves.push(uuid);
		}
		moveObjectsToParent(moves, 'root');
	}
	function shareDropZone(node: HTMLElement) {
		const setActive = (on: boolean) => {
			node.style.boxShadow = on ? 'inset 0 0 0 2px var(--accent)' : '';
			node.style.background = on ? 'var(--accent-soft)' : '';
		};
		const over = (e: DragEvent) => {
			if (e.dataTransfer?.types.includes('application/x-object-uuid')) {
				e.preventDefault();
				e.dataTransfer.dropEffect = 'move';
				setActive(true);
			}
		};
		const leave = () => setActive(false);
		const drop = (e: DragEvent) => {
			setActive(false);
			const uuids = listDropUuids(e);
			if (!uuids.length) return;
			e.preventDefault();
			e.stopPropagation();
			dropToRoot(uuids);
		};
		node.addEventListener('dragover', over);
		node.addEventListener('dragleave', leave);
		node.addEventListener('drop', drop);
		return {
			destroy() {
				node.removeEventListener('dragover', over);
				node.removeEventListener('dragleave', leave);
				node.removeEventListener('drop', drop);
			}
		};
	}

	// --- 26-B: LIST VIRTUALISATION (roadmap 26 Stage 0, audit M6) -------------------
	// The tree rendered EVERY visible row, recursively, and re-reconciled all of them on
	// every scene poke. At 3,000 objects that is 3,000 component instances each carrying
	// nine handlers and a Tooltip — the object list alone was several hundred ms of the
	// reported freeze, and it is why deleting one object in a big scene felt worse than
	// the delete itself.
	//
	// Above the threshold the SAME row component renders in `flat` mode over the
	// flattened `visibleObjectRows` — the one array the keyboard walker, Ctrl+A and the
	// type-ahead already read their order from — with two spacer divs standing in for
	// what is off screen. Sharing that array is what keeps the arrows and the window
	// agreeing by construction; deriving a second order would be a copy guaranteed to
	// drift (the Explorer's `gridEntries` ruling, one panel over).
	//
	// Below the threshold NOTHING changes: the recursive tree renders exactly as it did,
	// indent borders and all, so the common case is byte-identical.
	const VIRTUAL_MIN = 500;
	/** rows drawn beyond each edge, so a fast flick does not show blank space */
	const OVERSCAN = 12;
	let rowH = $state(24);
	let scrollTop = $state(0);
	let viewportH = $state(0);
	let treeScroller: HTMLElement | null = null;
	const treeRows = $derived(viewMode ? [] : visibleObjectRows($objectsGroup, $expandedObjects, $objectFilter as any));
	const virtualising = $derived(treeRows.length > VIRTUAL_MIN);
	const windowStart = $derived(virtualising ? Math.max(0, Math.floor(scrollTop / rowH) - OVERSCAN) : 0);
	const windowEnd = $derived(
		virtualising
			? Math.min(treeRows.length, Math.ceil((scrollTop + (viewportH || 400)) / rowH) + OVERSCAN)
			: 0
	);
	const windowRows = $derived(virtualising ? treeRows.slice(windowStart, windowEnd) : []);

	// 33 L1: the plain tree MOUNTS IN CHUNKS when it jumps. Under the virtualisation threshold
	// every row is a component instance, and a scene load (Castle Courtyard: 182 pieces) handed
	// the list all of them in one poke — measured as the longest task left in a load on a CPU x6
	// phone (434-565 ms of row mounting). Rows beyond `rowsMounted` arrive a few frames later;
	// a list that shrinks (a clear) starts the next load over from the first chunk.
	const ROWS_FIRST = 40;
	const ROWS_PER_FRAME = 16;
	let rowsMounted = $state(ROWS_FIRST);
	const plainRows = $derived(
		$objectsGroup ? $objectsGroup.children.filter((c: any) => !c.userData?.__localOnly) : []
	);
	let growFrame = 0;
	$effect(() => {
		const total = plainRows.length;
		if (total <= rowsMounted) {
			if (rowsMounted > Math.max(ROWS_FIRST, total)) rowsMounted = Math.max(ROWS_FIRST, total);
			return;
		}
		if (growFrame) return;
		const grow = () => {
			growFrame = 0;
			rowsMounted = Math.min(plainRows.length, rowsMounted + ROWS_PER_FRAME);
			if (rowsMounted < plainRows.length) growFrame = requestAnimationFrame(grow);
		};
		growFrame = requestAnimationFrame(grow);
	});

	/** Find the real scrolling ancestor by SCROLLABILITY, never by class name — the
	 * scroller is the `.obj-scroller` (was flowbite's `Listgroup`, whose element we did not own; the deep-link
	 * ruling in Section.svelte, same reason). */
	function trackTreeScroll(node: HTMLElement) {
		let ro: any = null;
		const read = () => {
			if (!treeScroller) return;
			scrollTop = treeScroller.scrollTop;
			viewportH = treeScroller.clientHeight;
			// measure ONE real row rather than trusting a constant: the spacers are in
			// pixels, so a wrong height makes the window drift away from the scrollbar
			const first = node.querySelector('[role="treeitem"] > div') as HTMLElement | null;
			const h = first?.offsetHeight ?? 0;
			if (h > 8 && Math.abs(h - rowH) > 0.5) rowH = h;
		};
		let el: HTMLElement | null = node.parentElement;
		while (el) {
			const style = getComputedStyle(el);
			if (/(auto|scroll)/.test(style.overflowY)) break;
			el = el.parentElement;
		}
		treeScroller = el;
		if (treeScroller) {
			treeScroller.addEventListener('scroll', read, { passive: true });
			ro = new ResizeObserver(read);
			ro.observe(treeScroller);
			ro.observe(node);
		}
		read();
		return {
			destroy() {
				treeScroller?.removeEventListener('scroll', read);
				ro?.disconnect();
				treeScroller = null;
			}
		};
	}

	// keyboard follow: in the window a selected row that is off screen has no element to
	// scroll itself into view, so the WINDOW moves instead (the arrows would otherwise
	// walk silently into nothing).
	let lastFollowed = '';
	$effect(() => {
		const uuid = $selectedObjects.length ? $selectedObjects[$selectedObjects.length - 1] : '';
		if (!virtualising || !uuid || uuid === lastFollowed) { lastFollowed = uuid; return; }
		lastFollowed = uuid;
		const index = treeRows.findIndex((r) => r.uuid === uuid);
		if (index < 0 || !treeScroller) return;
		const top = index * rowH;
		const view = treeScroller.clientHeight;
		if (top < treeScroller.scrollTop) treeScroller.scrollTop = top;
		else if (top + rowH > treeScroller.scrollTop + view) treeScroller.scrollTop = top + rowH - view;
	});

	// 26-A: the meter's dot and its tooltip. The reading is the sampler's; this only
	// picks the worst tier and spells out what is over budget, so the tooltip answers
	// "over budget on WHAT" without opening anything.
	const budgetProfileNow = $derived($sceneMetrics.profile === 'vr' ? 'vr' : 'desktop');
	const budgetTier = $derived(worstTier($sceneMetrics, budgetProfileNow));
	/** A DIRECT listener, not `on:click`/`onclick`: this file is written in the `on:`
	 * style throughout, so an attribute handler here is a hard "mixing syntaxes" error,
	 * and the `on:` form is deprecated in runes mode — the action is the way out of both,
	 * and it is what the panel-chrome rule asks for anyway (a delegated handler inside a
	 * panel can be swallowed on its way up). */
	function openStats(node: HTMLElement) {
		const open = () => statsOpen.set(true);
		node.addEventListener('click', open);
		return { destroy() { node.removeEventListener('click', open); } };
	}
	const budgetTitle = $derived.by(() => {
		const over = budgetRows($sceneMetrics, budgetProfileNow).filter((r) => r.tier === 'amber' || r.tier === 'red');
		if (!over.length) return 'Scene budget — within the ' + (budgetProfileNow === 'vr' ? 'VR / mobile' : 'desktop') + ' budget. Click for statistics.';
		return 'Scene budget: over on ' + over.map((r) => r.label.toLowerCase()).join(', ') + '. Click for statistics.';
	});

	// 26-D: THE QUALITY CHIP. The governor acts on its own, so it has to be SEEN acting and
	// be answerable in one click — an automatic change a person cannot see or undo is just a
	// different kind of broken (26-G's rule). Two states, one button: reducing on its own
	// (click keeps it), or held (click gives full quality back). A direct listener for the
	// same reason as openStats.
	const qualityTitle = $derived.by(() => {
		const q = $qualityState;
		const what = q.labels.join(', ').toLowerCase();
		return q.pinned
			? 'Held at reduced quality (' + what + '). Click to restore full quality.'
			: q.held
				? 'This scene is heavy for this device, so drawing was reduced: ' + what + '. It stays this way for this scene (it came back once and the frames dropped again). Click to keep it this way.'
				: 'This scene is heavy for this device, so drawing was reduced: ' + what + '. It comes back on its own when frames recover. Click to keep it this way.';
	});
	function qualityChipClick(node: HTMLElement) {
		const click = () => (get(qualityState).pinned ? releaseQuality() : pinQuality());
		node.addEventListener('click', click);
		return { destroy() { node.removeEventListener('click', click); } };
	}
	// 40 F12: the once-per-session "Lowered … to keep it smooth · Keep full quality" toast is
	// AutoQualityNotice (App root) — it used to live here and was gone whenever this window was closed.

	// bottom status line: totals across the whole tree (N objects · M hidden)
	let objectCount = $state(0);
	let hiddenCount = $state(0);
	objectsGroup.subscribe((group) => {
		let total = 0;
		let hidden = 0;
		const walk = (o: any) => {
			total++;
			if (o.visible === false) hidden++;
			o.children.forEach(walk);
		};
		group?.children.forEach(walk);
		objectCount = total;
		hiddenCount = hidden;
	});

	// --- advanced mode: System filter shows scene-root module/env objects ---
	let systemRows = $state([]);
	let systemNoticeDismissed = $state(
		typeof localStorage !== 'undefined' && safeStorage.getItem('systemNoticeDismissed') === 'true'
	);
	let expandedSystem = $state({});
	function refreshSystemRows() {
		const scene = $globalScene;
		if (!scene) {
			systemRows = [];
			return;
		}
		systemRows = systemGroupNames
			.map((name) => scene.getObjectByName(name))
			.filter(Boolean)
			.map((object) => ({
				name: object.name,
				type: object.type,
				children: object.children.map((child) => child.name || child.type),
				object
			}));
	}
	// module content spawns outside the store flow — poll while the view is active
	$effect(() => {
		if (viewMode !== 'system') return;
		refreshSystemRows();
		const timer = setInterval(refreshSystemRows, 1000);
		return () => clearInterval(timer);
	});
	function focusSystemObject(object) {
		const box = new THREE.Box3().setFromObject(object);
		if (!isFinite(box.min.x)) return;
		const center = box.getCenter(new THREE.Vector3());
		const size = Math.max(box.getSize(new THREE.Vector3()).length(), 2);
		flyTo([center.x + size * 0.6, center.y + size * 0.45, center.z + size * 0.6], center.toArray());
	}

	// system/env rows can ping too (87.5)
	function pingObject(object: any) {
		const box = new THREE.Box3().setFromObject(object);
		if (!isFinite(box.min.x)) {
			sendPing(object.getWorldPosition(new THREE.Vector3()));
			return;
		}
		const top = box.getCenter(new THREE.Vector3());
		top.y = box.max.y;
		sendPing(top);
	}

	// --- environment filter (70.4): read-only rows for environment-root ---
	let envRows = $state([]);
	let envNoticeDismissed = $state(
		typeof localStorage !== 'undefined' && safeStorage.getItem('envNoticeDismissed') === 'true'
	);
	function refreshEnvRows() {
		const scene = $globalScene;
		const root = scene?.getObjectByName(ENV_ROOT);
		envRows = (root?.children ?? []).map((object: any) => ({
			name: object.name,
			type: object.type,
			visible: object.visible,
			object
		}));
	}
	$effect(() => {
		if (viewMode !== 'environment') return;
		refreshEnvRows();
		const timer = setInterval(refreshEnvRows, 1000);
		return () => clearInterval(timer);
	});

	// 18-B: object-list window size limits, shared with the clamp helpers
	const OBJ_WIN_MIN = { minW: 250, minH: 200 };
	const OBJ_WIN_DEFAULT = { w: 300, h: 250 };

	/**
	 * R22 ROUND 25 (user): "same for object list window, probably smallest size just should
	 * show lucide icon and hide 'Objects' text".
	 *
	 * The same ranking the preview and the Explorer headers now have, and the same reason
	 * for measuring rather than asking the viewport: this window is resized by its own grip
	 * and can be narrow on a wide screen. When the row overflows, what falls off the end is
	 * whatever is LAST in the markup — here the close button — so the expendable pieces have
	 * to leave first. The search box is the biggest and least urgent; the word "Objects" is
	 * next, and the icon stays because a window still needs to say what it is at a glance.
	 */
	// ZERO IS NOT A WIDTH — see FilePreviewWindow's note. This window is tabbable, so it is
	// one of the ones that gets hidden behind a tab.
	let objHeaderW = $state(1000);
	function objHeaderWidth(node: HTMLElement) {
		const read = () => {
			const w = node.clientWidth;
			if (w > 0) objHeaderW = w;
		};
		const ro = new ResizeObserver(read);
		ro.observe(node);
		read();
		return { destroy: () => ro.disconnect() };
	}
	// fix-batch-1 #23: the thresholds are 100 % widths — at 150 % the search and the label are 1.5x as
	// wide, and an unscaled 260 kept the search on the folded N6 (a ~390 px header) and wrapped the ✕
	const objHideSearch = $derived(objHeaderW < (260 * $uiScale) / 100);
	const objHideLabel = $derived(objHeaderW < (190 * $uiScale) / 100);
	// 38 R6: what the header element carries now that WindowChrome draws it — the width
	// probe above (as an attachment) and the drop-to-root target
	const objHeaderAttrs = {
		[createAttachmentKey()]: fromAction(objHeaderWidth),
		// 53-reader: a GROUP (it is a drop target, so it needs a role) — `list` demanded listitem
		// children the header's search box and buttons can never be (axe aria-required-children)
		role: 'group',
		'aria-label': 'Object list tools',
		ondragover: (e: DragEvent) => {
			if (e.dataTransfer?.types.includes('application/x-object-uuid')) {
				e.preventDefault();
				e.dataTransfer.dropEffect = 'move';
			}
		},
		ondrop: (e: DragEvent) => {
			const uuids = listDropUuids(e);
			if (!uuids.length) return;
			e.preventDefault();
			dropToRoot(uuids);
		}
	};

	function dragMe(node) {
		startWindowDragGuard(); // 36 F3: no browser menu from a right press mid-drag
		// 80.1: proper resize (start-size captured, clamped) + persisted rect
		let saved: any = null;
		try {
			saved = JSON.parse(safeStorage.getItem('objectListRect') ?? 'null');
		} catch {}
		let moving = false;
		let left = saved?.left ?? 350;
		let top = saved?.top ?? 100;
		let width = saved?.width ?? scaledPx(300); // 53 A1: the default size follows the UI scale
		let height = saved?.height ?? scaledPx(250);

		let startX = 0;
		let startY = 0;
		// 44 M1: where in the window the pointer grabbed it — the window is placed at pointer - grab,
		// so it stays under the pointer (a body drag hands over past its slop; summed movement deltas
		// left the window those px behind for the rest of the gesture)
		let grabX = 0;
		let grabY = 0;
		let startWidth = 0;
		let startHeight = 0;

		// when tab-grouped, windowTabs owns the geometry (all members share one rect) —
		// dragMe must NOT set its own size/pos or it desyncs from the strip
		const grouped = () => !!groupRectOf('objects');

		// keep the window (and its subgroups) within the viewport — a rect persisted on
		// a wide screen used to reopen partly off a narrow screen with no way to scroll to
		// the clipped tree rows (same bug the Flow window had)
		const clampRect = () => {
			if (grouped()) return; // the group rect drives size/pos while grouped
			// 81.4: ...and neither does this window while it is side-DOCKED — docking.js
			// owns the rect then, and the reveal below (reopening after a reload) would
			// otherwise re-assert the floating one over its column
			if (node.dataset.docked) return;
			// 18-B: the viewport cap wins over the minimum, so this can never leave
			// the window wider than the screen
			({ w: width, h: height } = clampWinSize(width, height, OBJ_WIN_MIN));
			left = Math.max(0, Math.min(left, window.innerWidth - width));
			top = Math.max(0, Math.min(top, window.innerHeight - height));
			node.style.width = `${width}px`;
			node.style.height = `${height}px`;
			node.style.left = `${left}px`;
			node.style.top = `${top}px`;
		};

		// FIXED, like every other floating window (dragWindow/docking) — this was the
		// last `absolute` holdout. An absolutely-positioned element shoved past the
		// right/bottom edge joins the document's scroll overflow and GROWS the page,
		// which drags the fixed chrome (Connect bar, profile, corner HUD) sideways with
		// it; fixed elements never contribute to that overflow. The clamp math below was
		// already in viewport coordinates, so nothing else changes.
		node.style.position = 'fixed';
		node.style.userSelect = 'none';
		bodyDrag(node); // 44 M1: a press-and-drag anywhere that is not a control moves it too
		clampRect();
		window.addEventListener('resize', clampRect);
		// reveal: when the window is shown again after being shoved partly off-screen,
		// snap it fully back on so it's never lost
		let objWasVis = false;
		if (typeof IntersectionObserver !== 'undefined') {
			new IntersectionObserver((entries) => {
				const vis = entries.some((e) => e.isIntersecting);
				if (vis && !objWasVis) clampRect();
				objWasVis = vis;
			}).observe(node);
		}

		const persist = () =>
			safeStorage.setItem(
				'objectListRect',
				JSON.stringify({ left, top, width: node.offsetWidth, height: node.offsetHeight })
			);

		// pointer (not mouse) events so touch can move/resize the window on mobile
		node.addEventListener('pointerdown', (e) => {
			if (e.target.classList.contains('resize-handle')) {
				resizing = true;
				startX = e.clientX;
				startY = e.clientY;
				startWidth = node.offsetWidth;
				startHeight = node.offsetHeight;
			}
			// 153: start the drag when the click lands anywhere in the move-handle
			// header (incl. the "☰ Objects" title text), but NOT on its interactive
			// children (search input, close button) so those still focus/click
			// 36 F4: the shared header rule (windowGrip.isHeaderDrag), which also spares tabs
			const t = /** @type {any} */ (e.target);
			if (e.button === 0 && isHeaderDrag(t)) {
				moving = true;
				// 42 I6: start from where the window IS — a tab tear-off or the dock (dockHost) may
				// have placed it since the last drag
				if (!grouped() && !node.dataset.docked) ({ left, top } = { left: node.offsetLeft, top: node.offsetTop });
				grabX = e.clientX - left;
				grabY = e.clientY - top;
			}
		});

		window.addEventListener('pointermove', (e) => {
			if (moving) {
				if (grouped()) {
					// move the whole tab group so its strip follows (not just this window)
					moveGroupOf('objects', e.movementX, e.movementY);
				} else {
					left = e.clientX - grabX;
					top = e.clientY - grabY;
					// allow the window to be shoved PARTLY off-screen (a grabbable strip
					// always stays; the header row stays at/below the top so it's never
					// lost — reopening snaps it fully back on, see the reveal observer)
					const KEEP = 52;
					const w = node.offsetWidth;
					if (left < KEEP - w) left = KEEP - w;
					if (left > window.innerWidth - KEEP) left = window.innerWidth - KEEP;
					// keep the window from sliding BEHIND the Connect bar/pill (only when
					// they actually overlap horizontally)
					let minTop = 0;
					const cp = document.querySelector('.connect-pill');
					if (cp) {
						const r = cp.getBoundingClientRect();
						if (left < r.right && left + w > r.left) minTop = Math.round(r.bottom) + 4;
					}
					if (top < minTop) top = minTop;
					if (top > window.innerHeight - KEEP) top = window.innerHeight - KEEP;
					node.style.top = `${top}px`;
					node.style.left = `${left}px`;
				}
			}
			if (resizing) {
				// 18-B: the corner stops at the viewport edge, so the handle stays
				// reachable — an oversized window used to have no grabbable grip left
				const at = anchorOf(node);
				const fit = clampResize(
					startWidth + (e.clientX - startX),
					startHeight + (e.clientY - startY),
					at.left,
					at.top,
					OBJ_WIN_MIN
				);
				width = fit.w;
				height = fit.h;
				if (grouped()) {
					resizeGroup('objects', width, height); // resize the whole group (all tabs)
				} else {
					node.style.width = `${width}px`;
					node.style.height = `${height}px`;
				}
			}
		});

		window.addEventListener('pointerup', () => {
			if ((moving || resizing) && !grouped()) persist();
			moving = false;
			resizing = false;
		});

		// 18-B: double-click the grip — back to the default size, position kept.
		// A direct listener, like every other gesture in this action: the panel
		// chrome swallows delegated events.
		const resetSize = () => {
			if (grouped()) return;
			({ w: width, h: height } = clampWinSize(OBJ_WIN_DEFAULT.w, OBJ_WIN_DEFAULT.h, OBJ_WIN_MIN));
			node.style.width = `${width}px`;
			node.style.height = `${height}px`;
			persist();
		};
		node.addEventListener('dblclick', (e: any) => {
			if (!e.target?.classList?.contains('resize-handle')) return;
			resetSize();
		});
		registerSizeReset(node, resetSize); // 44 M3: the header menu's "Reset size"

		// 169: Settings "Reset window positions" recentres the object list too
		registerWindowReset(() => {
			left = 350;
			top = 100;
			node.style.left = `${left}px`;
			node.style.top = `${top}px`;
		});

		// 37 R14: a named workspace layout rewrote (or removed) `objectListRect`
		onLayoutRestore(() => {
			let stored: any = null;
			try {
				stored = JSON.parse(safeStorage.getItem('objectListRect') ?? 'null');
			} catch {}
			left = stored?.left ?? 350;
			top = stored?.top ?? 100;
			width = stored?.width ?? scaledPx(300);
			height = stored?.height ?? scaledPx(250);
			clampRect();
		});
	}

	// Right-click menu for objects (Objects.svelte rows + the viewport) — the item
	// set is shared with ViewportMenu's "Selected" submenu so both stay in parity.
	function objectMenuItems(menu) {
		return buildObjectMenuItems(menu.uuid, { point: menu.point ?? null, locked: menu.locked });
	}

	// 4a: the play FAB's RIGHT-CLICK menu — pick the mode and enter it in one gesture.
	// VR / AR / desktop used to be reachable only through two buried Settings toggles
	// ("VR override" and "Passthrough"), so the choice lived nowhere near the control
	// it governs. Each entry writes the preference and then enters, which is why the
	// dual hidden XR mount below matters: the aimed button is already in the DOM, so
	// `requestPlay` still calls `requestSession` inside this same user gesture.
	//
	// iOS Safari never fires `contextmenu` on a long press (Android does), so this is
	// an accelerator, not the only door — the Settings toggles stay exactly where they
	// were and a touch user is never stranded.
	let playMenu: { x: number; y: number } | null = $state(null);

	// A DIRECT listener, not an `on:contextmenu` directive: svelte DELEGATES event
	// attributes to the app root, so anything on the way up that swallows the event —
	// and this FAB sits inside the Controls chrome — silently eats the gesture (the
	// repo's standing rule for pointer gestures inside panels). It also keeps the
	// component off the mixed old/new event syntax, which svelte 5 refuses per file.
	function playModeMenu(node: HTMLElement) {
		const open = (e: MouseEvent) => {
			e.preventDefault();
			e.stopPropagation();
			toolbarMenu = null;
			customizeMenu = null;
			lastMenuAt = { x: e.clientX, y: e.clientY };
			playMenu = { x: e.clientX, y: e.clientY };
		};
		node.addEventListener('contextmenu', open);
		return { destroy: () => node.removeEventListener('contextmenu', open) };
	}

	function playModeItems() {
		return [
			// 41b H7: the "Play as" rows live in $lib/playMode (`playAsItems`) — the phone bar's Play
			// opens the same ones, so the two buttons write the same choice the same way
			...playAsItems(),
			// 30 P2: TEST PLAY — back to the menu, into Play, the Start screen. Offered only
			// where it means something: a scene with no game shell has no menu to start from.
			...($hudIsGame
				? [
						{ section: 'Game' },
						{
							label: 'Test play (start from the menu)',
							tooltip: 'Reset the game to its menu, enter Play, and start from the Start screen',
							action: () => testPlay()
						}
					]
				: []),
			// the FAB is a toolbar cell like any other, so it carries the same tail —
			// minus "Hide button" (there is no toolbar without a way to press play)
			...toolbarTail(null)
		];
	}

	// ── 4b: THE TOOLBAR IS A ROSTER ─────────────────────────────────────────────
	// The pill used to be seven hand-written flowbite `BottomNav` cells, so its
	// CONTENTS were markup: nothing could be reordered, hidden or collapsed without
	// editing this file. It is a plain <nav> over a DATA roster now — one `{#each}`
	// template, one registry, one persisted layout record.
	//
	// WHY NOT BottomNav: its inner grid column count has to be a JIT-literal
	// (`classes={{ inner: 'grid-cols-7' }}`), which a variable cell count cannot be,
	// and restProps land on the OUTER div only. The class strings on the <nav> below
	// are flowbite's OWN resolved output for `position="absolute" navType="application"`
	// plus this component's overrides — read off the rendered DOM and baked in as
	// literals — so the bar keeps the same border, surface, radius and geometry.
	//
	// Everything here is LOCAL. A toolbar layout is a fact about THIS screen, so it
	// never replicates, never enters a save and never lands in undo (`explorerView`'s
	// rule for a view mode, one domain over).
	/** W8a adds `posX`: WHERE ALONG THE BOTTOM EDGE the bar sits, as a FRACTION of the
	 *  usable track (0 = hard left, 1 = hard right), `null` = the canonical centre.
	 *  A fraction and not a pixel offset, because a bar parked 500px right of centre on
	 *  a 2560px monitor is off the screen on the laptop the same profile opens next.
	 *  It rides IN the layout record rather than in a key of its own, which is what
	 *  makes `resetLayout()` and Settings' "Reset window positions" (whose wipe already
	 *  names `controlsLayout`) cover the position with no second thing to remember. */
	// 41: the record is `$lib/toolbarLayout`'s `ToolbarLayout` (+ `left`/`right` corner stacks and
	// `seen`, the ids it has placed — see that file)
	type ControlsLayout = ToolbarLayout;
	/** 43 J2: the bar's trailing "…" (Customize toolbar) as an edit/menu id — not a cell of the row */
	const MORE = '__more';
	/** 43 J8: the bar's own box (a gap between cells, the padding, a corner stack's gap) as a menu id */
	const BAR = '__bar';
	/** the name menus print for the "…" */
	const MORE_LABEL = '… (Customize toolbar)';
	/** 43 K3: the Connect pill (top centre) as an edit/menu id — shown or hidden, never moved */
	const CONNECT = '__connect';
	const CONNECT_LABEL = 'Connect bar';
	/** 48 F1: the budget chip as a Customize row id */
	const BUDGET = '__budget';
	// 30 P1: `pressed` makes the cell a TOGGLE — it renders as a real <button> carrying
	// aria-pressed (a <p> cannot: the attribute is not supported on its role)
	const PIVOT_NAMES: Record<string, string> = { median: 'Median point', active: 'Active object', individual: 'Individual origins', parent: 'Parent origin' };
	// 38 rule: a NEW glyph goes through ui/Icon.svelte (names, sizes 16/20)
	const PIVOT_ICONS: Record<string, string> = { median: 'crosshair', active: 'locate-fixed', individual: 'boxes', parent: 'network' };
	/** the next pivot mode; Parent origin only when the set shares a parent */
	function cyclePivotMode() {
		const order = ['median', 'active', 'individual', ...(pivotParentAvailable() ? ['parent'] : [])];
		const next = order[(order.indexOf($pivotMode) + 1) % order.length] as any;
		pivotMode.set(next);
		showQualityToast('Pivot: ' + PIVOT_NAMES[next]);
	}
	// 42 I7: `label` is the SHORT name the menus print (Customize toolbar…, Edit positions, the "+"
	// popup, Swap with) — `title` stays the cell's tooltip, which may carry state and a hint
	// ("Pivot: Median point (click to change)") and which suites select the bar's cells by
	type CellButton = { title: string; label?: string; slot?: string; icon?: any; iconName?: string; tint: () => string; run: () => void; pressed?: () => boolean };

	/** the one PSEUDO-cell: the transparent well the play FAB sits in. It is not a
	 *  roster entry (play is never hideable) but it IS a cell of the row, which is
	 *  what makes "move one place left" mean the same thing for it and for a button.
	 *
	 *  W1 removed its sibling, a chevron cell that used to appear while collapsed:
	 *  a collapsed bar is the well and nothing else, and the way back out lives in
	 *  the FAB's own right-click menu (plus Settings' Reset window positions, which
	 *  is the hatch for iOS Safari, where a long press fires no `contextmenu`). */
	// 33 E1: THE USER'S ORDER — the transforms, then Interact, then Play (the well), then
	// the views they open most: object list, node editor, Explorer, Animation. Interact
	// sits beside Play because the two answer one question ("how am I touching the scene
	// right now"), and Animation joined the default bar (it was an opt-in view before).
	// 37 R1: the PIVOT POINT sits with the transforms it changes (Blender's header place)
	const DEFAULT_ORDER = ['move', 'rotate', 'scale', 'pivot', 'mode', 'objects', 'flow', 'explorer', 'animation'];
	const DEFAULT_SPACER = 5;
	/** 33 E1: the bars a profile could hold WITHOUT ever customizing — the default rows the
	 *  app has shipped, read as the VISUAL row (the well as `__spacer`). A stored record
	 *  that still IS one of these is a default nobody chose, so it migrates to the new
	 *  default (keeping where the bar sits and whether it is collapsed); anything else is
	 *  a custom bar and wins as saved. Pre-30 had no 'mode'; 30-31 appended it last. */
	const LEGACY_DEFAULT_ROWS = [
		'move,rotate,scale,__spacer,objects,flow,explorer',
		'move,rotate,scale,__spacer,objects,flow,explorer,mode',
		// 37 R1: the 33 E1 default, before the Pivot cell joined it
		'move,rotate,scale,mode,__spacer,objects,flow,explorer,animation'
	];
	/** 33 E1: ids that became DEFAULT after having been opt-in. A custom record that does
	 *  not list one LEFT it off on purpose (it was unticked), so it is not appended there —
	 *  the append rule is for buttons new to the app, and these are not. */
	const PROMOTED_DEFAULTS = ['animation'];

	/** W8b: the roster is bigger than the bar. `DEFAULT_ORDER` is what a fresh profile
	 *  puts ON the bar and has NOT changed — the same six ids, the same order, the same
	 *  well index — while `BUTTONS` now also holds the five remaining dock views as
	 *  OPTIONAL entries: listed in Customize unchecked, absent from the bar until asked
	 *  for. An id is on the bar iff it is in `order` and not in `hidden`, so an optional
	 *  button is simply one that starts in neither, and a profile that never opens
	 *  Customize is byte-identical to before this existed.
	 *
	 *  They come from `DOCK_VIEWS`, the same list the dock's "+" menu renders, minus the
	 *  Explorer (already a default button) — so the roster and the "+" cannot disagree
	 *  about which views exist. Titles come from `DOCK_TITLES`, the dock's own names, so
	 *  a button and its tab read the same word. */
	const VIEW_BUTTONS = DOCK_VIEWS.filter((view) => view.key !== 'explorer').map((view) => view.key);
	// 33 E1: a view on the DEFAULT bar (Animation) is not also an optional one, or the
	// Customize and Swap-with lists would carry it twice
	const OPTIONAL_VIEWS = VIEW_BUTTONS.filter((key) => !DEFAULT_ORDER.includes(key));

	/** the glyph for each optional view. Chosen from a rendered 18px sheet against the
	 *  six already on the bar, not from the names — which is what caught the one real
	 *  collision: `layout-dashboard` (the obvious HUD glyph) and `grid-2x2` (the obvious
	 *  UV one) are both a square quartered into four boxes and are indistinguishable at
	 *  this size, so the HUD takes a `monitor` — a screen, which is literally what a HUD
	 *  is drawn on. `code` beats `file-code` because a page silhouette sits next to the
	 *  Explorer's folder and its inner chevrons are illegible at 18px, while `</>` is
	 *  unmistakable; `clapperboard` beats `film`, whose plain rectangle muddles against
	 *  every other boxy glyph; `palette` says materials where `sparkles` says nothing. */
	const VIEW_ICONS: Record<string, any> = {
		flowcode: 'code',
		animation: 'clapperboard',
		uv: 'grid-2x2',
		shader: 'palette',
		hud: 'monitor',
		timeline: 'video',
		// 34 PF: a pulse trace reads as "performance" beside the five editor glyphs
		profiler: 'activity',
		// 36-code: `{}` — the code workspace, distinct from Flow Code's `</>`
		code: 'braces'
	};

	// The six roster buttons. Every title and every handler is VERBATIM what the
	// hand-written cells carried: controls-state, controls-transform-tint, dock-inset,
	// flow-explorer-dock, panel-toggle-keys and ~25 Explorer suites all select on
	// `p[title="…"]` / `#explorer-slot`, so these strings are load-bearing.
	// `tint` is a FUNCTION, not a stored string: it is called from the template, so
	// reading `$transformMode` / the `$derived` flags inside it registers the
	// dependency in the render effect exactly as the inline expressions used to.
	const BUTTONS: Record<string, CellButton> = {
		mode: {
			title: 'Interact mode (I)',
			slot: 'editor-mode-toggle',
			icon: 'tool:interact',
			tint: () => ($editorMode === 'interact' ? ICON_ON : ICON_OFF),
			pressed: () => $editorMode === 'interact',
			run: () => toggleEditorMode()
		},
		// 37 R1: Median / Active / Individual (/ Parent) — a click steps to the next mode; the
		// glyph and title say which is on. Shared with the Inspector's Pivot row and the object
		// menu (one `pivotMode` store), so all three always agree.
		pivot: {
			get title() {
				return 'Pivot: ' + PIVOT_NAMES[$pivotMode] + ' (click to change)';
			},
			label: 'Pivot',
			get iconName() {
				return PIVOT_ICONS[$pivotMode] ?? 'crosshair';
			},
			tint: () => (multiSel ? ICON_ON : ICON_OFF),
			run: () => cyclePivotMode()
		},
		move: {
			title: 'Move (1)',
			icon: 'move',
			tint: () => (hasSel && $transformMode === 'translate' ? ICON_ON : ICON_OFF),
			run: () => setTransformMode('translate')
		},
		rotate: {
			title: 'Rotate (2)',
			icon: 'rotate-ccw',
			tint: () => (hasSel && $transformMode === 'rotate' ? ICON_ON : ICON_OFF),
			run: () => setTransformMode('rotate')
		},
		scale: {
			title: 'Scale (3)',
			icon: 'maximize-2',
			tint: () => (hasSel && $transformMode === 'scale' ? ICON_ON : ICON_OFF),
			run: () => setTransformMode('scale')
		},
		objects: {
			title: 'Object list (O)',
			icon: 'list',
			tint: () => (!$objectListClose ? ICON_ON : ICON_OFF),
			run: () => togglePanel('objects')
		},
		flow: {
			title: 'Node editor (N)',
			icon: 'workflow',
			tint: () => (flowShown ? ICON_ON : ICON_OFF),
			run: () => togglePanel('flow')
		},
		explorer: {
			title: 'Explorer',
			slot: 'explorer-slot',
			icon: 'folder-open',
			tint: () => (panelShown.explorer ? ICON_ON : ICON_OFF),
			run: () => togglePanel('explorer')
		},
		// W8b: the five remaining dock views, built from ONE list rather than written
		// out. Each is the ordinary panel decision tree — `togglePanel` opens it in the
		// mode it was last in, activates it when another tab covers it, and hides it
		// when it is the one on screen — which is the whole reason these are worth
		// having as buttons: the "+" list can only ever open them.
		...Object.fromEntries(
			VIEW_BUTTONS.map((key) => [
				key,
				{
					title: DOCK_TITLES[key] ?? key,
					icon: VIEW_ICONS[key],
					tint: () => (panelShown[key] ? ICON_ON : ICON_OFF),
					run: () => togglePanel(key)
				} as CellButton
			])
		),
		// 41 G1: THE ROUND CORNER BUTTONS JOIN THE ROSTER. They were four hand-placed components
		// (the "+", the AI assistant, chat, the mic), so nothing could move or remove them; now
		// each is a roster entry like any bar button, placed by the layout record in a corner
		// stack or on the bar. The DOM ids, titles and handlers are the ones they always had
		// (suites and the tours select on #mobile-add-button / #ai-hud-button / #chat-button /
		// #mic-button), and the id travels with the button wherever it is placed.
		add: {
			title: 'Add / context menu',
			slot: 'mobile-add-button',
			icon: 'plus',
			tint: () => ICON_OFF,
			run: () => openAddMenu()
		},
		ai: {
			title: 'AI assistant',
			slot: 'ai-hud-button',
			icon: 'sparkles',
			tint: () => ($aiAssistantHidden === '' ? ICON_ON : ICON_OFF),
			run: () => toggleAiAssistant()
		},
		chat: {
			get title() {
				return $chatUnread > 0
					? `Chat (C) — ${$chatUnread} unread${$chatMentioned ? ', you were mentioned' : ''}`
					: 'Chat (C)';
			},
			label: 'Chat (C)',
			slot: 'chat-button',
			icon: 'message-square',
			tint: () => ($chatHidden !== 'hidden' ? ICON_ON : ICON_OFF),
			run: () => chatHidden.set($chatHidden === 'hidden' ? '' : 'hidden')
		},
		mic: {
			get title() {
				return $micActive ? 'Microphone on — click to mute' : 'Microphone off — click to talk, or hold V for push-to-talk';
			},
			label: 'Microphone',
			slot: 'mic-button',
			get iconName() {
				return $micActive || $pttActive ? 'mic' : 'mic-off';
			},
			tint: () => ($micActive || $pttActive ? ICON_ON : ICON_OFF),
			run: () => toggleMic()
		},
		// 42 I9: THE TOP-RIGHT GROUP AND THE TOUCH TOOLS JOIN THE ROSTER. Users.svelte and
		// TouchTools.svelte still draw these six where they are at home (the notifications panel
		// and the peers popover hang off their buttons); these entries are what every MENU and
		// the edit placeholders read, and what Controls draws when one is placed somewhere else
		// (Scene notes on the bar, Undo in a corner…). The bell and the peers trigger are
		// HOME-ONLY (`HOME_ONLY` below), so they are never drawn from here — only edited.
		notes: {
			title: 'Scene notes',
			slot: 'notes-toggle',
			icon: 'sticky-note',
			tint: () => ($notesDrawerOpen ? ICON_ON : ICON_OFF),
			run: () => notesDrawerOpen.update((v) => !v)
		},
		notifications: {
			title: 'Notifications',
			icon: 'bell',
			tint: () => ICON_OFF,
			run: () => {}
		},
		peers: {
			title: 'Connected peers — shown while someone is connected',
			label: 'Connected peers',
			icon: 'users',
			tint: () => ICON_OFF,
			run: () => {}
		},
		undo: {
			title: 'Undo',
			slot: 'touch-undo',
			icon: 'undo-2',
			tint: () => ICON_OFF,
			run: () => undo()
		},
		redo: {
			title: 'Redo',
			slot: 'touch-redo',
			icon: 'redo-2',
			tint: () => ICON_OFF,
			run: () => redo()
		},
		multiselect: {
			get title() {
				return $multiSelectMode
					? 'Multi-select on — a tap adds to the selection, a drag on empty space boxes'
					: 'Multi-select — tap to add objects, drag empty space to box-select';
			},
			label: 'Multi-select',
			slot: 'touch-multiselect',
			icon: 'box-select',
			tint: () => ($multiSelectMode ? ICON_ON : ICON_OFF),
			pressed: () => $multiSelectMode,
			run: () => multiSelectMode.update((v) => !v)
		}
	};
	/** 41 G1: the corner buttons and where a fresh profile puts them (bottom → top) — the
	 *  pre-41 places: AI under the "+" on the left, chat under the mic on the right */
	const CORNER_LEFT = ['ai', 'add'];
	const CORNER_RIGHT = ['chat', 'mic'];
	/** every id the layout can place, in the order the Customize / "+" lists show them */
	/** 42 I9: the bell and the peers trigger open their panels from the top-right corner, so they
	 *  may only live in the top-right group (moved, removed, re-added there — never elsewhere) */
	const HOME_ONLY: Record<string, Region> = { notifications: 'top', peers: 'top' };
	const ROSTER_IDS = [...DEFAULT_ORDER, ...OPTIONAL_VIEWS, ...CORNER_LEFT, ...CORNER_RIGHT, ...TOP_DEFAULT, ...TOUCH_DEFAULT];
	/** 42 I7: the name a MENU prints for a button (its short label, else its title) */
	function labelOf(id: string) {
		return id === SPACER ? 'Play' : (BUTTONS[id]?.label ?? BUTTONS[id]?.title ?? id);
	}

	/** the AI button press — AiHudButton's own path (I3): unconfigured points at Settings ▸ AI */
	function toggleAiAssistant() {
		if (!aiReady()) {
			showQualityToast('Enable an AI provider in Settings to use the assistant');
			settingsSection.set('ai');
			settingsOpen.set(true);
			return;
		}
		aiAssistantHidden.set($aiAssistantHidden === '' ? 'hidden' : '');
	}

	/** the "+" press — MobileAddButton's own path: a new object lands in the middle of the
	 *  VIEWPORT (W9), the menu opens beside the button, wherever the button now is */
	function openAddMenu() {
		const r = document.getElementById('mobile-add-button')?.getBoundingClientRect();
		const centre = canvasCenter();
		$viewportMenuOpener?.(centre.x, centre.y, true, r?.left ?? 16, r?.top ?? window.innerHeight - 60);
	}

	/** 41 G1: a click handler as a DIRECT listener (this file mixes on: directives, so the
	 *  attribute form is not available — the openCustomizeOnClick reasoning) */
	function onPress(node: HTMLElement, fn: (e: MouseEvent) => void) {
		let current = fn;
		const click = (e: MouseEvent) => {
			e.stopPropagation();
			current(e);
		};
		node.addEventListener('click', click);
		return {
			update(next: (e: MouseEvent) => void) {
				current = next;
			},
			destroy() {
				node.removeEventListener('click', click);
			}
		};
	}

	/** 30 P1: the toggle cell's click as a DIRECT listener — an `on:click` on a new element
	 *  adds a deprecation warning in this runes-mode file (the openStats reasoning). */
	function cellClick(node: HTMLElement, id: string) {
		let current = id;
		const click = () => runCell(current);
		node.addEventListener('click', click);
		return {
			update(next: string) {
				current = next;
			},
			destroy() {
				node.removeEventListener('click', click);
			}
		};
	}

	// 41 G23: THE MODEL LIVES IN `$lib/toolbarLayout` (a pure leaf, unit-tested) — reading a
	// stored record, the visual row, every move/hide/show/swap and the edit-positions
	// placements. What stays here is the CONFIG (which ids exist, the shipped defaults) and the
	// persistence. The legacy rows, the promoted defaults and the append-new-defaults rule
	// documented above are the leaf's now, unchanged in effect.
	const LAYOUT_CFG: LayoutConfig = {
		order: DEFAULT_ORDER,
		spacer: DEFAULT_SPACER,
		left: CORNER_LEFT,
		right: CORNER_RIGHT,
		top: TOP_DEFAULT,
		touch: TOUCH_DEFAULT,
		homeOnly: HOME_ONLY,
		isKnown: (id: string) => !!BUTTONS[id],
		legacyRows: LEGACY_DEFAULT_ROWS,
		promoted: PROMOTED_DEFAULTS
	};

	function defaultLayout(): ControlsLayout {
		return defaultToolbarLayout(LAYOUT_CFG);
	}

	/** Read the persisted layout, SSR-guarded and defensive: a stored record is user data a
	 *  later version of this file may not recognise, so it goes through `normalizeLayout`,
	 *  which drops unknown ids and duplicates, closes holes and never throws. */
	function loadLayout(): ControlsLayout {
		if (typeof localStorage === 'undefined') return defaultLayout();
		try {
			const raw = safeStorage.getItem('controlsLayout');
			return raw ? normalizeLayout(JSON.parse(raw), LAYOUT_CFG) : defaultLayout();
		} catch {
			return defaultLayout();
		}
	}

	// 41 G23 — THE RELOAD BUG. The page is PRERENDERED, so the server's HTML holds the DEFAULT
	// bar, and svelte 5 hydrates a keyed `{#each}` POSITIONALLY: it only checks that the list
	// is non-empty, then walks the client's items onto the server's DOM in order. A stored
	// custom order therefore hydrated each cell onto the markup of whatever button sat in that
	// slot by default — the title and tint effects repaired the attributes, but every cell's
	// <svg> kept the server's paths, so after "move the far-right buttons to the leftmost and
	// reload" the icons belonged to other buttons. The bar now HYDRATES WITH THE DEFAULT (what
	// the server rendered) and the stored record is applied right after mount, where a keyed
	// reorder moves real DOM nodes. Same for the viewport width (the narrow bar drops a cell).
	let controlsLayout: ControlsLayout = $state(defaultLayout());
	onMount(() => {
		controlsLayout = loadLayout();
		// 42 I8: a workspace layout carries this record (its desktop chrome profile) — re-read it
		// when one is applied, and drop a draft the new record makes stale
		return onLayoutRestore(() => {
			if (editing) cancelEditPositions();
			controlsLayout = loadLayout();
		});
	});

	function saveLayout() {
		try {
			safeStorage.setItem('controlsLayout', JSON.stringify(controlsLayout));
		} catch {
			// private mode / storage full — the bar still works for this session
		}
	}

	/** The ONE write path. ALWAYS REASSIGNS: `$derived` compares with `===`, so an
	 *  in-place `order.push(…)` would leave every cell exactly where it was. Every write goes
	 *  back through `normalizeLayout`, so no edit can store a record a reload would read
	 *  differently. */
	function setLayout(patch: Partial<ControlsLayout>) {
		controlsLayout = normalizeLayout({ ...controlsLayout, ...patch }, LAYOUT_CFG);
		saveLayout();
	}

	function resetLayout() {
		controlsLayout = defaultLayout();
		try {
			safeStorage.removeItem('controlsLayout');
		} catch {
			// nothing to clear
		}
	}

	// W1 SAFETY HATCH. Every way back out of a customized toolbar is a right-click, and
	// iOS Safari fires no `contextmenu` on a long press — so a bar collapsed there (or
	// on any device, by someone who cannot find the menu again) needs a door that is not
	// one. Settings' "Reset window positions" already wipes the layout LS keys and runs
	// the live resetters, which is exactly this job one domain over; `resetWindowLayout`
	// clears `controlsLayout` and this brings the live bar back with no reload.
	onMount(() => registerWindowReset(() => resetLayout()));

	/** THE VISUAL ROW — the bar exactly as the user reads it: the shown buttons with
	 *  the FAB's well spliced in at `spacerIndex` (`$lib/toolbarLayout`'s `visualRow`). Every
	 *  rearrangement is a splice on THIS sequence and the record is derived back from it,
	 *  which is the W1 correction: `order` and `spacerIndex` used to be moved independently,
	 *  so a step across the well moved TWO cells at once. */
	function visualIds(): string[] {
		return visualRow(controlsLayout);
	}

	// The cells the bar renders. Collapsed, that is the well ALONE — the play button
	// is the whole toolbar, and its own menu is the way back.
	// 37 R1 × R21 (1.26 union): the Pivot cell made the default bar 402 px — wider than a
	// 393 px phone, so every page scrolled sideways. Below NARROW_BAR it stays off the bar
	// (the record keeps it; the Inspector and the object menu still set the pivot there) —
	// the multiselect lane's own fallback (QUESTIONS-37-multiselect #1).
	const NARROW_BAR = 440;
	/** 43 J10: at or below this the bar's cells SHARE the width (hud.css, max-width 520px) — no folding */
	const FOLD_MIN_VW = 520;
	// 41 G23: the SERVER's width until mounted (see the hydration note above)
	let viewportW = $state(1280);
	onMount(() => {
		const read = () => (viewportW = window.innerWidth);
		read();
		window.addEventListener('resize', read);
		return () => window.removeEventListener('resize', read);
	});
	// 43 J10: THE OVERFLOW. What does not fit the room the bar has (`barRoom`, measured with the track:
	// the viewport less a pinned sidebar and the corner stacks on its row) folds into "»", right to left
	// by the user's order, Play never ($lib/toolbarLayout `foldToFit`). Derived, never stored — the
	// enabled set stays what the user chose, so room coming back unfolds by itself. Off while Edit
	// positions runs (it shows every item, wrapping) and on a phone-width bar (its cells shrink instead).
	const foldPlan = $derived.by(() => {
		if (controlsLayout.collapsed) return { shown: [SPACER], folded: [] as string[] };
		const row = visualIds().filter((id) => !(id === 'pivot' && viewportW < NARROW_BAR));
		if (editing || viewportW <= FOLD_MIN_VW || !barRoom.ok) return { shown: row, folded: [] as string[] };
		return foldToFit(row, {
			...barMetrics,
			// a px of slack: the arithmetic is in whole layout px, the browser's in fractions of one
			budget: barRoom.right - barRoom.left - 1,
			// the "…" is drawn only on a wide window (hud.css hides it below 720 px)
			more: controlsLayout.more !== false && viewportW >= 720
		});
	});
	const visibleCells = $derived(foldPlan.shown.map((id) => ({ id })));
	/** the cells folded into "»", in the bar's left → right order */
	const folded = $derived(foldPlan.folded);

	/** A cell press. It needs no "was that a drag?" guard of its own: a move that ends
	 *  here has already armed `swallowNextClick`, so this handler is simply not reached
	 *  for the click a gesture produced. ONE mechanism, at the window, covering every
	 *  cell and the play FAB alike. */
	function runCell(id: string) {
		BUTTONS[id]?.run();
	}

	// --- rearranging (the arithmetic is `$lib/toolbarLayout`'s) ---------------------
	/** Move one cell — a button or the well itself — exactly ONE visual slot: it trades
	 *  places with its neighbour on the visual row, so crossing the play button is a single
	 *  step and every other cell keeps its slot. */
	function moveCell(id: string, dir: number) {
		setLayout(moveToolbarCell(controlsLayout, id, dir));
	}

	/** Take a bar button off the bar; it keeps its slot for Customize to bring it back. */
	function hideButton(id: string) {
		setLayout(hideToolbarButton(controlsLayout, id));
	}

	/** Put a button on the bar. W8b: an OPTIONAL view has never been in `order` at all,
	 *  so it is APPENDED — the far right end, past the play well, which is where a new
	 *  thing belongs and where the arrows can walk it from. A DEFAULT button that was
	 *  hidden keeps its slot in `order` and returns to exactly where it was left. */
	function showButton(id: string) {
		setLayout(showToolbarButton(controlsLayout, id, LAYOUT_CFG));
	}

	/** W8b — SWAP: put `toId` in `fromId`'s exact slot and take `fromId` off the bar.
	 *
	 *  The bar keeps its shape (same number of cells, same well position, every other
	 *  cell untouched), which is the whole point: a user who wants the Animation tab a
	 *  press away trades the button they never use for it, rather than growing the bar
	 *  and then having to move things. */
	function swapCell(fromId: string, toId: string) {
		if (!BUTTONS[toId]) return;
		setLayout(swapToolbarCell(controlsLayout, fromId, toId, HOME_ONLY));
	}

	// ── 41 G1: EDIT POSITIONS ──────────────────────────────────────────────────────────
	// The user's ask, verbatim in spirit: a right-click (long press on touch) "Edit positions"
	// mode where the buttons are dragged into place, every placeholder but Play carries a small
	// red "−", an emptied place carries a small green "+" that offers whatever "Customize
	// toolbar…" lists and is not placed yet (never Play), up to THREE round buttons stacked in
	// each bottom corner, and a round green ✓ at the bar's top right applies.
	//
	// It edits a DRAFT (`editing`, `$lib/toolbarLayout`'s Placements) and touches the record
	// only on ✓, through the same `fromPlacements` → `setLayout` path, so it shares every rule
	// the Customize list and Move left/right obey (G23) and a cancel is free. While it is on, a
	// press on a button does nothing but pick it up: the bar's own move gesture, the cell
	// menus and the buttons' actions all stand down.
	let editing: Placements | null = $state(null);
	/** the item the keyboard acts on (and the one a drag is carrying) */
	let editFocus: string | null = $state(null);
	/** a drag in flight: what it carries and where the pointer is (the ghost follows it) */
	let editDrag: { id: string; x: number; y: number } | null = $state(null);
	/** the green "+" popup: where to anchor it and which place it fills */
	let editAddMenu: { x: number; y: number; region: Region; index: number; hole: string | null } | null = $state(null);

	/** enter edit mode, optionally with an item focused (the one that was right-clicked) */
	function enterEditPositions(focusId: string | null = null) {
		toolbarMenu = null;
		customizeMenu = null;
		playMenu = null;
		if (toolbarGrab.active()) toolbarGrab.cancel();
		editing = placements(controlsLayout, HOME_ONLY);
		touchShowDraft = null;
		editFocus = focusId && (focusId === SPACER || (focusId === MORE && controlsLayout.more) || regionOf(controlsLayout, focusId)) ? focusId : null;
		tick().then(() => focusEditItem(editFocus ?? visualIds()[0]));
	}

	function applyEditPositions() {
		if (!editing) return;
		// 43 J12: the row beside the logo is drawn in edit mode on every device; an edit that CHANGED it
		// (added, moved or removed a button there) means "show this row", so a mouse user's Touch tools
		// turns on — an edit that left it alone leaves the setting as it was
		// 45 N2: ...unless the person said what they want with the row's own Show / Hide cluster, which wins
		if (touchShowDraft !== null) {
			if (touchShowDraft !== $touchTools) touchTools.set(touchShowDraft);
		} else if (!$touchTools && editing.touch.join() !== controlsLayout.touch.join() && editing.touch.length) touchTools.set(true);
		touchShowDraft = null;
		const next = fromPlacements(controlsLayout, editing);
		editing = null;
		editDrag = null;
		editAddMenu = null;
		setLayout({ ...next, collapsed: false });
	}

	function cancelEditPositions() {
		touchShowDraft = null;
		editing = null;
		editDrag = null;
		editAddMenu = null;
	}

	// a phone-sized window has no bar at all (PhoneShell draws its own), so folding the phone
	// mid-edit throws the draft away rather than leaving an invisible mode armed
	$effect(() => {
		if ($phoneShell && editing) cancelEditPositions();
	});

	function focusEditItem(id: string | null) {
		if (!id) return;
		const el = document.querySelector<HTMLElement>(`[data-edit-id="${CSS.escape(id)}"]`);
		el?.focus({ preventScroll: true });
	}

	/** the red "−": take the item off (a bar item leaves a "+" in its place until ✓) */
	function editRemove(id: string) {
		if (!editing || id === SPACER) return;
		if (id === CONNECT) {
			// 43 K3: the Connect pill hides; the "+" left at the top centre brings it back
			editing = { ...editing, connect: false };
			if (editFocus === id) editFocus = null;
			return;
		}
		if (id === MORE) {
			// 43 J2: the "…" leaves the bar like any item; the end "+" offers it back
			editing = { ...editing, more: false };
			if (editFocus === id) editFocus = null;
			return;
		}
		const region = placeRegion(editing, id);
		editing = placeRemove(editing, id, { hole: region === 'bar' });
		if (editFocus === id) editFocus = null;
	}

	/** the green "+": open the popup of unplaced roster buttons for this place */
	function editOpenAdd(e: MouseEvent | KeyboardEvent, region: Region, index: number, hole: string | null = null) {
		const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
		editAddMenu = { x: Math.round(r.left), y: Math.round(r.top), region, index, hole };
	}

	function editAddItems() {
		if (!editing || !editAddMenu) return [];
		const target = editAddMenu;
		const draft = editing;
		// 42 I9: only what may go THERE (the bell and the peers trigger only in the top-right group)
		const free = unplacedIds(draft, ROSTER_IDS).filter((id) => canPlace(draft, id, target.hole ? 'bar' : target.region));
		// 43 J2: a removed "…" comes back from any of the bar's "+" (it always sits at the bar's end)
		const moreBack = draft.more === false && (target.hole || target.region === 'bar');
		if (!free.length && !moreBack)
			return [{ label: 'Every button is placed', tooltip: 'Remove one with its red "−" first', disabled: true }];
		return [
			{ section: 'Place a button' },
			...(moreBack
				? [
						{
							label: MORE_LABEL,
							icon: 'ellipsis',
							tooltip: 'The bar\'s own menu button — it always sits at the end of the bar',
							action: () => {
								if (!editing) return;
								editing = { ...editing, more: true };
								editFocus = MORE;
								tick().then(() => focusEditItem(MORE));
							}
						}
					]
				: []),
			...free.map((id) => ({
				label: labelOf(id),
				icon: BUTTONS[id].iconName ?? BUTTONS[id].icon,
				action: () => {
					if (!editing) return;
					editing = target.hole ? fillHole(editing, target.hole, id) : placeAt(editing, id, target.region, target.index);
					editFocus = id;
					tick().then(() => focusEditItem(id));
				}
			}))
		];
	}

	/** the keyboard, while editing — in CAPTURE so the editor's own arrows / Delete never see it */
	function onEditKey(e: KeyboardEvent) {
		// 44 M12b: an open cluster menu / an armed cluster move owns Escape (it closes / puts the cluster back)
		if (!editing || editAddMenu || clusterMenu || clusterGrab.active()) return;
		if (e.key === 'Escape') {
			e.preventDefault();
			e.stopPropagation();
			cancelEditPositions();
			return;
		}
		const focused = (document.activeElement as HTMLElement | null)?.dataset?.editId ?? null;
		if (!focused) return;
		if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
			e.preventDefault();
			e.stopPropagation();
			editing = stepItem(editing, focused, e.key);
			editFocus = focused;
			tick().then(() => focusEditItem(focused));
		} else if ((e.key === 'Delete' || e.key === 'Backspace') && focused !== SPACER) {
			e.preventDefault();
			e.stopPropagation();
			editRemove(focused);
		}
	}

	/** a press outside the bar, the corners and the popup cancels (the user's "outside = cancel") */
	function onEditOutside(e: PointerEvent) {
		if (!editing || editAddMenu || clusterMenu || clusterGrab.active()) return;
		const t = e.target as Element | null;
		if (t?.closest?.('#controls-pill, .hud-stack, #hud-tr, #touch-tools, #toolbar-edit-ghost, #connect-edit, [role="menu"], [data-cluster-grip], #cluster-move-hint, .connect-wrap, #budget-edit, #budget-chip-wrap')) return;
		cancelEditPositions();
	}

	onMount(() => {
		window.addEventListener('keydown', onEditKey, true);
		window.addEventListener('pointerdown', onEditOutside, true);
		return () => {
			window.removeEventListener('keydown', onEditKey, true);
			window.removeEventListener('pointerdown', onEditOutside, true);
		};
	});

	/** Where a drag would drop: the region under the pointer (each inflated so a corner stack is
	 *  easy to hit) and the index among that region's OTHER items — counting only the others is
	 *  what keeps the live reorder from oscillating as the carried item moves under the pointer. */
	function editDropTarget(x: number, y: number, id: string): { region: Region; index: number } | null {
		const PAD = 28;
		const inside = (el: Element | null) => {
			if (!el) return false;
			const r = el.getBoundingClientRect();
			return x >= r.left - PAD && x <= r.right + PAD && y >= r.top - PAD && y <= r.bottom + PAD;
		};
		// 42 I9: the top-right group and the touch tools — rows (a stacked touch cluster is a column)
		for (const region of ['top', 'touch'] as const) {
			const group = document.getElementById(region === 'top' ? 'hud-tr' : 'touch-tools');
			if (!group || !inside(group) || id === SPACER || !editing || !canPlace(editing, id, region)) continue;
			// 44 M12b: a rotated group is a column too
			const column = (region === 'touch' && group.classList.contains('tt-stacked')) || isVertical(region);
			const others = [...group.querySelectorAll<HTMLElement>('[data-edit-wrap]')].filter((el) => el.dataset.editWrap !== id);
			const index = others.filter((el) => {
				const r = el.getBoundingClientRect();
				return column ? r.top + r.height / 2 < y : r.left + r.width / 2 < x;
			}).length;
			return { region, index };
		}
		for (const region of ['left', 'right'] as const) {
			const stack = document.getElementById(`hud-stack-${region}`);
			if (!inside(stack) || id === SPACER || (editing && !canPlace(editing, id, region))) continue;
			const others = [...(stack?.querySelectorAll<HTMLElement>('[data-edit-wrap]') ?? [])].filter((el) => el.dataset.editWrap !== id);
			// bottom → top: an item sits ABOVE every other whose centre is below the pointer. 44 M12b: rotated to a
			// row, the left stack reads left → right from its corner and the right one right → left
			const index = others.filter((el) => {
				const r = el.getBoundingClientRect();
				if (!isVertical(region)) return region === 'left' ? r.left + r.width / 2 < x : r.left + r.width / 2 > x;
				return r.top + r.height / 2 > y;
			}).length;
			return { region, index };
		}
		const row = document.querySelector('#controls-pill .hud-bar-row');
		if (!inside(row) || (editing && !canPlace(editing, id, 'bar'))) return null;
		const others = [...(row?.querySelectorAll<HTMLElement>('[data-edit-slot]') ?? [])].filter((el) => el.dataset.editWrap !== id);
		const barVertical = isVertical('bar');
		const index = others.filter((el) => {
			const r = el.getBoundingClientRect();
			return barVertical ? r.top + r.height / 2 < y : r.left + r.width / 2 < x;
		}).length;
		return { region: 'bar', index };
	}

	// THE GRIP IS A REAL <button>, the size of the whole placeholder, and the "−" is its SIBLING:
	// browsers snap a finger to the nearest real button (touch target adjustment), so while the
	// placeholder was a div with a <button> "−" in its corner, a finger pressed on the middle of
	// a 44 px button landed on the 18 px "−" — measured with CDP touch, elementFromPoint said the
	// icon and the pointerdown said the "−".
	/** One edit item's pointer gesture (mouse, pen or a finger — pointer events throughout, so a
	 *  real touch drags exactly like a mouse). A press that does not travel is not a drag: it only
	 *  focuses the item. A drag reorders the draft LIVE, so the other buttons part to show where
	 *  it will land, and a ghost of the carried button follows the pointer.
	 *
	 *  The gesture lives HERE, not in the node that started it: a button carried into another
	 *  region is drawn by a different {#each} (bar → corner), so the node under the finger is
	 *  destroyed mid-drag — a gesture owned by that node ended the moment it crossed over. */
	let editGesture: { id: string; x: number; y: number; dragging: boolean } | null = null;
	function editGestureMove(e: PointerEvent) {
		const g = editGesture;
		if (!g || !editing || g.id === MORE) return; // 43 J2: the "…" is removable, not movable
		if (!g.dragging && Math.abs(e.clientX - g.x) + Math.abs(e.clientY - g.y) < DRAG_SLOP) return;
		e.preventDefault();
		clearTimeout(holdTimer);
		g.dragging = true;
		editDrag = { id: g.id, x: e.clientX, y: e.clientY };
		const target = editDropTarget(e.clientX, e.clientY, g.id);
		if (!target) return;
		const p = editing;
		if (placeRegion(p, g.id) === target.region && p[target.region].indexOf(g.id) === target.index) return; // already there
		editing = placeAt(p, g.id, target.region, target.index);
	}
	let holdTimer = 0;
	function editGestureEnd(e?: Event) {
		clearTimeout(holdTimer);
		window.removeEventListener('pointermove', editGestureMove);
		window.removeEventListener('pointerup', editGestureEnd);
		window.removeEventListener('pointercancel', editGestureEnd);
		const carried = editGesture?.dragging ? editGesture.id : null;
		editGesture = null;
		editDrag = null;
		if (carried) {
			// a mouse drag ends in a click that must not land; a finger that moved produces none,
			// and an armed swallow would eat the NEXT real tap instead (the "−" right after a drag)
			if ((e as PointerEvent | undefined)?.pointerType === 'mouse') swallowNextClick();
			tick().then(() => focusEditItem(carried));
		}
	}
	function editItemGesture(node: HTMLElement, id: string) {
		let current = id;
		const down = (e: PointerEvent) => {
			if (!editing || (e.button ?? 0) !== 0) return;
			if ((e.target as Element)?.closest?.('.hud-edit-remove')) return;
			e.stopPropagation(); // the bar's own move gesture must not see an edit press
			// a touch press is implicitly CAPTURED by the element it started on, which is about
			// to be re-rendered as the draft moves — release it so the moves reach the window
			try {
				node.releasePointerCapture?.(e.pointerId);
			} catch {
				// not captured
			}
			editGestureEnd();
			editGesture = { id: current, x: e.clientX, y: e.clientY, dragging: false };
			editFocus = current;
			// 44 M12b: a finger held STILL opens the cluster's menu (a held finger that moves drags the button)
			clearTimeout(holdTimer);
			if (e.pointerType !== 'mouse') {
				const at = { x: e.clientX, y: e.clientY };
				const g = editGesture;
				holdTimer = window.setTimeout(() => {
					// decided on the NEXT frame: Chrome delivers a finger's pointermoves aligned to frames, so a busy
					// frame (the edit loop measures every one) can hold back the moves that make this press a drag —
					// the timer then won the race and the cluster menu ate the drag (toolbar-slots-42 I9, 3 in 7)
					requestAnimationFrame(() => {
						if (editGesture !== g || g.dragging) return;
						const cid = clusterAt(node);
						editGestureEnd();
						if (cid) {
							longPressAt = performance.now();
							openClusterMenu(cid, at.x, at.y);
						}
					});
				}, LONG_PRESS_MS);
			}
			window.addEventListener('pointermove', editGestureMove, { passive: false });
			window.addEventListener('pointerup', editGestureEnd);
			window.addEventListener('pointercancel', editGestureEnd);
		};
		// a long press on touch raises `contextmenu`; in edit mode that is a drag being held
		const menu = (e: Event) => {
			if (!editing) return;
			e.preventDefault();
			e.stopPropagation();
			// 44 M12b: a mouse right-click on a placeholder opens its cluster's menu (a touch contextmenu is the
			// held finger — its own timer above decides)
			const me = e as PointerEvent;
			if (me.pointerType === 'touch' || performance.now() - longPressAt < 1200) return;
			const cid = clusterAt(node);
			if (cid) openClusterMenu(cid, me.clientX, me.clientY);
		};
		node.addEventListener('pointerdown', down);
		node.addEventListener('contextmenu', menu);
		return {
			update(next: string) {
				current = next;
			},
			destroy() {
				node.removeEventListener('pointerdown', down);
				node.removeEventListener('contextmenu', menu);
			}
		};
	}

	/** 43 K3: where the Connect pill sits, so Edit positions can outline it (measured on entering, and
	 *  while editing on a resize) — null while the pill is hidden */
	let connectRect: { left: number; top: number; width: number; height: number } | null = $state(null);
	function measureConnect() {
		const el = document.querySelector('.connect-pill') as HTMLElement | null;
		const r = el?.getBoundingClientRect();
		const next = r && r.width ? { left: r.left, top: r.top, width: r.width, height: r.height } : null;
		const c = connectRect;
		// reassigned only on a change (a $state write per frame would re-render the outline for nothing)
		if (!next || !c || Math.abs(next.left - c.left) > 0.5 || Math.abs(next.top - c.top) > 0.5 || Math.abs(next.width - c.width) > 0.5 || Math.abs(next.height - c.height) > 0.5) connectRect = next;
	}
	// 44 M12: the outline FOLLOWS the pill. It was measured once on entering, and entering Edit positions is
	// itself what moves the pill: the row beside the logo appears (J12), the walls change and the pill slides to
	// its new centre on a 0.2 s transition — so the outline (and its "−") sat beside the pill, the reported gap.
	// A ResizeObserver never fires for a box that only moves, so read it every frame while editing (cheap: one rect).
	$effect(() => {
		if (!editing) return;
		void editing.connect;
		let raf = 0;
		let live = true;
		const loop = () => {
			if (!live) return;
			measureConnect();
			measureClusters();
			raf = requestAnimationFrame(loop);
		};
		tick().then(loop);
		return () => {
			live = false;
			cancelAnimationFrame(raf);
		};
	});

	// ── 44 M12b: THE CLUSTERS — free but anchored placement, rotation, the cluster menu ───────────────
	// The user: "Would you allow to move freely button clusters to adjust their placement …". Six clusters — the bar,
	// the two bottom-corner stacks, the row beside the logo, the top-right group, the Connect pill (the logo and the
	// profile stay where they are). In Edit positions each has a grip (drag it anywhere; it snaps to the screen's
	// edges / centre lines, the sidebar edges and the other clusters, with guide lines) and a menu (right-click or a
	// long press on it, a tap on its grip): Move, Rotate to vertical / horizontal (not the Connect pill — it has Pin to
	// top row / Float), Reset position, Reset all positions, Hide cluster / Show all. A place is stored as the
	// fraction of the free span along each axis ($lib/clusterPlace) in the record's `clusters`, so it keeps its
	// relative place on another window, beside a sidebar or above the dock, and layouts carry it with the record.
	// The AREA is the window less the pinned sidebars, the visible dock and a docked Connect bar; a placed cluster
	// never overlaps another cluster, the logo or the profile — it is nudged to the nearest free spot.
	const CLUSTER_SEL: Record<string, string> = {
		bar: '#controls-pill',
		left: '#hud-stack-left',
		right: '#hud-stack-right',
		touch: '#touch-tools',
		top: '#hud-tr',
		connect: '.connect-pill',
		budget: '#budget-chip-wrap'
	};
	const CLUSTER_LABEL: Record<string, string> = {
		bar: 'Toolbar',
		left: 'Bottom-left buttons',
		right: 'Bottom-right buttons',
		touch: 'Buttons beside the logo',
		top: 'Top-right buttons',
		connect: 'Connect bar',
		budget: 'Budget chip'
	};
	/** a cluster's home orientation (rotation turns it 90° from this) */
	const HOME_VERTICAL: Record<string, boolean> = { bar: false, left: true, right: true, touch: false, top: false };
	/** the chrome that never moves, and that a placed cluster keeps clear of */
	const STATIC_SEL = ['#logo-menu', '#avatar-trigger'];
	/** where a rotated (vertical) bar goes when it has no place of its own: the left edge, half way down */
	const BAR_VERTICAL_HOME = { x: 0, y: 0.5 };

	/** the clusters as drawn: the draft's while editing, the record's otherwise */
	const liveClusters = $derived.by(() => normalizeClusters(editing ? (editing.clusters ?? {}) : (controlsLayout.clusters ?? {})));
	/** a cluster drag in flight: which one and its live box (the engine draws it there, unsnapped by others) */
	let clusterDrag: { id: string; box: Box } | null = $state(null);
	let clusterGuides: Guide[] = $state([]);
	/** the clusters' rects while Edit positions runs (grips are drawn from them) */
	let clusterRects: Record<string, Box> = $state({});
	/** the cluster menu */
	let clusterMenu: { x: number; y: number; id: string } | null = $state(null);
	/** which cluster the next gesture moves */
	let grabId = 'bar';

	const isRotated = (id: string, cl = liveClusters) => !!cl[id]?.rotated;
	const isVertical = (id: string, cl = liveClusters) => (HOME_VERTICAL[id] ?? false) !== isRotated(id, cl);
	/** 45 N2: whether the row beside the logo shows once Edit positions is applied. That is the Touch tools setting
	 *  (remembered, layout chrome, OFF by default on a desktop) — so the row's Show / Hide cluster drafts it here and ✓
	 *  writes it, Cancel leaves it as it was. Before, the menu offered "Hide cluster" for a row a desktop never showed,
	 *  had no "Show cluster" at all, and ✓ made the row the person had just arranged vanish. */
	let touchShowDraft: boolean | null = $state(null);
	const touchRowOn = $derived(editing && touchShowDraft !== null ? touchShowDraft : $touchTools);
	/** hidden once applied: its own record, the row beside the logo also by the setting, Connect by the draft's "−" */
	function clusterHidden(id: string, cl = liveClusters) {
		if (id === 'connect') return editing?.connect === false;
		return !!cl[id]?.hidden || (id === 'touch' && !touchRowOn);
	}
	/** a cluster with a place of its own (a pinned Connect pill lives on the top row, whatever it was given) */
	function isPlaced(id: string, cl = liveClusters) {
		const c = cl[id];
		if (!c || typeof c.x !== 'number' || typeof c.y !== 'number') return false;
		if (c.hidden) return false;
		return id !== 'connect' || !$connectPinned;
	}
	const barPlaced = $derived(isPlaced('bar'));
	function clusterEl(id: string) {
		if (typeof document === 'undefined') return null;
		const el = document.querySelector(CLUSTER_SEL[id]) as HTMLElement | null;
		// 48 F1: the budget chip keeps a box while it waits for a spot (it is measured invisible) — not drawn = not there
		if (id === 'budget' && el?.classList.contains('bc-hidden')) return null;
		return el;
	}
	const boxOf = (r: DOMRect): Box => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
	function shown(el: Element | null) {
		const r = el?.getBoundingClientRect();
		return r && r.width > 0 && r.height > 0 ? boxOf(r) : null;
	}
	/** the room a cluster may take: the window less the pinned sidebars, the visible dock and a docked Connect bar */
	function clusterArea(): Box {
		const g = get(sidebarGeometry);
		const vw = window.innerWidth;
		const vh = window.innerHeight;
		const inset = cssPx(getComputedStyle(document.documentElement).getPropertyValue('--bottom-inset')) || 0;
		return {
			left: g?.wide ? g.dockLeft : 0,
			right: vw - (g?.wide ? g.dockRight : 0),
			top: get(connectDocked) ? get(connectBarHeight) : 0,
			bottom: vh - inset
		};
	}
	/** an open (unpinned) sidebar column — a snap target, not an obstacle (it may close) */
	function openColumns(): Box[] {
		const g = get(sidebarGeometry);
		if (!g?.wide) return [];
		const vh = window.innerHeight;
		const out: Box[] = [];
		if (g.left.shown && !g.left.full) out.push({ left: g.leftX, right: g.leftX + g.left.w, top: g.left.top, bottom: vh });
		if (g.right.shown && !g.right.full) out.push({ left: window.innerWidth - g.right.w, right: window.innerWidth, top: g.right.top, bottom: vh });
		return out;
	}
	function writePlace(id: string, box: Box | null) {
		const root = document.documentElement;
		root.classList.toggle(`cl-${id}-placed`, !!box);
		if (!box) return;
		root.style.setProperty(`--cl-${id}-x`, Math.round(box.left) + 'px');
		root.style.setProperty(`--cl-${id}-y`, Math.round(box.top) + 'px');
	}

	/** THE LAYOUT PASS: classes for rotation / hidden, and every placed cluster's px from its fractions, nudged
	 *  clear of the static chrome, the clusters at home and the ones placed before it (CLUSTERS order) */
	function layoutClusters() {
		if (typeof document === 'undefined') return;
		const root = document.documentElement;
		const cl = liveClusters;
		root.classList.toggle('hud-edit-on', editing !== null);
		for (const id of CLUSTERS) {
			root.classList.toggle(`cl-${id}-rotated`, isRotated(id, cl));
			root.classList.toggle(`cl-${id}-hidden`, id !== 'connect' && clusterHidden(id, cl));
		}
		const area = clusterArea();
		const obstacles: Box[] = [];
		for (const sel of STATIC_SEL) {
			const b = shown(document.querySelector(sel));
			if (b) obstacles.push(b);
		}
		for (const id of CLUSTERS) {
			if (isPlaced(id, cl) || clusterHidden(id, cl)) continue;
			const b = shown(clusterEl(id));
			if (b) obstacles.push(b);
		}
		const boxes: Record<string, Box> = {};
		for (const id of CLUSTERS) {
			if (!isPlaced(id, cl)) {
				writePlace(id, null);
				continue;
			}
			if (clusterDrag?.id === id) {
				writePlace(id, clusterDrag.box);
				boxes[id] = clusterDrag.box;
				continue;
			}
			const el = clusterEl(id);
			if (!el || !el.offsetWidth) continue;
			const size = { w: el.offsetWidth, h: el.offsetHeight };
			const c = cl[id];
			const box = nudgeFree(boxAt({ x: c.x!, y: c.y! }, size, area), area, [...obstacles, ...Object.values(boxes)]);
			boxes[id] = box;
			writePlace(id, box);
		}
		(window as any).__clusters = { area, boxes, clusters: cl };
	}
	$effect(() => {
		void liveClusters;
		void editing;
		void touchRowOn;
		void $sidebarGeometry;
		void $bottomInset;
		void $connectDocked;
		void $connectBarHeight;
		void $connectPinned;
		void visibleCells;
		void stackLeft;
		void stackRight;
		void stackTop;
		void stackTouch;
		void viewportW;
		tick().then(layoutClusters);
		// once more after the sidebars' / Connect's own slides have landed
		const t = setTimeout(layoutClusters, 280);
		return () => clearTimeout(t);
	});
	// a cluster's SIZE changes with its buttons, a rotation, a peer connecting (the peers trigger) — re-place it
	onMount(() => {
		if (typeof ResizeObserver === 'undefined') return;
		const ro = new ResizeObserver(() => layoutClusters());
		let observed: Element[] = [];
		const watch = () => {
			const els = CLUSTERS.map((id) => clusterEl(id)).filter((el): el is HTMLElement => !!el);
			if (els.length === observed.length && els.every((el, i) => el === observed[i])) return;
			ro.disconnect();
			observed = els;
			for (const el of els) ro.observe(el);
		};
		watch();
		const t = setInterval(watch, 1000);
		window.addEventListener('resize', layoutClusters);
		return () => {
			clearInterval(t);
			ro.disconnect();
			window.removeEventListener('resize', layoutClusters);
		};
	});

	/** write one cluster's state — into the draft while editing, else the record */
	function setCluster(id: string, patch: Record<string, any> | null) {
		const base = editing ? (editing.clusters ?? {}) : (controlsLayout.clusters ?? {});
		const next: Record<string, any> = { ...base };
		if (patch === null) delete next[id];
		else {
			const merged: Record<string, any> = { ...(base[id] ?? {}), ...patch };
			for (const k of Object.keys(merged)) if (merged[k] === undefined || merged[k] === false) delete merged[k];
			if (Object.keys(merged).length) next[id] = merged;
			else delete next[id];
		}
		const clusters = normalizeClusters(next);
		if (editing) editing = { ...editing, clusters };
		else setLayout({ clusters });
	}

	/** what a drag snaps to: the other clusters, the static chrome and any open sidebar column */
	function snapTargets(id: string): Box[] {
		const out: Box[] = [];
		for (const other of CLUSTERS) {
			if (other === id || clusterHidden(other)) continue;
			const b = shown(clusterEl(other));
			if (b) out.push(b);
		}
		for (const sel of STATIC_SEL) {
			const b = shown(document.querySelector(sel));
			if (b) out.push(b);
		}
		return [...out, ...openColumns()];
	}

	/** THE CLUSTER MOVE — a drag on a grip (or the bar itself once it is placed), or armed from the menu (modal:
	 *  follow the pointer, click to place; a finger drags and lifts, 44 M4). Absolute from the snapshot. */
	const clusterGrab = createGesture({
		snapshot: () => {
			const id = grabId;
			const box = shown(clusterEl(id));
			if (!box) return null;
			const area = clusterArea();
			const targets = snapTargets(id);
			// what it must not land on: the static chrome and the other VISIBLE clusters (not the sidebar columns)
			const obstacles = targets.filter((b) => !openColumns().some((c) => c.left === b.left && c.right === b.right && c.top === b.top));
			return { id, box, area, targets, obstacles };
		},
		start: () => {
			armNudge = 0;
		},
		apply: (ctx) => {
			const { id, box, area, targets } = ctx.snapshot;
			const moved = clampBox({ left: box.left + ctx.dx, top: box.top + ctx.dy, right: box.right + ctx.dx, bottom: box.bottom + ctx.dy }, area);
			const snapped = snapBox(moved, area, targets);
			clusterDrag = { id, box: snapped.box };
			clusterGuides = snapped.guides;
			writePlace(id, snapped.box);
			if (!isPlaced(id)) document.documentElement.classList.add(`cl-${id}-placed`);
		},
		revert: () => {
			clusterDrag = null;
			clusterGuides = [];
			tick().then(layoutClusters);
		},
		end: (ctx, kept) => {
			const d = clusterDrag;
			clusterDrag = null;
			clusterGuides = [];
			if (!kept || !d) return;
			if (ctx.event?.pointerType === 'mouse' || ctx.modal) swallowNextClick();
			const { area, obstacles, id } = ctx.snapshot;
			const free = nudgeFree(d.box, area, obstacles);
			const f = fractionsOf(free, area);
			setCluster(id, { x: f.x, y: f.y });
			tick().then(layoutClusters);
		},
		onActive: (active, modal) => {
			movingBar = active && grabId === 'bar';
			movingCluster = active && modal ? grabId : null;
		},
		touchDrag: true,
		rebase: (ctx) => {
			if (clusterDrag) ctx.snapshot = { ...ctx.snapshot, box: clusterDrag.box };
		},
		passDown: (e) => !!(e.target as Element | null)?.closest?.('#cluster-move-cancel')
	});
	/** the cluster an armed (menu) move carries, for its hint */
	let movingCluster: string | null = $state(null);
	function armClusterMove(id: string, at: { x: number; y: number }) {
		if (clusterGrab.active()) return;
		grabId = id;
		clusterGrab.begin({ clientX: at.x, clientY: at.y } as any, { modal: true });
	}

	/** which cluster an element is in (for a right-click / long press in Edit positions) */
	function clusterAt(t: Element | null): string | null {
		if (!t) return null;
		if (t.closest('#connect-edit, .connect-wrap')) return 'connect';
		for (const id of CLUSTERS) if (id !== 'connect' && t.closest(CLUSTER_SEL[id])) return id;
		const grip = t.closest('[data-cluster-grip]') as HTMLElement | null;
		return grip?.dataset.clusterGrip ?? null;
	}
	function openClusterMenu(id: string, x: number, y: number) {
		toolbarMenu = null;
		customizeMenu = null;
		playMenu = null;
		editAddMenu = null;
		lastMenuAt = { x, y };
		clusterMenu = { x, y, id };
	}

	// ── 45 N1: THE CONNECT PILL'S MENU OUTSIDE EDIT POSITIONS ─────────────────────────────────────────
	// The user: "allow right click on connect.svelte to adjust position". A right-click (a long press on touch) on the
	// pill opens the cluster menu the other clusters have in Edit positions — Move, Pin to top row / Float, Reset
	// position, Reset all. Window listeners in CAPTURE, so Connect.svelte's own buttons never see the gesture. A text
	// field keeps its own menu (the dial box is where a person pastes an invite id), and Edit positions keeps its own
	// path (the pill's outline there is an edit item). Not on the folded phone: its Connect is a chip and a sheet.
	function pillMenuTarget(t: EventTarget | null) {
		const el = t as Element | null;
		if (editing || $phoneShell || !el?.closest?.('.connect-pill')) return false;
		return !el.closest('input, textarea, [contenteditable="true"]');
	}
	function onPillContext(e: MouseEvent) {
		if (!pillMenuTarget(e.target)) return;
		e.preventDefault();
		e.stopPropagation();
		// a held finger raises this too (Android) — the timer below already opened the menu
		if ((e as PointerEvent).pointerType === 'touch' || performance.now() - longPressAt < 1200) return;
		openClusterMenu('connect', e.clientX, e.clientY);
	}
	let pillHold: { id: number; x: number; y: number; timer: number } | null = null;
	function pillHoldEnd() {
		if (pillHold) clearTimeout(pillHold.timer);
		pillHold = null;
	}
	function onPillDown(e: PointerEvent) {
		pillHoldEnd();
		if (e.pointerType === 'mouse' || !pillMenuTarget(e.target)) return;
		const hold = { id: e.pointerId, x: e.clientX, y: e.clientY, timer: 0 };
		hold.timer = window.setTimeout(() => {
			if (pillHold !== hold) return;
			pillHold = null;
			longPressAt = performance.now();
			openClusterMenu('connect', hold.x, hold.y);
			// the lift that ends the hold must not also press the pill button it was held on
			const eat = (ev: MouseEvent) => {
				if (!(ev.target as Element | null)?.closest?.('.connect-pill')) return;
				ev.stopPropagation();
				ev.preventDefault();
			};
			window.addEventListener('click', eat, true);
			setTimeout(() => window.removeEventListener('click', eat, true), 700);
		}, LONG_PRESS_MS);
		pillHold = hold;
	}
	function onPillMove(e: PointerEvent) {
		if (pillHold && e.pointerId === pillHold.id && Math.abs(e.clientX - pillHold.x) + Math.abs(e.clientY - pillHold.y) >= DRAG_SLOP) pillHoldEnd();
	}
	onMount(() => {
		window.addEventListener('contextmenu', onPillContext, true);
		window.addEventListener('pointerdown', onPillDown, true);
		window.addEventListener('pointermove', onPillMove, true);
		window.addEventListener('pointerup', pillHoldEnd, true);
		window.addEventListener('pointercancel', pillHoldEnd, true);
		return () => {
			pillHoldEnd();
			window.removeEventListener('contextmenu', onPillContext, true);
			window.removeEventListener('pointerdown', onPillDown, true);
			window.removeEventListener('pointermove', onPillMove, true);
			window.removeEventListener('pointerup', pillHoldEnd, true);
			window.removeEventListener('pointercancel', pillHoldEnd, true);
		};
	});

	function clusterMenuItems(id: string) {
		const cl = liveClusters;
		const placed = isPlaced(id, cl);
		const anyPlaced = CLUSTERS.some((c) => isPlaced(c, cl)) || controlsLayout.posX != null;
		const anyHidden = CLUSTERS.some((c) => clusterHidden(c, cl));
		const vertical = isVertical(id, cl);
		const items: any[] = [{ section: CLUSTER_LABEL[id] }];
		items.push({
			label: 'Move',
			tooltip: id === 'connect' && $connectPinned
				? 'The Connect bar is pinned to the top row — Float it first'
				: 'Drag it anywhere — it snaps to the edges, the sidebars and the other clusters',
			disabled: id === 'connect' && $connectPinned,
			action: () => armClusterMove(id, lastMenuAt)
		});
		if (!UNROTATED.includes(id))
			items.push({
				label: vertical ? 'Rotate to horizontal' : 'Rotate to vertical',
				tooltip: vertical ? 'Lay its buttons out in a row' : 'Lay its buttons out in a column',
				action: () => rotateCluster(id)
			});
		else if (id === 'connect')
			items.push({
				label: $connectPinned ? 'Float' : 'Pin to top row',
				tooltip: $connectPinned ? 'Float the Connect bar — it goes compact when the top row is full' : 'Give the Connect bar its own row along the top',
				action: () => setConnectPinned()
			});
		items.push(
			{
				label: 'Reset position',
				tooltip: 'Put it back where it started',
				disabled: !placed && !(id === 'bar' && controlsLayout.posX != null),
				action: () => resetClusterPosition(id)
			},
			{
				label: 'Reset all positions',
				tooltip: 'Put every cluster back where it started (rotations stay)',
				disabled: !anyPlaced,
				action: () => resetAllPositions()
			}
		);
		// 45 N1: the Connect pill's menu OUTSIDE Edit positions is the four rows the user asked for (Move, Pin / Float,
		// Reset position, Reset all); hiding it is an Edit positions act (its "+" there is the way back)
		if (id === 'connect' && !editing) return items;
		items.push(
			{ section: '' },
			id === 'connect'
				? editing?.connect === false
					? { label: 'Show cluster', action: () => editing && (editing = { ...editing, connect: true }) }
					: { label: 'Hide cluster', tooltip: 'Hide the Connect bar ("+ Connect" brings it back)', action: () => editRemove(CONNECT) }
				: clusterHidden(id, cl)
					? { label: 'Show cluster', tooltip: id === 'touch' ? 'Show these buttons beside the logo (Touch tools on)' : undefined, action: () => showCluster(id) }
					: {
							label: 'Hide cluster',
							tooltip: id === 'bar' ? 'The toolbar holds Play — it cannot be hidden' : id === 'budget' ? 'Hide the budget chip (Customize toolbar… or Show all brings it back)' : 'Hide these buttons (Show all brings them back)',
							disabled: id === 'bar',
							action: () => hideCluster(id)
						},
			{
				label: 'Show all',
				tooltip: 'Bring back every hidden cluster',
				disabled: !anyHidden,
				action: () => showAllClusters()
			}
		);
		return items;
	}
	function rotateCluster(id: string) {
		const c = liveClusters[id] ?? {};
		const rotated = !c.rotated;
		if (id === 'bar') {
			// a vertical bar lives on a screen edge: it takes the left edge, half way down, unless it has a place
			const atVerticalHome = c.x === BAR_VERTICAL_HOME.x && c.y === BAR_VERTICAL_HOME.y;
			if (rotated && typeof c.x !== 'number') setCluster(id, { rotated: true, ...BAR_VERTICAL_HOME });
			else if (!rotated && atVerticalHome) setCluster(id, { rotated: false, x: undefined, y: undefined, a: undefined });
			else setCluster(id, { rotated });
		} else setCluster(id, { rotated });
		tick().then(layoutClusters);
	}
	function resetClusterPosition(id: string) {
		// a vertical bar's start is the left edge, half way down; every other cluster's is its home
		if (id === 'bar' && isRotated('bar')) setCluster(id, { ...BAR_VERTICAL_HOME });
		else setCluster(id, { x: undefined, y: undefined, a: undefined });
		if (id === 'bar' && controlsLayout.posX != null) setLayout({ posX: null });
		tick().then(layoutClusters);
	}
	function resetAllPositions() {
		for (const id of CLUSTERS) if (liveClusters[id] && (typeof liveClusters[id].x === 'number')) resetClusterPosition(id);
		if (controlsLayout.posX != null) setLayout({ posX: null });
	}
	function showAllClusters() {
		for (const id of CLUSTERS) if (id !== 'connect' && clusterHidden(id)) showCluster(id);
		if (editing && editing.connect === false) editing = { ...editing, connect: true };
	}
	/** 45 N2: the row beside the logo shows / hides through the Touch tools setting (drafted while editing) */
	function showCluster(id: string) {
		if (liveClusters[id]?.hidden) setCluster(id, { hidden: false });
		if (id !== 'touch' || ($touchTools && touchShowDraft !== false)) return;
		if (editing) touchShowDraft = true;
		else touchTools.set(true);
	}
	function hideCluster(id: string) {
		if (id !== 'touch') return setCluster(id, { hidden: true });
		if (editing) touchShowDraft = false;
		else touchTools.set(false);
	}

	/** a cluster's grip in Edit positions: drag = move the cluster, tap / right-click = its menu */
	function clusterGrip(node: HTMLElement, id: string) {
		let current = id;
		let from: { x: number; y: number } | null = null;
		let press: PointerEvent | null = null;
		const done = () => {
			from = null;
			press = null;
			window.removeEventListener('pointermove', onMove);
			window.removeEventListener('pointerup', onUp);
			window.removeEventListener('pointercancel', done);
		};
		const onMove = (e: PointerEvent) => {
			if (!from || !press) return;
			if (Math.abs(e.clientX - from.x) + Math.abs(e.clientY - from.y) < DRAG_SLOP) return;
			e.preventDefault();
			grabId = current;
			const opened = clusterGrab.begin(press);
			done();
			if (opened) clusterGrab.move(e);
		};
		const onUp = (e: PointerEvent) => {
			const tap = !!from;
			done();
			if (tap) {
				const r = node.getBoundingClientRect();
				openClusterMenu(current, Math.round(r.left), Math.round(r.bottom));
				e.preventDefault();
			}
		};
		const onDown = (e: PointerEvent) => {
			if ((e.button ?? 0) !== 0 || clusterGrab.active()) return;
			// 48 F1: the budget chip's outline carries its own "−" / "+" — a press there is that button's
			if ((e.target as Element | null)?.closest?.('.hud-edit-remove, .hud-edit-add')) return;
			e.stopPropagation();
			try {
				node.releasePointerCapture?.(e.pointerId);
			} catch {
				// not captured
			}
			from = { x: e.clientX, y: e.clientY };
			press = e;
			window.addEventListener('pointermove', onMove, { passive: false });
			window.addEventListener('pointerup', onUp);
			window.addEventListener('pointercancel', done);
		};
		const menu = (e: MouseEvent) => {
			e.preventDefault();
			e.stopPropagation();
			openClusterMenu(current, e.clientX, e.clientY);
		};
		node.addEventListener('pointerdown', onDown);
		node.addEventListener('contextmenu', menu);
		return {
			update(next: string) {
				current = next;
			},
			destroy() {
				done();
				node.removeEventListener('pointerdown', onDown);
				node.removeEventListener('contextmenu', menu);
			}
		};
	}
	/** where each cluster's grip is drawn: centred above it (below it when it is at the top of the screen, beside a
	 *  vertical one) — or, when that spot is taken (the bar's round ✓, a cluster, an earlier grip, the screen edge), the next of a
	 *  few spots around the cluster: a grip on the ✓ ate the tap that applies the edit (unfolded, a full right corner) */
	const gripPlaces = $derived.by(() => {
		const out: Record<string, { x: number; y: number }> = {};
		if (typeof window === 'undefined') return out;
		// hud.css's .cl-grip sizes (a finger's grip is larger)
		const coarse = !!window.matchMedia?.('(pointer: coarse)').matches;
		const GRIP_W = coarse ? 40 : 28;
		const GRIP_H = coarse ? 26 : 18;
		const vw = window.innerWidth;
		const vh = window.innerHeight;
		// the ✓, the edit hint and every cluster's buttons are taken (a finger there would take the grip)
		const fixed = ['toolbar-edit-apply', 'toolbar-edit-hint'].map((id) => shown(document.getElementById(id))).filter((b): b is Box => !!b);
		const taken: Box[] = [...fixed, ...Object.values(clusterRects)];
		const at = (x: number, y: number): Box => ({ left: x - GRIP_W / 2, top: y - GRIP_H / 2, right: x + GRIP_W / 2, bottom: y + GRIP_H / 2 });
		const fits = (b: Box) => b.left >= 2 && b.top >= 2 && b.right <= vw - 2 && b.bottom <= vh - 2 && !taken.some((t) => overlaps(b, t, 4));
		for (const [id, r] of Object.entries(clusterRects)) {
			const vertical = id !== 'connect' && isVertical(id);
			const cx = (r.left + r.right) / 2;
			const cy = (r.top + r.bottom) / 2;
			const above = r.top - GRIP_H / 2 - 5;
			const below = r.bottom + GRIP_H / 2 + 5;
			const before = r.left - GRIP_W / 2 - 4;
			const after = r.right + GRIP_W / 2 + 4;
			const near = r.left + GRIP_W / 2;
			const far = r.right - GRIP_W / 2;
			const leftHalf = cx < vw / 2;
			const tries: [number, number][] = vertical
				? [[leftHalf ? after : before, cy], [leftHalf ? before : after, cy], [cx, above], [cx, below]]
				: [[cx, r.top >= 34 ? above : below], [cx, r.top >= 34 ? below : above], [leftHalf ? near : far, above], [leftHalf ? far : near, above], [before, cy], [after, cy]];
			const pick = tries.find(([x, y]) => fits(at(x, y))) ?? tries[0];
			out[id] = { x: pick[0], y: pick[1] };
			taken.push(at(pick[0], pick[1]));
		}
		return out;
	});
	function gripStyle(id: string) {
		const g = gripPlaces[id];
		return g ? `left: ${Math.round(g.x)}px; top: ${Math.round(g.y)}px` : 'display: none';
	}
	/** the clusters' rects while editing (read every frame by the edit loop, with the Connect outline) */
	function measureClusters() {
		const next: Record<string, Box> = {};
		for (const id of CLUSTERS) {
			if (id === 'connect' && editing?.connect === false) continue;
			const b = shown(clusterEl(id));
			if (b) next[id] = b;
		}
		const prev = clusterRects;
		const same =
			Object.keys(next).length === Object.keys(prev).length &&
			Object.entries(next).every(([k, b]) => prev[k] && Math.abs(prev[k].left - b.left) < 0.5 && Math.abs(prev[k].top - b.top) < 0.5 && Math.abs(prev[k].right - b.right) < 0.5 && Math.abs(prev[k].bottom - b.bottom) < 0.5);
		if (!same) clusterRects = next;
	}

	/** the edit button's label, for the a11y tree and the tooltip */
	function editLabel(id: string) {
		return labelOf(id);
	}
	/** what a stack shows while editing: its items, then ONE "+" for the next place while it has
	 *  room (42 I9, the user's "show + only for further buttons to place" — a fourth once three are
	 *  placed, never a column of empty places) */
	function stackSlots(list: string[]) {
		return list.length < SIDE_MAX ? [...list, '__empty:0'] : [...list];
	}
	/** the corner stacks as rendered: the draft while editing, the record otherwise */
	const stackLeft = $derived.by(() => (editing ? editing.left : controlsLayout.left));
	const stackRight = $derived.by(() => (editing ? editing.right : controlsLayout.right));
	// 42 I9: the top-right group and the touch tools — drawn by Users / TouchTools (their natives)
	// and by Controls (their placeholders while editing, and any other button placed there)
	const stackTop = $derived.by(() => (editing ? editing.top : controlsLayout.top));
	const stackTouch = $derived.by(() => (editing ? editing.touch : controlsLayout.touch));
	$effect(() => {
		// 43 K3: + whether the Connect pill shows (the draft's while editing — the pill hides the moment its
		// "−" is pressed, and the "+" in its place brings it back)
		const connect = editing ? editing.connect !== false : controlsLayout.connect !== false;
		toolbarSlots.set({ top: [...stackTop], touch: [...stackTouch], editing: editing !== null, connect, clusters: liveClusters });
	});
	/** the buttons of a group Controls draws in it outside Edit positions (not the natives) */
	const topExtras = $derived(stackTop.filter((id) => !TOP_NATIVE.includes(id)));
	const touchExtras = $derived(stackTouch.filter((id) => !TOUCH_NATIVE.includes(id)));

	/** 42 I9: move a node into another component's element (the top-right group, the touch tools)
	 *  — a display:contents wrapper, so its children become that group's flex items and take their
	 *  CSS `order` among the group's own buttons. The target may mount after this component, so
	 *  the action retries for a few frames; the wrapper is the ONLY node of its `{#if}`, which is
	 *  what lets svelte remove it wherever it now lives. */
	function portalTo(node: HTMLElement, selector: string) {
		let raf = 0;
		let tries = 0;
		const place = () => {
			const target = document.querySelector(selector);
			if (target) {
				if (node.parentElement !== target) target.appendChild(node);
				return;
			}
			if (tries++ < 240) raf = requestAnimationFrame(place);
		};
		place();
		return {
			destroy() {
				cancelAnimationFrame(raf);
				node.remove();
			}
		};
	}

	/** 44 M13: while Edit positions runs, the corner stacks sit BESIDE any open sidebar, like the edit bar (J8) and the
	 *  row beside the logo — their placeholders used to stay in the corner, under an open column */
	$effect(() => {
		if (typeof document === 'undefined') return;
		const g = $sidebarGeometry;
		const on = editing !== null && !!g?.wide;
		const root = document.documentElement;
		root.classList.toggle('hud-edit-beside', on);
		root.style.setProperty('--sb-open-left', on && g.left.shown ? g.leftX + g.left.w + 'px' : '0px');
		root.style.setProperty('--sb-open-right', on && g.right.shown ? g.right.w + 'px' : '0px');
	});

	/** the pill no longer owns the corners' heights, so the opt-in sim transport rides above
	 *  whatever the right stack holds (0..3 buttons) instead of a fixed 112px */
	$effect(() => {
		if (typeof document === 'undefined') return;
		const n = stackRight.length + (editing && stackRight.length < SIDE_MAX ? 1 : 0);
		document.documentElement.style.setProperty('--hud-stack-right-n', String(n));
	});

	// --- the toolbar's own right-click menus --------------------------------------
	// `cellMenu` generalises 4a's `playModeMenu`: a DIRECT `contextmenu` listener,
	// because svelte DELEGATES event attributes to the app root and the Controls chrome
	// is exactly the kind of ancestor that swallows them on the way up. Every cell
	// opens the same shared ContextMenu, and opening one closes the other two — one
	// menu on screen at a time.
	let toolbarMenu: { x: number; y: number; id: string } | null = $state(null);
	let customizeMenu: { x: number; y: number } | null = $state(null);
	/** 43 J10: the "»" menu of the cells that do not fit */
	let overflowMenu: { x: number; y: number } | null = $state(null);

	// 41 G1: a LONG PRESS opens the same menu on touch, by its own timer. Android raises a
	// `contextmenu` for a held finger and iOS never does (the W1 hatch existed for exactly that),
	// so relying on the browser left iPhones with no way into any toolbar menu — "Edit positions"
	// included. The timer opens it everywhere; the browser's own contextmenu that follows on
	// Android is then the SAME gesture and is swallowed instead of opening the menu twice.
	const LONG_PRESS_MS = 500;
	let longPressAt = 0;
	function cellMenu(node: HTMLElement, id: string) {
		const openAt = (x: number, y: number) => {
			playMenu = null;
			customizeMenu = null;
			overflowMenu = null;
			lastMenuAt = { x, y };
			toolbarMenu = { x, y, id };
		};
		const open = (e: MouseEvent) => {
			e.preventDefault();
			e.stopPropagation();
			if (editing) {
				// 44 M12b: in Edit positions a right-click opens the CLUSTER's menu (a held finger is a drag — the
				// long press there is editItemGesture's / the grip's)
				const cid = clusterAt(e.target as Element | null);
				if (cid && (e as PointerEvent).pointerType !== 'touch' && performance.now() - longPressAt > 1200) openClusterMenu(cid, e.clientX, e.clientY);
				return;
			}
			if (performance.now() - longPressAt < 1200) return; // already opened by the hold
			openAt(e.clientX, e.clientY);
		};
		let timer = 0;
		let fired = false;
		let from: { x: number; y: number } | null = null;
		const stop = () => {
			clearTimeout(timer);
			// the lift that ends a hold must not ALSO press the button it was held on — only THAT
			// button: a quick tap on the menu the hold just opened is a real press
			if (fired) {
				const eat = (ev: MouseEvent) => {
					if (!node.contains(ev.target as Node)) return;
					ev.stopPropagation();
					ev.preventDefault();
				};
				window.addEventListener('click', eat, true);
				setTimeout(() => window.removeEventListener('click', eat, true), 700);
			}
			fired = false;
			from = null;
			window.removeEventListener('pointermove', moved);
			window.removeEventListener('pointerup', stop);
			window.removeEventListener('pointercancel', stop);
		};
		const moved = (e: PointerEvent) => {
			if (from && Math.abs(e.clientX - from.x) + Math.abs(e.clientY - from.y) >= DRAG_SLOP) stop();
		};
		const down = (e: PointerEvent) => {
			if (e.pointerType === 'mouse' || editing) return;
			// 43 J8: the bar's own box opens its menu only from a GAP — a press on a cell is that
			// cell's (its own timer runs), and this listener sees it only because it bubbles
			if (id === BAR && (e.target as Element | null)?.closest?.('button, p')) return;
			stop();
			from = { x: e.clientX, y: e.clientY };
			const at = from;
			timer = window.setTimeout(() => {
				from = null; // the hold is decided: travel no longer cancels it
				if (editing || toolbarGrab.active()) return stop();
				fired = true;
				longPressAt = performance.now();
				openAt(at.x, at.y);
			}, LONG_PRESS_MS);
			window.addEventListener('pointermove', moved);
			window.addEventListener('pointerup', stop);
			window.addEventListener('pointercancel', stop);
		};
		node.addEventListener('contextmenu', open);
		node.addEventListener('pointerdown', down);
		return {
			destroy: () => {
				stop();
				node.removeEventListener('contextmenu', open);
				node.removeEventListener('pointerdown', down);
			}
		};
	}

	/** the mode the Explorer is in — panelToggles' own `opensDocked` rule, READ rather
	 *  than duplicated, so the two rows can say which one is on. `setDocked` keeps this
	 *  flag in step with the panel, so it is the honest answer either way. */
	function explorerOpensDocked(): boolean {
		return typeof localStorage === 'undefined' || safeStorage.getItem('explorerDocked') !== 'false';
	}

	/** Move the Explorer between dock tab and floating window.
	 *
	 *  It would be tempting to write `explorerDocked` here and reopen through
	 *  `togglePanel`, and it is MEASURABLY inert: the panel reads that flag exactly
	 *  ONCE, at mount, into component-local state, so nothing moves until the next
	 *  reload — closing and reopening does not help, because the component stays
	 *  mounted the whole time. The panel owns the mode (flag + render branch + dock
	 *  occupancy in one function), so we ASK and it acts — the write-once arm store it
	 *  already uses for the inline scene-save request.
	 *
	 *  W5: that arm is `dockModeArm` now — the same seam keyed by DOCK KEY, so the tab
	 *  strip's context menu can undock any tab through it. This row just names its own. */
	function setExplorerMode(docked: boolean) {
		armDockMode('explorer', docked);
	}

	/** the toolbar's "…" (an action: this file's on: directives and the onclick attribute cannot mix) */
	function openCustomizeOnClick(node: HTMLElement) {
		node.addEventListener('click', openCustomize);
		return { destroy: () => node.removeEventListener('click', openCustomize) };
	}
	function openCustomize() {
		// anchored to the BAR, not the pointer: this menu is about the whole toolbar.
		// ContextMenu measures itself and clamps into the viewport, so a bar sitting on
		// the bottom edge gets a menu that opens upward with no arithmetic here.
		const rect = document.getElementById('controls-pill')?.getBoundingClientRect();
		customizeMenu = { x: Math.round(rect?.left ?? 8), y: Math.round(rect?.top ?? 8) };
		// an armed move opened from HERE takes the bar's own corner as its origin —
		// `lastMenuAt` is only ever the point the user's gesture last named
		lastMenuAt = { x: customizeMenu.x, y: customizeMenu.y };
	}

	/** The tail EVERY toolbar menu carries — the play FAB's mode menu included, which
	 *  is why `id` may be null: the FAB is not a roster entry, so it is never offered
	 *  "Hide button" and its Move left / Move right walk the well instead. */
	function toolbarTail(id: string | null) {
		// 43 J2/J8: two ids that are not cells of the row — the trailing "…" (MORE) and the bar's own
		// box (BAR: a gap between cells, the padding, a corner stack's gap). Neither walks the row,
		// so neither is offered Move left / Move right; only the "…" can be hidden.
		const special = id === MORE || id === BAR;
		// a plain `const` the closures below capture: TS does not carry a narrowing of
		// a PARAMETER into a nested arrow, so `id!` or a cast would be the alternative
		const target = special ? '' : (id ?? '');
		// the FAB is the WELL on the visual row, so both kinds of cell ask the same
		// question of the same sequence — one rule, no second index arithmetic
		const cell = target || SPACER;
		const seq = visualIds();
		const at = seq.indexOf(cell);
		const collapsed = controlsLayout.collapsed;
		return [
			{ section: 'Toolbar' },
			// 41 G1: first, because it is the one row that does everything below it by hand
			{
				label: 'Edit positions',
				tooltip: 'Drag the buttons into place, remove them with − or add with + — ✓ applies, Escape cancels',
				action: () => enterEditPositions(id === MORE ? MORE : target || (special ? null : SPACER))
			},
			...(special ? [] : [{
				label: 'Move left',
				tooltip: target
					? 'One place left — past the play button when it is next'
					: 'Move the play button one place left',
				disabled: collapsed || at <= 0,
				action: () => moveCell(cell, -1)
			},
			{
				label: 'Move right',
				tooltip: target
					? 'One place right — past the play button when it is next'
					: 'Move the play button one place right',
				disabled: collapsed || at < 0 || at >= seq.length - 1,
				action: () => moveCell(cell, 1)
			}]),
			...(id === MORE
				? [
						{
							label: 'Hide button',
							tooltip: 'Take the "…" off the bar — Customize toolbar (any button\'s right-click menu) brings it back',
							action: () => setLayout({ more: false })
						}
					]
				: []),
			...(target
				? [
						{
							label: 'Hide button',
							tooltip: 'Take it off the bar — Customize toolbar brings it back',
							action: () => hideButton(target)
						}
					]
				: []),
			// W8a: the same move a drag performs, for whoever got here by long press or
			// by keyboard. Disabled — with the reason — when the track is too narrow to
			// hold the bar anywhere but the middle, which is the phone case.
			{
				label: 'Move toolbar',
				tooltip: barPlaced
					? 'Move the bar anywhere — it snaps to the edges and the other buttons'
					: track.ok
						? 'Slide the bar along the bottom — click to place it, arrows nudge, Escape puts it back'
						: 'The screen has no room to move the bar — it stays centred',
				disabled: !track.ok && !barPlaced,
				action: () => armMoveToolbar()
			},
			{
				label: 'Reset toolbar position',
				tooltip: 'Put the bar back in the middle',
				disabled: controlsLayout.posX == null && !barPlaced,
				action: () => (barPlaced ? resetClusterPosition('bar') : setLayout({ posX: null }))
			},
			// the z-order pref, surfaced where the toolbar itself is (the Settings row
			// stays; this is the same store, so the two can never disagree). Checked at
			// menu-open is enough — the row closes the menu, so it never shows stale.
			{
				label: 'Always on top',
				tooltip: $toolbarAlwaysOnTop
					? 'The bar paints over the dock and floating windows — click to let them cover it'
					: 'Floating windows and the dock cover the bar (the default) — click to keep it on top',
				checked: $toolbarAlwaysOnTop,
				action: () => toolbarAlwaysOnTop.update((v) => !v)
			},
			// 42 I10: the two "lift above docked panels" prefs, beside Always on top (the user's
			// place for them): the bar's (`floatingToolbar`, the Settings row of the same name) and
			// the corner stacks' (`hudStackLift`, new, off by default). Both are the same stores as
			// Settings ▸ Interface ▸ Windows & chrome, so the two places cannot disagree.
			{
				label: 'Lift toolbar above docked panels',
				tooltip: $floatingToolbar
					? 'The bar moves up when a panel is docked at the bottom — click to keep it on the floor'
					: 'A docked panel covers the bar — click to make the bar move up above it',
				checked: $floatingToolbar,
				action: () => floatingToolbar.update((v) => !v)
			},
			{
				label: 'Lift corner buttons above docked panels',
				tooltip: $hudStackLift
					? 'The round corner buttons move up when a panel is docked — click to keep them on the floor'
					: 'A docked panel covers the round corner buttons (the default) — click to move them up above it',
				checked: $hudStackLift,
				action: () => hudStackLift.update((v) => !v)
			},
			// W1: the chevron cell is gone, so this row IS the way out of a collapsed
			// bar — which is why it swaps rather than sitting beside a second entry
			collapsed
				? {
						label: 'Expand toolbar',
						tooltip: 'Bring the whole bar back',
						action: () => setLayout({ collapsed: false })
					}
				: {
						label: 'Collapse toolbar',
						tooltip: 'Shrink the bar down to the play button',
						action: () => setLayout({ collapsed: true })
					},
			{ label: 'Customize toolbar…', tooltip: 'Choose which buttons the bar shows', action: () => openCustomize() }
		];
	}

	function cellMenuItems(id: string) {
		// 43: the "…" and the bar's own box carry the Toolbar rows alone
		if (id === MORE || id === BAR) return toolbarTail(id);
		const head: any[] = [];
		if (id === 'flow') {
			// This used to carry the dock's shared "+" list (`dockAddItems`) as an
			// "Add a view" section. It is GONE from here, and ONLY from here — the list
			// itself is unchanged and still renders in the two places that own the
			// gesture: the docked tab strip's ＋ and the floating Node editor header's ＋.
			// Adding a view is something you do TO the dock, and both of those buttons
			// sit on the dock; a third copy hanging off a toolbar cell's right-click menu
			// put six rows of noise in front of the two rows this menu exists for.
			head.push(
				{ section: 'Node editor' },
				{ label: 'Open Node editor', tooltip: 'Show or hide the graph editor (N)', action: () => togglePanel('flow') }
			);
		}
		if (id === 'explorer') {
			head.push(
				{ section: 'Explorer' },
				{
					label: 'Open as dock tab',
					checked: explorerOpensDocked(),
					tooltip: 'Show the library along the bottom, beside the other dock tabs',
					action: () => setExplorerMode(true)
				},
				{
					label: 'Open as floating window',
					checked: !explorerOpensDocked(),
					tooltip: 'Show the library in a window you can move and resize',
					action: () => setExplorerMode(false)
				}
			);
		}
		// W8b: SWAP WITH ▸ — trade this cell for any roster button that is not on the bar.
		// It is the fast way to get a one-press button for a dock view: the alternative
		// is Customize, tick the view, then walk it across the bar with the arrows. The
		// bar keeps its shape, so nothing else moves and the well stays put.
		//
		// The list is built from the same `DOCK_VIEWS` the "+" menu renders (through
		// `BUTTONS`), so the two can never offer different sets. The transforms take part
		// as both sources and targets: a cell is a cell, Customize already treats all
		// seven identically, and a user who never rotates anything should be able to
		// trade Rotate for the Animation tab — excluding them would leave a Rotate cell
		// with a submenu that is always empty, which is worse than a menu that works.
		head.push({ section: 'This button' }, { label: 'Swap with', children: swapItems(id) });
		return [...head, ...toolbarTail(id)];
	}

	/** the swap targets: every roster button that is not currently a cell of the bar */
	function swapItems(id: string) {
		// 41 G1: everything not placed anywhere (the corners count as placed)
		const at = regionOf(controlsLayout, id);
		// 42 I9: a home-only button can only be swapped in where it may live
		const offBar = ROSTER_IDS.filter((key) => BUTTONS[key] && !regionOf(controlsLayout, key) && (!HOME_ONLY[key] || HOME_ONLY[key] === at));
		if (!offBar.length)
			return [
				{
					label: 'Every button is on the bar',
					tooltip: 'There is nothing left to swap in — hide one first',
					disabled: true
				}
			];
		return offBar.map((key) => ({
			label: labelOf(key),
			tooltip: `Put ${labelOf(key)} in this slot and take ${labelOf(id)} off the bar`,
			action: () => swapCell(id, key)
		}));
	}

	/** The whole-bar checklist. Every row here is `keepOpen` — this menu is a PANE you
	 *  work through, not a command you pick, and the first version dismissed itself on
	 *  the first toggle. That only works because the array is DERIVED (below): a row's
	 *  action writes the layout, the derived rebuilds, and ContextMenu re-renders the
	 *  same open menu with the new checks, arrows and disabled states.
	 *
	 *  Reordering lives on the ROW as a ‹ › pair rather than as menu commands: the row
	 *  already means "this button", and a per-row control is the only way to say
	 *  "move THIS one" without the list growing a second entry per button. They move
	 *  one VISUAL slot, the same rule as the cell menu's Move left / Move right, so a
	 *  press can walk a button across the play well. */
	function customizeItems() {
		// W8b: THE LIST *IS* THE BAR, read top to bottom — the play well included, as a
		// row of its own. Three measured faults came out of the old shape, which listed
		// `controlsLayout.order` (the STORAGE order, hidden entries interleaved) while a
		// move only ever swapped SHOWN buttons:
		//   · a move leapfrogged any hidden row lying between the two, so one press
		//     travelled two or more rows and the ticks appeared to scramble around the
		//     unticked one — the reported "keep enabled ... there is a mess"
		//   · pressing an arrow whose neighbour was the WELL rewrote only `spacerIndex`,
		//     so the list did not change at all and the press looked dead
		//   · the rows re-sorted under a stationary pointer, so a second press at the
		//     same pixel grabbed the button that had just taken the slot and undid the
		//     first — the two ping-ponged forever and nothing could be walked anywhere
		// Rows now mirror `visualIds()` exactly, so ONE press is ALWAYS one row, in the
		// direction pressed, and the row travels with its own DOM node (ContextMenuItems
		// keys on `key`), which keeps it focused for a repeat press.
		//
		// UP IS LEFT. The list is vertical and the bar is horizontal, so the arrows are
		// ▲/▼ — what a stacked list means — and up is toward the LEFT end of the bar,
		// which is the end the first row shows. Every tooltip says so out loud.
		const seq = visualIds();
		// 41 G1: "not on the bar" = placed NOWHERE (the corner stacks have their own sections)
		const offBar = ROSTER_IDS.filter((id) => BUTTONS[id] && !regionOf(controlsLayout, id));
		/** 42 I9: a top-right / touch-tools row — the group reads left → right, so ▲ is one place
		 *  LEFT (earlier) and ▼ one place right, the bar's own up-is-left rule */
		const groupRows = (side: 'top' | 'touch') => {
			const list = controlsLayout[side];
			return list.map((id, at) => ({
				key: id,
				label: labelOf(id),
				checked: true,
				keepOpen: true,
				tooltip: side === 'top' ? 'Take it out of the top-right group' : 'Take it out of the touch tools',
				action: () => hideButton(id),
				rowActions: [
					{ icon: 'chevron-up', label: `Move ${labelOf(id)} up`, tooltip: 'One place left', disabled: at <= 0, run: () => moveInStack(id, 'ArrowLeft') },
					{ icon: 'chevron-down', label: `Move ${labelOf(id)} down`, tooltip: 'One place right', disabled: at >= list.length - 1, run: () => moveInStack(id, 'ArrowRight') }
				]
			}));
		};
		/** 41 G1: a corner row — ▲ moves it up the stack, ▼ down (the stack reads bottom → top) */
		const cornerRows = (side: 'left' | 'right') => {
			const list = controlsLayout[side];
			return [...list].reverse().map((id) => {
				const at = list.indexOf(id);
				return {
					key: id,
					label: labelOf(id),
					checked: true,
					keepOpen: true,
					tooltip: 'Take it off the corner',
					action: () => hideButton(id),
					rowActions: [
						{ icon: 'chevron-up', label: `Move ${labelOf(id)} up`, disabled: at >= list.length - 1, run: () => moveInStack(id, 'ArrowUp') },
						{ icon: 'chevron-down', label: `Move ${labelOf(id)} down`, disabled: at <= 0, run: () => moveInStack(id, 'ArrowDown') }
					]
				};
			});
		};
		/** 43 J2: the "…" row — a checkbox like any button's, its arrows greyed because it always sits
		 *  at the bar's end */
		const moreRow = () => {
			const on = controlsLayout.more !== false;
			return {
				key: MORE,
				label: MORE_LABEL,
				checked: on,
				keepOpen: true,
				tooltip: on
					? 'Take the "…" off the bar — this list stays one right-click away on any button'
					: 'Put the "…" back at the end of the bar',
				action: () => setLayout({ more: !on }),
				rowActions: [
					{ icon: 'chevron-up', label: 'Move … up', tooltip: 'The "…" always sits at the end of the bar', disabled: true },
					{ icon: 'chevron-down', label: 'Move … down', tooltip: 'The "…" always sits at the end of the bar', disabled: true }
				]
			};
		};
		/** the reorder pair for a row that is ON the bar */
		const arrows = (id: string, at: number, title: string) => [
			{
				icon: 'chevron-up',
				label: `Move ${title} up`,
				disabled: at <= 0,
				run: () => moveCell(id, -1)
			},
			{
				icon: 'chevron-down',
				label: `Move ${title} down`,
				disabled: at < 0 || at >= seq.length - 1,
				run: () => moveCell(id, 1)
			}
		];
		return [
			// 41 G1: the drag-and-drop way to do everything this list does
			{
				key: '__edit',
				label: 'Edit positions…',
				tooltip: 'Drag the buttons into place on the bar itself — ✓ applies, Escape cancels',
				action: () => enterEditPositions(null)
			},
			{ section: 'On the bar' },
			...seq.map((id, at) => {
				if (id === SPACER)
					// the well earns a row because it is a cell of the bar and the list claims
					// to mirror the bar. It also gives the play button a reorder control that
					// only its own right-click menu used to offer. No toggle: there is no
					// toolbar without a way to press play, so the row says so and does nothing.
					return {
						key: SPACER,
						label: 'Play',
						checked: true,
						keepOpen: true,
						tooltip: 'The play button is always on the bar — it can be moved, never removed',
						rowActions: arrows(SPACER, at, 'Play')
					};
				return {
					key: id,
					label: labelOf(id),
					checked: true,
					keepOpen: true,
					tooltip: 'Take it off the bar',
					action: () => hideButton(id),
					rowActions: arrows(id, at, labelOf(id))
				};
			}),
			...(controlsLayout.more !== false ? [moreRow()] : []),
			// Everything the roster knows that is not on the bar — the buttons hidden from
			// the six defaults AND the optional dock views, which is what makes those
			// discoverable at all. A row here has no place in the bar yet, so it has no
			// direction to move in: its arrows are greyed and say why rather than being
			// absent, which would make the two halves of the list look like different
			// kinds of row.
			...(controlsLayout.left.length ? [{ section: 'Left corner' }, ...cornerRows('left')] : []),
			...(controlsLayout.right.length ? [{ section: 'Right corner' }, ...cornerRows('right')] : []),
			...(controlsLayout.top.length ? [{ section: 'Top right' }, ...groupRows('top')] : []),
			...(controlsLayout.touch.length ? [{ section: $touchTools ? 'Touch tools' : 'Touch tools (shown while Touch tools is on)' }, ...groupRows('touch')] : []),
			// 43 K3: the Connect pill — shown or hidden, never moved
			{ section: 'Top' },
			{
				key: CONNECT,
				label: CONNECT_LABEL,
				checked: controlsLayout.connect !== false,
				keepOpen: true,
				tooltip: controlsLayout.connect !== false ? 'Hide the Connect bar at the top of the screen' : 'Show the Connect bar at the top of the screen',
				action: () => setLayout({ connect: controlsLayout.connect === false })
			},
			// 48 F1: the budget chip beside the toolbar — shown or hidden (moved in Edit positions)
			{
				key: BUDGET,
				label: 'Budget chip',
				checked: !controlsLayout.clusters?.budget?.hidden,
				keepOpen: true,
				tooltip: controlsLayout.clusters?.budget?.hidden ? 'Show the scene budget chip beside the toolbar' : 'Hide the scene budget chip beside the toolbar',
				action: () => setCluster('budget', { hidden: !controlsLayout.clusters?.budget?.hidden })
			},
			...(offBar.length || controlsLayout.more === false
				? [
						{ section: 'Not on the bar' },
						...(controlsLayout.more === false ? [moreRow()] : []),
						...offBar.map((id) => ({
							key: id,
							label: labelOf(id),
							checked: false,
							keepOpen: true,
							// 42 I9: where a press puts it — its own group for the top-right / touch buttons
							tooltip: HOME_ONLY[id] === 'top' || TOP_DEFAULT.includes(id) ? 'Put it back in the top-right group' : TOUCH_DEFAULT.includes(id) ? 'Put it back in the touch tools' : 'Put it on the bar',
							action: () => showButton(id),
							rowActions: [
								{
									icon: 'chevron-up',
									label: `Move ${labelOf(id)} up`,
									tooltip: 'Not on the bar — there is nowhere to move it',
									disabled: true
								},
								{
									icon: 'chevron-down',
									label: `Move ${labelOf(id)} down`,
									tooltip: 'Not on the bar — there is nowhere to move it',
									disabled: true
								}
							]
						}))
					]
				: []),
			{ section: '' },
			{
				key: '__reset',
				label: 'Reset toolbar',
				danger: true,
				keepOpen: true,
				tooltip: 'Back to the default buttons, corners included, in their default places',
				action: resetLayout
			}
		];
	}

	/** 41 G1: one step up/down a corner stack, through the same placements the edit mode uses */
	function moveInStack(id: string, key: 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight') {
		setLayout(fromPlacements(controlsLayout, stepItem(placements(controlsLayout, HOME_ONLY), id, key)));
	}

	/** the reactive half of `keepOpen`: passing `customizeItems()` inline would already
	 *  re-run inside the template's render effect, but the menu's whole point is that
	 *  the rows track the record, so the dependency is stated here rather than implied
	 *  by where the call happens to sit */
	const customizeMenuItems = $derived(customizeItems());

	// ── W8a: THE BAR MOVES ─────────────────────────────────────────────────────────
	/** The corner HUD clusters the bar may not slide under. MEASURED, never assumed:
	 *  their positions differ by breakpoint (ui.css lifts chat/AI to bottom:74px and the
	 *  mic / "+" to 122px at <=600px, precisely so they clear this bar) and three of the
	 *  five are conditional — `#sim-controls` is an opt-in setting, `#mic-button` belongs
	 *  to VoiceChat and any of them can be absent in a stripped build. Connect's
	 *  `measureDock()` is the same shape one domain over. */
	// 41 G1: the round buttons live in the two corner STACKS now (whatever they hold)
	// (each BUTTON is measured, not the stack box: a stack is as tall as what it holds, so its
	// box would read the upper buttons as sharing the bar's row)
	const TOOLBAR_NEIGHBOURS = ['#hud-stack-left > *', '#hud-stack-right > *', '#sim-controls'];
	const EDGE_MARGIN = 8; // breathing room against a neighbour and against the viewport
	const SNAP_PX = 24; // how near the middle still counts as the middle
	const DRAG_SLOP = 6; // travel that turns a press into a move
	const EDIT_APPLY_OVERHANG = 18; // 43 J8: how far Edit positions' ✓ reaches past the bar's right edge (hud.css)

	/** the reachable band for the bar's CENTRE, in client px. `ok` is false when the
	 *  track is narrower than the bar itself (a phone with the buttons beside it): there
	 *  is then no position to choose, so the bar centres and the move gesture stands
	 *  down rather than offering a drag that cannot go anywhere. */
	let track = $state({ min: 0, max: 0, mid: 0, ok: false });
	/** 43 J8/J10: the band the bar may occupy (client px) — the viewport less the edge margins, a PINNED
	 *  sidebar and any corner button on the bar's row. `ok` once measured. */
	let barRoom = $state({ left: 0, right: 0, ok: false });
	/** 43 J10: the widths the overflow arithmetic needs, read off the live bar (hud.css owns them) */
	let barMetrics = $state({ chrome: 14, cell: 38, well: 56, gap: 2, tail: 47 });
	/** 43 J8: Edit positions' band — the viewport less EVERY open sidebar and the corners — and the edit
	 *  bar's width in it; the bar wraps to that width and slides only as far as it must to stay inside */
	let editPlace: { left: number; right: number; w: number } | null = $state(null);
	/** the live centre while a gesture runs; null the rest of the time, so the stored
	 *  fraction is the only source once it ends */
	let dragCentre: number | null = $state(null);
	let movingBar = $state(false);
	/** 44 M4: the move was armed from a menu (no button held) — the bar says how to place it */
	let movingModal = $state(false);
	/** a touch screen (the hint's words): read once — a device does not change its pointer mid-session */
	const coarsePointer = typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches;
	/** where the menu that armed a modal move was opened — the origin its pointer
	 *  offsets are measured from, since a menu action carries no event of its own */
	let lastMenuAt = { x: 0, y: 0 };
	let armNudge = 0;
	let trackRO: ResizeObserver | null = null;
	let observedKey = '';
	/** 44 L5: the observer's callback only SCHEDULES a measurement. `measureTrack` re-folds the bar
	 *  (J10), which resizes `#controls-pill` — an element this same observer watches — and svelte
	 *  flushes that DOM write in the microtask right after the callback, i.e. INSIDE the browser's
	 *  delivery pass. A size change at the depth just delivered cannot be delivered in that pass, so
	 *  Chromium raised "ResizeObserver loop completed with undelivered notifications" (the 1.34
	 *  report) every time the bar changed its own width at its fold edge (a pointer-type switch, a
	 *  zoom, a webfont landing). One frame later the write is an ordinary layout change. */
	let trackRaf = 0;
	function scheduleTrack() {
		if (trackRaf) return;
		trackRaf = requestAnimationFrame(() => {
			trackRaf = 0;
			measureTrack();
		});
	}

	/** Re-derive the track from the LIVE DOM. Every number here is read, none is coded:
	 *  a breakpoint constant would have to be kept in step with ui.css, and it could not
	 *  know whether the sim transport is switched on. */
	function measureTrack() {
		if (typeof window === 'undefined') return;
		const nav = document.getElementById('controls-pill');
		if (!nav) return;
		const pill = nav.getBoundingClientRect();
		if (!pill.width) return;
		const vw = window.innerWidth;
		if (barPlaced) {
			// 44 M12b: a placed bar has no bottom track; its room is the area's length along the bar (the folded
			// "»" budget) — across the area when horizontal, down it when vertical
			const a = clusterArea();
			const len = (isVertical('bar') ? a.bottom - a.top : a.right - a.left) - 2 * EDGE_MARGIN;
			if (editPlace) editPlace = null;
			measureBarMetrics(nav);
			if (barRoom.left !== 0 || barRoom.right !== len || !barRoom.ok) barRoom = { left: 0, right: len, ok: len > 0 };
			if (track.ok) track = { ...track, ok: false };
			return;
		}
		let left = EDGE_MARGIN;
		let right = vw - EDGE_MARGIN;
		// 43 J8: THE SIDEBARS. A PINNED column runs to the bottom edge, so the bar may never cross it —
		// a drag, Move toolbar and the overflow budget all stop at its edge; while Edit positions runs,
		// EVERY open column does (the user's "next to the sidebar, not on top of it"). The geometry is
		// 42 sidebars' store (`$lib/sidebars`), the same numbers its columns are drawn from.
		const sb = get(sidebarGeometry);
		if (sb?.wide) {
			if (sb.left.shown && (sb.left.full || editing)) left = Math.max(left, sb.leftX + sb.left.w + EDGE_MARGIN);
			if (sb.right.shown && (sb.right.full || editing)) right = Math.min(right, vw - sb.right.w - EDGE_MARGIN);
		}
		// the bar's ROW is its bottom bar-height: a wrapped edit bar is taller, and reading its whole box
		// would let a corner button ABOVE the row narrow the band it wraps into (and so on)
		const rowH = cssPx(getComputedStyle(document.documentElement).getPropertyValue('--hud-bar-h')) || pill.height;
		const rowTop = Math.max(pill.top, pill.bottom - rowH);
		const found: HTMLElement[] = [];
		for (const el of TOOLBAR_NEIGHBOURS.flatMap((sel) => [...document.querySelectorAll<HTMLElement>(sel)])) {
			found.push(el);
			const r = el.getBoundingClientRect();
			if (!r.width || !r.height) continue; // in the DOM but not rendered
			// ONLY a neighbour whose vertical band overlaps the bar's can be in the way,
			// and that one rule is why the <=600px lift needs no breakpoint of its own
			// here: at that width chat / AI / mic / "+" have moved ABOVE this row, so
			// they stop clamping and the bar gets the full width — measured, not coded.
			if (r.bottom <= rowTop || r.top >= pill.bottom) continue;
			if ((r.left + r.right) / 2 < vw / 2) left = Math.max(left, r.right + EDGE_MARGIN);
			else right = Math.min(right, r.left - EDGE_MARGIN);
		}
		observeNeighbours(nav, found);
		if (editing) {
			// 43 J8: the edit bar wraps into this band (its max-width) and is placed inside it; the normal
			// bar's track is left as it was — the edit bar is not the bar it describes
			// the round ✓ overhangs the bar's top-right corner (hud.css): keep room for it inside the band
			const next = { left, right: right - EDIT_APPLY_OVERHANG, w: pill.width };
			if (!editPlace || next.left !== editPlace.left || next.right !== editPlace.right || Math.abs(next.w - editPlace.w) >= 0.5) editPlace = next;
			if (typeof window !== 'undefined') (window as any).__toolbarTrack = { ...track, room: barRoom, editPlace, folded };
			return;
		}
		if (editPlace) editPlace = null;
		measureBarMetrics(nav);
		if (left !== barRoom.left || right !== barRoom.right || !barRoom.ok) barRoom = { left, right, ok: right - left > 0 };
		const half = pill.width / 2;
		const min = left + half;
		const max = right - half;
		const ok = max - min >= 1;
		const next = { min, max, mid: ok ? Math.max(min, Math.min(max, vw / 2)) : vw / 2, ok };
		// REASSIGNED, never mutated: `$derived` compares with ===. Guarded on the values
		// so a ResizeObserver callback can never write its way into a second callback.
		if (next.min !== track.min || next.max !== track.max || next.mid !== track.mid || next.ok !== track.ok)
			track = next;
		// the debug seam (`__outlineDebug` / `__flowViewport` precedent): what the bar
		// COMPUTED, beside what a suite can see for itself in the rendered rects. It is
		// what turned "the armed move commits 21px off" from a guess into one reading.
		if (typeof window !== 'undefined')
			(window as any).__toolbarTrack = { ...track, centre: pillCentre, posX: controlsLayout.posX, room: barRoom, folded, metrics: barMetrics };
	}

	/** re-observe only when the SET of neighbours changed — `observe()` fires an initial callback per
	 *  element, so re-attaching on every measurement would spin */
	function observeNeighbours(nav: HTMLElement, found: HTMLElement[]) {
		const key = found.map((el) => el.id).join(',');
		if (trackRO && key !== observedKey) {
			observedKey = key;
			trackRO.disconnect();
			trackRO.observe(nav); // the bar's own width changes when cells hide/collapse
			for (const el of found) trackRO.observe(el);
		}
	}

	/** 43 J10: the widths `foldToFit` adds up, read from the live bar and hud.css's own tokens (a touch
	 *  screen's cells are 44 px, a mouse's 38) — nothing here is a copy of a CSS number */
	function measureBarMetrics(nav: HTMLElement) {
		const px = (v: string) => parseFloat(v) || 0;
		const root = getComputedStyle(document.documentElement);
		const cs = getComputedStyle(nav);
		const row = nav.querySelector('.hud-bar-row');
		const cell = cssPx(root.getPropertyValue('--hud-cell')) || 38;
		const fab = cssPx(root.getPropertyValue('--hud-fab')) || 44;
		const gap = row ? px(getComputedStyle(row).columnGap) : 2;
		const navGap = px(cs.columnGap);
		const sep = nav.querySelector('.hud-sep');
		const sepW = sep ? sep.getBoundingClientRect().width + px(getComputedStyle(sep).marginLeft) + px(getComputedStyle(sep).marginRight) : 5;
		const next = {
			chrome: px(cs.paddingLeft) + px(cs.paddingRight) + px(cs.borderLeftWidth) + px(cs.borderRightWidth),
			cell,
			well: fab + 12,
			gap,
			// the trailing control (the "…", or the "»" once anything folds): gap, separator, gap, one cell
			tail: navGap + sepW + navGap + cell
		};
		const m = barMetrics;
		if (next.chrome !== m.chrome || next.cell !== m.cell || next.well !== m.well || next.gap !== m.gap || next.tail !== m.tail) barMetrics = next;
	}

	onMount(() => {
		if (typeof ResizeObserver !== 'undefined') trackRO = new ResizeObserver(scheduleTrack);
		measureTrack();
		window.addEventListener('resize', measureTrack);
		window.addEventListener('keydown', onArmedKey, true);
		return () => {
			window.removeEventListener('resize', measureTrack);
			window.removeEventListener('keydown', onArmedKey, true);
			trackRO?.disconnect();
			trackRO = null;
			if (trackRaf) cancelAnimationFrame(trackRaf);
			trackRaf = 0;
		};
	});

	// A neighbour that APPEARS is invisible to the observer set (nothing can watch an
	// element that does not exist yet), and the bar's own width changes with the roster,
	// and `floatingToolbar` / the dock move the bar's ROW — which changes which
	// neighbours overlap it at all. All four are re-measured after the render that
	// caused them (Connect's `tick().then(measureDock)` shape).
	//
	// The dock half is `bottomInset` and NOT `visibleDockKey` or `dockMinimized`, because
	// the honest dependency is whatever the bar's `bottom` resolves FROM: `pillStyle`
	// reads `--bottom-inset`, which is exactly what `bottomInset` publishes. That one
	// store closes the whole class in a single line — minimize, restore, close the last
	// tab, undock it, or switch to a tab of a different height — where naming any of
	// those closes only its own path. MEASURED on the reported one: parked hard right
	// with a 320px dock open (track 149..1131, right edge 1272) and then minimized, the
	// bar dropped back onto the chat/AI row and sat 52px OVER `#chat-button`, because
	// nothing re-measured; the track it needed was 209..1071. Nothing re-clamps the
	// STORED fraction here and nothing should: `posX` is a fraction of whatever track is
	// live, so `pillCentre` re-maps it onto the narrower one for free on the next
	// measurement (the same reading, after: right edge 1212, clear).
	$effect(() => {
		void $showSimControls;
		void visibleCells;
		void stackLeft;
		void stackRight;
		void $floatingToolbar;
		void $bottomInset;
		// 43 J5/J8/J10: a sidebar pinned, opened, resized or moved moves the band; the lift moves the
		// corner stacks into it or out of it; entering / leaving Edit positions swaps which band applies
		void $sidebarGeometry;
		void $hudStackLift;
		void editing;
		tick().then(measureTrack);
	});

	/** the bar's centre in px: a live gesture wins, else the stored fraction mapped onto
	 *  the CURRENT track, else the canonical middle */
	const pillCentre = $derived.by(() => {
		if (dragCentre != null) return dragCentre;
		if (!track.ok || controlsLayout.posX == null) return track.mid;
		return track.min + controlsLayout.posX * (track.max - track.min);
	});

	/** Eat exactly the one click a finished move is about to produce, in CAPTURE on the
	 *  window so it never reaches the cell it landed on — a flag the handlers check
	 *  cannot do this job, because `click` arrives in a LATER task than the `pointerup`
	 *  that would clear the flag, and clearing it any later would eat the user's next
	 *  real press. The timer is the release valve for a gesture that produces no click
	 *  at all (Enter, or a pointer that left the window). */
	function swallowNextClick() {
		if (typeof window === 'undefined') return;
		let timer = 0;
		const disarm = () => {
			window.removeEventListener('click', eat, true);
			window.removeEventListener('pointerdown', disarm, true);
			clearTimeout(timer);
		};
		const eat = (e: MouseEvent) => {
			e.stopPropagation();
			e.preventDefault();
			disarm();
		};
		window.addEventListener('click', eat, true);
		// 48 G1 (J12): the gesture's own click comes straight after its release, before any new press — so
		// the next PRESS disarms. When no click follows (the pressed item was re-rendered by the drop) the
		// eater otherwise lingered its full 700 ms and ate the next REAL click: the ✓ pressed right after a drag
		window.addEventListener('pointerdown', disarm, true);
		timer = window.setTimeout(disarm, 700);
	}

	function clampCentre(c: number, t: { min: number; max: number; mid: number }) {
		const v = Math.max(t.min, Math.min(t.max, c));
		// the middle is magnetic, so the canonical position is always reachable by feel
		// and not only through the menu
		return Math.abs(v - t.mid) <= SNAP_PX ? t.mid : v;
	}

	/** The move itself, on the SHARED gesture engine. `modalGrab` is exactly the
	 *  confirm/cancel drag this needs — it owns the origin, the snapshot, the window
	 *  listeners and the commit-or-revert contract — and its MODAL mode is what makes
	 *  the armed "Move toolbar" four lines rather than a second engine.
	 *
	 *  What it does NOT cover, and what `swallowNextClick` is for: its capture-phase
	 *  pointerdown stops the committing press from opening a FRESH GESTURE, which is
	 *  all its own comment claims. The `click` the browser dispatches afterwards is a
	 *  different event and reaches the cell underneath regardless. */
	const toolbarGrab = createGesture({
		snapshot: () => {
			measureTrack();
			if (!track.ok) return null; // no room to choose — refuse, and the press stays a click
			return { centre: pillCentre, track: { ...track } };
		},
		start: () => {
			armNudge = 0;
		},
		// ABSOLUTE from the snapshot every move, never incremental — and the track is
		// FROZEN in it, because the bar's position is what the clamp is measured against
		apply: (ctx) => {
			dragCentre = clampCentre(ctx.snapshot.centre + ctx.dx + armNudge, ctx.snapshot.track);
		},
		revert: () => {
			dragCentre = null; // back to whatever is stored
		},
		end: (ctx, kept) => {
			const c = dragCentre;
			dragCentre = null;
			armNudge = 0;
			// A gesture that PLACED the bar owes one swallowed click. Both halves need it
			// and for the same reason: the press that ends a move is over a toolbar cell
			// (a drag ends wherever it ends; an armed move is committed by clicking, and
			// the bar is under the pointer BY DESIGN) and neither `preventDefault` nor
			// `stopPropagation` on a pointer event stops the `click` the browser
			// dispatches afterwards — they are different events. MEASURED: without this,
			// committing an armed move over the Node editor cell opened the dock, which
			// moved the bar 24px as the track widened under it. A revert (Escape) arms
			// nothing, since no click is coming.
			if (kept) swallowNextClick();
			if (!kept || c == null) return;
			const t = ctx.snapshot.track;
			const span = t.max - t.min;
			// snapped to the middle -> store the DEFAULT rather than the fraction that
			// happens to land there, so the bar re-centres on the next screen too.
			// CLAMPED, because the track is frozen for the gesture and the live one may
			// have moved under it (a window resize mid-drag): a fraction outside 0..1
			// would render outside the track it is read against.
			const frac = span > 0 ? Math.max(0, Math.min(1, (c - t.min) / span)) : null;
			setLayout({ posX: c === t.mid ? null : frac });
		},
		onActive: (active, modal) => {
			movingBar = active;
			movingModal = active && modal;
		},
		// 44 M4: armed from the menu on a touch screen, a finger GRABS the bar (follow it, place it on the
		// lift) — the modal "follow the pointer, click to place" committed on the first touch, so the
		// armed move could never move on touch. The drag continues from wherever the bar is now.
		touchDrag: true,
		rebase: (ctx) => {
			ctx.snapshot = { ...ctx.snapshot, centre: dragCentre ?? ctx.snapshot.centre };
			armNudge = 0;
		},
		passDown: (e) => !!(e.target as Element | null)?.closest?.('#toolbar-move-cancel')
	});

	/** THE MOVE GESTURE. A press anywhere on the bar starts a CANDIDATE; it becomes a
	 *  move only once the pointer has travelled `DRAG_SLOP`, and a press that never
	 *  travels stays an ordinary click.
	 *
	 *  The discrimination is MOVEMENT and never a timer, which is the whole design: a
	 *  finger held still has to remain the browser's long press, because that is what
	 *  raises the `contextmenu` every cell menu in this file lives on. A "held 300ms =
	 *  drag" rule would eat all of them on Android. For the same reason nothing is
	 *  preventDefault-ed on the pointerdown — that alone can suppress a long press — only
	 *  from the move that crosses the threshold, where the gesture is already decided.
	 *
	 *  Direct listeners in an action, the repo's rule for pointer gestures inside panel
	 *  chrome: svelte DELEGATES event attributes to the app root, and this chrome is
	 *  exactly the kind of ancestor that swallows them on the way up. */
	function toolbarDrag(node: HTMLElement) {
		let from: { x: number; y: number } | null = null;
		let press: PointerEvent | null = null;
		const done = () => {
			from = null;
			press = null;
			window.removeEventListener('pointermove', onMove);
			window.removeEventListener('pointerup', done);
			window.removeEventListener('pointercancel', done);
		};
		const onMove = (e: PointerEvent) => {
			if (!from || !press) return;
			if (Math.abs(e.clientX - from.x) + Math.abs(e.clientY - from.y) < DRAG_SLOP) return;
			e.preventDefault();
			// hand over with the ORIGINAL press as the origin, so the bar does not jump
			// by the slop it took to decide. 44 M12b: a PLACED bar moves as a cluster (anywhere, snapping)
			if (barPlaced) grabId = 'bar';
			const opened = barPlaced ? clusterGrab.begin(press) : toolbarGrab.begin(press);
			done();
			if (!opened) return; // no track to move along — the press stays a click
			if (barPlaced) clusterGrab.move(e);
			else toolbarGrab.move(e);
		};
		const onDown = (e: PointerEvent) => {
			// the play FAB is the one control an accidental drag must not grab: a 50px
			// circle is the way into play mode and it is what a thumb aims at
			if (e.button !== 0 || (e.target as Element)?.closest?.('#play-button')) return;
			if (editing) return; // 41 G1: in edit positions a press picks a button up instead
			if (toolbarGrab.active() || clusterGrab.active()) return; // an armed move already owns the bar
			from = { x: e.clientX, y: e.clientY };
			press = e;
			window.addEventListener('pointermove', onMove);
			window.addEventListener('pointerup', done);
			window.addEventListener('pointercancel', done);
		};
		node.addEventListener('pointerdown', onDown);
		return {
			destroy() {
				done();
				node.removeEventListener('pointerdown', onDown);
			}
		};
	}

	/** "Move toolbar", from any toolbar menu: the same gesture with no button held, for
	 *  whoever reached the bar by keyboard or long press rather than by dragging it. */
	function armMoveToolbar() {
		if (barPlaced) return armClusterMove('bar', lastMenuAt);
		toolbarGrab.begin({ clientX: lastMenuAt.x, clientY: lastMenuAt.y } as any, { modal: true });
	}

	/** the arrows, while an armed move is running. `modalGrab` owns Escape and Enter and
	 *  ignores every other key, so this only has to add the nudge — in CAPTURE, so the
	 *  editor's own arrow bindings never see it. */
	function onArmedKey(e: KeyboardEvent) {
		if (!toolbarGrab.active() || !toolbarGrab.isModal()) return;
		const step = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
		if (!step) return;
		e.preventDefault();
		e.stopPropagation();
		armNudge += step * (e.shiftKey ? 10 : 1);
		toolbarGrab.refresh();
	}

	/* WHERE THE PILL SITS, and WHO WINS THE PIXEL — two independent prefs since W8a,
	 * because they are two questions and one flag could only answer them together:
	 *   floating ON  + on top ON  — the bar lifts onto `--bottom-inset` when a dock
	 *       opens and paints over the dock and over floating windows.
	 *   floating ON  + on top OFF (the DEFAULT since the third on-device pass) — the
	 *       bar still lifts clear of the dock, but a window dragged over it covers it:
	 *       it moves out of the way rather than fighting.
	 *   floating OFF + on top ON  — the bar stays on the viewport floor and still owns
	 *       its pixels, so an open dock passes BEHIND it.
	 *   floating OFF + on top OFF — the W2 behaviour: an ordinary member of the
	 *       bottom-HUD tier, z-30 like `#chat-button` / `#ai-hud-button` beside it, and
	 *       an open editor owns the bottom of the screen and covers it.
	 * ONE derived pair rather than markup branches: the nav, the roster and the FAB
	 * inside it are identical in every combination.
	 * NO `transition: bottom` any more (W8a, on the user's read): the bar sliding as a
	 * dock opens or as the setting flips read as distracting rather than as continuity,
	 * so it moves in the same frame the inset does. The FAB keeps its own
	 * `transition: transform` for the hover scale, which is a different property and a
	 * different gesture.
	 * The FAB also keeps its own `z-index: var(--z-hud)`: the pill is positioned WITH a
	 * z-index, so it is a stacking context and its children cannot escape it whatever
	 * they ask for. That z only orders the FAB against its own siblings in the well.
	 * `left` is emitted only once the track has been MEASURED — before that (SSR, the
	 * first paint) the `start-1/2` class is the honest answer. */
	const pillZClass = $derived($toolbarAlwaysOnTop ? 'z-(--z-hud)' : 'z-(--z-chrome)');
	/** 43 J8: where the EDIT bar's centre goes — the bar's own centre, slid only as far as it must to
	 *  sit wholly inside the band beside the open sidebars (the user's "it can be moved a bit") */
	const editCentre = $derived.by(() => {
		if (!editing || !editPlace || barPlaced) return null;
		const room = editPlace.right - editPlace.left;
		const half = Math.min(editPlace.w, room) / 2;
		const lo = editPlace.left + half;
		const hi = editPlace.right - half;
		return lo > hi ? (editPlace.left + editPlace.right) / 2 : Math.max(lo, Math.min(hi, pillCentre));
	});
	const pillStyle = $derived(
		// 44 M12b: a PLACED bar is drawn where the cluster engine put it (the --cl-bar-* pair, layoutClusters)
		barPlaced
			? 'left: var(--cl-bar-x, 50%); top: var(--cl-bar-y, auto); bottom: auto; translate: none; touch-action: none;' + (movingBar ? ' cursor: grabbing;' : '')
			:
		($floatingToolbar ? 'bottom: calc(var(--bottom-inset, 0px) + 16px);' : 'bottom: 16px;') +
			(editCentre != null
				? ` left: ${Math.round(editCentre)}px; max-width: ${Math.max(0, Math.floor(editPlace!.right - editPlace!.left))}px;`
				: track.mid > 0
					? ` left: ${Math.round(pillCentre)}px;`
					: '') +
			' touch-action: none;' +
			(movingBar ? ' cursor: grabbing;' : '')
	);

	// ── 43 J10: the "»" and its menu ────────────────────────────────────────────────────────────
	function openOverflow(e: MouseEvent) {
		const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
		toolbarMenu = null;
		customizeMenu = null;
		playMenu = null;
		overflowMenu = { x: Math.round(r.left), y: Math.round(r.top) };
	}
	/** the folded cells, each doing what its cell does (its armed / open state as the row's check),
	 *  then the way into Customize — the "…" that folded first lives here */
	function overflowItems() {
		return [
			{ section: 'More buttons' },
			...folded.map((id) => {
				const btn = BUTTONS[id];
				return { key: id, label: labelOf(id), icon: btn.iconName ?? btn.icon, checked: btn.tint() === ICON_ON, tooltip: btn.title, action: () => runCell(id) };
			}),
			{ section: '' },
			{ key: '__customize', label: 'Customize toolbar…', tooltip: 'Choose which buttons the bar shows — the ones that do not fit wait here', action: () => openCustomize() }
		];
	}

</script>

<!-- WHERE THE PILL SITS is `floatingToolbar`'s call (Settings ▸ Interface ▸ Windows
     & chrome, default ON since W8a) — see the derived pair above. With it ON the pill RIDES
     ABOVE the bottom dock: `--bottom-inset` is the visible docked Flow/Explorer panel's
     height (published by $lib/bottomDock), so the bar and the play FAB inside it sit in
     the band just above it instead of covering its last ~60px — which is what the old
     `--dock-inset` model got wrong, padding the DOCK's content and only at <=500px, so
     every wider screen had the pill permanently over the node palette / folder tree.
     OFF the pill stays on the viewport floor; whether the dock then COVERS it is the
     separate `toolbarAlwaysOnTop` pref's call (see the four combinations above).
       W8a: the bar is also MOVABLE along this edge (`use:toolbarDrag` + the `left` in
     `pillStyle`) and there is no `bottom` transition any more — it changes rows in the
     same frame the inset does.
       4b: a plain <nav> over the `visibleCells` roster, no longer flowbite's
     `BottomNav` (whose inner grid column count must be a JIT literal, which a
     customizable cell count cannot be). The class list is flowbite's own RESOLVED
     output for `position="absolute" navType="application"` plus this component's
     overrides, read off the rendered DOM — same border, surface, radius and 40px
     height. `bottom-4` stays in it purely as the class the inline style overrides,
     exactly as before. The cells are `w-10` literals now: the grid's content-sized
     `fr` columns used to take their width from the spacer, and a flex row has to say
     it out loud. -->
<!-- 36 F2: a toolbar never takes the keyboard (keyScope `keep`) -->
<!-- 38 R8: the toolbar is one glass bar (styles/hud.css): icon cells 38 px on a fine pointer,
     44 px on touch, the accent's soft fill on an armed cell, and Play — the only `--live`
     control — a 44 px circle sitting IN the bar instead of overhanging it. Ids, titles, the
     roster, the drag and every handler are unchanged. -->
<nav
	id="controls-pill"
	data-key-scope="keep"
	class="tp-ui hud-glass hud-bar absolute -translate-x-1/2 rtl:translate-x-1/2 bottom-4 start-1/2 w-max min-w-max shrink-0 {pillZClass}"
	class:hud-editing={editing !== null}
	style={pillStyle}
	aria-label="Scene tools"
	use:toolbarDrag
	use:cellMenu={BAR}
	use:roving={{ item: editing ? ':not(*)' : '.hud-cell, .hud-play', axis: 'x' }}
>
	<div class="hud-bar-row">
		{#if editing}
			<!-- 41 G1 EDIT POSITIONS: the draft, drawn as outlined (jiggling) placeholders. Every item
			     is a focusable drag handle (arrows move it, Delete removes it), every one but Play
			     carries the red "−", and a "+" at each end (and wherever a "−" left a gap) offers
			     the unplaced buttons. -->
			<button type="button" class="hud-cell hud-edit-add" id="toolbar-edit-add-start" title="Add a button at the start of the bar" aria-label="Add a button at the start of the bar" use:onPress={(e: MouseEvent) => editOpenAdd(e, 'bar', 0)}
				><Icon name="plus" size={16} aria-hidden="true" /></button
			>
			{#each editing.bar as id (id)}
				{#if isHole(id)}
					<button type="button" class="hud-cell hud-edit-add" data-edit-slot data-edit-hole={id} title="Add a button here" aria-label="Add a button here" use:onPress={(e: MouseEvent) => editing && editOpenAdd(e, 'bar', editing.bar.indexOf(id), id)}
						><Icon name="plus" size={16} aria-hidden="true" /></button
					>
				{:else if id === SPACER}
					<div class="hud-play-well hud-edit-item hud-edit-play" class:hud-edit-carried={editDrag?.id === id} data-edit-wrap={id} data-edit-slot>
						<button type="button" class="hud-edit-grip" data-edit-id={id} title="Play — drag to move it; it always stays on the bar" aria-label="Play — arrow keys move it along the bar" use:editItemGesture={id}
							><span class="hud-play"><Icon name="play" size={20} class="hud-play-tri" fill="currentColor" aria-hidden="true" /></span></button
						>
					</div>
				{:else}
					<div class="hud-cell hud-edit-item" class:hud-edit-carried={editDrag?.id === id} data-edit-wrap={id} data-edit-slot>
						<button type="button" class="hud-edit-grip" data-edit-id={id} title={editLabel(id)} aria-label="{editLabel(id)} — arrow keys move it, Delete removes it" use:editItemGesture={id}
							><Icon name={BUTTONS[id].iconName ?? BUTTONS[id].icon} size={20} aria-hidden="true" /></button
						>
						<button type="button" class="hud-edit-remove" tabindex="-1" title="Remove" aria-label="Remove {editLabel(id)}" use:onPress={() => editRemove(id)}><Icon name="minus" size={16} aria-hidden="true" /></button>
					</div>
				{/if}
			{/each}
			<button type="button" class="hud-cell hud-edit-add" id="toolbar-edit-add-end" title="Add a button at the end of the bar" aria-label="Add a button at the end of the bar" use:onPress={(e: MouseEvent) => editing && editOpenAdd(e, 'bar', editing.bar.length)}
				><Icon name="plus" size={16} aria-hidden="true" /></button
			>
		{:else}
		{#each visibleCells as cell (cell.id)}
			{#if cell.id === SPACER}
				<!-- the WELL Play sits in. 4b: the play button is the well's own child, so it
				     rides the bar's position (one anchor) and moving the well moves Play. -->
				<div class="hud-play-well">
					<p
						id="play-button"
						role="button"
						tabindex="-1"
						use:pressOnKey
						title={$willEnterAR
							? 'Enter AR — the scene composites over your room'
							: $willEnterXR
								? 'Enter VR'
								: 'Play'}
						class="hud-play"
						on:click={() => {
							requestPlay();
						}}
						use:playModeMenu
					>
						<!-- CO4b: ONE entry point that SHOWS its destination — the play triangle,
						     a headset for VR, the headset with A and R in its lenses for AR. The
						     overlay is pointer-events none, so the circle stays ONE hit target
						     (#play-button's clip-path in ui.css). -->
						{#if $willEnterAR}
							<span class="pointer-events-none relative inline-flex select-none items-center justify-center">
								<Icon name="tool:vr" size={24} aria-hidden="true" />
								<span class="hud-play-lens" style="left: 29%">A</span>
								<span class="hud-play-lens" style="left: 71%">R</span>
							</span>
						{:else if $willEnterXR}
							<Icon name="tool:vr" size={20} aria-hidden="true" />
						{:else}
							<Icon name="play" size={20} class="hud-play-tri" fill="currentColor" aria-hidden="true" />
						{/if}
					</p>
				</div>
			{:else}
				{@const btn = BUTTONS[cell.id]}
				{@const glyph = btn.iconName ?? btn.icon}
				{@const tint = btn.tint()}
				{#if btn.pressed}
					<!-- 30 P1: a TOGGLE cell is a real button, so it can say aria-pressed; the
					     focus ring is keyboard-only (33 E2). -->
					<button
						type="button"
						id={btn.slot}
						class="hud-cell"
						class:on={tint === ICON_ON}
						title={btn.title}
						aria-label={btn.title}
						aria-pressed={btn.pressed()}
						use:cellClick={cell.id}
						use:cellMenu={cell.id}
					>
						<Icon name={glyph} size={20} class={tint} aria-hidden="true" />
					</button>
				{:else}
					<!-- ONE template for every roster button (`p[title=…]` is what suites and
					     the panel toggles select on). -->
					<p
						id={btn.slot}
						class="hud-cell relative"
						class:on={tint === ICON_ON}
						title={btn.title}
						role="button"
						tabindex="-1"
						use:pressOnKey
						on:click={() => runCell(cell.id)}
						use:cellMenu={cell.id}
					>
						<Icon name={glyph} size={20} class={tint} aria-hidden="true" />
						{#if cell.id === 'chat' && $chatUnread > 0}
							<span id="chat-unread" class="chat-unread-badge" class:mention={$chatMentioned}>{$chatUnread > 99 ? '99+' : $chatUnread}</span>
						{/if}
					</p>
				{/if}
			{/if}
		{/each}
		{/if}
	</div>
	{#if movingModal}
		<!-- 44 M4: the armed Move toolbar says how to finish it — a finger drags and lifts, a mouse follows and
		     clicks; touch has no Escape, so it gets a Cancel that puts the bar back -->
		<p class="hud-edit-hint hud-move-hint" id="toolbar-move-hint" role="status">
			<span>{coarsePointer ? 'Drag the toolbar to place it' : 'Move to place · click to drop · ← → nudge · Esc cancels'}</span>
			<button type="button" id="toolbar-move-cancel" class="hud-move-cancel" use:onPress={() => toolbarGrab.cancel()}>Cancel</button>
		</p>
	{/if}
	{#if editing}
		<!-- 41 G1: the round green ✓ at the bar's top right applies; Escape / a press outside cancels -->
		<button type="button" id="toolbar-edit-apply" class="hud-edit-apply" title="Apply the new positions" aria-label="Apply the new positions" use:onPress={() => applyEditPositions()}
			><Icon name="check" size={20} aria-hidden="true" /></button
		>
		<p class="hud-edit-hint" id="toolbar-edit-hint" role="status">Drag to arrange · − removes · + adds · ✓ applies · Esc cancels</p>
		{#if editing.more !== false}
			<!-- 43 J2: the "…" in edit mode — removable with its "−" (or Delete) like any item; it stays
			     the bar's last control, so it is not a drag handle, and the end "+" brings it back -->
			<span class="hud-sep hud-bar-more" aria-hidden="true"></span>
			<div class="hud-cell hud-edit-item hud-edit-more hud-bar-more" data-edit-wrap={MORE}>
				<button type="button" class="hud-edit-grip" data-edit-id={MORE} title={MORE_LABEL} aria-label="{MORE_LABEL} — Delete removes it"
					><Icon name="ellipsis" size={20} aria-hidden="true" /></button
				>
				<button type="button" class="hud-edit-remove" tabindex="-1" title="Remove" aria-label="Remove {MORE_LABEL}" use:onPress={() => editRemove(MORE)}><Icon name="minus" size={16} aria-hidden="true" /></button>
			</div>
		{/if}
	{:else if !controlsLayout.collapsed && folded.length}
		<!-- 43 J10: the buttons that do not fit wait in "»" (right to left by the user's order, Play never);
		     once anything folds it ends the bar in place of the "…", and its menu closes with Customize -->
		<span class="hud-sep" aria-hidden="true"></span>
		<button id="toolbar-overflow" type="button" class="hud-cell" class:on={overflowMenu !== null} data-folded={folded.join(',')} title="More buttons — {folded.length} {folded.length === 1 ? 'does' : 'do'} not fit" aria-label="More buttons ({folded.length})" aria-haspopup="menu" aria-expanded={overflowMenu !== null} use:onPress={openOverflow} use:cellMenu={BAR}
			><Icon name="chevrons-right" size={20} aria-hidden="true" /></button
		>
	{:else if !controlsLayout.collapsed && controlsLayout.more !== false}
		<!-- 38 R8 (design page): the bar's own "…" opens Customize toolbar — the same checklist as
		     the right-click menu's last row. Outside the cell row on purpose: the roster suites read
		     the row's children as the bar's cells. Hidden on a narrow window (hud.css).
		     43 J2: removable like any item (`more` in the record), and its right-click opens the
		     toolbar menu like every cell's. -->
		<span class="hud-sep hud-bar-more" aria-hidden="true"></span>
		<button id="toolbar-customize" type="button" class="hud-cell hud-bar-more" title="Customize toolbar…" aria-label="Customize toolbar" use:openCustomizeOnClick use:cellMenu={MORE}
			><Icon name="ellipsis" size={20} aria-hidden="true" /></button
		>
	{/if}
</nav>

<!-- 41 G1: THE CORNER STACKS — the round buttons that used to be four hand-placed components
     (the "+" and the AI assistant bottom-left, chat and the mic bottom-right) are roster
     entries now, stacked bottom → top, at most three a side. Under the bottom dock's z-tier as
     before, so an open flow editor / Explorer covers them. -->
{#snippet stack(side: 'left' | 'right', list: string[])}
	<div id="hud-stack-{side}" class="tp-ui hud-stack hud-stack-{side}" class:hud-editing={editing !== null} role="toolbar" aria-label="{side === 'left' ? 'Left' : 'Right'} corner buttons" use:cellMenu={BAR} use:roving={{ item: editing ? ':not(*)' : '.hud-fab', axis: 'both' }}>
		{#if editing}
			{#each stackSlots(list) as id (id)}
				{#if id.startsWith('__empty:')}
					<button type="button" class="hud-fab hud-edit-add" title="Add a button here" aria-label="Add a button to the {side} corner" use:onPress={(e: MouseEvent) => editOpenAdd(e, side, list.length)}
						><Icon name="plus" size={20} aria-hidden="true" /></button
					>
				{:else}
					<div class="hud-fab hud-edit-item" class:hud-edit-carried={editDrag?.id === id} data-edit-wrap={id}>
						<button type="button" class="hud-edit-grip" data-edit-id={id} title={editLabel(id)} aria-label="{editLabel(id)} — arrow keys move it, Delete removes it" use:editItemGesture={id}
							><Icon name={BUTTONS[id].iconName ?? BUTTONS[id].icon} size={20} aria-hidden="true" /></button
						>
						<button type="button" class="hud-edit-remove" tabindex="-1" title="Remove" aria-label="Remove {editLabel(id)}" use:onPress={() => editRemove(id)}><Icon name="minus" size={16} aria-hidden="true" /></button>
					</div>
				{/if}
			{/each}
		{:else}
			{#each list as id (id)}
				{@const btn = BUTTONS[id]}
				{@const tint = btn.tint()}
				<button type="button" id={btn.slot} class="hud-fab" class:on={tint === ICON_ON} title={btn.title} aria-label={btn.title} use:cellClick={id} use:cellMenu={id}>
					<Icon name={btn.iconName ?? btn.icon} size={20} aria-hidden="true" />
					{#if id === 'chat' && $chatUnread > 0}
						<span id="chat-unread" class="chat-unread-badge" class:mention={$chatMentioned}>{$chatUnread > 99 ? '99+' : $chatUnread}</span>
					{/if}
				</button>
			{/each}
		{/if}
	</div>
{/snippet}
{@render stack('left', stackLeft)}
{@render stack('right', stackRight)}

<!-- 42 I9: THE TOP-RIGHT GROUP AND THE TOUCH TOOLS. Their own components draw the natives (notes,
     the bell, the peers trigger; undo, redo, multi-select) where the record puts them; what is
     drawn HERE is portaled into their flex row — a display:contents wrapper, so each child takes
     its `order` among the natives: any OTHER roster button placed in the group, and, while Edit
     positions runs, every placeholder of the group (the natives stand down for them). -->
{#snippet group(region: 'top' | 'touch', list: string[], extras: string[], cell: string)}
	{#if editing}
		{#each stackSlots(list) as id, i (id)}
			{#if id.startsWith('__empty:')}
				<button type="button" class="{cell} hud-edit-add" style:order={i} title="Add a button here" aria-label={region === 'top' ? 'Add a button to the top-right group' : 'Add a button to the touch tools'} use:onPress={(e: MouseEvent) => editOpenAdd(e, region, list.length)}
					><Icon name="plus" size={16} aria-hidden="true" /></button
				>
			{:else}
				<div class="{cell} hud-edit-item" class:hud-edit-carried={editDrag?.id === id} style:order={i} data-edit-wrap={id}>
					<button type="button" class="hud-edit-grip" data-edit-id={id} title={editLabel(id)} aria-label="{editLabel(id)} — arrow keys move it, Delete removes it" use:editItemGesture={id}
						><Icon name={BUTTONS[id].iconName ?? BUTTONS[id].icon} size={20} aria-hidden="true" /></button
					>
					<button type="button" class="hud-edit-remove" tabindex="-1" title="Remove" aria-label="Remove {editLabel(id)}" use:onPress={() => editRemove(id)}><Icon name="minus" size={16} aria-hidden="true" /></button>
				</div>
			{/if}
		{/each}
	{:else}
		{#each extras as id (id)}
			{@const btn = BUTTONS[id]}
			{@const tint = btn.tint()}
			<button type="button" id={btn.slot} class={cell} class:on={tint === ICON_ON} class:tt-on={region === 'touch' && tint === ICON_ON} style:order={list.indexOf(id)} title={btn.title} aria-label={btn.title} aria-pressed={btn.pressed ? btn.pressed() : undefined} use:cellClick={id} use:cellMenu={id}>
				<Icon name={btn.iconName ?? btn.icon} size={20} class={tint} aria-hidden="true" />
				{#if id === 'chat' && $chatUnread > 0}
					<span id="chat-unread" class="chat-unread-badge" class:mention={$chatMentioned}>{$chatUnread > 99 ? '99+' : $chatUnread}</span>
				{/if}
			</button>
		{/each}
	{/if}
{/snippet}
{#if !$phoneShell}
	<div class="contents" data-toolbar-portal="top" use:portalTo={'#hud-tr'}>{@render group('top', stackTop, topExtras, 'hud-cell')}</div>
{/if}
{#if ($touchTools || editing) && !$phoneShell}
	<div class="contents" data-toolbar-portal="touch" use:portalTo={'#touch-tools'}>{@render group('touch', stackTouch, touchExtras, 'tt-btn')}</div>
{/if}

{#if editing && !$phoneShell}
	<!-- 43 K3: the Connect pill in Edit positions — outlined with a red "−" (it is shown / hidden, never
	     moved); hidden, a "+" at the top centre brings it back. The outline covers the pill, so a press
	     there is part of the edit, not a Connect click. -->
	<div id="connect-edit" class="tp-ui">
		{#if editing.connect !== false && connectRect}
			<div class="hud-edit-item hud-edit-connect" data-edit-wrap={CONNECT} style="left: {connectRect.left}px; top: {connectRect.top}px; width: {connectRect.width}px; height: {connectRect.height}px">
				<span class="hud-edit-grip" data-edit-id={CONNECT} title={CONNECT_LABEL}></span>
				<button type="button" class="hud-edit-remove" tabindex="-1" title="Hide the Connect bar" aria-label="Hide the {CONNECT_LABEL}" use:onPress={() => editRemove(CONNECT)}><Icon name="minus" size={16} aria-hidden="true" /></button>
			</div>
		{:else if editing.connect === false}
			<button type="button" id="connect-edit-add" class="hud-cell hud-edit-add hud-edit-connect-add" title="Show the Connect bar" aria-label="Show the {CONNECT_LABEL}" use:onPress={() => editing && (editing = { ...editing, connect: true })}
				><Icon name="plus" size={16} aria-hidden="true" /><span>Connect</span></button
			>
		{/if}
	</div>
{/if}

{#if editing && !$phoneShell && clusterRects.budget}
	<!-- 48 F1: the budget chip in Edit positions — an outline over it (a press there is part of the edit: drag it to move
	     the chip, tap or right-click it for its menu) with a red "−" to hide it; hidden, it is faint with a green "+" -->
	{@const b = clusterRects.budget}
	{@const off = clusterHidden('budget')}
	<div
		id="budget-edit"
		class="tp-ui hud-edit-item hud-edit-connect hud-edit-budget"
		data-edit-wrap="budget"
		style="left: {b.left}px; top: {b.top}px; width: {b.right - b.left}px; height: {b.bottom - b.top}px"
		use:clusterGrip={'budget'}
	>
		{#if off}
			<button type="button" id="budget-edit-add" class="hud-edit-remove hud-edit-add" tabindex="-1" title="Show the budget chip" aria-label="Show the budget chip" use:onPress={() => setCluster('budget', { hidden: false })}><Icon name="plus" size={16} aria-hidden="true" /></button>
		{:else}
			<button type="button" id="budget-edit-remove" class="hud-edit-remove" tabindex="-1" title="Hide the budget chip" aria-label="Hide the budget chip" use:onPress={() => setCluster('budget', { hidden: true })}><Icon name="minus" size={16} aria-hidden="true" /></button>
		{/if}
	</div>
{/if}

{#if editing && !$phoneShell}
	<!-- 44 M12b: each cluster's GRIP — drag it to move the whole cluster (it snaps; guide lines show to what), tap or
	     right-click it for the cluster's menu (Move, Rotate, Reset position, Reset all, Hide / Show all) -->
	<div id="cluster-grips" class="tp-ui">
		{#each Object.keys(clusterRects) as id (id)}
			<button
				type="button"
				class="cl-grip"
				id="cluster-grip-{id}"
				data-cluster-grip={id}
				class:cl-grip-hidden={id !== 'connect' && clusterHidden(id)}
				style={gripStyle(id)}
				title="{CLUSTER_LABEL[id]} — drag to move, tap for more"
				aria-label="{CLUSTER_LABEL[id]}: drag to move, press for its menu"
				use:clusterGrip={id}><Icon name="grip-vertical" size={16} aria-hidden="true" /></button
			>
		{/each}
	</div>
{/if}
{#each clusterGuides as g (g.axis + g.at)}
	<div class="cl-guide cl-guide-{g.axis}" style={g.axis === 'x' ? `left: ${g.at}px` : `top: ${g.at}px`} aria-hidden="true"></div>
{/each}
{#if movingCluster}
	<!-- 44 M12b: a cluster move armed from its menu — how to finish it (touch has no Escape) -->
	<p class="hud-edit-hint hud-move-hint cl-move-hint" id="cluster-move-hint" role="status">
		<span>{coarsePointer ? `Drag to place the ${CLUSTER_LABEL[movingCluster].toLowerCase()}` : 'Move to place · click to drop · Esc cancels'}</span>
		<button type="button" id="cluster-move-cancel" class="hud-move-cancel" use:onPress={() => clusterGrab.cancel()}>Cancel</button>
	</p>
{/if}
{#if clusterMenu}
	<ContextMenu x={clusterMenu.x} y={clusterMenu.y} items={clusterMenuItems(clusterMenu.id)} sizeKey="toolbarcluster" on:close={() => (clusterMenu = null)} />
{/if}

{#if editDrag}
	<!-- the carried button, following the pointer (the draft already shows where it lands) -->
	<div id="toolbar-edit-ghost" class="hud-edit-ghost" style="left: {editDrag.x}px; top: {editDrag.y}px" aria-hidden="true">
		{#if editDrag.id === SPACER}<span class="hud-play"><Icon name="play" size={20} class="hud-play-tri" fill="currentColor" /></span>{:else}<Icon name={BUTTONS[editDrag.id].iconName ?? BUTTONS[editDrag.id].icon} size={20} />{/if}
	</div>
{/if}

{#if editAddMenu}
	<ContextMenu x={editAddMenu.x} y={editAddMenu.y} items={editAddItems()} sizeKey="toolbaradd" on:close={() => (editAddMenu = null)} />
{/if}

<!-- physics transport (P-A): play / pause / stop / reset, above the chat toggle -->
<SimControls />

<!-- BOTH hidden XR buttons mount permanently (4a). They used to swap on
     `{#if $vrPassthrough}` — a reactive REMOUNT, which is fine while the preference
     only ever changed in Settings, and a race the moment the play FAB's mode menu can
     flip it and enter in the SAME gesture: svelte's flush is async, so the aimed
     button would not exist yet when `requestPlay` looked for it, and by the time it
     did the user activation that `requestSession` needs would be spent. With both
     mounted the aim is a QUERY, not a mount, and the entry stays gesture-synchronous.
     `data-aim` says which one a plain press would click — the preference, echoed for
     anyone (including the suites) who needs to read the decision off the DOM. -->
<div class="hidden" id="vrButton" data-aim={$vrPassthrough ? 'ar' : 'vr'}>
	<!-- W3: `onerror` is the ONE signal threlte gives for a session request that
	     REJECTS — a denied permission, no headset, a spent user activation — and it
	     was going nowhere, so the optimistic `isVRMode = true` in requestPlay stuck
	     and took the context menus down with it. -->
	<div id="vrButtonVr"><VRButton onerror={() => xrSessionFailed()} /></div>
	<!-- passthrough (90): same button flow, immersive-ar session -->
	<div id="vrButtonAr">
		<XRButton
			mode="immersive-ar"
			onerror={() => xrSessionFailed()}
			sessionInit={{
				requiredFeatures: [],
				optionalFeatures: ['local-floor', 'bounded-floor', 'anchors', 'hand-tracking', 'plane-detection', 'layers', 'depth-sorted-layers', 'hit-test', 'mesh-detection']
			}}
		/>
	</div>
</div>

{#if playMenu}
	<ContextMenu
		x={playMenu.x}
		y={playMenu.y}
		items={playModeItems()}
		sizeKey="playmode"
		on:close={() => (playMenu = null)}
	/>
{/if}

<!-- 4b: one toolbar cell's own menu (opened at the pointer by `cellMenu`), and
     the whole-bar Customize checklist it can open (anchored to the BAR). Each is
     its own `{#if}` and each opener nulls the other two, so only one is ever
     mounted; the `sizeKey`s are distinct so the search box remembers a height per
     KIND of menu rather than sharing one. -->
{#if toolbarMenu}
	<ContextMenu
		x={toolbarMenu.x}
		y={toolbarMenu.y}
		items={cellMenuItems(toolbarMenu.id)}
		sizeKey="toolbarcell"
		on:close={() => (toolbarMenu = null)}
	/>
{/if}

{#if overflowMenu}
	<ContextMenu x={overflowMenu.x} y={overflowMenu.y} items={overflowItems()} sizeKey="toolbaroverflow" on:close={() => (overflowMenu = null)} />
{/if}

{#if customizeMenu}
	<ContextMenu
		x={customizeMenu.x}
		y={customizeMenu.y}
		items={customizeMenuItems}
		sizeKey="toolbarcustomize"
		on:close={() => (customizeMenu = null)}
	/>
{/if}

<div id="object-list" data-key-scope="objects" role="region" aria-label="Object list" class={($objectListClose ? 'hidden' : 'flex') + ' flex-col ui-panel tp-ui tp-window overflow-hidden'} use:dragMe use:focusStack={'objects'}
	use:tabbable={{ key: 'objects', title: 'Objects', openStore: objectListClose, isOpen: (v) => !v, close: () => objectListClose.set(true) }}
	use:dockable={{ key: 'objects' }}
	use:bottomDockable={{ key: 'objects' }}
	style="z-index: var(--z-window)">
	<!-- dropping a row on the header moves the object back to the scene root -->
	<!-- 38 R6: the one window header (ui/WindowChrome, tool size). It is still the move
	     handle AND the drop-to-root target, and keeps its R22 ranking: the search leaves
	     first, then the word "Objects" (the icon stands in), the ✕ never -->
	<WindowChrome
		size="tool"
		bare
		body={false}
		title="Objects"
		dockedHead="tools"
		headerClass="ui-panel-header move-handle cursor-move select-none"
		headerAttrs={objHeaderAttrs}
		onclose={() => objectListClose.set(true)}
		closeAttrs={{ title: 'Close (O)' }}
	>
		{#snippet heading()}
			<span class="wc-label" title="Objects">{#if objHideLabel}<Icon name="list" size={16} />{:else}Objects{/if}</span>
			<!-- 38 NOTES-38 #24 (design page): the tool header carries the count -->
			<span class="obj-head-count" aria-label="{objectCount} objects">{objectCount}</span>
			{#if !objHideSearch}
				<span class="obj-search" on:pointerdown={(e) => e.stopPropagation()} role="presentation">
					<SearchField
						id="object-search"
						size="sm"
						placeholder="Search objects…"
						bind:value={searchTerm}
						onkeydown={searchKeydown}
					/>
				</span>
			{/if}
			<span class="flex-1"></span>
		{/snippet}
	</WindowChrome>
	<div class="obj-filters flex flex-col gap-1">
		<div class="relative flex items-center gap-1">
			<!-- 80.2: one scrollable chip row that never overflows the window -->
			<div id="filter-chips" class="tp-noscrollbar flex min-w-0 flex-1 items-center gap-1 overflow-x-auto whitespace-nowrap scrollbar-none" use:chipScroll>
				<button
					class="obj-chip"
					aria-pressed={!searchTypes.size && !viewMode}
					title="Show everything — click again to restore the previous chips"
					on:click={clickAll}
				>
					All
				</button>
				{#each [['mesh', 'Meshes'], ['light', 'Lights'], ['group', 'Groups'], ['stroke', 'Strokes']] as [value, label]}
					{#if !hiddenChips.has(value)}
						<button
							class="obj-chip"
							aria-pressed={searchTypes.has(value)}
							on:click={() => toggleTypeChip(value)}
						>
							{label}
						</button>
					{/if}
				{/each}
				{#each [...($showEnvInList ? [['environment', 'Environment']] : []), ...($advancedMode ? [['system', 'System']] : [])] as [value, label]}
					{#if !hiddenChips.has(value)}
						<button
							class="obj-chip"
							aria-pressed={viewMode === value}
							on:click={() => { viewMode = viewMode === value ? '' : value; searchTypes = new Set(); }}
						>
							{label}
						</button>
					{/if}
				{/each}
				{#if $objectFilter}
					<span class="obj-matches shrink-0">{matchCount} match{matchCount === 1 ? '' : 'es'}</span>
				{/if}
			</div>
			<!-- 80.3: chip visibility popover + reset -->
			<button
				id="chip-config"
				class="obj-cfg"
				title="Choose which filters show here"
				aria-label="Choose which filters show here"
				aria-expanded={chipPopup}
				on:click={() => (chipPopup = !chipPopup)}
			>
				<Icon name="sliders-horizontal" size={16} />
			</button>
			{#if chipPopup}
				<div
					id="chip-popup"
					class="obj-pop absolute right-0 top-8 z-10 flex w-48 flex-col gap-0.5"
				>
					{#each [['mesh', 'Meshes'], ['light', 'Lights'], ['group', 'Groups'], ['stroke', 'Strokes'], ...($showEnvInList ? [['environment', 'Environment']] : []), ...($advancedMode ? [['system', 'System']] : [])] as [value, label]}
						<label class="obj-pop-row">
							<input
								type="checkbox"
								checked={!hiddenChips.has(value)}
								on:change={() => toggleChipVisible(value)}
							/>
							{label}
						</label>
					{/each}
					<button
						id="reset-filters"
						class="obj-pop-reset"
						on:click={resetAllFilters}
					>
						Reset all filters
					</button>
					<label class="obj-pop-row obj-pop-sep">
						<input type="checkbox" bind:checked={$showLocalObjects} />
						Show local objects
					</label>
				</div>
			{/if}
		</div>
	</div>
	<div class="obj-scroller flex min-h-0 flex-1 flex-col overflow-y-auto rounded-lg rounded-br rounded-bl bg-transparent text-text-muted" use:minimalScroll>
		<!-- 24-B2: the tree is the keyboard surface — focusable, arrows/Enter/F2/type-ahead
		     walk the VISIBLE rows (see listKeydown); a subtle ring says it has focus -->
		<div
			id="object-tree"
			class="container outline-none focus-visible:ring-1 focus-visible:ring-accent"
			role="tree"
			tabindex="0"
			aria-label="Objects"
			aria-multiselectable="true"
			bind:this={treeEl}
			use:treeKeys>
			{#if viewMode === 'system'}
				{#if !systemNoticeDismissed}
					<div class="flex items-start gap-1 bg-ink-warn/15 p-2 text-[11px] text-ink-warn">
						<span class="flex-1">
							System objects are managed by modules and the environment — they regenerate
							from their state and are not editable here.
						</span>
						<button
							class="rounded-sm bg-surface-active px-1 text-text hover:bg-border-strong"
							title="Dismiss"
							aria-label="Dismiss this notice"
							on:click={() => {
								systemNoticeDismissed = true;
								safeStorage.setItem('systemNoticeDismissed', 'true');
							}}>✕</button>
					</div>
				{/if}
				{#each systemRows as row (row.name)}
					<div class="border-b border-border px-2 py-1 text-sm text-text-2">
						<div class="flex items-center gap-2">
							<button
								class="w-4 text-text-muted"
								title="Show children"
								on:click={() => (expandedSystem = { ...expandedSystem, [row.name]: !expandedSystem[row.name] })}
							>
								{expandedSystem[row.name] ? '−' : '+'}
							</button>
							<Icon name="cog" size={16} class="text-text-muted" aria-hidden="true" title="System object" />
							<span class="flex-1 overflow-hidden text-ellipsis whitespace-nowrap" title="Managed by a module / the environment">
								{row.name}
							</span>
							<span class="text-[10px] text-text-muted">{row.children.length}</span>
							<button
								class="rounded-sm bg-surface-active px-1.5 text-xs text-text hover:bg-border-strong"
								title="Ping it for everyone"
								on:click={() => pingObject(row.object)}><Icon name="pin" size={16} aria-hidden="true" /></button>
							<button
								class="rounded-sm bg-surface-active px-1.5 text-xs text-text hover:bg-border-strong"
								title="Pin a synced note to it"
								on:click={() => addAnnotation(row.object.uuid)}><Icon name="square-pen" size={16} aria-hidden="true" /></button>
							<button
								class="rounded-sm bg-surface-active px-1.5 text-xs text-text hover:bg-border-strong"
								title="Focus the camera on it"
								on:click={() => focusSystemObject(row.object)}><Icon name="eye" size={16} aria-hidden="true" /></button>
						</div>
						{#if expandedSystem[row.name]}
							{#each row.children as childName}
								<p class="pl-8 text-xs text-text-muted">{childName}</p>
							{/each}
						{/if}
					</div>
				{/each}
				{#if systemRows.length === 0}
					<p class="p-2 text-xs italic text-text-muted">No system objects right now — spawn a module (pong, dungeon) to see its content here.</p>
				{/if}
			{:else if viewMode === 'environment'}
				{#if !envNoticeDismissed}
					<div class="flex items-start gap-1 bg-ink-warn/15 p-2 text-[11px] text-ink-warn">
						<span class="flex-1">
							Environment objects are managed from Scene settings — switching presets
							replaces them. Edit them there, not here.
						</span>
						<button
							class="rounded-sm bg-surface-active px-1 text-text hover:bg-border-strong"
							title="Dismiss"
							aria-label="Dismiss this notice"
							on:click={() => {
								envNoticeDismissed = true;
								safeStorage.setItem('envNoticeDismissed', 'true');
							}}>✕</button>
					</div>
				{/if}
				{#each envRows as row (row.name)}
					<div class="border-b border-border px-2 py-1 text-sm text-text-2">
						<div class="flex items-center gap-2">
							<Icon name="sun" size={16} class="text-ink-warn/80" aria-hidden="true" title="Environment light" />
							<span class="flex-1 overflow-hidden text-ellipsis whitespace-nowrap" title="Managed from Scene settings">
								{row.name}
							</span>
							<span class="text-[10px] text-text-muted">{row.type}</span>
							<button
								class="rounded-sm bg-surface-active px-1.5 text-xs text-text hover:bg-border-strong"
								title="Ping it for everyone"
								on:click={() => pingObject(row.object)}><Icon name="pin" size={16} aria-hidden="true" /></button>
							<button
								class="rounded-sm bg-surface-active px-1.5 text-xs text-text hover:bg-border-strong"
								title="Focus the camera on it"
								on:click={() => focusSystemObject(row.object)}><Icon name="eye" size={16} aria-hidden="true" /></button>
						</div>
					</div>
				{/each}
				{#if envRows.length === 0}
					<p class="p-2 text-xs italic text-text-muted">The environment group is empty — pick a preset or add environment lights in Scene settings.</p>
				{/if}
			{:else}
			  {#if $objectsGroup}
				<LocalObjects />
				<!-- drop a local object anywhere here to SHARE it to the scene root -->
				<div class="min-h-8 rounded-sm transition-colors" data-object-rows={virtualising ? 'window' : 'tree'} use:shareDropZone use:trackTreeScroll>
					{#if virtualising}
						<div style={'height:' + windowStart * rowH + 'px'} aria-hidden="true"></div>
						{#each windowRows as row (row.uuid)}
							<Objects element={row.object} flat depth={row.depth} />
						{/each}
						<div style={'height:' + (treeRows.length - windowEnd) * rowH + 'px'} aria-hidden="true"></div>
					{:else if $objectsGroup.children.length > 0}
						{#each plainRows.slice(0, rowsMounted) as element}
						<Objects {element} />
						{/each}
					{/if}
				</div>
				<!-- 30 P3: every module's scene-root content, listed read-only -->
				<ModuleContent />
			  {/if}
			{/if}
		</div>
	</div>
	<!-- 26-A: THE BUDGET METER. One dot beside the count that a person can learn in a
	     second, next to the one number that already says how big the scene is. It opens
	     the Statistics window, because a warning you cannot act on is a decoration. -->
	<!-- 38 NOTES-38 #24 (design page): ONE status line — the count in mono on the left, the
	     reduced-quality state as a warn Badge on the right (it was a raw amber strip above).
	     Both stay the buttons they were: same ids, same handlers. -->
	<div class="obj-foot-row shrink-0">
		<button
			id="object-count"
			class="obj-foot text-left"
			title={budgetTitle}
			use:openStats
		>
			<span id="object-budget-dot" class="budget-dot mr-1" data-tier={budgetTier}></span>{objectCount} object{objectCount === 1 ? '' : 's'}{hiddenCount ? ' · ' + hiddenCount + ' hidden' : ''}
		</button>
		{#if $qualityState.level > 0 || $qualityState.pinned}
			<button
				id="quality-chip"
				class="obj-quality"
				data-level={$qualityState.level}
				data-pinned={$qualityState.pinned ? 'true' : 'false'}
				title={qualityTitle}
				use:qualityChipClick
			>
				<Badge tone="warn" text={'Reduced quality' + ($qualityState.pinned ? ' · held' : ' (scene is heavy)')} />
			</button>
		{/if}
	</div>
	<!-- corner grip INSIDE the window (was parked 38px below the box and unreachable, 92) -->
	<div
		class="resize-handle resize-cue"
		title="Drag to resize · double-click to reset size"
		style="position: absolute; bottom: 0; right: 0; width: 16px; height: 16px; cursor: se-resize; border-bottom-right-radius: 0.5rem; z-index: 5;"
	></div>
</div>

{#if $objectContextMenu}
	<ContextMenu
		x={$objectContextMenu.x}
		y={$objectContextMenu.y}
		items={objectMenuItems($objectContextMenu)}
		sizeKey="object"
		on:close={() => ($objectContextMenu = null)}
	/>
{/if}

<style>
	/* 38 R6: the object list's filter row, footer and chip popover in the tokens — chips are
	   the kit's Chips look (pill, border-strong, the accent-soft fill when on); the row logic
	   (All restores the previous set, Environment / System are exclusive views) is unchanged */
	.obj-search {
		display: flex;
		min-width: 0;
		width: 168px;
		flex-shrink: 1;
	}
	.obj-search :global(.sf) {
		width: 100%;
	}
	/* fix-batch-1 #23: at a large UI scale the search enters the header's line-breaking at a minimum
	   and grows into what is left (WindowChrome's compact-header rule for the title), so it narrows
	   before the ✕ wraps to a second row */
	:global(:root[data-ui-large]) .obj-search {
		flex: 3 1 0; /* most of what is left: the spacer after it only pushes the ✕ right */
		width: auto;
		min-width: min(6em, 100%);
	}
	.obj-filters {
		padding: 8px 10px;
		border-bottom: 1px solid var(--border);
		font-size: var(--fs-section);
	}
	.obj-chip {
		display: inline-flex;
		align-items: center;
		flex-shrink: 0;
		height: 26px;
		padding: 0 10px;
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-pill);
		background: transparent;
		color: var(--text-2);
		font-size: var(--fs-section);
		cursor: pointer;
	}
	.obj-chip:hover {
		border-color: var(--text-faint);
	}
	.obj-chip[aria-pressed='true'] {
		border-color: var(--accent);
		background: var(--accent-soft);
		color: var(--text);
	}
	.obj-matches {
		color: var(--text-faint);
	}
	.obj-cfg {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		width: 26px;
		height: 26px;
		border: 0;
		border-radius: var(--radius-input);
		background: transparent;
		color: var(--text-muted);
		cursor: pointer;
	}
	.obj-cfg:hover,
	.obj-cfg[aria-expanded='true'] {
		background: var(--surface-hover);
		color: var(--text);
	}
	.obj-pop {
		padding: 6px;
		border: 1px solid var(--border);
		border-radius: var(--radius-card);
		background: var(--surface-1);
		box-shadow: var(--shadow-window);
		color: var(--text);
	}
	.obj-pop-row {
		display: flex;
		align-items: center;
		gap: 8px;
		height: 30px;
		padding: 0 6px;
		border-radius: var(--radius-input);
		font-size: var(--fs-desc);
		cursor: pointer;
	}
	.obj-pop-row:hover {
		background: var(--surface-hover);
	}
	.obj-pop-row input {
		accent-color: var(--accent);
	}
	.obj-pop-sep {
		margin-top: 4px;
		border-top: 1px solid var(--border);
		border-radius: 0;
	}
	.obj-pop-reset {
		height: 30px;
		margin-top: 4px;
		padding: 0 6px;
		border: 0;
		border-radius: var(--radius-input);
		background: transparent;
		color: var(--warn-text);
		font-size: var(--fs-desc);
		text-align: left;
		cursor: pointer;
	}
	.obj-pop-reset:hover {
		background: var(--surface-hover);
	}
	.obj-foot-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		min-height: 28px;
		padding: 0 8px 0 0;
		border-top: 1px solid var(--border);
	}
	.obj-foot {
		display: flex;
		align-items: center;
		min-width: 0;
		height: 26px;
		padding: 0 12px;
		border: 0;
		background: transparent;
		color: var(--text-faint);
		font-family: var(--font-ui-mono);
		font-size: var(--fs-badge);
		white-space: nowrap;
		cursor: pointer;
	}
	.obj-quality {
		display: inline-flex;
		min-width: 0;
		padding: 0;
		border: 0;
		background: transparent;
		cursor: pointer;
	}
	.obj-head-count {
		font-family: var(--font-ui-mono);
		font-size: var(--fs-badge);
		color: var(--text-faint);
		font-variant-numeric: tabular-nums;
	}
	.obj-foot:hover {
		color: var(--text-2);
	}
</style>
