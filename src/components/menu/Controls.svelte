<script lang="ts">
	import { Clapperboard, Code, Cog, Eye, FolderOpen, Grid2x2, List, Maximize2, MessageSquare, Monitor, Move, Palette, Pin, Play, RectangleGoggles, RotateCcw, SquarePen, Sun, Workflow } from '@lucide/svelte';
	import { Listgroup } from 'flowbite-svelte';
	import { objectsGroup, TControls, transformMode, isLocked, lockedObjects, globalScene, vrPassthrough, vrOverride, selectedObject, selectedObjects } from '../../stores/sceneStore';
	import { chatHidden, flowGraphClose, flowCodeClose, animationClose, uvEditorClose, shaderEditorClose, hudEditorClose, explorerClose, objectListClose, objectContextMenu, renamingObject, advancedMode, showEnvInList, showLocalObjects, floatingToolbar, toolbarAlwaysOnTop, showSimControls } from '../../stores/appStore.js';
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
	import { onMount, setContext, tick } from 'svelte';
	import { createGesture } from '$lib/modalGrab';
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
	import { visibleDockKey, dockOccupants, bottomInset, FLOW_FAMILY, armDockMode, DOCK_TITLES } from '$lib/bottomDock';
	import { togglePanel } from '$lib/panelToggles';
	import { requestPlay, willEnterXR, willEnterAR, vrSupported, arSupported, xrSessionFailed } from '$lib/playMode';
	import { dockAddItems, DOCK_VIEWS } from '$lib/dockMenu';
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
		const visible = $visibleDockKey ?? '';
		const occupants = $dockOccupants;
		const closed: Record<string, boolean> = {
			flowcode: $flowCodeClose,
			animation: $animationClose,
			uv: $uvEditorClose,
			shader: $shaderEditorClose,
			hud: $hudEditorClose,
			explorer: $explorerClose
		};
		const out: Record<string, boolean> = {};
		for (const key of Object.keys(closed))
			out[key] = !closed[key] && (visible === key || !occupants[key]?.present);
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
			lastMenuAt = { x: e.clientX, y: e.clientY };
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
	/** W8a adds `posX`: WHERE ALONG THE BOTTOM EDGE the bar sits, as a FRACTION of the
	 *  usable track (0 = hard left, 1 = hard right), `null` = the canonical centre.
	 *  A fraction and not a pixel offset, because a bar parked 500px right of centre on
	 *  a 2560px monitor is off the screen on the laptop the same profile opens next.
	 *  It rides IN the layout record rather than in a key of its own, which is what
	 *  makes `resetLayout()` and Settings' "Reset window positions" (whose wipe already
	 *  names `controlsLayout`) cover the position with no second thing to remember. */
	type ControlsLayout = {
		order: string[];
		hidden: string[];
		spacerIndex: number;
		collapsed: boolean;
		posX: number | null;
	};
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
	const OPTIONAL_VIEWS = DOCK_VIEWS.filter((view) => view.key !== 'explorer').map((view) => view.key);

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
		flowcode: Code,
		animation: Clapperboard,
		uv: Grid2x2,
		shader: Palette,
		hud: Monitor
	};

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
			tint: () => (panelShown.explorer ? ICON_ON : ICON_OFF),
			run: () => togglePanel('explorer')
		},
		// W8b: the five remaining dock views, built from ONE list rather than written
		// out. Each is the ordinary panel decision tree — `togglePanel` opens it in the
		// mode it was last in, activates it when another tab covers it, and hides it
		// when it is the one on screen — which is the whole reason these are worth
		// having as buttons: the "+" list can only ever open them.
		...Object.fromEntries(
			OPTIONAL_VIEWS.map((key) => [
				key,
				{
					title: DOCK_TITLES[key] ?? key,
					icon: VIEW_ICONS[key],
					tint: () => (panelShown[key] ? ICON_ON : ICON_OFF),
					run: () => togglePanel(key)
				} as CellButton
			])
		)
	};

	function defaultLayout(): ControlsLayout {
		return { order: [...DEFAULT_ORDER], hidden: [], spacerIndex: DEFAULT_SPACER, collapsed: false, posX: null };
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
			// W8b: kept ids are the ones the REGISTRY knows, not the ones the DEFAULT order
			// lists — that older test dropped every optional view on the next reload, so a
			// button enabled from Customize came back gone. A missing DEFAULT id is still
			// appended (a button added to the app later shows by default, `explorerColumns`'
			// rule); an OPTIONAL id absent from the record is absent from the bar, which is
			// what makes it opt-in. Duplicates are dropped — `order` is a set of positions,
			// and a hand-edited or half-migrated record must not render one button twice.
			const order: string[] = Array.isArray(saved.order)
				? saved.order.filter(
						(id: any, at: number) => BUTTONS[id] && saved.order.indexOf(id) === at
					)
				: [];
			for (const id of DEFAULT_ORDER) if (!order.includes(id)) order.push(id);
			const hidden: string[] = Array.isArray(saved.hidden)
				? saved.hidden.filter((id: any) => order.includes(id))
				: [];
			const room = order.filter((id) => !hidden.includes(id)).length;
			const spacerIndex = Number.isFinite(saved.spacerIndex)
				? Math.max(0, Math.min(saved.spacerIndex, room))
				: Math.min(DEFAULT_SPACER, room);
			// a stored fraction is clamped rather than trusted: 0..1 is the whole domain,
			// and anything else (a hand-edited key, an older shape) reads as "centred"
			const posX =
				typeof saved.posX === 'number' && Number.isFinite(saved.posX)
					? Math.max(0, Math.min(1, saved.posX))
					: null;
			return { order, hidden, spacerIndex, collapsed: saved.collapsed === true, posX };
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

	/** A cell press. It needs no "was that a drag?" guard of its own: a move that ends
	 *  here has already armed `swallowNextClick`, so this handler is simply not reached
	 *  for the click a gesture produced. ONE mechanism, at the window, covering every
	 *  cell and the play FAB alike. */
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

	/** Put a button on the bar. W8b: an OPTIONAL view has never been in `order` at all,
	 *  so it is APPENDED — the far right end, past the play well, which is where a new
	 *  thing belongs and where the arrows can walk it from. A DEFAULT button that was
	 *  hidden keeps its slot in `order` and returns to exactly where it was left. */
	function showButton(id: string) {
		if (!BUTTONS[id]) return;
		const hidden = controlsLayout.hidden.filter((h) => h !== id);
		const order = controlsLayout.order.includes(id)
			? controlsLayout.order
			: [...controlsLayout.order, id];
		const at = order.filter((o) => BUTTONS[o] && !hidden.includes(o)).indexOf(id);
		const spacerIndex =
			at > -1 && at < controlsLayout.spacerIndex ? controlsLayout.spacerIndex + 1 : controlsLayout.spacerIndex;
		setLayout({ order, hidden, spacerIndex });
	}

	/** W8b — SWAP: put `toId` in `fromId`'s exact slot and take `fromId` off the bar.
	 *
	 *  The bar keeps its shape (same number of cells, same well position, every other
	 *  cell untouched), which is the whole point: a user who wants the Animation tab a
	 *  press away trades the button they never use for it, rather than growing the bar
	 *  and then having to move things. `fromId` leaves `order` ENTIRELY rather than
	 *  going into `hidden`, so it comes back on offer in every "Swap with" list and in
	 *  Customize; `toId` is lifted out of wherever it sat first, so a button that was
	 *  merely hidden cannot end up in `order` twice. */
	function swapCell(fromId: string, toId: string) {
		if (!BUTTONS[toId] || fromId === toId) return;
		const order = controlsLayout.order.filter((o) => o !== toId);
		const at = order.indexOf(fromId);
		if (at < 0) return;
		order[at] = toId;
		setLayout({ order, hidden: controlsLayout.hidden.filter((h) => h !== toId && h !== fromId) });
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
			lastMenuAt = { x: e.clientX, y: e.clientY };
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
	 *  already uses for the inline scene-save request.
	 *
	 *  W5: that arm is `dockModeArm` now — the same seam keyed by DOCK KEY, so the tab
	 *  strip's context menu can undock any tab through it. This row just names its own. */
	function setExplorerMode(docked: boolean) {
		armDockMode('explorer', docked);
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
			// W8a: the same move a drag performs, for whoever got here by long press or
			// by keyboard. Disabled — with the reason — when the track is too narrow to
			// hold the bar anywhere but the middle, which is the phone case.
			{
				label: 'Move toolbar',
				tooltip: track.ok
					? 'Slide the bar along the bottom — click to place it, arrows nudge, Escape puts it back'
					: 'The screen has no room to move the bar — it stays centred',
				disabled: !track.ok,
				action: () => armMoveToolbar()
			},
			{
				label: 'Reset toolbar position',
				tooltip: 'Put the bar back in the middle',
				disabled: controlsLayout.posX == null,
				action: () => setLayout({ posX: null })
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
		const seq = visualIds();
		const offBar = [...DEFAULT_ORDER, ...OPTIONAL_VIEWS].filter(
			(key) => BUTTONS[key] && !seq.includes(key)
		);
		if (!offBar.length)
			return [
				{
					label: 'Every button is on the bar',
					tooltip: 'There is nothing left to swap in — hide one first',
					disabled: true
				}
			];
		return offBar.map((key) => ({
			label: BUTTONS[key].title,
			tooltip: `Put ${BUTTONS[key].title} in this slot and take ${BUTTONS[id].title} off the bar`,
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
		const offBar = [...DEFAULT_ORDER, ...OPTIONAL_VIEWS].filter(
			(id) => BUTTONS[id] && !seq.includes(id)
		);
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
					label: BUTTONS[id].title,
					checked: true,
					keepOpen: true,
					tooltip: 'Take it off the bar',
					action: () => hideButton(id),
					rowActions: arrows(id, at, BUTTONS[id].title)
				};
			}),
			// Everything the roster knows that is not on the bar — the buttons hidden from
			// the six defaults AND the optional dock views, which is what makes those
			// discoverable at all. A row here has no place in the bar yet, so it has no
			// direction to move in: its arrows are greyed and say why rather than being
			// absent, which would make the two halves of the list look like different
			// kinds of row.
			...(offBar.length
				? [
						{ section: 'Not on the bar' },
						...offBar.map((id) => ({
							key: id,
							label: BUTTONS[id].title,
							checked: false,
							keepOpen: true,
							tooltip: 'Put it on the bar',
							action: () => showButton(id),
							rowActions: [
								{
									icon: 'chevron-up',
									label: `Move ${BUTTONS[id].title} up`,
									tooltip: 'Not on the bar — there is nowhere to move it',
									disabled: true
								},
								{
									icon: 'chevron-down',
									label: `Move ${BUTTONS[id].title} down`,
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

	// ── W8a: THE BAR MOVES ─────────────────────────────────────────────────────────
	/** The corner HUD clusters the bar may not slide under. MEASURED, never assumed:
	 *  their positions differ by breakpoint (ui.css lifts chat/AI to bottom:74px and the
	 *  mic / "+" to 122px at <=600px, precisely so they clear this bar) and three of the
	 *  five are conditional — `#sim-controls` is an opt-in setting, `#mic-button` belongs
	 *  to VoiceChat and any of them can be absent in a stripped build. Connect's
	 *  `measureDock()` is the same shape one domain over. */
	const TOOLBAR_NEIGHBOURS = ['#ai-hud-button', '#mobile-add-button', '#chat-button', '#mic-button', '#sim-controls'];
	const EDGE_MARGIN = 8; // breathing room against a neighbour and against the viewport
	const SNAP_PX = 24; // how near the middle still counts as the middle
	const DRAG_SLOP = 6; // travel that turns a press into a move

	/** the reachable band for the bar's CENTRE, in client px. `ok` is false when the
	 *  track is narrower than the bar itself (a phone with the buttons beside it): there
	 *  is then no position to choose, so the bar centres and the move gesture stands
	 *  down rather than offering a drag that cannot go anywhere. */
	let track = $state({ min: 0, max: 0, mid: 0, ok: false });
	/** the live centre while a gesture runs; null the rest of the time, so the stored
	 *  fraction is the only source once it ends */
	let dragCentre: number | null = $state(null);
	let movingBar = $state(false);
	/** where the menu that armed a modal move was opened — the origin its pointer
	 *  offsets are measured from, since a menu action carries no event of its own */
	let lastMenuAt = { x: 0, y: 0 };
	let armNudge = 0;
	let trackRO: ResizeObserver | null = null;
	let observedKey = '';

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
		let left = EDGE_MARGIN;
		let right = vw - EDGE_MARGIN;
		const found: HTMLElement[] = [];
		for (const sel of TOOLBAR_NEIGHBOURS) {
			const el = document.querySelector<HTMLElement>(sel);
			if (!el) continue;
			found.push(el);
			const r = el.getBoundingClientRect();
			if (!r.width || !r.height) continue; // in the DOM but not rendered
			// ONLY a neighbour whose vertical band overlaps the bar's can be in the way,
			// and that one rule is why the <=600px lift needs no breakpoint of its own
			// here: at that width chat / AI / mic / "+" have moved ABOVE this row, so
			// they stop clamping and the bar gets the full width — measured, not coded.
			if (r.bottom <= pill.top || r.top >= pill.bottom) continue;
			if ((r.left + r.right) / 2 < vw / 2) left = Math.max(left, r.right + EDGE_MARGIN);
			else right = Math.min(right, r.left - EDGE_MARGIN);
		}
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
			(window as any).__toolbarTrack = { ...track, centre: pillCentre, posX: controlsLayout.posX };
		// re-observe only when the SET of neighbours changed — `observe()` fires an
		// initial callback per element, so re-attaching on every measurement would spin
		const key = found.map((el) => el.id).join(',');
		if (trackRO && key !== observedKey) {
			observedKey = key;
			trackRO.disconnect();
			trackRO.observe(nav); // the bar's own width changes when cells hide/collapse
			for (const el of found) trackRO.observe(el);
		}
	}

	onMount(() => {
		if (typeof ResizeObserver !== 'undefined') trackRO = new ResizeObserver(() => measureTrack());
		measureTrack();
		window.addEventListener('resize', measureTrack);
		window.addEventListener('keydown', onArmedKey, true);
		return () => {
			window.removeEventListener('resize', measureTrack);
			window.removeEventListener('keydown', onArmedKey, true);
			trackRO?.disconnect();
			trackRO = null;
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
		void $floatingToolbar;
		void $bottomInset;
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
		const eat = (e: MouseEvent) => {
			e.stopPropagation();
			e.preventDefault();
			window.removeEventListener('click', eat, true);
			clearTimeout(timer);
		};
		window.addEventListener('click', eat, true);
		timer = window.setTimeout(() => window.removeEventListener('click', eat, true), 700);
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
		onActive: (active) => {
			movingBar = active;
		}
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
			// by the slop it took to decide
			const opened = toolbarGrab.begin(press);
			done();
			if (!opened) return; // no track to move along — the press stays a click
			toolbarGrab.move(e);
		};
		const onDown = (e: PointerEvent) => {
			// the play FAB is the one control an accidental drag must not grab: a 50px
			// circle is the way into play mode and it is what a thumb aims at
			if (e.button !== 0 || (e.target as Element)?.closest?.('#play-button')) return;
			if (toolbarGrab.active()) return; // an armed move already owns the bar
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
	 *   floating ON  + on top ON  (the DEFAULT) — the bar lifts onto `--bottom-inset`
	 *       when a dock opens and paints over the dock and over floating windows.
	 *   floating ON  + on top OFF — the bar still lifts clear of the dock, but a window
	 *       dragged over it covers it: it moves out of the way rather than fighting.
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
	const pillZClass = $derived($toolbarAlwaysOnTop ? 'z-45' : 'z-30');
	const pillStyle = $derived(
		($floatingToolbar ? 'bottom: calc(var(--bottom-inset, 0px) + 16px);' : 'bottom: 16px;') +
			(track.mid > 0 ? ` left: ${Math.round(pillCentre)}px;` : '') +
			' touch-action: none;' +
			(movingBar ? ' cursor: grabbing;' : '')
	);

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
<nav
	id="controls-pill"
	class="border-gray-200 dark:border-gray-600 absolute max-w-lg -translate-x-1/2 rtl:translate-x-1/2 border bottom-4 start-1/2 h-10 w-max min-w-max shrink-0 bg-white rounded-full dark:bg-gray-700 {pillZClass}"
	style={pillStyle}
	use:toolbarDrag
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
