<script>
	// 38 R9 — THE PHONE SHELL (SPEC §6, the design page's Mobile section).
	//
	// Below 640px the editor chrome is: the logo top-left, a Connect CHIP, the bell and the
	// avatar across the top; a context STRIP that follows the task; a five-slot bottom BAR
	// (Add, Objects, Play, Chat, More); windows as bottom SHEETS. This component draws the
	// new pieces and REUSES everything else — it never re-implements a control:
	//
	//   - every button calls the function the desktop control calls (togglePanel,
	//     requestPlay, setTransformMode, undo, the viewport-menu opener …), so a phone
	//     press and a desktop press cannot drift;
	//   - the windows that become sheets (Objects, Chat, AI, notifications, the Connect
	//     bar) are the SAME components, placed into the sheet FRAME this draws by
	//     styles/phone.css (`[data-ps-host]`). Their ids, stores and handlers are untouched,
	//     which is what keeps the behaviour lock (SPEC §0) true on a phone;
	//   - the logo, the bell and the avatar are the existing elements, re-seated by CSS.
	//
	// While mounted it puts `phone-shell` on <html>; phone.css hides the old phone chrome
	// (toolbar pill, round HUD buttons, touch-tools column, docked Connect bar) only under
	// that class, so CSS and markup always agree about which shell is on screen.
	import { onDestroy, tick, untrack } from 'svelte';
	import Icon from '../ui/Icon.svelte';
	import { connectionStatus, connectionLabel } from '$lib/connectionStatus';
	import SheetGrip from '../ui/SheetGrip.svelte';
	import { stripScroll } from '$lib/ui/stripScroll.js';
	import { minimalScroll } from '$lib/ui/minimalScroll.js';
	import {
		phoneSheet,
		phoneDetents,
		detentOf,
		setPhoneDetent,
		phoneDetentHeights,
		phoneShellActive,
		phoneSheetMaxH
	} from '$lib/ui/phoneShell.js';
	import {
		phoneBar,
		setBar,
		placeItem,
		removeItem,
		moveItem,
		labelled,
		WINDOW_ITEMS,
		EDIT_ITEMS,
		VIEW_ITEMS,
		DEFAULT_BAR,
		MAX_ITEMS,
		MORE_HINT_KEY
	} from '$lib/ui/phoneBar.js';
	import { phoneSelectionStrip, phoneDockTabs, phoneGrabHandle } from '$lib/ui/phonePrefs.js';
	import { barHold } from '$lib/ui/barHold.js';
	import Toggle from '../ui/Toggle.svelte';
	import ContextMenu from '../ContextMenu.svelte';
	import { safeStorage } from '$lib/safeStorage';
	// 43 J9: the More sheet's how-to hides itself once the person has edited the bar (Settings ▸ Reset tips)
	import { tipShown, dismissTip, TIP_PHONE_MORE } from '$lib/tips';
	import { showChoiceEx } from '$lib/confirmDialog';
	import { hudIsGame } from '$lib/hudDocs';
	import { testPlay } from '$lib/gamePresence';
	import { snapDetent, stepDetent, phoneSheetMax } from '$lib/ui/sheetSnap.js';
	import { sheetDrag } from '$lib/ui/sheetDrag.js';
	import { followBottomEdge } from '$lib/ui/bottomEdge.js';
	import {
		peers,
		userdata,
		messages,
		chatHidden,
		aiAssistantHidden,
		notificationCenterOpen,
		peersPanelOpen,
		inspectorKind,
		connectDrawerOpen,
		connectDrawerPinned,
		waitingForApproval,
		viewportMenuOpener,
		viewportMenu,
		multiSelectMode,
		touchTools,
		showToast,
		settingsOpen,
		settingsSection
	} from '../../stores/appStore';
	import { selectedObjects, transformMode, editorMode } from '../../stores/sceneStore';
	import { undo, redo, canUndo, canRedo } from '$lib/history';
	import { setTransformMode, toggleEditorMode } from '$lib/objectActions';
	import { phoneBarTap, openPhoneTab, closePhoneTab, phoneDockShown, phoneTabsOpen } from '$lib/phoneDock';
	import { toggleViewportFocus } from '$lib/focusMode';
	import { requestPlay, willEnterXR, willEnterAR, playAsItems } from '$lib/playMode';
	// 50 R1: the AR table — a phone places the scene on a real table (Android Chrome, WebXR immersive-ar)
	import { enterArTable, arTableEntry } from '$lib/arTable';
	import { openFilm } from '$lib/film/filmState';
	import { AR_UNSUPPORTED_NOTE } from '$lib/arTableCore.js';
	import { visibleDockKey, DOCK_TITLES, dockMinimized, dockHeight } from '$lib/bottomDock';
	import { micActive, pttActive, toggleMic } from '$lib/voiceChat';
	import { aiReady } from '$lib/ai/providers';
	import { canvasCenter } from '$lib/canvasRect';
	import { statsOpen } from '$lib/sceneBudget';
	// 46 B1: the budget chip's phone form (an item of the bar catalog — in More ▸ Tools & View by default)
	import { budgetTarget, sceneCost, TARGETS, verdictFor, openBudget } from '$lib/budgetMeter';
	import { uiScale } from '$lib/uiScale'; // 53 A1: the shell's script geometry follows the UI scale
	const moreTipShown = tipShown(TIP_PHONE_MORE);

	// ---- the <html> class + the sheet geometry --------------------------------------
	let viewportH = $state(typeof window === 'undefined' ? 844 : window.innerHeight);
	// NOTES-38 #32 (a): a sheet sits ABOVE the bottom bar (Play stays visible and tappable), so
	// its detents are fractions of the room above the bar, not of the window
	// 53 A1: every px here is a DESIGN px that phone.css also draws at the UI scale — `k` keeps the
	// script's geometry in step with the stylesheet's (the bar is 76 × k tall on screen)
	const k = $derived($uiScale / 100);
	const BAR_H = $derived(Math.round(76 * k)); // .ps-bar (+ the safe-area inset, which CSS adds)
	// 40 F1: no sheet rises into the top bar, and none pushes the selection strip under it — the
	// strip (52 + an 8 gap) rides ON TOP of the sheet while something is selected (#32 b)
	const TOP_ROOM = $derived(Math.round(64 * k)); // the logo / chip / avatar row (12 + 44) and its gap
	const STRIP_ROOM = $derived(Math.round(60 * k));
	const hasSel = $derived(($selectedObjects ?? []).length > 0);
	// 41 G13: Interact empties the selection, and the strip STAYS so Interact can be turned off
	const interactOn = $derived($editorMode === 'interact');
	// 42 I5: More ▸ "Selection toolbar" off = no floating strip at all (the tools that matter can sit
	// on the bar, and More ▸ Edit keeps every one of them — Interact included — one tap away)
	const stripOn = $derived($phoneSelectionStrip && (hasSel || interactOn));
	const sheetMax = $derived(phoneSheetMax(viewportH, { barH: BAR_H, topH: TOP_ROOM, stripH: stripOn ? STRIP_ROOM : 0 }));
	const heights = $derived.by(() => {
		const d = phoneDetentHeights(viewportH - BAR_H);
		return /** @type {Record<string, number>} */ ({
			peek: Math.min(d.peek, sheetMax),
			half: Math.min(d.half, sheetMax),
			full: Math.min(d.full, sheetMax)
		});
	});
	// every other phone sheet (the Inspector, the menus, the Add list, the dock …) reads the room
	// from here: the store for script-sized sheets, the CSS var for CSS-placed ones
	$effect(() => {
		phoneSheetMaxH.set(sheetMax);
		document.documentElement.style.setProperty('--ps-sheet-max', sheetMax + 'px');
		return () => {
			phoneSheetMaxH.set(0);
			document.documentElement.style.removeProperty('--ps-sheet-max');
		};
	});

	$effect(() => {
		const root = document.documentElement;
		root.classList.add('phone-shell');
		phoneShellActive.set(true);
		return () => {
			root.classList.remove('phone-shell');
			phoneShellActive.set(false);
		};
	});
	onDestroy(() => {
		if (typeof document !== 'undefined') {
			document.documentElement.classList.remove('phone-shell');
			clearHosts();
		}
	});

	// ---- which sheet is on top ------------------------------------------------------
	// The window sheets keep their own open stores. The shell only needs to know the
	// ORDER they opened in: the newest open one is framed and on top. Two can be open at
	// once (as on desktop, nothing is closed for you) — the older one waits underneath.
	/** kind -> [selector of the reused element, title for the frame (null = the window
	 *  draws its own header), menu-like (a scrim behind it)]
	 * @type {Record<string, [string|null, string|null, boolean]>} */
	// 41b H1: Objects is a DOCK TAB now (PhoneDockHost), not a framed sheet
	const HOSTS = {
		chat: ['#chat-window', null, false],
		ai: ['#ai-assistant-window', null, false],
		notif: ['#notif-panel', null, true],
		// 41b H15: the connected-peers panel is a drawer like the notifications (it draws its own header)
		peers: ['#peers-popover', null, true],
		conn: ['.connect-wrap', 'Connection', true],
		more: [null, 'More', true]
	};

	const openNow = $derived(/** @type {Record<string, boolean>} */ ({
		chat: $chatHidden === '',
		ai: $aiAssistantHidden === '',
		notif: $notificationCenterOpen,
		peers: $peersPanelOpen,
		conn: $phoneSheet === 'conn',
		more: $phoneSheet === 'more'
	}));

	/** opening order, newest LAST @type {string[]} */
	let order = $state([]);
	$effect(() => {
		const now = openNow;
		const kept = order.filter((k) => now[k]);
		const added = Object.keys(now).filter((k) => now[k] && !kept.includes(k));
		const next = [...kept, ...added];
		if (next.join() !== order.join()) order = next;
	});
	const top = $derived(order.length ? order[order.length - 1] : null);
	// NOTES-38 #15: each window's sheet reopens at the height it was left at (half the first time)
	const detent = $derived(detentOf($phoneDetents, top));
	/** @param {string} d */
	const setDetent = (d) => top && setPhoneDetent(top, d);

	/** live height while a finger drags the handle; null = resting on a detent */
	let dragH = $state(/** @type {number|null} */ (null));
	/** the frame (41 G5: its body hands off to the sheet gesture) @type {HTMLElement | undefined} */
	let frameEl = $state();
	const sheetH = $derived(top ? (dragH ?? heights[detent] ?? heights.half) : 0);
	const titled = $derived(top ? HOSTS[top][1] !== null : false);
	// 42 I5: More ▸ "Grab handle" off = no grabber pill and no tap-to-resize; a thin invisible edge
	// still drags (the handle strip shrinks to it)
	const STRIP_H = $derived(Math.round(($phoneGrabHandle ? 22 : 10) * k)); // the handle strip
	const HEAD_H = $derived(Math.round(44 * k)); // the frame's own title row (Connection, More)

	// publish the frame rect for phone.css (the reused element is placed into it)
	$effect(() => {
		const root = document.documentElement.style;
		root.setProperty('--ps-sheet-h', sheetH + 'px');
		root.setProperty('--ps-body-top', `${viewportH - BAR_H - sheetH + STRIP_H + (titled ? HEAD_H : 0)}px`);
		document.documentElement.classList.toggle('ps-sheet-open', !!top);
	});

	// mark the reused elements: the top one is placed into the frame, the others wait
	// underneath at the same rect. A DATA ATTRIBUTE, not a class — several of these
	// elements bind `class` to a store, and svelte rewrites className wholesale.
	function clearHosts() {
		for (const el of document.querySelectorAll('[data-ps-host]')) el.removeAttribute('data-ps-host');
	}
	function markHosts() {
		clearHosts();
		for (const k of order) {
			const sel = HOSTS[k][0];
			const el = sel && document.querySelector(sel);
			if (el) el.setAttribute('data-ps-host', k === top ? 'top' : 'under');
		}
	}
	$effect(() => {
		void order;
		void top;
		// the element may mount a frame after its store flips; try now, then after the
		// flush, then once more on the next frame
		markHosts();
		tick().then(markHosts);
		const raf = requestAnimationFrame(markHosts);
		return () => cancelAnimationFrame(raf);
	});

	function closeKind(/** @type {string|null} */ k) {
		dragH = null;
		if (k === 'chat') chatHidden.set('hidden');
		else if (k === 'ai') aiAssistantHidden.set('hidden');
		else if (k === 'notif') notificationCenterOpen.set(false);
		else if (k === 'peers') peersPanelOpen.set(false);
		else if (k === 'conn') closeConn();
		else if (k === 'more') phoneSheet.set(null);
	}

	// ---- the handle: tap steps a detent, drag rests on one, below peek closes ---------
	// 40 F1: the gesture is the shared one ($lib/ui/sheetDrag) — only where a release RESTS is
	// this sheet's own (its three remembered detents, NOTES-38 #15)
	const DETENTS = ['peek', 'half', 'full'];
	/** @param {{height: number, velocity: number}} g @returns {number|'closed'} */
	function settleDetent(g) {
		const next = snapDetent({ height: g.height, velocity: g.velocity, heights, detents: DETENTS });
		return next === 'closed' ? 'closed' : heights[next];
	}
	/** @param {number} h */
	function restAt(h) {
		dragH = null;
		const d = DETENTS.find((k) => heights[k] === h) ?? 'half';
		setDetent(d);
	}
	function tapHandle() {
		if (!$phoneGrabHandle) return; // the tap-to-resize goes with the visible handle
		const up = stepDetent(detent, 1, DETENTS, heights, false);
		setDetent(up === detent ? 'peek' : up);
	}
	/** @param {KeyboardEvent} e */
	function handleKey(e) {
		if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
		e.preventDefault();
		const next = stepDetent(detent, e.key === 'ArrowUp' ? 1 : -1, DETENTS, heights, true);
		if (next === 'closed') closeKind(top);
		else setDetent(next);
	}

	// ---- the Connect chip + sheet ----------------------------------------------------
	const openCount = $derived($peers?.openedPeers?.size ?? 0);
	// the same three states the Connect pill derives (Connect.svelte connState)
	const pendingOut = $derived(($waitingForApproval ?? []).some((/** @type {any} */ w) => w[1] === 'pending'));
	const connState = $derived(openCount > 0 ? 'connected' : pendingOut ? 'pending' : 'idle');
	function openConn() {
		if ($phoneSheet === 'conn') return closeConn();
		phoneSheet.set('conn');
	}
	// the drawer's Info / Rooms / Toasts tabs ARE the sheet's lower half, whoever opened it
	$effect(() => {
		if ($phoneSheet === 'conn') connectDrawerOpen.set(true);
	});
	function closeConn() {
		phoneSheet.set(null);
		if (!$connectDrawerPinned) connectDrawerOpen.set(false);
	}

	// 41b H4 (refines G21): the chip SAYS its state ("Connected", "Connecting…", "Offline") when the
	// top bar has room, and drops to the dot alone only when it is crowded (peers + a call). A
	// CONTAINER-WIDTH rule, not a device one: the room is the chip's own slot between the logo and
	// the right-hand chrome, measured by a ResizeObserver (the slot narrows when the peers button
	// appears, the chip widens when the mic does). The label's natural width comes from a hidden copy
	// that is always laid out — a hidden label measures 0, and zero is not a width.
	const chipLabel = $derived(connectionLabel($connectionStatus.tone));
	const CHIP_LABEL_GAP = $derived(8 * k); // .ps-chip-main's gap
	let chipCompact = $state(false);
	/** @type {HTMLElement | undefined} */
	let chipWrapEl = $state();
	/** @type {HTMLElement | undefined} */
	let chipEl = $state();
	/** @type {HTMLElement | undefined} */
	let chipMeasureEl = $state();
	$effect(() => {
		const wrap = chipWrapEl;
		const chip = chipEl;
		const meas = chipMeasureEl;
		if (!wrap || !chip || !meas) return;
		let compact = untrack(() => chipCompact);
		const fit = () => {
			const room = wrap.clientWidth;
			if (!room) return;
			const shown = /** @type {HTMLElement | null} */ (chip.querySelector('.ps-chip-lbl'));
			const base = chip.offsetWidth - (shown ? shown.offsetWidth + CHIP_LABEL_GAP : 0);
			const next = base + CHIP_LABEL_GAP + meas.offsetWidth > room;
			if (next !== compact) chipCompact = compact = next;
		};
		const ro = new ResizeObserver(fit);
		ro.observe(wrap);
		ro.observe(chip);
		ro.observe(meas);
		fit();
		return () => ro.disconnect();
	});

	// ---- the strip -------------------------------------------------------------------
	// (`hasSel` is declared with the sheet geometry above: the room a sheet may take depends on it)
	// 41 G11: Inspect is a TOGGLE whose pressed state is the Inspector really showing the
	// selection (it used to be an always-tinted label button that could only open it)
	// 41b H1: the Inspector is the PROPERTIES dock tab on a phone — pressed while that tab is the one
	// on screen, and a press while it is covered by another tab (or the dock is minimized) brings it
	// to the front instead of opening a drawer behind the dock
	const inspecting = $derived($phoneDockShown === 'properties' && $inspectorKind === 'selection');
	function toggleInspect() {
		if (inspecting) closePhoneTab('properties');
		else openPhoneTab('properties');
	}

	// ---- the bar ---------------------------------------------------------------------
	function add() {
		const r = document.getElementById('ps-add')?.getBoundingClientRect();
		const centre = canvasCenter();
		$viewportMenuOpener?.(centre.x, centre.y, true, r?.left ?? 16, r?.top ?? window.innerHeight - 90);
		// the Add tab is the Add LIST itself (the design's Add sheet), not the whole
		// viewport menu — that one stays on the canvas long-press and More › Viewport tools
		viewportMenu.update((m) => (m ? { ...m, only: 'add' } : m));
	}
	// NOTES-38 #32 (a): the Add LIST opened from the bar sits above the bar like the other
	// sheets; the canvas long-press menus (c) may still cover it — phone.css reads this class
	$effect(() => {
		document.documentElement.classList.toggle('ps-add-open', $viewportMenu?.only === 'add');
		return () => document.documentElement.classList.remove('ps-add-open');
	});

	// NOTES-38 #32 (b): the selection strip rides on TOP of whatever is open along the bottom —
	// a sheet, the Inspector, a docked view, the Add list (41 G20: the notes sheet, its note card and
	// a toolbox sheet too) — so Move / Undo work without closing it. Measured, not computed: those
	// panels belong to other components ($lib/ui/bottomEdge's list, the bar itself included).
	// 41b H3: it FOLLOWS a drawer being resized in the same frame — the edge is read once per
	// animation frame and the strip moved by a TRANSFORM written right there (no layout), where a
	// 120 ms poll moving `bottom` left it frames behind and then jumping ("inspect toolbar stutter").
	/** @type {HTMLElement | undefined} */
	let stripEl = $state();
	$effect(() => {
		const el = stripEl;
		if (!el) return;
		return followBottomEdge((occ) => {
			el.style.transform = `translateX(-50%) translateY(${-(occ + 8)}px)`;
		});
	});

	// 40 F1: the DOCK (Explorer, Node editor, Animation … — one shared height) is a sheet too. Its
	// panels belong to their editors (and their tab strip to DockTabs), so the grab bar is drawn
	// HERE, over the panel's top edge (phone.css pads the panel for it): drag resizes the shared
	// `dockHeight`, swipe down to the end MINIMIZES the dock (every tab stays open; the bar's
	// buttons bring it back — panelToggles' minimized rule).
	// 42 I5: More ▸ "Dock tab row" off hides DockTabs' strip (phone.css), so the room goes too
	const DOCK_TABS_ROOM = $derived($phoneDockTabs ? Math.round(28 * k) : 0); // DockTabs' strip rides just above the panel
	// the root classes phone.css reads for the two chrome switches
	$effect(() => {
		const root = document.documentElement.classList;
		root.toggle('ps-no-dock-tabs', !$phoneDockTabs);
		root.toggle('ps-no-grab', !$phoneGrabHandle);
		return () => root.remove('ps-no-dock-tabs', 'ps-no-grab');
	});
	const dockOn = $derived(!!$visibleDockKey && !$dockMinimized);
	const dockMax = $derived(Math.max(160, sheetMax - DOCK_TABS_ROOM));
	const dockShown = $derived(Math.min($dockHeight, dockMax));
	/** 41 G5: the docked view on screen — its lists hand off to the dock's sheet gesture (a
	 *  canvas or node graph inside keeps every touch: sheetDrag's touch-action rule) */
	// 41b H1: a content tab's panel (the Inspector, the object list, the notes) is re-seated over the
	// dock frame rather than inside it, so it is a surface of its own
	const dockPanels = () =>
		[...document.querySelectorAll('.tp-dock-panel, [data-pd-host="shown"]')].filter((el) => !el.classList.contains('hidden') && /** @type {HTMLElement} */ (el).offsetHeight > 0);

	// 41b H1: a swipe-away MINIMIZES the dock, and the height it comes back at is the one the gesture
	// started from — the live drag wrote every step into the shared height, so without this the next
	// tab opened at the few pixels the swipe ended at (measured: flowDockHeight=0, every tab 27 px)
	let dockDragFrom = 0;
	/** @param {number} h @param {boolean} done */
	function dockResize(h, done) {
		if (!dockDragFrom) dockDragFrom = $dockHeight;
		dockHeight.set(Math.round(h));
		if (done) dockDragFrom = 0;
	}
	function dockClose() {
		if (dockDragFrom) dockHeight.set(dockDragFrom);
		dockDragFrom = 0;
		dockMinimized.set(true);
	}

	// unread chat: messages that arrived while the chat sheet was closed
	let seenChat = $state(0);
	const chatOpen = $derived($chatHidden === '');
	$effect(() => {
		if (chatOpen) seenChat = $messages.length;
	});
	const chatUnread = $derived(chatOpen ? 0 : Math.max(0, $messages.length - seenChat));
	// 41b H6/H7: a long press (contextmenu) on Play opens PLAY'S OWN phone menu. It used to forward to
	// the desktop toolbar's play button, whose menu is about that toolbar — Move left / Move right
	// walked a bar that is not drawn on a phone, and "Always on top", "Move toolbar", "Collapse"
	// and "Customize toolbar…" do nothing here. The phone rows: the same "Play as" rows the desktop
	// opens with ($lib/playMode), Test play in a game, then this bar's own: Move left / Move right
	// (Play walks along the bar) and, 42 I5, "Arrange the bar…" (More, where the bar is arranged —
	// so a bar emptied down to Play can still be changed).
	let playMenuAt = $state(/** @type {{x: number, y: number} | null} */ (null));
	/** @param {MouseEvent} e */
	function playMenu(e) {
		e.preventDefault();
		playMenuAt = { x: e.clientX, y: e.clientY };
	}
	function playMenuItems() {
		const list = $phoneBar;
		const at = list.indexOf('play');
		return [
			...playAsItems(),
			// 50 R1: only where it can work — elsewhere the More tile carries the note
			...($arTableEntry === 'ready'
				? [{ label: 'Play on a table (AR)', tooltip: 'Find a table through the camera and play the scene on it', action: () => enterArTable() }]
				: []),
			...($hudIsGame
				? [
						{ section: 'Game' },
						{ label: 'Test play (start from the menu)', tooltip: 'Reset the game to its menu, enter Play, and start from the Start screen', action: () => testPlay() }
					]
				: []),
			{ section: 'Bar' },
			{ label: 'Move left', tooltip: 'Move Play one place left on the bar', disabled: at <= 0, action: () => editBar(moveItem($phoneBar, 'play', -1)) },
			{ label: 'Move right', tooltip: 'Move Play one place right on the bar', disabled: at < 0 || at >= list.length - 1, action: () => editBar(moveItem($phoneBar, 'play', 1)) },
			{ label: 'Arrange the bar…', tooltip: 'Open More — press and hold any item to drag it to or from the bar', action: () => phoneSheet.set('more') }
		];
	}
	function toggleMore() {
		phoneSheet.set($phoneSheet === 'more' ? null : 'more');
	}

	// ---- the More sheet --------------------------------------------------------------
	function openAi() {
		phoneSheet.set(null);
		if (!aiReady()) {
			showToast('Enable an AI provider in Settings to use the assistant');
			settingsSection.set('ai');
			settingsOpen.set(true);
			return;
		}
		aiAssistantHidden.set('');
	}
	/** close the shell's own sheet, then run (a destination opened from More replaces it) */
	const fromMore = (/** @type {() => void} */ fn) => () => {
		phoneSheet.set(null);
		fn();
	};
	/** @param {string} key */
	const viewAction = (key) => ({
		label: DOCK_TITLES[key] ?? key,
		// 41b H5: a tap on the view that is on screen minimizes the dock (phoneBarTap)
		run: fromMore(() => phoneBarTap(key)),
		pressed: () => $visibleDockKey === key && !$dockMinimized
	});
	/** @param {'translate' | 'rotate' | 'scale'} mode @param {string} label @param {string} icon @param {string} key */
	const transformAction = (mode, label, icon, key) => ({
		label,
		hint: `${label} (${key})`,
		icon,
		run: fromMore(() => setTransformMode(mode)),
		pressed: () => hasSel && $transformMode === mode,
		disabled: () => !hasSel
	});
	/** ONE map the bar AND the More tiles render from, so an item cannot behave differently in its
	 *  two places (NOTES-38 #7 / 42 I5: any of them may sit on the bar). `short` is the bar's label
	 *  where the full one would not fit; `pressed` absent = not a toggle; `disabled` keeps the item
	 *  holdable (aria-disabled, not the attribute — a disabled button takes no pointer events).
	 * `note` (50 R1) is a line under a More tile's label — why an item that cannot work here is off.
	 * @type {Record<string, {label: string, short?: string, hint?: string, icon: string, run: () => void, pressed?: () => boolean, disabled?: () => boolean, badge?: () => number, dot?: () => string, note?: () => string}>} */
	const ACTIONS = {
		play: { label: 'Play', icon: 'play', run: fromMore(() => requestPlay()) },
		add: { label: 'Add', icon: 'plus', run: () => add() },
		// 41b H1/H5: Objects, Configure Scene and Notes are dock tabs — the bar shows / minimizes them
		objects: { label: 'Objects', icon: 'list', run: fromMore(() => phoneBarTap('objects')), pressed: () => $visibleDockKey === 'objects' && !$dockMinimized },
		// 43 J1: Statistics is a dock tab too (a floating window only where undocking is allowed)
		stats: { label: 'Statistics', short: 'Stats', icon: 'gauge', run: fromMore(() => phoneBarTap('stats')), pressed: () => ($visibleDockKey === 'stats' && !$dockMinimized) || ($statsOpen && !$phoneTabsOpen.stats) },
		chat: {
			label: 'Chat',
			icon: 'message-square',
			run: () => {
				const open = chatOpen;
				phoneSheet.set(null);
				chatHidden.set(open ? 'hidden' : '');
			},
			pressed: () => chatOpen,
			badge: () => chatUnread
		},
		scene: {
			label: 'Scene',
			icon: 'sun',
			run: fromMore(() => phoneBarTap('scene')),
			pressed: () => $visibleDockKey === 'scene' && !$dockMinimized
		},
		ai: { label: 'AI assistant', short: 'AI', icon: 'sparkles', run: () => openAi(), pressed: () => $aiAssistantHidden === '' },
		notes: {
			label: 'Notes',
			icon: 'sticky-note',
			run: fromMore(() => phoneBarTap('notes')),
			pressed: () => $visibleDockKey === 'notes' && !$dockMinimized
		},
		more: {
			label: 'More',
			icon: 'layout-grid',
			run: () => toggleMore(),
			pressed: () => $phoneSheet === 'more',
			// the More tab carries the unread count of whatever lives in More
			badge: () => ($phoneBar.includes('chat') ? 0 : chatUnread)
		},
		explorer: { ...viewAction('explorer'), icon: 'folder-open' },
		flow: { ...viewAction('flow'), icon: 'workflow' },
		animation: { ...viewAction('animation'), icon: 'clapperboard' },
		flowcode: { ...viewAction('flowcode'), icon: 'code' },
		shader: { ...viewAction('shader'), icon: 'palette' },
		uv: { ...viewAction('uv'), icon: 'grid-2x2' },
		hud: { ...viewAction('hud'), icon: 'monitor' },
		timeline: { ...viewAction('timeline'), icon: 'video' },
		profiler: { ...viewAction('profiler'), icon: 'activity' },
		code: { ...viewAction('code'), icon: 'braces' },
		// 42 I5: More ▸ Edit — the selection strip's tools, placeable on the bar (Inspect toggles the
		// Properties tab as the strip's does; Move / Rotate / Scale arm the gizmo)
		inspect: { label: 'Inspect', icon: 'sliders-horizontal', run: fromMore(() => toggleInspect()), pressed: () => inspecting, disabled: () => !hasSel && !inspecting },
		move: transformAction('translate', 'Move', 'move', '1'),
		rotate: transformAction('rotate', 'Rotate', 'rotate-ccw', '2'),
		scale: transformAction('scale', 'Scale', 'maximize-2', '3'),
		undo: { label: 'Undo', icon: 'undo-2', run: () => undo(), disabled: () => !$canUndo },
		redo: { label: 'Redo', icon: 'redo-2', run: () => redo(), disabled: () => !$canRedo },
		multiselect: { label: 'Select multiple', short: 'Multi', icon: 'square-dashed', run: () => multiSelectMode.update((v) => !v), pressed: () => $multiSelectMode },
		interact: { label: 'Interact mode', short: 'Interact', icon: 'hand', run: () => toggleEditorMode(), pressed: () => interactOn },
		// 42 I5: "Tools, snapping, view and camera…" renamed, and placeable
		tools: { label: 'Tools & View', short: 'Tools', icon: 'wrench', run: () => viewportTools() },
		// 50 R1: the AR table. Off with a NOTE where the browser has no immersive-ar (iPhone, desktop) —
		// never a button that fails; the session request rides this press (it needs the activation)
		ar: {
			label: 'AR table',
			short: 'AR',
			icon: 'smartphone',
			get hint() {
				return $arTableEntry === 'ready' ? 'Place the scene on a real table through the camera, then play it' : AR_UNSUPPORTED_NOTE;
			},
			run: fromMore(() => enterArTable()),
			disabled: () => $arTableEntry !== 'ready',
			note: () => ($arTableEntry === 'unsupported' ? AR_UNSUPPORTED_NOTE : $arTableEntry === 'checking' ? 'Checking…' : '')
		},
		focus: { label: 'Focus mode', short: 'Focus', icon: 'maximize-2', run: () => enterFocusMode() },
		// 68 V1: film the scene with the phone (turn it to look, a stick to move, ● to record)
		film: { label: 'Film with phone', short: 'Film', icon: 'video', hint: 'The phone becomes a scene camera: turn it to look around, record a shot into the Timeline', run: fromMore(() => openFilm()) },
		// 46 B1: the scene budget for the chosen device (Statistics ▸ Budget picks the device); the dot is its tier
		budget: {
			get label() {
				return `Budget · ${(TARGETS[$budgetTarget] ?? TARGETS.quest).short} ${verdictFor($sceneCost, $budgetTarget).percent}%`;
			},
			get short() {
				return `${verdictFor($sceneCost, $budgetTarget).percent}%`;
			},
			hint: 'Does this scene fit the device you ship to? Opens Statistics ▸ Budget',
			icon: 'gauge',
			dot: () => verdictFor($sceneCost, $budgetTarget).tier,
			run: fromMore(() => openBudget())
		}
	};
	/** a press on an item (the bar's and More's): a disabled one does nothing @param {string} key */
	function runItem(key) {
		const act = ACTIONS[key];
		if (!act || act.disabled?.()) return;
		act.run();
	}
	// the strip already owns #ps-move … #ps-redo, #ps-multiselect, #ps-interact and #ps-inspect; the
	// same tools on the bar take a `ps-bar-` id so every id exists once
	const STRIP_IDS = new Set(EDIT_ITEMS);
	/** @param {string} key */
	const barId = (key) => (STRIP_IDS.has(key) ? `ps-bar-${key}` : `ps-${key}`);
	/** More's own ids: the windows' tiles, the Edit tools (the 38 R9 rows' ids), Tools & View @param {string} key */
	const tileId = (key) => (EDIT_ITEMS.includes(key) ? `ps-more-${key}` : key === 'tools' ? 'ps-viewport-tools' : key === 'focus' ? 'ps-focus-mode' : `ps-tile-${key}`);
	/** More ▸ Windows: Play waits here only while it is off the bar */
	const windowTiles = $derived(WINDOW_ITEMS.filter((k) => k !== 'play' || !$phoneBar.includes('play')));

	// the bar's width decides the labels past five (a container rule: a wider phone stays labelled)
	let barW = $state(0);
	const withLabels = $derived(labelled($phoneBar.length, barW));

	// 41b H6: More may leave the bar — the FIRST time it does, a modal says how to get it back (a long
	// press on any bar item, the one door left). "Keep More" puts it back where it was.
	/** @param {string[]} before */
	function moreHint(before) {
		let seen = false;
		try {
			seen = safeStorage.getItem(MORE_HINT_KEY) === '1';
			safeStorage.setItem(MORE_HINT_KEY, '1');
		} catch {
			// private mode: the notice may come back next session
		}
		if (seen) return;
		showChoiceEx({
			id: 'more-hint',
			title: 'More is off the bar',
			message: 'To get More back, press and hold any item on the bottom bar.',
			choices: [{ value: 'ok', label: 'Got it' }],
			cancelLabel: 'Keep More'
		}).then((answer) => {
			if (!answer && !$phoneBar.includes('more')) setBar(before);
		});
	}
	/** 43 J9: a bar edit the PERSON made (an item dragged on, off or along, Play moved) — the More tip
	 *  has done its job once they have, so it hides itself for good (Settings ▸ Reset tips) */
	function editBar(/** @type {string[]} */ list) {
		const before = $phoneBar.join();
		setBar(list);
		if ($phoneBar.join() !== before) dismissTip(TIP_PHONE_MORE);
	}
	function resetBar() {
		setBar(DEFAULT_BAR);
	}
	function viewportTools() {
		phoneSheet.set(null);
		const c = canvasCenter();
		tick().then(() => $viewportMenuOpener?.(c.x, c.y, false));
	}
	/** a long press / right-click on a bar item (41b H6: the way to More, and so to the bar) @param {MouseEvent} e */
	function openMoreFromBar(e) {
		e.preventDefault();
		phoneSheet.set('more');
	}

	// ---- 42 I5: hold and drag, into / along / out of the bar ------------------------------
	// While More is open every item — More's and the bar's, Play included — is held and dragged
	// (barHold): dropped on the bar it lands where the finger is (a new one if there is room, the
	// same one moved along); a bar item dropped on the More sheet leaves the bar. Closed More = no
	// dragging, except the long press on a bar item (not Play), which opens More AND picks the item
	// up in one gesture. Play's long press with More closed stays Play's menu (41b H6/H7).
	/** @type {{key: string, from: 'bar' | 'more', x: number, y: number, over: 'bar' | 'more' | null, at: number, caret: number, refused: string} | null} */
	let drag = $state(null);
	/** @type {HTMLElement | undefined} */
	let barEl = $state();

	/** the bar's items other than the dragged one, in order, with their rects @param {string} key */
	function otherItems(key) {
		if (!barEl) return [];
		return [...barEl.querySelectorAll('[data-bar-item]')]
			.filter((el) => /** @type {HTMLElement} */ (el).dataset.barItem !== key)
			.map((el) => el.getBoundingClientRect());
	}
	/** what a finger at (x, y) is over, and where on the bar it would land @param {number} x @param {number} y */
	function dropAt(x, y) {
		if (!drag) return;
		const br = barEl?.getBoundingClientRect();
		const fr = frameEl?.getBoundingClientRect();
		/** @type {'bar' | 'more' | null} */
		let over = null;
		if (br && y >= br.top - 16) over = 'bar';
		else if (fr && top === 'more' && y >= fr.top && y <= fr.bottom) over = 'more';
		let at = 0;
		let caret = 0;
		let refused = '';
		if (over === 'bar' && br) {
			const rects = otherItems(drag.key);
			at = rects.filter((r) => r.left + r.width / 2 < x).length;
			caret = rects.length === 0 ? br.width / 2 : at === 0 ? rects[0].left - br.left : at >= rects.length ? rects[rects.length - 1].right - br.left : (rects[at - 1].right + rects[at].left) / 2 - br.left;
			if (!$phoneBar.includes(drag.key) && $phoneBar.length >= MAX_ITEMS) refused = 'full';
		} else if (over === 'more' && drag.from === 'bar' && $phoneBar.length <= 1) refused = 'last';
		drag = { ...drag, x, y, over, at, caret, refused };
	}
	/** @param {string} key @param {'bar' | 'more'} from @param {number} x @param {number} y */
	function pickUp(key, from, x, y) {
		drag = { key, from, x, y, over: null, at: 0, caret: 0, refused: '' };
		dropAt(x, y);
	}
	/** @param {number} x @param {number} y */
	function drop(x, y) {
		dropAt(x, y);
		const d = drag;
		drag = null;
		if (!d) return;
		const before = $phoneBar;
		if (d.over === 'bar') {
			const res = placeItem(before, d.key, d.at);
			if (res.refused === 'full') showToast(`The bar holds ${MAX_ITEMS} — drag one off first`);
			else editBar(res.list);
		} else if (d.over === 'more' && d.from === 'bar') {
			const res = removeItem(before, d.key);
			if (res.refused === 'last') showToast('The bar keeps at least one item');
			else {
				editBar(res.list);
				if (d.key === 'more') moreHint(before);
			}
		}
	}
	/** what a hold on an item means @param {string} key @param {'bar' | 'more'} from @returns {'drag' | 'menu' | null} */
	function holdItem(key, from, /** @type {number} */ x, /** @type {number} */ y) {
		if (from === 'more' || $phoneSheet === 'more') {
			pickUp(key, from, x, y);
			return 'drag';
		}
		if (key === 'play') {
			playMenuAt = { x, y };
			return 'menu';
		}
		phoneSheet.set('more');
		pickUp(key, from, x, y);
		return 'drag';
	}
	/** barHold's options for one item @param {string} key @param {'bar' | 'more'} from */
	const holdOpts = (key, from) => ({
		onhold: (/** @type {number} */ x, /** @type {number} */ y) => holdItem(key, from, x, y),
		onmove: (/** @type {number} */ x, /** @type {number} */ y) => dropAt(x, y),
		ondrop: drop,
		oncancel: () => (drag = null)
	});
	// a closed More ends any drag it was the target of
	$effect(() => {
		if ($phoneSheet !== 'more' && drag && drag.from === 'more') drag = null;
	});

	// 42 I14: More ▸ Tools & View ▸ Focus mode (42-int: an ACTIONS item, so it is placeable on the bar too) — the phone's way in (no Ctrl+Space); the sheet closes first so the
	// viewport is what maximizes, and the "Exit focus" pill is the way back
	function enterFocusMode() {
		phoneSheet.set(null);
		toggleViewportFocus();
	}
