<script lang="ts">
	import { Cog, Eye, FolderOpen, List, Maximize2, MessageSquare, Move, Pin, Play, RectangleGoggles, RotateCcw, SquarePen, Sun, Workflow } from '@lucide/svelte';
	import { BottomNav, Listgroup } from 'flowbite-svelte';
	import { objectsGroup, TControls, transformMode, isLocked, isVRMode, lockedObjects, globalScene, vrPassthrough, vrOverride, selectedObject, selectedObjects } from '../../stores/sceneStore';
	import { chatHidden, flowGraphClose, flowCodeClose, animationClose, uvEditorClose, explorerClose, objectListClose, objectContextMenu, renamingObject, advancedMode, showEnvInList, showLocalObjects, shaderEditorClose, hudEditorClose } from '../../stores/appStore.js';
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
	import { setContext, tick } from 'svelte';
	import { writable } from 'svelte/store';
	import { shareObject } from '$lib/objectPermissions';
	import Objects from './Objects.svelte';
	import LocalObjects from './LocalObjects.svelte';
	import ContextMenu from '../ContextMenu.svelte';
	import MobileAddButton from './MobileAddButton.svelte';
	import AiHudButton from './AiHudButton.svelte';
	import SimControls from './SimControls.svelte';
	import { focusStack, raiseWindow, isTopWindow } from '$lib/windowFocus';
	import { tabbable, groupRectOf, moveGroupOf, resizeGroup } from '$lib/windowTabs';
	import { clampWinSize, clampResize, anchorOf } from '$lib/windowSize';
	import { dockable } from '$lib/docking';
	import { visibleDockKey, bottomDockActive, activateDock, dockOccupants, FLOW_FAMILY } from '$lib/bottomDock';
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
	const flowDockVisible = $derived(FLOW_FAMILY.includes($visibleDockKey ?? ''));
	const flowFloatingShown = $derived(!$flowGraphClose && !$dockOccupants.flow?.present);
	const flowShown = $derived(flowDockVisible || flowFloatingShown);
	const explorerShown = $derived(!$explorerClose && ($visibleDockKey === 'explorer' || !$dockOccupants.explorer?.present));
	// remembers which flow-family views were open when the docked group was hidden
	let flowDockSnapshot: any = null;
	function toggleFlow() {
		const open = !$flowGraphClose;
		const docked = !!$dockOccupants.flow?.present; // Node editor docked AND open
		if (open && !docked) {
			flowGraphClose.set(true); // FLOATING Node editor is shown -> hide only its window
			return;
		}
		if (docked) {
			if (flowDockVisible) {
				// docked group is on screen -> hide only the tabs that are actually DOCKED
				// (leave undocked/floating Flow Code / Animation windows open)
				flowDockSnapshot = {
					flow: true,
					flowcode: !!$dockOccupants.flowcode?.present,
					animation: !!$dockOccupants.animation?.present,
					uv: !!$dockOccupants.uv?.present,
					shader: !!$dockOccupants.shader?.present,
					// A4: without this line the HUD tab never comes back after play mode
					hud: !!$dockOccupants.hud?.present
				};
				flowGraphClose.set(true);
				if (flowDockSnapshot.flowcode) flowCodeClose.set(true);
				if (flowDockSnapshot.animation) animationClose.set(true);
				if (flowDockSnapshot.uv) uvEditorClose.set(true);
				if (flowDockSnapshot.shader) shaderEditorClose.set(true);
				if (flowDockSnapshot.hud) hudEditorClose.set(true);
			} else {
				activateDock('flow'); // docked but hidden (Explorer covering) -> bring the dock back
			}
			return;
		}
		// Node editor is CLOSED -> show it in its last mode
		const wasDocked = typeof localStorage === 'undefined' || localStorage.getItem('flowDocked') !== 'false';
		const snap = flowDockSnapshot;
		if (snap && (snap.flow || snap.flowcode || snap.animation || snap.uv || snap.shader || snap.hud)) {
			if (snap.flow) flowGraphClose.set(false);
			if (snap.flowcode) flowCodeClose.set(false);
			if (snap.animation) animationClose.set(false);
			if (snap.uv) uvEditorClose.set(false);
			if (snap.shader) shaderEditorClose.set(false);
			if (snap.hud) hudEditorClose.set(false);
			flowDockSnapshot = null;
			activateDock('flow');
		} else {
			flowGraphClose.set(false);
			if (wasDocked) activateDock('flow'); // docked -> show as the dock tab; floating -> leave the dock alone
		}
	}
	function toggleExplorer() {
		if (explorerShown) explorerClose.set(true); // shown (docked or floating) -> hide
		else {
			explorerClose.set(false); // hidden -> show it in its last mode
			bottomDockActive.set('explorer'); // if docked, make it the visible panel
		}
	}
	// Object List is a pure floating window. Clicking its button RAISES it to the front
	// (bring-to-front, as the user "called" it); clicking again while it is already at
	// the front closes it. Opening a closed one raises it too.
	function toggleObjectList() {
		if ($objectListClose) {
			objectListClose.set(false);
			tick().then(() => raiseWindow('objects'));
		} else if (isTopWindow('objects')) {
			objectListClose.set(true);
		} else {
			raiseWindow('objects');
		}
	}

	// CO4b: WHAT the play button is about to do, so it can show it. The condition
	// mirrors `checkPlay`'s own test below — a supported immersive session AND no
	// desktop override — rather than reading the hidden #vrButton's label, which is
	// threlte's private text and only exists once its own support probe resolves.
	// `vrPassthrough` picks WHICH session kind is asked for, so it also picks which
	// support answer matters.
	let vrSupported = $state(false);
	let arSupported = $state(false);
	// try/catch and not just .catch(): a runtime whose isSessionSupported THROWS
	// synchronously would otherwise throw during this component's init, and this
	// component owns the play button — the one control the app cannot lose.
	try {
		const xr = typeof navigator === 'undefined' ? null : (navigator as any).xr;
		xr?.isSessionSupported?.('immersive-vr')
			?.then((ok: boolean) => (vrSupported = !!ok))
			?.catch(() => (vrSupported = false));
		xr?.isSessionSupported?.('immersive-ar')
			?.then((ok: boolean) => (arSupported = !!ok))
			?.catch(() => (arSupported = false));
	} catch {
		vrSupported = false;
		arSupported = false;
	}
	const willEnterXR = $derived(($vrPassthrough ? arSupported : vrSupported) && !$vrOverride);
	const willEnterAR = $derived(willEnterXR && $vrPassthrough);

	let allowPlay = true;
	// 21-F3 REJOIN: a play press that landed inside the exit cooldown, replayed when it
	// expires. The cooldown itself has to stay — it exists because the browser refuses a
	// pointer-lock request for about a second after a user-initiated Esc — but DROPPING
	// the press was never part of that: the button simply did nothing, with no feedback,
	// which is precisely the "I left play and could not get back in" report. Deferring is
	// the whole fix, and it costs one flag.
	let playQueued = false;
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

	function checkPlay() {
		const vrButton = document.getElementById('vrButton')?.querySelector('button');
		// 'Enter VR' or 'Enter AR' (passthrough preference, phase 90)
		if (vrButton?.textContent?.trim().startsWith('Enter') && localStorage.getItem('vrOverride') !== 'true') {
			$isVRMode = true;
			vrButton.click();
		} else {
			// already in play — a second press is not a re-entry
			if ($isLocked === true) return;
			// 21-F3: inside the exit cooldown, REMEMBER the press instead of eating it.
			// `isLocked === false` is the transient Controls itself writes on the way out
			// (the effect below settles it to null), so both non-null values land here.
			if (allowPlay !== true || $isLocked === false) {
				playQueued = true;
				return;
			}
			if ($isLocked === null) $isLocked = true;
		}
	}

	$effect(() => {
		//Timeout for pointer lock
		//on ESC release have delay
	if ($isLocked === false) {
		$isLocked = null;
		allowPlay = false;
		setTimeout(() => {
			allowPlay = true;
			// 21-F3: honour a press made during the cooldown. Through checkPlay, not a
			// bare store write, so the VR branch and the guards above still decide.
			if (playQueued) {
				playQueued = false;
				checkPlay();
			}
		}, 2000)
	}
	});
