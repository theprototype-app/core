<script lang="ts">
	import { Cog, Eye, FolderOpen, List, Maximize2, MessageSquare, Move, Pin, Play, RectangleGoggles, RotateCcw, SquarePen, Sun, Workflow } from '@lucide/svelte';
	import { Listgroup } from 'flowbite-svelte';
	import { objectsGroup, TControls, transformMode, isLocked, lockedObjects, globalScene, vrPassthrough, vrOverride, selectedObject, selectedObjects } from '../../stores/sceneStore';
	import { chatHidden, flowGraphClose, explorerClose, objectListClose, objectContextMenu, renamingObject, advancedMode, showEnvInList, showLocalObjects, armExplorerDock, floatingToolbar } from '../../stores/appStore.js';
	import { systemGroupNames } from '$lib/moduleSDK';
	import { ENV_ROOT } from '$lib/environment';
	import { flyTo } from '$lib/objectActions';
	import { mutedFlowObjects } from '../../stores/flowStore';
	import { focusObject, duplicateObject, toggleObjectVisibility, moveObjectToGroup, setTransformMode } from '$lib/objectActions';
	import { registerWindowReset } from '$lib/dragWindow';
	import { enterEditMode } from '$lib/meshEdit';
	import { addAnnotation } from '$lib/annotationsHandler';
	import { requestControl, nameOf } from '$lib/lockControl';
	import { savePrefab } from '$lib/prefabs';
	import { sendPing } from '$lib/ping';
	import { buildObjectMenuItems } from '$lib/objectMenu';
	import * as THREE from 'three';
	import { onMount, setContext } from 'svelte';
	import { writable } from 'svelte/store';
	import { shareObject } from '$lib/objectPermissions';
	import Objects from './Objects.svelte';
	import LocalObjects from './LocalObjects.svelte';
	import ContextMenu from '../ContextMenu.svelte';
	import MobileAddButton from './MobileAddButton.svelte';
	import AiHudButton from './AiHudButton.svelte';
	import SimControls from './SimControls.svelte';
	import { focusStack } from '$lib/windowFocus';
	import { tabbable, groupRectOf, moveGroupOf, resizeGroup } from '$lib/windowTabs';
	import { clampWinSize, clampResize, anchorOf } from '$lib/windowSize';
	import { dockable } from '$lib/docking';
	import { visibleDockKey, dockOccupants, FLOW_FAMILY } from '$lib/bottomDock';
	import { togglePanel } from '$lib/panelToggles';
	import { requestPlay, willEnterXR, willEnterAR, vrSupported, arSupported, xrSessionFailed } from '$lib/playMode';
	import { dockAddItems } from '$lib/dockMenu';
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
	const flowDockVisible = $derived(FLOW_FAMILY.includes($visibleDockKey ?? ''));
	const flowFloatingShown = $derived(!$flowGraphClose && !$dockOccupants.flow?.present);
	const flowShown = $derived(flowDockVisible || flowFloatingShown);
	const explorerShown = $derived(!$explorerClose && ($visibleDockKey === 'explorer' || !$dockOccupants.explorer?.present));

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
	const ICON_ON = 'text-primary-500';
	const ICON_OFF = 'text-black dark:text-slate-200';

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

	// 80.3: which chips show in the bar (⚙ popover), persisted
	let chipPopup = $state(false);
	let hiddenChips: Set<string> = $state(
		new Set(
			typeof localStorage !== 'undefined'
				? JSON.parse(localStorage.getItem('hiddenListChips') ?? '[]')
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
		localStorage.setItem('hiddenListChips', JSON.stringify([...next]));
	}
	function resetAllFilters() {
		searchTerm = '';
		searchTypes = new Set();
		lastTypes = new Set();
		viewMode = '';
		hiddenChips = new Set();
		localStorage.setItem('hiddenListChips', '[]');
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
	function shareDropZone(node: HTMLElement) {
		const setActive = (on: boolean) => {
			node.style.boxShadow = on ? 'inset 0 0 0 2px rgb(59 130 246 / 0.7)' : '';
			node.style.background = on ? 'rgb(59 130 246 / 0.08)' : '';
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
			const uuid = e.dataTransfer?.getData('application/x-object-uuid');
			if (!uuid) return;
			e.preventDefault();
			e.stopPropagation();
			const obj: any = ($objectsGroup as any)?.getObjectByProperty('uuid', uuid);
			if (obj?.userData?.__localOnly) shareObject(obj);
			else moveObjectToGroup(uuid, 'root');
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
		typeof localStorage !== 'undefined' && localStorage.getItem('systemNoticeDismissed') === 'true'
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
		typeof localStorage !== 'undefined' && localStorage.getItem('envNoticeDismissed') === 'true'
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
	let classActive =
		'group inline-flex items-center justify-center hover:bg-primary-700 focus:outline-hidden focus:ring-4 focus:ring-primary-300';

	// 18-B: object-list window size limits, shared with the clamp helpers
	const OBJ_WIN_MIN = { minW: 250, minH: 200 };
	const OBJ_WIN_DEFAULT = { w: 300, h: 250 };

	function dragMe(node) {
		// 80.1: proper resize (start-size captured, clamped) + persisted rect
		let saved: any = null;
		try {
			saved = JSON.parse(localStorage.getItem('objectListRect') ?? 'null');
		} catch {}
		let moving = false;
		let left = saved?.left ?? 350;
		let top = saved?.top ?? 100;
		let width = saved?.width ?? 300;
		let height = saved?.height ?? 250;

		let startX = 0;
		let startY = 0;
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
			localStorage.setItem(
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
			const t = /** @type {any} */ (e.target);
			if (t?.closest?.('.move-handle') && !t.closest('input, button')) {
				moving = true;
			}
		});

		window.addEventListener('pointermove', (e) => {
			if (moving) {
				if (grouped()) {
					// move the whole tab group so its strip follows (not just this window)
					moveGroupOf('objects', e.movementX, e.movementY);
				} else {
					left += e.movementX;
					top += e.movementY;
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
		node.addEventListener('dblclick', (e: any) => {
			if (!e.target?.classList?.contains('resize-handle') || grouped()) return;
			({ w: width, h: height } = clampWinSize(OBJ_WIN_DEFAULT.w, OBJ_WIN_DEFAULT.h, OBJ_WIN_MIN));
			node.style.width = `${width}px`;
			node.style.height = `${height}px`;
			persist();
		});

		// 169: Settings "Reset window positions" recentres the object list too
		registerWindowReset(() => {
			left = 350;
			top = 100;
			node.style.left = `${left}px`;
			node.style.top = `${top}px`;
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
			playMenu = { x: e.clientX, y: e.clientY };
		};
		node.addEventListener('contextmenu', open);
		return { destroy: () => node.removeEventListener('contextmenu', open) };
	}

	function playModeItems() {
		return [
			{ section: 'Play as' },
			{
				label: 'Play (desktop)',
				checked: !$willEnterXR,
				action: () => {
					// vrOverride is the STRING mirror Settings writes; Scene seeds the store
					// from localStorage on boot, so both halves have to move together.
					vrOverride.set(true);
					localStorage.setItem('vrOverride', 'true');
					requestPlay();
				}
			},
			{
				label: 'Enter VR',
				checked: $willEnterXR && !$vrPassthrough,
				disabled: !$vrSupported,
				tooltip: $vrSupported ? 'Immersive VR — the scene replaces your view' : 'No immersive-vr support detected',
				action: () => {
					vrOverride.set(false);
					localStorage.removeItem('vrOverride');
					vrPassthrough.set(false);
					localStorage.setItem('vrPassthrough', 'false');
					requestPlay();
				}
			},
			{
				label: 'Enter AR passthrough',
				checked: $willEnterAR,
				disabled: !$arSupported,
				tooltip: $arSupported
					? 'Mixed reality — the scene composites over your room'
					: 'No immersive-ar (passthrough) support detected',
				action: () => {
					vrOverride.set(false);
					localStorage.removeItem('vrOverride');
					vrPassthrough.set(true);
					localStorage.setItem('vrPassthrough', 'true');
					requestPlay();
				}
			},
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
	type ControlsLayout = { order: string[]; hidden: string[]; spacerIndex: number; collapsed: boolean };
	type CellButton = { title: string; slot?: string; icon: any; tint: () => string; run: () => void };

	/** the one PSEUDO-cell: the transparent well the play FAB sits in. It is not a
	 *  roster entry (play is never hideable) but it IS a cell of the row, which is
	 *  what makes "move one place left" mean the same thing for it and for a button.
	 *
	 *  W1 removed its sibling, a chevron cell that used to appear while collapsed:
	 *  a collapsed bar is the well and nothing else, and the way back out lives in
	 *  the FAB's own right-click menu (plus Settings' Reset window positions, which
	 *  is the hatch for iOS Safari, where a long press fires no `contextmenu`). */
	const SPACER = '__spacer';
	const DEFAULT_ORDER = ['move', 'rotate', 'scale', 'objects', 'flow', 'explorer'];
	const DEFAULT_SPACER = 3;

	// The six roster buttons. Every title and every handler is VERBATIM what the
	// hand-written cells carried: controls-state, controls-transform-tint, dock-inset,
	// flow-explorer-dock, panel-toggle-keys and ~25 Explorer suites all select on
	// `p[title="…"]` / `#explorer-slot`, so these strings are load-bearing.
	// `tint` is a FUNCTION, not a stored string: it is called from the template, so
	// reading `$transformMode` / the `$derived` flags inside it registers the
	// dependency in the render effect exactly as the inline expressions used to.
	const BUTTONS: Record<string, CellButton> = {
		move: {
			title: 'Move (1)',
			icon: Move,
			tint: () => (hasSel && $transformMode === 'translate' ? ICON_ON : ICON_OFF),
			run: () => setTransformMode('translate')
		},
		rotate: {
			title: 'Rotate (2)',
			icon: RotateCcw,
			tint: () => (hasSel && $transformMode === 'rotate' ? ICON_ON : ICON_OFF),
			run: () => setTransformMode('rotate')
		},
		scale: {
			title: 'Scale (3)',
			icon: Maximize2,
			tint: () => (hasSel && $transformMode === 'scale' ? ICON_ON : ICON_OFF),
			run: () => setTransformMode('scale')
		},
		objects: {
			title: 'Object list (O)',
			icon: List,
			tint: () => (!$objectListClose ? ICON_ON : ICON_OFF),
			run: () => togglePanel('objects')
		},
		flow: {
			title: 'Node editor (N)',
			icon: Workflow,
			tint: () => (flowShown ? ICON_ON : ICON_OFF),
			run: () => togglePanel('flow')
		},
		explorer: {
			title: 'Explorer',
			slot: 'explorer-slot',
			icon: FolderOpen,
			tint: () => (explorerShown ? ICON_ON : ICON_OFF),
			run: () => togglePanel('explorer')
		}
	};

	function defaultLayout(): ControlsLayout {
		return { order: [...DEFAULT_ORDER], hidden: [], spacerIndex: DEFAULT_SPACER, collapsed: false };
	}

	/** Read the persisted layout, SSR-guarded and defensive: a stored record is user
	 *  data that a later version of this file may not recognise. A button the saved
	 *  order has never heard of is APPENDED rather than suppressed (`explorerColumns`'
	 *  rule: store what is hidden, so anything added later shows by default), and an
	 *  id that no longer exists is dropped so the registry lookup can never miss. */
	function loadLayout(): ControlsLayout {
		if (typeof localStorage === 'undefined') return defaultLayout();
		try {
			const raw = localStorage.getItem('controlsLayout');
			if (!raw) return defaultLayout();
			const saved = JSON.parse(raw) ?? {};
			const order: string[] = Array.isArray(saved.order)
				? saved.order.filter((id: any) => DEFAULT_ORDER.includes(id))
				: [];
			for (const id of DEFAULT_ORDER) if (!order.includes(id)) order.push(id);
			const hidden: string[] = Array.isArray(saved.hidden)
				? saved.hidden.filter((id: any) => order.includes(id))
				: [];
			const room = order.filter((id) => !hidden.includes(id)).length;
			const spacerIndex = Number.isFinite(saved.spacerIndex)
				? Math.max(0, Math.min(saved.spacerIndex, room))
				: Math.min(DEFAULT_SPACER, room);
			return { order, hidden, spacerIndex, collapsed: saved.collapsed === true };
		} catch {
			return defaultLayout();
		}
	}

	let controlsLayout: ControlsLayout = $state(loadLayout());

	function saveLayout() {
		try {
			localStorage.setItem('controlsLayout', JSON.stringify(controlsLayout));
		} catch {
			// private mode / storage full — the bar still works for this session
		}
	}

	/** The ONE write path. ALWAYS REASSIGNS: `$derived` compares with `===`, so an
	 *  in-place `order.push(…)` would leave every cell exactly where it was. */
	function setLayout(patch: Partial<ControlsLayout>) {
		controlsLayout = { ...controlsLayout, ...patch };
		saveLayout();
	}

	function resetLayout() {
		controlsLayout = defaultLayout();
		try {
			localStorage.removeItem('controlsLayout');
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

	/** the roster buttons actually ON the bar, in bar order (the spacer is not one) */
	function shownIds(): string[] {
		return controlsLayout.order.filter((id) => BUTTONS[id] && !controlsLayout.hidden.includes(id));
	}

	/** THE VISUAL ROW — the bar exactly as the user reads it: the shown buttons with
	 *  the FAB's well spliced in at `spacerIndex`. Every rearrangement is a splice on
	 *  THIS sequence and the record is derived back from it (below), which is the W1
	 *  correction: `order` and `spacerIndex` used to be moved independently, so a step
	 *  across the well moved TWO cells at once ("Move left and right near play just
	 *  swap items around the play button"). */
	function visualIds(): string[] {
		const shown = shownIds();
		const seq: string[] = [...shown];
		seq.splice(Math.max(0, Math.min(controlsLayout.spacerIndex, shown.length)), 0, SPACER);
		return seq;
	}

	// The cells the bar renders. Collapsed, that is the well ALONE — the play button
	// is the whole toolbar, and its own menu is the way back.
	const visibleCells = $derived.by(() =>
		controlsLayout.collapsed ? [{ id: SPACER }] : visualIds().map((id) => ({ id }))
	);

	function runCell(id: string) {
		BUTTONS[id]?.run();
	}

	// --- rearranging -------------------------------------------------------------
	/** Move one cell — a button or the well itself — exactly ONE visual slot.
	 *
	 *  Swapping with the neighbour ON THE VISUAL ROW is what makes crossing the play
	 *  button a single step: the button and the well trade places, so the button ends
	 *  up on play's other side and every other cell keeps its slot. The record is then
	 *  READ OFF the mutated row — the well's index is where the well now is, and the
	 *  shown buttons are poured back into their slots in `order`, so hidden entries
	 *  keep their absolute positions and come back where they were left. */
	function moveCell(id: string, dir: number) {
		const seq = visualIds();
		const at = seq.indexOf(id);
		const to = at + dir;
		if (at < 0 || to < 0 || to >= seq.length) return;
		seq[at] = seq[to];
		seq[to] = id;
		const shown = seq.filter((cell) => cell !== SPACER);
		const order = [...controlsLayout.order];
		let next = 0;
		for (let i = 0; i < order.length; i++)
			if (BUTTONS[order[i]] && !controlsLayout.hidden.includes(order[i])) order[i] = shown[next++];
		setLayout({ order, spacerIndex: seq.indexOf(SPACER) });
	}

	function hideButton(id: string) {
		const at = shownIds().indexOf(id);
		const spacerIndex =
			at > -1 && at < controlsLayout.spacerIndex ? controlsLayout.spacerIndex - 1 : controlsLayout.spacerIndex;
		setLayout({ hidden: [...controlsLayout.hidden, id], spacerIndex });
	}

	function showButton(id: string) {
		const hidden = controlsLayout.hidden.filter((h) => h !== id);
		const at = controlsLayout.order.filter((o) => BUTTONS[o] && !hidden.includes(o)).indexOf(id);
		const spacerIndex =
			at > -1 && at < controlsLayout.spacerIndex ? controlsLayout.spacerIndex + 1 : controlsLayout.spacerIndex;
		setLayout({ hidden, spacerIndex });
	}

	// --- the toolbar's own right-click menus --------------------------------------
	// `cellMenu` generalises 4a's `playModeMenu`: a DIRECT `contextmenu` listener,
	// because svelte DELEGATES event attributes to the app root and the Controls chrome
	// is exactly the kind of ancestor that swallows them on the way up. Every cell
	// opens the same shared ContextMenu, and opening one closes the other two — one
	// menu on screen at a time.
	let toolbarMenu: { x: number; y: number; id: string } | null = $state(null);
	let customizeMenu: { x: number; y: number } | null = $state(null);

	function cellMenu(node: HTMLElement, id: string) {
		const open = (e: MouseEvent) => {
			e.preventDefault();
			e.stopPropagation();
			playMenu = null;
			customizeMenu = null;
			toolbarMenu = { x: e.clientX, y: e.clientY, id };
		};
		node.addEventListener('contextmenu', open);
		return { destroy: () => node.removeEventListener('contextmenu', open) };
	}

	/** the mode the Explorer is in — panelToggles' own `opensDocked` rule, READ rather
	 *  than duplicated, so the two rows can say which one is on. `setDocked` keeps this
	 *  flag in step with the panel, so it is the honest answer either way. */
	function explorerOpensDocked(): boolean {
		return typeof localStorage === 'undefined' || localStorage.getItem('explorerDocked') !== 'false';
	}

	/** Move the Explorer between dock tab and floating window.
	 *
	 *  It would be tempting to write `explorerDocked` here and reopen through
	 *  `togglePanel`, and it is MEASURABLY inert: the panel reads that flag exactly
	 *  ONCE, at mount, into component-local state, so nothing moves until the next
	 *  reload — closing and reopening does not help, because the component stays
	 *  mounted the whole time. The panel owns the mode (flag + render branch + dock
	 *  occupancy in one function), so we ASK and it acts — the write-once arm store it
	 *  already uses for the inline scene-save request. */
	function setExplorerMode(docked: boolean) {
		armExplorerDock(docked);
	}

	function openCustomize() {
		// anchored to the BAR, not the pointer: this menu is about the whole toolbar.
		// ContextMenu measures itself and clamps into the viewport, so a bar sitting on
		// the bottom edge gets a menu that opens upward with no arithmetic here.
		const rect = document.getElementById('controls-pill')?.getBoundingClientRect();
		customizeMenu = { x: Math.round(rect?.left ?? 8), y: Math.round(rect?.top ?? 8) };
	}

	/** The tail EVERY toolbar menu carries — the play FAB's mode menu included, which
	 *  is why `id` may be null: the FAB is not a roster entry, so it is never offered
	 *  "Hide button" and its Move left / Move right walk the well instead. */
	function toolbarTail(id: string | null) {
		// a plain `const` the closures below capture: TS does not carry a narrowing of
		// a PARAMETER into a nested arrow, so `id!` or a cast would be the alternative
		const target = id ?? '';
		// the FAB is the WELL on the visual row, so both kinds of cell ask the same
		// question of the same sequence — one rule, no second index arithmetic
		const cell = target || SPACER;
		const seq = visualIds();
		const at = seq.indexOf(cell);
		const collapsed = controlsLayout.collapsed;
		return [
			{ section: 'Toolbar' },
			{
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
			},
			...(target
				? [
						{
							label: 'Hide button',
							tooltip: 'Take it off the bar — Customize toolbar brings it back',
							action: () => hideButton(target)
						}
					]
				: []),
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
		const head: any[] = [];
		if (id === 'flow') {
			// the dock's shared "+" list — the same one DockTabs and the floating Node
			// editor's header render, so a view added there appears here for free
			head.push(
				{ section: 'Node editor' },
				{ label: 'Open Node editor', tooltip: 'Show or hide the graph editor (N)', action: () => togglePanel('flow') },
				{ section: 'Add a view' },
				...dockAddItems()
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
		return [...head, ...toolbarTail(id)];
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
		const ids = [...new Set([...controlsLayout.order, ...DEFAULT_ORDER])].filter((id) => BUTTONS[id]);
		const seq = visualIds();
		return [
			{ section: 'Toolbar buttons' },
			...ids.map((id) => {
				const shown = !controlsLayout.hidden.includes(id);
				const at = seq.indexOf(id);
				return {
					label: BUTTONS[id].title,
					checked: shown,
					keepOpen: true,
					tooltip: shown ? 'Take it off the bar' : 'Put it back on the bar',
					action: () => (shown ? hideButton(id) : showButton(id)),
					rowActions: [
						{
							icon: 'chevron-left',
							label: `Move ${BUTTONS[id].title} left`,
							disabled: !shown || at <= 0,
							run: () => moveCell(id, -1)
						},
						{
							icon: 'chevron-right',
							label: `Move ${BUTTONS[id].title} right`,
							disabled: !shown || at < 0 || at >= seq.length - 1,
							run: () => moveCell(id, 1)
						}
					]
				};
			}),
			{ section: '' },
			{
				label: 'Reset toolbar',
				danger: true,
				keepOpen: true,
				tooltip: 'Back to the six default buttons in their default order',
				action: resetLayout
			}
		];
	}

	/** the reactive half of `keepOpen`: passing `customizeItems()` inline would already
	 *  re-run inside the template's render effect, but the menu's whole point is that
	 *  the rows track the record, so the dependency is stated here rather than implied
	 *  by where the call happens to sit */
	const customizeMenuItems = $derived(customizeItems());

	/* W2: WHERE THE PILL SITS, and it is the user's call (`floatingToolbar`, default OFF).
	 *   ON  — the 0854c3b behaviour: anchored on `--bottom-inset`, so the bar and the play
	 *         FAB in its well ride in the band just above an open dock, on the z-45 HUD
	 *         tier that keeps them clear of it.
	 *   OFF — the pill is an ordinary member of the BOTTOM-HUD tier: pinned 16px off the
	 *         viewport floor, and z-30 like `#chat-button` / `#ai-hud-button` /
	 *         `#sim-controls` beside it, which is to say the dock DELIBERATELY covers it
	 *         (the same reasoning as the chat button's comment below — an open editor owns
	 *         the bottom of the screen and the toolbar goes under it).
	 * ONE derived pair rather than two markup branches: the nav, the roster and the FAB
	 * inside it are identical in both modes, and a second branch would be a second copy of
	 * the well to keep in step. The transition stays in BOTH so flipping the setting — and,
	 * when floating, opening the dock — animates rather than jumping.
	 * The FAB keeps its own `z-index: var(--z-hud)`: the pill is positioned WITH a z-index,
	 * so it is a stacking context and its children cannot escape it whatever they ask for.
	 * That z only orders the FAB against its own siblings in the well. */
	const pillZClass = $derived($floatingToolbar ? 'z-45' : 'z-30');
	const pillStyle = $derived(
		$floatingToolbar
			? 'bottom: calc(var(--bottom-inset, 0px) + 16px); transition: bottom 200ms ease'
			: 'bottom: 16px; transition: bottom 200ms ease'
	);

</script>

<!-- WHERE THE PILL SITS is `floatingToolbar`'s call now (Settings ▸ Interface ▸ Windows
     & chrome, default OFF) — see the derived pair above. With it ON the pill RIDES
     ABOVE the bottom dock: `--bottom-inset` is the visible docked Flow/Explorer panel's
     height (published by $lib/bottomDock), so the bar and the play FAB inside it sit in
     the band just above it instead of covering its last ~60px — which is what the old
     `--dock-inset` model got wrong, padding the DOCK's content and only at <=500px, so
     every wider screen had the pill permanently over the node palette / folder tree.
     OFF the pill stays on the viewport floor and the dock covers it. 200ms matches the
     dock's own fly transition, so when they do move they move together.
       4b: a plain <nav> over the `visibleCells` roster, no longer flowbite's
     `BottomNav` (whose inner grid column count must be a JIT literal, which a
     customizable cell count cannot be). The class list is flowbite's own RESOLVED
     output for `position="absolute" navType="application"` plus this component's
     overrides, read off the rendered DOM — same border, surface, radius and 40px
     height. `bottom-4` stays in it purely as the class the inline style overrides,
     exactly as before. The cells are `w-10` literals now: the grid's content-sized
     `fr` columns used to take their width from the spacer, and a flex row has to say
     it out loud. -->
<nav
	id="controls-pill"
	class="border-gray-200 dark:border-gray-600 absolute max-w-lg -translate-x-1/2 rtl:translate-x-1/2 border bottom-4 start-1/2 h-10 w-max min-w-max shrink-0 bg-white rounded-full dark:bg-gray-700 {pillZClass}"
	style={pillStyle}
>
	<div class="mx-auto flex h-full max-w-lg">
		{#each visibleCells as cell, i (cell.id)}
			{#if cell.id === SPACER}
				<!-- QW (Controls Option A): the transparent WELL the floating play button
				     sits in — the old filled square peeked out around the circle. Hovering
				     either NEIGHBOR paints it too (the arbitrary variants below), so the
				     hover red runs continuously up to the round button instead of leaving
				     pill-colored notches above/below the circle.
				       TWO HALVES so each neighbor's hover paints only ITS side up to the
				     circle (a full-width paint peeked out red on the opposite side of the
				     FAB). No transition — the neighbors' own hover backgrounds are instant,
				     a fade here lagged visibly.
				       4b: the FAB is the well's own THIRD child now (see below), which is
				     why the right half is addressed as `:nth-child(2)` rather than
				     `:last-child` — the FAB would otherwise steal that position and the
				     right-hand hover paint would silently stop appearing. -->
				<div class="relative flex h-full w-10 items-stretch justify-center">
					<div
						class={'h-full w-5 [p:hover+div>&:first-child]:bg-primary-700' + (i === 0 ? ' rounded-l-full' : '')}
					></div>
					<div
						class={'h-full w-5 [div:has(+p:hover)>&:nth-child(2)]:bg-primary-700' +
							(i === visibleCells.length - 1 ? ' rounded-r-full' : '')}
					></div>
					<!-- QW (Controls Option A): the WHOLE button scales on hover anywhere on
					     it (the centering translate lives in a tailwind class so the two
					     transforms compose instead of fighting). clip-path circles the HIT
					     AREA too: the 50px square box used to intercept clicks/hovers meant
					     for the cells it overlaps. fill=currentColor keeps the play triangle
					     SOLID (lucide is stroke-only by default); the 2px nudge is the
					     classic optical centering.
					       4b: the FAB LIVES IN THE BAR now instead of being an absolutely
					     positioned sibling with its own `--bottom-inset` arithmetic. It
					     inherits the pill's ride for free (one anchor, one transition, no
					     chance of the two drifting apart mid-animation) and it TRACKS THE
					     WELL, so moving the well moves the play button. `top: -5px` against
					     the 38px inner row reproduces the old geometry exactly: a 50px
					     circle 5px proud of the bar's top and 7px below its bottom, which is
					     the 4px/6px overhang measured against the bordered 40px pill. -->
					<p
						id="play-button"
						title={$willEnterAR
							? 'Enter AR — the scene composites over your room'
							: $willEnterXR
								? 'Enter VR'
								: 'Play'}
						class={classActive +
							' -translate-x-1/2 rounded-full bg-primary-600 font-medium hover:scale-110 dark:focus:ring-primary-800'}
						style="position: absolute; height: 50px; width: 50px; top: -5px; left: 50%; z-index: var(--z-hud);
	        display: flex; transition: transform 100ms"
						on:click={() => {
							requestPlay();
						}}
						use:playModeMenu
					>
						<!-- CO4b: ONE entry point that SHOWS its destination. The FAB already
						     starts play mode on desktop and an immersive session in a headset,
						     and `$vrPassthrough` decides which KIND (both hidden XR buttons
						     mount below; `data-aim` says which one a press clicks) — so the
						     honest thing is to say so ON this button rather than grow a second
						     one beside it. Right-click picks the mode explicitly.
						       desktop  the play triangle, unchanged
						       VR       a headset (rectangle-goggles): press this and you are
						                IN there
						       AR       the same headset with A and R in its two lens halves,
						                and a slightly bigger glyph to carry them
						     The visor is ONE path with a nose notch at the bottom centre, so
						     its halves sit at x 7.5 and 16.5 of the 24-unit box — 31.25% and
						     68.75% — which is where the letters are anchored
						     (translate(-50%,-50%) centres them on that point, so they stay put
						     at any icon size). The overlay is `pointer-events: none` and
						     unselectable: the circle stays ONE hit target, which
						     #play-button's clip-path was tuned for. No `ml-0.5` on the goggles
						     — that 2px nudge is optical centering for a TRIANGLE, and a
						     symmetric visor with it looks off-centre. -->
						{#if $willEnterAR}
							<span class="pointer-events-none relative inline-flex select-none items-center justify-center">
								<RectangleGoggles size={30} class="text-white" aria-hidden="true" />
								<span
									class="absolute text-[10px] font-bold leading-none text-white"
									style="left: 29%; top: 50%; transform: translate(-50%, -50%)">A</span
								>
								<span
									class="absolute text-[10px] font-bold leading-none text-white"
									style="left: 71%; top: 50%; transform: translate(-50%, -50%)">R</span
								>
							</span>
						{:else if $willEnterXR}
							<RectangleGoggles size={26} class="text-white" aria-hidden="true" />
						{:else}
							<Play size={24} class="ml-0.5 text-white" fill="currentColor" aria-hidden="true" />
						{/if}
					</p>
				</div>
			{:else}
				{@const btn = BUTTONS[cell.id]}
				{@const Glyph = btn.icon}
				<!-- ONE template for every roster button: the six hand-written cells each
				     carried their own copy of this element, so each one also carried its own
				     copy of the same three a11y/deprecation warnings. -->
				<p
					id={btn.slot}
					class={classActive +
						' w-10' +
						(i === 0 ? ' rounded-l-full' : '') +
						(i === visibleCells.length - 1 ? ' rounded-r-full' : '')}
					title={btn.title}
					on:click={() => runCell(cell.id)}
					use:cellMenu={cell.id}
				>
					<Glyph size={18} class={btn.tint()} aria-hidden="true" />
				</p>
			{/if}
		{/each}
	</div>
</nav>

<!-- chat toggle lives bottom-right under the mic (93); z under the bottom
     dock so an open flow editor / Explorer covers the stack -->
<button
	id="chat-button"
	class="fixed bottom-4 right-4 z-30 flex h-11 w-11 items-center justify-center rounded-full bg-gray-700 shadow-lg transition-colors hover:bg-gray-600"
	title="Chat (C)"
	on:click={() => chatHidden.set($chatHidden === 'hidden' ? '' : 'hidden')}
>
	<MessageSquare size={16} class="text-white" aria-hidden="true" />
</button>

<!-- mobile "+" (bottom-left): opens the same create/context menu as a right-click
     (own component so it can use onclick without mixing with this file's on:) -->
<MobileAddButton />

<!-- A2: AI assistant button, bottom-left below the "+" (own component, onclick) -->
<AiHudButton />

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

{#if customizeMenu}
	<ContextMenu
		x={customizeMenu.x}
		y={customizeMenu.y}
		items={customizeMenuItems}
		sizeKey="toolbarcustomize"
		on:close={() => (customizeMenu = null)}
	/>
{/if}

<div id="object-list" class={($objectListClose ? 'hidden' : 'flex') + ' flex-col ui-panel overflow-hidden'} use:dragMe use:focusStack={'objects'}
	use:tabbable={{ key: 'objects', title: '☰ Objects', openStore: objectListClose, isOpen: (v) => !v, close: () => objectListClose.set(true) }}
	use:dockable={{ key: 'objects' }}
	style="z-index: var(--z-window)">
	<!-- dropping a row on the header moves the object back to the scene root -->
	<!-- header matches the Explorer chrome (104): title + inline search + close;
	     still the move handle AND the drop-to-root target -->
	<div
		role="list"
		class="ui-panel-header move-handle shrink-0 cursor-move select-none rounded-tl-lg rounded-tr-lg py-1.5"
		on:dragover={(e) => { if (e.dataTransfer?.types.includes('application/x-object-uuid')) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; } }}
		on:drop={(e) => {
			const uuid = e.dataTransfer?.getData('application/x-object-uuid');
			if (!uuid) return;
			e.preventDefault();
			const obj = ($objectsGroup as any)?.getObjectByProperty('uuid', uuid);
			if (obj?.userData?.__localOnly) shareObject(obj);
			else moveObjectToGroup(uuid, 'root');
		}}
	>
		<span>☰ Objects</span>
		<input
			id="object-search"
			class="ui-input w-36 py-0.5 font-normal normal-case tracking-normal"
			placeholder="Search objects…"
			value={searchTerm}
			on:pointerdown={(e) => e.stopPropagation()}
			on:input={(e) => (searchTerm = e.currentTarget.value)}
			on:keydown={(e) => { if (e.key === 'Escape') { searchTerm = ''; e.currentTarget.blur(); } }}
		/>
		<span class="flex-1"></span>
		<button class="ui-button-quiet" title="Close (O)" on:click={() => objectListClose.set(true)}>✕</button>
	</div>
	<div class="flex flex-col gap-1 bg-gray-100 p-1 text-xs dark:bg-gray-700">
		<div class="relative flex items-center gap-1">
			<!-- 80.2: one scrollable chip row that never overflows the window -->
			<div id="filter-chips" class="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto whitespace-nowrap scrollbar-none" use:chipScroll>
				<button
					class={'shrink-0 rounded-full px-2 py-0.5 ' +
						(!searchTypes.size && !viewMode
							? 'bg-primary-600 text-white'
							: 'bg-gray-200 text-gray-700 dark:bg-gray-600 dark:text-gray-200')}
					title="Show everything — click again to restore the previous chips"
					on:click={clickAll}
				>
					All
				</button>
				{#each [['mesh', 'Meshes'], ['light', 'Lights'], ['group', 'Groups'], ['stroke', 'Strokes']] as [value, label]}
					{#if !hiddenChips.has(value)}
						<button
							class={'shrink-0 rounded-full px-2 py-0.5 ' +
								(searchTypes.has(value)
									? 'bg-primary-600 text-white'
									: 'bg-gray-200 text-gray-700 dark:bg-gray-600 dark:text-gray-200')}
							on:click={() => toggleTypeChip(value)}
						>
							{label}
						</button>
					{/if}
				{/each}
				{#each [...($showEnvInList ? [['environment', 'Environment']] : []), ...($advancedMode ? [['system', 'System']] : [])] as [value, label]}
					{#if !hiddenChips.has(value)}
						<button
							class={'shrink-0 rounded-full px-2 py-0.5 ' +
								(viewMode === value
									? 'bg-primary-600 text-white'
									: 'bg-gray-200 text-gray-700 dark:bg-gray-600 dark:text-gray-200')}
							on:click={() => { viewMode = viewMode === value ? '' : value; searchTypes = new Set(); }}
						>
							{label}
						</button>
					{/if}
				{/each}
				{#if $objectFilter}
					<span class="shrink-0 text-gray-500 dark:text-gray-300">{matchCount} match{matchCount === 1 ? '' : 'es'}</span>
				{/if}
			</div>
			<!-- 80.3: chip visibility popover + reset -->
			<button
				id="chip-config"
				class="shrink-0 rounded-sm bg-gray-200 px-1.5 py-0.5 text-gray-600 dark:bg-gray-600 dark:text-gray-200"
				title="Choose which filters show here"
				on:click={() => (chipPopup = !chipPopup)}
			>
				⚙
			</button>
			{#if chipPopup}
				<div
					id="chip-popup"
					class="absolute right-0 top-6 z-10 flex w-44 flex-col gap-1 rounded-lg border border-gray-300 bg-white p-2 shadow-xl dark:border-gray-600 dark:bg-gray-800"
				>
					{#each [['mesh', 'Meshes'], ['light', 'Lights'], ['group', 'Groups'], ['stroke', 'Strokes'], ...($showEnvInList ? [['environment', 'Environment']] : []), ...($advancedMode ? [['system', 'System']] : [])] as [value, label]}
						<label class="flex cursor-pointer items-center gap-2 text-gray-700 dark:text-gray-200">
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
						class="mt-1 rounded-sm bg-gray-200 px-2 py-1 text-gray-700 hover:bg-gray-300 dark:bg-gray-600 dark:text-gray-200 dark:hover:bg-gray-500"
						on:click={resetAllFilters}
					>
						Reset all filters
					</button>
					<label class="mt-1 flex cursor-pointer items-center gap-2 border-t border-gray-300 pt-1.5 text-gray-700 dark:border-gray-600 dark:text-gray-200">
						<input type="checkbox" bind:checked={$showLocalObjects} />
						Show local objects
					</label>
				</div>
			{/if}
		</div>
	</div>
	<Listgroup active class="min-h-0 flex-1 overflow-y-auto -rounded rounded-br rounded-bl">
		<div class="container">
			{#if viewMode === 'system'}
				{#if !systemNoticeDismissed}
					<div class="flex items-start gap-1 bg-yellow-900/40 p-2 text-[11px] text-yellow-200">
						<span class="flex-1">
							System objects are managed by modules and the environment — they regenerate
							from their state and are not editable here.
						</span>
						<button
							class="rounded-sm bg-gray-600 px-1 text-white"
							on:click={() => {
								systemNoticeDismissed = true;
								localStorage.setItem('systemNoticeDismissed', 'true');
							}}>✕</button>
					</div>
				{/if}
				{#each systemRows as row (row.name)}
					<div class="border-b border-gray-600/40 px-2 py-1 text-sm text-gray-800 dark:text-gray-200">
						<div class="flex items-center gap-2">
							<button
								class="w-4 text-gray-400"
								title="Show children"
								on:click={() => (expandedSystem = { ...expandedSystem, [row.name]: !expandedSystem[row.name] })}
							>
								{expandedSystem[row.name] ? '−' : '+'}
							</button>
							<Cog size={16} class="text-gray-400" aria-hidden="true" title="System object" />
							<span class="flex-1 overflow-hidden text-ellipsis whitespace-nowrap" title="Managed by a module / the environment">
								{row.name}
							</span>
							<span class="text-[10px] text-gray-400">{row.children.length}</span>
							<button
								class="rounded-sm bg-gray-600 px-1.5 text-xs text-white"
								title="Ping it for everyone"
								on:click={() => pingObject(row.object)}><Pin size={16} aria-hidden="true" /></button>
							<button
								class="rounded-sm bg-gray-600 px-1.5 text-xs text-white"
								title="Pin a synced note to it"
								on:click={() => addAnnotation(row.object.uuid)}><SquarePen size={16} aria-hidden="true" /></button>
							<button
								class="rounded-sm bg-gray-600 px-1.5 text-xs text-white"
								title="Focus the camera on it"
								on:click={() => focusSystemObject(row.object)}><Eye size={16} aria-hidden="true" /></button>
						</div>
						{#if expandedSystem[row.name]}
							{#each row.children as childName}
								<p class="pl-8 text-xs text-gray-400">{childName}</p>
							{/each}
						{/if}
					</div>
				{/each}
				{#if systemRows.length === 0}
					<p class="p-2 text-xs italic text-gray-400">No system objects right now — spawn a module (pong, dungeon) to see its content here.</p>
				{/if}
			{:else if viewMode === 'environment'}
				{#if !envNoticeDismissed}
					<div class="flex items-start gap-1 bg-yellow-900/40 p-2 text-[11px] text-yellow-200">
						<span class="flex-1">
							Environment objects are managed from Scene settings — switching presets
							replaces them. Edit them there, not here.
						</span>
						<button
							class="rounded-sm bg-gray-600 px-1 text-white"
							on:click={() => {
								envNoticeDismissed = true;
								localStorage.setItem('envNoticeDismissed', 'true');
							}}>✕</button>
					</div>
				{/if}
				{#each envRows as row (row.name)}
					<div class="border-b border-gray-600/40 px-2 py-1 text-sm text-gray-800 dark:text-gray-200">
						<div class="flex items-center gap-2">
							<Sun size={16} class="w-4 text-center text-yellow-300/80" aria-hidden="true" title="Environment light" />
							<span class="flex-1 overflow-hidden text-ellipsis whitespace-nowrap" title="Managed from Scene settings">
								{row.name}
							</span>
							<span class="text-[10px] text-gray-400">{row.type}</span>
							<button
								class="rounded-sm bg-gray-600 px-1.5 text-xs text-white"
								title="Ping it for everyone"
								on:click={() => pingObject(row.object)}><Pin size={16} aria-hidden="true" /></button>
							<button
								class="rounded-sm bg-gray-600 px-1.5 text-xs text-white"
								title="Focus the camera on it"
								on:click={() => focusSystemObject(row.object)}><Eye size={16} aria-hidden="true" /></button>
						</div>
					</div>
				{/each}
				{#if envRows.length === 0}
					<p class="p-2 text-xs italic text-gray-400">The environment group is empty — pick a preset or add environment lights in Scene settings.</p>
				{/if}
			{:else}
			  {#if $objectsGroup}
				<LocalObjects />
				<!-- drop a local object anywhere here to SHARE it to the scene root -->
				<div class="min-h-8 rounded-sm transition-colors" use:shareDropZone>
					{#if $objectsGroup.children.length > 0}
						{#each $objectsGroup.children.filter((/** @type {any} */ c) => !c.userData?.__localOnly) as element}
						<Objects {element} />
						{/each}
					{/if}
				</div>
			  {/if}
			{/if}
		</div>
	</Listgroup>
	<div id="object-count" class="shrink-0 rounded-bl rounded-br bg-gray-100 px-2 py-0.5 text-[10px] text-gray-500 dark:bg-gray-700 dark:text-gray-300">
		{objectCount} object{objectCount === 1 ? '' : 's'}{hiddenCount ? ' · ' + hiddenCount + ' hidden' : ''}
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