</script>

<svelte:window onresize={() => (viewportH = window.innerHeight)} />

<div class="tp-ui ps" data-key-scope="keep">
	<!-- TOP BAR: the logo, the bell and the avatar are the existing elements (phone.css
	     seats them); the chip is the one new piece -->
	<div class="ps-chipwrap" bind:this={chipWrapEl}>
		<div class="ps-chip" data-state={connState} data-tour="connect" data-compact={chipCompact ? '' : undefined} bind:this={chipEl}>
			<button
				type="button"
				id="ps-connect-chip"
				class="ps-chip-main"
				aria-expanded={$phoneSheet === 'conn'}
				aria-label={`${$connectionStatus.words}. Open connection details`}
				title={$connectionStatus.words}
				data-tone={$connectionStatus.tone}
				onclick={openConn}
			>
				<!-- 41 G21 + 41b H4: a status dot, the state word when there is room for it, the chevron
				     (+ the mic in a call); the full sentence is the tooltip and the accessible name -->
				<span class="ps-dot cx-status-dot" data-tone={$connectionStatus.tone} aria-hidden="true"></span>
				{#if !chipCompact}<span class="ps-chip-lbl" id="ps-connect-label" aria-hidden="true">{chipLabel}</span>{/if}
				<Icon name="chevron-down" size={16} />
				<span class="ps-chip-measure" aria-hidden="true" bind:this={chipMeasureEl}>{chipLabel}</span>
			</button>
			{#if connState === 'connected'}
				<button
					type="button"
					id="ps-mic"
					class="ps-chip-mic"
					class:on={$micActive || $pttActive}
					aria-pressed={$micActive}
					aria-label={$micActive ? 'Microphone on — tap to mute' : 'Microphone off — tap to talk'}
					onclick={toggleMic}
				>
					<Icon name={$micActive || $pttActive ? 'mic' : 'mic-off'} size={16} />
				</button>
			{/if}
		</div>
	</div>

	<!-- SELECTION STRIP (NOTES-38 #31 / #32 b): only while something is selected — just looking
	     or panning shows no toolbar — or while Interact is on (41 G13: Interact empties the
	     selection, and this is where it is turned off again). It rides above whatever is open
	     along the bottom (a sheet, the Inspector, a docked view), so Move / Undo work without
	     closing it. 41 G11: Multi-select and Interact are toggles here (after Scale), and Inspect
	     is an icon toggle; each shows its real on/off state. -->
	{#if stripOn}
		<div class="ps-strip tp-noscrollbar" role="toolbar" aria-label="Edit selection" id="ps-strip" bind:this={stripEl} use:stripScroll>
			<button type="button" class="ps-cell" id="ps-move" aria-label="Move (1)" disabled={!hasSel} aria-pressed={hasSel && $transformMode === 'translate'} onclick={() => setTransformMode('translate')}><Icon name="move" size={20} /></button>
			<button type="button" class="ps-cell" id="ps-rotate" aria-label="Rotate (2)" disabled={!hasSel} aria-pressed={hasSel && $transformMode === 'rotate'} onclick={() => setTransformMode('rotate')}><Icon name="rotate-ccw" size={20} /></button>
			<button type="button" class="ps-cell" id="ps-scale" aria-label="Scale (3)" disabled={!hasSel} aria-pressed={hasSel && $transformMode === 'scale'} onclick={() => setTransformMode('scale')}><Icon name="maximize-2" size={20} /></button>
			<button type="button" class="ps-cell" id="ps-multiselect" aria-label="Select multiple" title="Select multiple" aria-pressed={$multiSelectMode} onclick={() => multiSelectMode.update((v) => !v)}><Icon name="square-dashed" size={20} /></button>
			<button type="button" class="ps-cell" id="ps-interact" aria-label="Interact mode (I)" title="Interact mode (I)" aria-pressed={interactOn} onclick={() => toggleEditorMode()}><Icon name="hand" size={20} /></button>
			<span class="ps-sep" aria-hidden="true"></span>
			<button type="button" class="ps-cell" id="ps-inspect" aria-label="Inspect" title="Inspect" disabled={!hasSel && !inspecting} aria-pressed={inspecting} onclick={toggleInspect}><Icon name="sliders-horizontal" size={20} /></button>
			<span class="ps-sep" aria-hidden="true"></span>
			<button type="button" class="ps-cell" id="ps-undo" aria-label="Undo" disabled={!$canUndo} onclick={() => undo()}><Icon name="undo-2" size={20} /></button>
			<button type="button" class="ps-cell" id="ps-redo" aria-label="Redo" disabled={!$canRedo} onclick={() => redo()}><Icon name="redo-2" size={20} /></button>
		</div>
	{/if}

	<!-- BOTTOM BAR (42 I5): up to seven items in this device's order, Play among them (or not);
	     Play is the only live (orange) control. Labelled at five or fewer; past five a narrow bar
	     shows icons (the name stays the accessible name and the tooltip). While More is open every
	     item is held and dragged along / off the bar; the caret shows where a drop lands. -->
	<nav
		class="ps-bar"
		aria-label="Main"
		id="ps-bar"
		bind:this={barEl}
		bind:clientWidth={barW}
		data-icons-only={withLabels ? undefined : ''}
		data-dense={$phoneBar.length > 5 ? '' : undefined}
		data-drop={drag?.over === 'bar' ? (drag.refused ? 'refused' : 'ok') : undefined}
		style:grid-template-columns="repeat({$phoneBar.length}, minmax(0, 1fr))"
	>
		{#each $phoneBar as key (key)}
			{#if key === 'play'}
				<button
					type="button"
					class="ps-tab ps-play"
					class:ps-held={drag?.key === 'play'}
					id="ps-play"
					data-tour="play"
					data-bar-item="play"
					use:barHold={holdOpts('play', 'bar')}
					oncontextmenu={playMenu}
					aria-label={$willEnterAR ? 'Enter AR' : $willEnterXR ? 'Enter VR' : 'Play'}
					data-play-as={$willEnterAR ? 'ar' : $willEnterXR ? 'vr' : 'screen'}
					onclick={() => requestPlay()}
				><span class="ps-live" class:ps-live-xr={$willEnterXR}>
					<!-- 41b H7: the glyph says what a press does, as on desktop: the triangle, a headset for VR,
					     the headset with A and R in its lenses for AR -->
					{#if $willEnterAR}
						<span class="ps-play-ar"><Icon name="tool:vr" size={24} /><span class="hud-play-lens" style="left: 29%">A</span><span class="hud-play-lens" style="left: 71%">R</span></span>
					{:else if $willEnterXR}
						<Icon name="tool:vr" size={24} />
					{:else}
						<Icon name="play" size={24} fill="currentColor" />
					{/if}
				</span></button>
			{:else}
				{@const act = ACTIONS[key]}
				{@const n = act.badge?.() ?? 0}
				<button
					type="button"
					class="ps-tab"
					class:ps-held={drag?.key === key}
					id={barId(key)}
					data-bar-item={key}
					data-tour={key === 'add' ? 'add' : key === 'more' ? 'tools' : undefined /* #31: the tools live in More at rest */}
					aria-pressed={act.pressed ? act.pressed() : undefined}
					aria-disabled={act.disabled?.() || undefined}
					aria-label={withLabels ? undefined : act.label}
					title={act.hint ?? (withLabels ? undefined : act.label)}
					use:barHold={holdOpts(key, 'bar')}
					onclick={() => runItem(key)}
					oncontextmenu={openMoreFromBar}
				>
					<Icon name={act.icon} size={20} />{#if act.dot}<span class="budget-dot ps-dot" data-tier={act.dot()} aria-hidden="true"></span>{/if}{#if withLabels}<span class="ps-tab-lbl">{act.short ?? act.label}</span>{/if}
					{#if n > 0}<span class="ps-nb" aria-label={`${n} unread`}>{n > 99 ? '99+' : n}</span>{/if}
				</button>
			{/if}
		{/each}
		{#if drag?.over === 'bar'}
			<span class="ps-caret" id="ps-bar-caret" aria-hidden="true" style:left="{drag.caret}px"></span>
		{/if}
	</nav>

	{#if dockOn}
		<!-- 42 I5: with More ▸ "Grab handle" off the grip is a thin invisible band ON the panel's top
		     edge (12 px in, 2 px out — clear of the tab row above), which still drags -->
		<div class="ps-dockgrip" id="ps-dock-grip" data-bare={$phoneGrabHandle ? undefined : ''} style:bottom="calc(var(--ps-bar-h) + {dockShown - ($phoneGrabHandle ? 24 : 12)}px)">
			<SheetGrip label="dock" height={dockShown} min={160} max={dockMax} surface={dockPanels} onresize={dockResize} onclose={dockClose} />
		</div>
	{/if}

	<!-- THE SHEET FRAME: a surface, a handle, (a title row for the shell's own sheets);
	     the reused window is placed into the rest of it by phone.css -->
	{#if top}
		{#if HOSTS[top][2] || detent === 'full'}
			<button type="button" class="ps-scrim" tabindex="-1" aria-label="Close" onclick={() => closeKind(top)}></button>
		{/if}
		<section
			bind:this={frameEl}
			class="ps-sheet"
			class:ps-dragging={dragH !== null}
			data-kind={top}
			data-detent={dragH !== null ? 'dragging' : detent}
			style:height="{sheetH}px"
			aria-label={HOSTS[top][1] ?? 'Sheet'}
		>
			<div
				class="ps-strip-h"
				use:sheetDrag={{
					height: () => sheetH,
					min: () => heights.peek,
					max: () => heights.full,
					keys: false,
					settle: settleDetent,
					onmove: (h) => (dragH = h),
					onsettle: restAt,
					onclose: () => closeKind(top),
					ontap: tapHandle,
					// 41 G5: the frame's own body (More, Connection) and the window placed into it
					surfaces: () => [frameEl, document.querySelector('[data-ps-host="top"]')]
				}}
			>
				<button
					type="button"
					class="ps-handle"
					id="ps-sheet-handle"
					style:height="{STRIP_H}px"
					data-sheet-grip
					aria-label={`Sheet height: ${detent}. Tap to change, drag down to close.`}
					onkeydown={handleKey}
				>{#if $phoneGrabHandle}<span class="ps-grabber" aria-hidden="true"></span>{/if}</button>
			</div>
			{#if titled}
				<div class="ps-head">
					<h2 class="ps-title">{HOSTS[top][1]}</h2>
					<button type="button" class="ps-close" id="ps-sheet-close" aria-label={`Close ${HOSTS[top][1]}`} onclick={() => closeKind(top)}><Icon name="x" size={20} /></button>
				</div>
			{/if}
			{#if top === 'more'}
				<!-- 42 I5: More is where the bar is arranged — every item here (and on the bar) is held and
				     dragged to / from the bar while this sheet is open; a tap still runs it. -->
				{#snippet tile(/** @type {string} */ key)}
					{@const act = ACTIONS[key]}
					{@const n = act.badge?.() ?? 0}
					<button
						type="button"
						class="ps-tile"
						class:ps-held={drag?.key === key && drag.from === 'more'}
						id={tileId(key)}
						data-more-item={key}
						data-on-bar={$phoneBar.includes(key) ? '' : undefined}
						aria-pressed={act.pressed ? act.pressed() : undefined}
						aria-disabled={act.disabled?.() || undefined}
						title={act.hint}
						use:barHold={holdOpts(key, 'more')}
						onclick={() => runItem(key)}
					>
						<span class="ps-gi" class:ps-gi-play={key === 'play'}><Icon name={act.icon} size={20} />{#if act.dot}<span class="budget-dot ps-dot" data-tier={act.dot()} aria-hidden="true"></span>{/if}</span>{act.label}
						{#if act.note?.()}<span class="ps-tile-note" id={`${tileId(key)}-note`}>{act.note()}</span>{/if}
						{#if n > 0}<span class="ps-nb ps-nb-tile">{n > 99 ? '99+' : n}</span>{/if}
					</button>
				{/snippet}
				<div class="ps-body" id="ps-more-sheet" data-drop={drag?.over === 'more' && drag.from === 'bar' ? (drag.refused ? 'refused' : 'ok') : undefined} use:minimalScroll>
					<h3 class="ps-sec">Windows</h3>
					<div class="ps-tiles">
						{#each windowTiles as key (key)}{@render tile(key)}{/each}
					</div>
					<!-- NOTES-38 #31: what the strip offered with nothing selected lives here; 42 I5: all of it -->
					<h3 class="ps-sec">Edit</h3>
					<div class="ps-tiles">
						{#each EDIT_ITEMS as key (key)}{@render tile(key)}{/each}
					</div>
					<h3 class="ps-sec">Tools &amp; View</h3>
					<div class="ps-tiles">
						{#each VIEW_ITEMS as key (key)}{@render tile(key)}{/each}
					</div>
					<h3 class="ps-sec">Show</h3>
					<div class="ps-switches">
						<div class="ps-switch">
							<span class="ps-switch-txt"><span id="ps-switch-strip-l">Selection toolbar</span><span class="ps-switch-desc">Move, Rotate, Scale and Inspect over a selection</span></span>
							<Toggle id="ps-switch-strip" labelledby="ps-switch-strip-l" bind:checked={$phoneSelectionStrip} />
						</div>
						<div class="ps-switch">
							<span class="ps-switch-txt"><span id="ps-switch-tabs-l">Dock tab row</span><span class="ps-switch-desc">The tabs above docked windows</span></span>
							<Toggle id="ps-switch-tabs" labelledby="ps-switch-tabs-l" bind:checked={$phoneDockTabs} />
						</div>
						<div class="ps-switch">
							<span class="ps-switch-txt"><span id="ps-switch-grab-l">Grab handle</span><span class="ps-switch-desc">Off: drag the top edge to resize</span></span>
							<Toggle id="ps-switch-grab" labelledby="ps-switch-grab-l" bind:checked={$phoneGrabHandle} />
						</div>
					</div>
					<div class="ps-more-foot">
						<button type="button" class="ps-btn" id="ps-bar-reset" disabled={$phoneBar.join() === DEFAULT_BAR.join()} onclick={resetBar}>Reset bar</button>
					</div>
					<!-- the how-to rides the sheet's bottom edge, right above the bar it talks about -->
					{#if $moreTipShown}
						<p class="ps-hint" id="ps-more-hint">Hold and drag items to or from the bar (up to {MAX_ITEMS})</p>
					{/if}
				</div>
			{/if}
		</section>
	{/if}

	<!-- 42 I5: the held item follows the finger, lifted clear of it so it stays visible -->
	{#if drag}
		<div class="ps-ghost" id="ps-drag-ghost" data-key={drag.key} data-refused={drag.refused || undefined} style:left="{drag.x}px" style:top="{drag.y}px" aria-hidden="true">
			<span class="ps-gi" class:ps-gi-play={drag.key === 'play'}><Icon name={ACTIONS[drag.key].icon} size={20} /></span>
		</div>
	{/if}

	{#if playMenuAt}
		<ContextMenu x={playMenuAt.x} y={playMenuAt.y} items={playMenuItems()} sizeKey="phoneplay" onclose={() => (playMenuAt = null)} />
	{/if}
</div>

<style>
	/* the bar/strip sit BELOW the drawer tier (30): the Inspector, the notes sheet, the dock
	   and every window cover them, the way a sheet covers a tab bar */
	.ps-chipwrap {
		position: fixed;
		top: 12px;
		left: 64px;
		right: var(--ps-right, 116px);
		height: 44px;
		z-index: var(--z-chrome-top);
		display: flex;
		align-items: center;
		justify-content: center;
		pointer-events: none;
	}
	.ps-chip {
		pointer-events: auto;
		display: inline-flex;
		align-items: center;
		max-width: 100%;
		height: 44px;
		padding: 0 2px;
		border-radius: var(--radius-pill, 999px);
		background: var(--surface-1);
		border: 1px solid var(--border);
		box-shadow: var(--shadow-window);
		color: var(--text);
	}
	.ps-chip-main {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
		height: 40px;
		padding: 0 12px;
		border: 0;
		border-radius: var(--radius-pill, 999px);
		background: transparent;
		color: inherit;
		font: 500 var(--fs-body) var(--font-ui);
		cursor: pointer;
	}
	.ps-chip-main {
		position: relative;
	}
	.ps-chip-lbl {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	/* the label's natural width, always laid out and never seen (41b H4) */
	.ps-chip-measure {
		position: absolute;
		left: 0;
		top: 0;
		visibility: hidden;
		pointer-events: none;
		white-space: nowrap;
	}
	.ps-dot {
		width: 8px;
		height: 8px;
		flex-shrink: 0;
		border-radius: 50%;
	}
	.ps-chip-mic {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 40px;
		height: 40px;
		border: 0;
		border-radius: 50%;
		background: transparent;
		color: var(--text-muted);
		cursor: pointer;
	}
	.ps-chip-mic.on {
		background: var(--accent-soft);
		color: var(--accent-text);
	}

	.ps-strip {
		position: fixed;
		left: 50%;
		/* 41b H3: lifted by a transform from the bottom edge (`followBottomEdge`); this is its resting
		   place above the bar until the first frame writes the measured one */
		bottom: 0;
		transform: translateX(-50%) translateY(calc(-84px - env(safe-area-inset-bottom, 0px)));
		z-index: var(--z-selection); /* 41 G20: under every dock and sheet — a drawer covers it */
		display: flex;
		align-items: center;
		gap: 0; /* 41 G11: nine cells — the cells' own padding spaces them */
		height: 52px;
		padding: 0 4px;
		border-radius: 16px;
		background: var(--surface-1);
		border: 1px solid var(--border);
		box-shadow: var(--shadow-window);
		max-width: calc(100vw - 16px);
	}
	.ps-cell {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		/* 41 G11: nine cells + two 7 px rules + the strip's 16 px gutter, 8 px padding and border
		   fit a 390 px phone (38.6 px each there), 44 when roomier */
		width: min(44px, calc((100vw - 44px) / 9));
		flex-shrink: 0;
		height: 44px;
		border: 0;
		border-radius: 12px;
		background: transparent;
		color: var(--text-2);
		cursor: pointer;
	}
	.ps-cell[aria-pressed='true'] {
		background: var(--accent-soft);
		color: var(--accent-text);
	}
	.ps-cell:disabled {
		opacity: 0.35;
		cursor: default;
	}
	.ps-sep {
		width: 1px;
		height: 24px;
		margin: 0 3px;
		background: var(--border);
	}
	.ps-bar {
		position: fixed;
		left: 0;
		right: 0;
		bottom: 0;
		z-index: var(--z-phone-bar); /* #32 / 40 F1: above every sheet (the main menu is 43), so the raised Play circle is never covered */
		height: calc(76px + env(safe-area-inset-bottom, 0px));
		padding: 0 6px calc(8px + env(safe-area-inset-bottom, 0px));
		display: grid;
		align-items: center;
		background: var(--surface-1);
		border-top: 1px solid var(--border);
	}
	.ps-tab {
		position: relative;
		display: grid;
		justify-items: center;
		align-content: center;
		gap: 3px;
		height: 60px;
		border: 0;
		border-radius: 12px;
		background: transparent;
		color: var(--text-muted);
		font: 500 11.5px var(--font-ui);
		cursor: pointer;
	}
	.ps-tab[aria-pressed='true'] {
		color: var(--accent-text);
	}
	.ps-live {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 56px;
		height: 56px;
		margin-top: -26px;
		padding-left: 3px;
		border-radius: 50%;
		background: var(--live);
		color: var(--on-live);
		box-shadow: 0 0 0 5px var(--surface-1), 0 6px 16px color-mix(in srgb, var(--live) 45%, transparent);
	}
	.ps-nb {
		position: absolute;
		top: 6px;
		left: calc(50% + 6px);
		min-width: 17px;
		height: 17px;
		padding: 0 4px;
		border-radius: 999px;
		background: var(--accent-fill);
		color: var(--on-accent);
		font: 600 10px/17px var(--font-ui-mono, monospace);
	}

	.ps-dockgrip {
		position: fixed;
		left: 0;
		right: 0;
		height: 24px;
		z-index: calc(var(--z-dock) + 1); /* over its dock panel (--z-dock, 35), under every sheet */
		background: transparent;
	}
	.ps-dockgrip[data-bare] {
		height: 12px; /* the panel's 12 px top padding (phone.css .ps-no-grab) */
	}
	.ps-scrim {
		position: fixed;
		inset: 0 0 calc(76px + env(safe-area-inset-bottom, 0px)) 0; /* #32: the bar stays live */
		z-index: calc(var(--z-sheet) - 1);
		border: 0;
		padding: 0;
		background: var(--scrim);
		cursor: default;
	}
	.ps-sheet {
		position: fixed;
		left: 0;
		right: 0;
		bottom: calc(76px + env(safe-area-inset-bottom, 0px)); /* #32 (a): above the bar */
		z-index: var(--z-sheet);
		display: flex;
		flex-direction: column;
		box-sizing: border-box;
		background: var(--surface-1);
		color: var(--text);
		border: 1px solid var(--border);
		border-bottom: 0;
		border-radius: 18px 18px 0 0;
		box-shadow: var(--shadow-window);
		transition: height 0.22s cubic-bezier(0.2, 0.8, 0.2, 1);
	}
	.ps-dragging {
		transition: none;
	}
	.ps-strip-h {
		flex-shrink: 0;
		touch-action: none;
		cursor: grab;
	}
	.ps-handle {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 100%;
		height: 22px;
		padding: 0;
		border: 0;
		background: transparent;
		cursor: inherit;
	}
	.ps-grabber {
		width: 40px;
		height: 5px;
		border-radius: 3px;
		background: var(--border-strong);
	}
	.ps-head {
		display: flex;
		align-items: center;
		height: 44px;
		padding: 0 6px 0 16px;
		border-bottom: 1px solid var(--border);
		flex-shrink: 0;
	}
	.ps-title {
		flex: 1;
		min-width: 0;
		margin: 0;
		font: 600 17px var(--font-ui);
	}
	.ps-play-ar {
		position: relative;
		display: inline-flex;
		align-items: center;
		justify-content: center;
	}
	.ps-live.ps-live-xr {
		padding-left: 0; /* the triangle's optical nudge is for the triangle only */
	}
	.ps-close {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 44px;
		height: 44px;
		border: 0;
		border-radius: var(--radius-button, 8px);
		background: transparent;
		color: var(--text-muted);
		cursor: pointer;
	}
	.ps-body {
		flex: 1;
		min-height: 0;
		overflow: auto;
		overscroll-behavior: contain;
		padding: 4px 12px 16px;
	}
	.ps-sec {
		margin: 12px 4px 8px;
		font: 600 12px var(--font-ui);
		letter-spacing: var(--tracking-section, 0.06em);
		text-transform: uppercase;
		color: var(--text-faint);
	}
	.ps-tiles {
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		gap: 6px;
	}
	.ps-tile {
		display: grid;
		justify-items: center;
		gap: 6px;
		padding: 10px 2px 8px;
		border: 0;
		border-radius: 12px;
		background: transparent;
		color: var(--text-2);
		font: 400 12px/1.2 var(--font-ui);
		text-align: center;
		cursor: pointer;
	}
	.ps-gi {
		display: grid;
		place-items: center;
		width: 46px;
		height: 46px;
		border-radius: 14px;
		background: var(--surface-2);
		border: 1px solid var(--border);
		color: var(--text);
	}
	.ps-tile[aria-pressed='true'] .ps-gi {
		background: var(--accent-soft);
		border-color: var(--accent);
		color: var(--accent-text);
	}
	.ps-tile {
		position: relative;
	}
	/* 50 R1: why an item is off here (the AR table's "AR needs Android Chrome") */
	.ps-tile-note {
		color: var(--color-text-muted);
		font-size: 11px;
		line-height: 1.2;
	}
	.ps-nb-tile {
		top: 4px;
		left: auto;
		right: 12px;
	}
	.ps-tab-lbl {
		max-width: 100%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.ps-hint {
		margin: 8px 4px 12px;
		color: var(--text-muted);
		font: 400 var(--fs-desc) var(--font-ui);
	}
	.ps-btn {
		height: 44px;
		padding: 0 16px;
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-button, 8px);
		background: transparent;
		color: var(--text);
		font: 500 var(--fs-body) var(--font-ui);
		cursor: pointer;
	}
	.ps-btn:disabled {
		opacity: 0.45;
		cursor: default;
	}
	.ps-tab:hover,
	.ps-cell:not(:disabled):hover,
	.ps-tile:hover,
	.ps-close:hover,
	.ps-chip-main:hover {
		background: var(--surface-hover);
	}
	/* ---- 42 I5: the bar past five items, and hold-and-drag ---------------------------------- */
	/* icons-only: the icon centred in a 60 px tall cell (every cell stays >= 44 px wide at seven) */
	.ps-bar[data-icons-only] .ps-tab {
		gap: 0;
	}
	/* six or seven columns: Play's raised circle fits its narrower cell */
	.ps-bar[data-dense] .ps-live {
		width: 50px;
		height: 50px;
	}
	.ps-tab[aria-disabled='true'] {
		opacity: 0.4;
	}
	.ps-tile[aria-disabled='true'] .ps-gi {
		opacity: 0.45;
	}
	/* an item that is on the bar wears a small accent dot in More */
	.ps-tile[data-on-bar] .ps-gi::after {
		content: '';
		position: absolute;
		top: -3px;
		right: -3px;
		width: 9px;
		height: 9px;
		border-radius: 50%;
		background: var(--accent-fill);
		border: 2px solid var(--surface-1);
	}
	.ps-gi {
		position: relative;
	}
	/* 46 B1: the budget item's tier — a dot on its icon (bottom-right in More, beside the glyph on the bar) */
	.ps-dot {
		position: absolute;
		right: 4px;
		bottom: 4px;
		width: 10px;
		height: 10px;
		border: 2px solid var(--surface-1);
		box-sizing: content-box;
	}
	.ps-tab .ps-dot {
		right: calc(50% - 17px);
		bottom: auto;
		top: 10px;
	}
	.ps-gi-play {
		background: var(--live);
		border-color: var(--live);
		color: var(--on-live);
	}
	/* the item being held stays in place, faded, while its ghost follows the finger */
	.ps-held {
		opacity: 0.35;
	}
	.ps-caret {
		position: absolute;
		top: 10px;
		bottom: calc(14px + env(safe-area-inset-bottom, 0px));
		width: 3px;
		margin-left: -1.5px;
		border-radius: 2px;
		background: var(--accent);
		pointer-events: none;
	}
	.ps-bar[data-drop='refused'] .ps-caret {
		background: var(--ink-bad);
	}
	.ps-bar[data-drop] {
		box-shadow: inset 0 2px 0 var(--accent);
	}
	.ps-bar[data-drop='refused'] {
		box-shadow: inset 0 2px 0 var(--ink-bad);
	}
	/* a bar item held over More: dropping it here takes it off the bar */
	.ps-body[data-drop] {
		outline: 2px dashed var(--accent);
		outline-offset: -6px;
		border-radius: 14px;
	}
	.ps-body[data-drop='refused'] {
		outline-color: var(--ink-bad);
	}
	.ps-ghost {
		position: fixed;
		z-index: var(--z-portal);
		transform: translate(-50%, calc(-100% - 18px));
		pointer-events: none;
		filter: drop-shadow(0 6px 14px color-mix(in srgb, var(--text) 30%, transparent));
	}
	.ps-ghost .ps-gi {
		border-color: var(--accent);
	}
	.ps-ghost[data-refused] .ps-gi {
		border-color: var(--ink-bad);
	}
	.ps-switches {
		display: grid;
		gap: 2px;
	}
	.ps-switch {
		display: flex;
		align-items: center;
		gap: 12px;
		min-height: 52px;
		padding: 0 8px;
	}
	.ps-switch-txt {
		display: grid;
		flex: 1;
		min-width: 0;
		font: 400 var(--fs-body) var(--font-ui);
		color: var(--text);
	}
	.ps-switch-desc {
		font-size: var(--fs-desc);
		color: var(--text-muted);
	}
	.ps-more-foot {
		margin: 12px 4px 8px;
	}
	#ps-more-hint {
		position: sticky;
		bottom: -16px; /* the body's bottom padding: the line sits on the sheet's edge */
		margin: 0 -12px -16px;
		padding: 8px 16px calc(8px + 2px);
		border-top: 1px solid var(--border);
		background: var(--surface-1);
		text-align: center;
	}
	:global(.ps button:focus-visible) {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}
	@media (prefers-reduced-motion: reduce) {
		.ps-sheet {
			transition: none;
		}
	}
</style>