</script>

<!-- The pill RIDES ABOVE the bottom dock: `--bottom-inset` is the visible docked
     Flow/Explorer panel's height (published by $lib/bottomDock), so the pill and the
     play FAB below sit in the band just above it instead of covering its last ~60px.
     This replaces the old `--dock-inset` model, which padded the DOCK's content and
     only did so at <=500px — every wider screen had the pill permanently over the
     node palette / folder tree. The inline style is load-bearing: flowbite's
     `application` navType puts `bottom-4` on the outer div as a utility CLASS, and an
     inline declaration is what beats it (restProps land on that same outer div). 200ms
     matches the dock's own fly transition, so the two move together. -->
<BottomNav
	position="absolute"
	navType="application"
	class="h-10 w-max min-w-max shrink-0 bg-white rounded-full dark:bg-gray-700 z-45"
	classes={{ inner: 'grid-cols-7' }}
	style="bottom: calc(var(--bottom-inset, 0px) + 16px); transition: bottom 200ms ease"
>
	<p class={classActive + ' rounded-l-full'} title="Move (1)" on:click={() => setTransformMode('translate')}>
		<Move size={18} class={hasSel && $transformMode === 'translate' ? ICON_ON : ICON_OFF} aria-hidden="true" />
	</p>
	<p class={classActive} title="Rotate (2)" on:click={() => setTransformMode('rotate')}>
		<RotateCcw size={18} class={hasSel && $transformMode === 'rotate' ? ICON_ON : ICON_OFF} aria-hidden="true" />
	</p>

	<p class={classActive} title="Scale (3)" on:click={() => setTransformMode('scale')}>
		<Maximize2 size={18} class={hasSel && $transformMode === 'scale' ? ICON_ON : ICON_OFF} aria-hidden="true" />
	</p>
	<!-- QW (Controls Option A): transparent SPACER reserving the grid cell under the
	     floating play button — the old filled square peeked out around the circle.
	     Hovering either NEIGHBOR paints the spacer too (arbitrary variants below), so
	     the hover red runs continuously up to the round button instead of leaving
	     pill-colored notches above/below the circle. -->
	<!-- the 40px total width is LOAD-BEARING: the grid's fr columns are content-
	     sized, so this spacer's width is what gives every cell its width (18px
	     icons alone collapse the whole bar). TWO HALVES so each neighbor's hover
	     paints only ITS side up to the circle (a full-width paint peeked out red
	     on the opposite side of the FAB). No transition — the neighbors' own
	     hover backgrounds are instant, a fade here lagged visibly. -->
	<div class="flex h-full items-stretch justify-center">
		<div class="h-full w-5 [p:hover+div>&:first-child]:bg-primary-700"></div>
		<div class="h-full w-5 [div:has(+p:hover)>&:last-child]:bg-primary-700"></div>
	</div>

	<p
		class={classActive}
		title="Object list (O)"
		on:click={toggleObjectList}
	>
		<List size={18} class={!$objectListClose ? ICON_ON : ICON_OFF} aria-hidden="true" />
	</p>
	<p
		class={classActive}
		title="Node editor (N)"
		on:click={toggleFlow}
	>
		<Workflow size={18} class={flowShown ? ICON_ON : ICON_OFF} aria-hidden="true" />
	</p>
	<p
		class={classActive + ' rounded-r-full'}
		id="explorer-slot"
		title="Explorer"
		on:click={toggleExplorer}
	>
		<FolderOpen size={18} class={explorerShown ? ICON_ON : ICON_OFF} aria-hidden="true" />
	</p>
</BottomNav>

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

<!-- QW (Controls Option A): the WHOLE button scales on hover anywhere on it (the
     centering translate lives in a tailwind class so the two transforms compose
     instead of fighting). clip-path circles the HIT AREA too: the 50px square box
     used to intercept clicks/hovers meant for the Scale / Object-list cells it
     overlaps. fill=currentColor keeps the play triangle SOLID (lucide is
     stroke-only by default); the 2px nudge is the classic optical centering.
       The transition is ONE inline declaration covering BOTH properties rather than
     the tailwind `transition-transform duration-100` this used to carry: an inline
     `transition:` shorthand REPLACES whatever the class set, so adding `bottom` there
     would have silently wiped the transform transition and killed the hover-scale.
     Inline owns both — transform keeps its 100ms, bottom rides the dock's 200ms. -->

<p
	id="play-button"
	title={willEnterAR
		? 'Enter AR — the scene composites over your room'
		: willEnterXR
			? 'Enter VR'
			: 'Play'}
	class={classActive + ' -translate-x-1/2 rounded-full bg-primary-600 font-medium hover:scale-110 dark:focus:ring-primary-800'}
	style="position: absolute; height: 50px; width: 50px; bottom: calc(var(--bottom-inset, 0px) + 10px); z-index: var(--z-hud);
        display: flex; left: 50%; transition: transform 100ms, bottom 200ms ease"
	on:click={() => {
		checkPlay();
	}}
>
	<!-- CO4b: ONE entry point that SHOWS its destination. The FAB already starts play
	     mode on desktop and an immersive session in a headset, and `$vrPassthrough`
	     decides which KIND (#vrButton below swaps VRButton for an immersive-ar
	     XRButton) — so the honest thing is to say so ON this button rather than grow
	     a second one beside it.
	       desktop  the play triangle, unchanged
	       VR       a headset (rectangle-goggles): press this and you are IN there
	       AR       the same headset with A and R in its two lens halves, and a
	                slightly bigger glyph to carry them
	     The visor is ONE path with a nose notch at the bottom centre, so its halves
	     sit at x 7.5 and 16.5 of the 24-unit box — 31.25% and 68.75% — which is where
	     the letters are anchored (translate(-50%,-50%) centres them on that point, so
	     they stay put at any icon size). The overlay is `pointer-events: none` and
	     unselectable: the circle stays ONE hit target, which #play-button's clip-path
	     was tuned for. No `ml-0.5` on the goggles — that 2px nudge is optical
	     centering for a TRIANGLE, and a symmetric visor with it looks off-centre. -->
	{#if willEnterAR}
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
	{:else if willEnterXR}
		<RectangleGoggles size={26} class="text-white" aria-hidden="true" />
	{:else}
		<Play size={24} class="ml-0.5 text-white" fill="currentColor" aria-hidden="true" />
	{/if}
</p>

<div class="hidden" id="vrButton">
	{#if $vrPassthrough}
		<!-- passthrough (90): same button flow, immersive-ar session -->
		<XRButton
			mode="immersive-ar"
			sessionInit={{
				requiredFeatures: [],
				optionalFeatures: ['local-floor', 'bounded-floor', 'anchors', 'hand-tracking', 'plane-detection', 'layers', 'depth-sorted-layers', 'hit-test', 'mesh-detection']
			}}
		/>
	{:else}
		<VRButton />
	{/if}
</div>

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
