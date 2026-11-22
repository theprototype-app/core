import { writable, derived, get } from 'svelte/store';
import { inspectorClose, inspectorKind, objectListClose, notesDrawerOpen, mobileUndockAllowed, setInspectorRevealer, setPanelsHook } from '../stores/appStore';
import { layoutsMenuOpen } from './uiLayouts';
import {
	setDockOccupant,
	dockHeight,
	activateDock,
	visibleDockKey,
	dockMinimized,
	bottomDockActive,
	dockOccupants,
	PHONE_DOCK_TABS,
	HOSTED_DOCK_TABS
} from './bottomDock';
import { hostedTabsOpen, dockHostedView, hostedDocked, HOSTED } from './dockHost';
import { chatHidden, chatTab } from '../stores/appStore';
import { assetBrowserOpen } from './cc0/assetBrowserState.js';
import { statsOpen } from './sceneBudget';
import { registerDockOpener, registerDockCloser, closeStoreFor } from './dockMenu';
import { togglePanel } from './panelToggles';
import { phoneShell } from './ui/phoneShell.js';

// 41b H1 — THE PHONE'S CONTENT TABS. On a phone the content panels — the Inspector (as two
// tabs: Properties for the selection, Configure Scene for the scene), the Objects list, the
// notes list and the workspace Layouts — are tabs in the bottom dock, beside the Explorer and
// the editors. Before this they were sheets of their own, and Inspect opened the properties as
// a drawer BEHIND a docked view ("inspect button when clicked 'object properties' drawer are
// behind docked windows"). Menus, action sheets, notifications, the profile, Add, More and the
// option panels stay drawers (the decision table is in the lane's STATUS).
//
// Nothing here re-implements a panel. Each one keeps its own open store and its own component;
// this module only (1) reports the open ones as dock occupants while the phone posture is on,
// (2) keeps the ONE Inspector element showing whichever of its two tabs the dock shows, and
// (3) remembers per POSTURE which panels were open, so folding and unfolding the phone (or
// resizing a window across 640 px) moves every panel between its phone tab and its wider-screen
// home — the right drawer, the floating Objects window, the notes drawer, the Layouts dialog —
// and back. PhoneDockHost.svelte draws the dock frame the reused elements are placed into.
//
// THE INSPECTOR IS TWO TABS OVER ONE ELEMENT. `inspectorClose` / `inspectorKind` stay the app's
// truth (every caller keeps writing them); on the phone `inspTabs` says which of the two tabs are
// in the strip. The Inspector shows the kind of whichever is visible, and stays mounted (hidden by
// the host CSS) while another tab is in front. A close the app makes while a tab is on screen
// closes THAT tab — read after a short settle, because `showSidebar` closes and reopens across a
// 50 ms timer when it switches kinds, and that is a switch, not a close.

/** the two Inspector tabs and the kind each shows */
const INSPECTOR_TABS = ['properties', 'scene'];
/** @param {string} kind */
const tabOfKind = (kind) => (kind === 'scene' ? 'scene' : 'properties');

/** which Inspector tabs are in the phone dock (meaningless off the phone) */
export const inspTabs = writable({ properties: false, scene: false });

/** 'phone' while the phone shell's width is on, 'wide' otherwise (unfolded, desktop) */
let posture = /** @type {'phone'|'wide'|null} */ (null);
/** true between hidePanels() and restorePanels() (Settings, spectating): nothing is reopened */
let panelsHidden = false;
/** writes this module makes to the app's stores, so its own listeners do not answer them */
let ours = 0;
/**
 * The guard lasts until the end of the current task, not the end of `fn`: svelte's stores QUEUE the
 * notifications of a write made while another store's subscribers are running (a posture change runs
 * inside `phoneShell`'s), and deliver them after that subscriber returns — after a synchronous guard
 * was already lifted (measured: the Inspector's quiet reopen on a fold then stole the front tab).
 * @param {() => void} fn
 */
function quietly(fn) {
	ours++;
	try {
		fn();
	} finally {
		queueMicrotask(() => ours--);
	}
}

/** each content panel's open state in the phone posture (false everywhere else) */
// (Objects is the one content panel with a floating window of its own: with Settings ▸ Interface ▸
// "Allow undocking on touch screens" on, a phone keeps it a floating, tab-groupable window — 41 G6 —
// and only the panels with no floating mode are dock tabs)
// 43 J1: Statistics follows the Objects list's rule — a dock tab unless undocking is allowed
// 78 PL23: Chat, the AI assistant and Free assets follow the same rule (a sheet / window only where undocking is allowed)
export const phoneTabsOpen = derived(
	[phoneShell, inspTabs, objectListClose, notesDrawerOpen, layoutsMenuOpen, mobileUndockAllowed, statsOpen, chatHidden, assetBrowserOpen],
	([$phone, $ins, $objClosed, $notes, $layouts, $undock, $stats, $chat, $assets]) => ({
		properties: $phone && $ins.properties,
		scene: $phone && $ins.scene,
		objects: $phone && !$undock && !$objClosed,
		notes: $phone && !!$notes,
		layouts: $phone && !!$layouts,
		stats: $phone && !$undock && !!$stats,
		chat: $phone && !$undock && $chat === '',
		assets: $phone && !$undock && !!$assets
	})
);

/** the content tabs that are floating WINDOWS elsewhere (and on a phone that allows undocking) */
const WINDOW_TABS = ['objects', 'stats', 'chat', 'assets']; // uir-chat: the AI assistant is Chat's Assistant tab
/** 78 PL23: the hosted windows whose open store is dockHost's HOSTED entry (no phone-only store of their own) */
const HOSTED_PHONE_TABS = ['chat', 'assets'];

/** the phone content tab on screen right now (null: none, or the dock is minimized) */
export const phoneDockShown = derived([phoneShell, visibleDockKey, dockMinimized], ([$phone, $key, $min]) =>
	$phone && !$min && $key && PHONE_DOCK_TABS.includes($key) ? $key : null
);

/** is a content panel's TAB the one on screen? (Inspect's pressed state, the bar's toggles) */
/** @param {string} key */
export function phoneTabShown(key) {
	return get(phoneDockShown) === key;
}

// ---- open / close one tab ------------------------------------------------------------------

/** put a content panel in the phone dock and show it @param {string} key */
export function openPhoneTab(key) {
	if (INSPECTOR_TABS.includes(key)) {
		inspTabs.update((t) => ({ ...t, [key]: true }));
		activateDock(key);
		syncInspectorToDock();
		return;
	}
	if (key === 'objects') objectListClose.set(false);
	else if (key === 'notes') notesDrawerOpen.set(true);
	else if (key === 'layouts') layoutsMenuOpen.set(true);
	else if (key === 'stats') statsOpen.set(true);
	else if (HOSTED_PHONE_TABS.includes(key)) HOSTED[key].open();
	activateDock(key);
}

/** take a content panel out of the phone dock (closes it) @param {string} key */
export function closePhoneTab(key) {
	if (INSPECTOR_TABS.includes(key)) {
		const other = key === 'scene' ? 'properties' : 'scene';
		inspTabs.update((t) => ({ ...t, [key]: false }));
		const showing = !get(inspectorClose) && tabOfKind(get(inspectorKind)) === key;
		if (!showing) return;
		quietly(() => {
			if (get(inspTabs)[other]) inspectorKind.set(other === 'scene' ? 'scene' : 'selection');
			else inspectorClose.set(true);
		});
		return;
	}
	if (key === 'objects') objectListClose.set(true);
	else if (key === 'notes') notesDrawerOpen.set(false);
	else if (key === 'layouts') layoutsMenuOpen.set(false);
	else if (key === 'stats') statsOpen.set(false);
	else if (HOSTED_PHONE_TABS.includes(key)) HOSTED[key].close();
}

/** the dock shows an Inspector tab: make the one Inspector element show that tab's kind */
function syncInspectorToDock() {
	const key = get(visibleDockKey);
	if (posture !== 'phone' || panelsHidden || get(dockMinimized) || !key || !INSPECTOR_TABS.includes(key)) return;
	if (!get(inspTabs)[/** @type {'properties'|'scene'} */ (key)]) return;
	const kind = get(inspectorKind);
	const want = key === 'scene' ? 'scene' : kind === 'file' ? 'file' : 'selection';
	if (!get(inspectorClose) && kind === want) return;
	quietly(() => {
		inspectorKind.set(/** @type {any} */ (want));
		inspectorClose.set(false);
	});
}

// ---- H5: the phone bar's tap -----------------------------------------------------------------

/**
 * 41b H5 — a bottom-bar tap on a destination. The item whose docked view is ON SCREEN minimizes
 * the dock (every tab stays open, the viewport clears), the next tap brings it back; one that is
 * docked but covered by another tab comes to the front; a closed one opens. With undocking on
 * (Settings ▸ Interface) and the view FLOATING, the tap opens / closes that window instead.
 * @param {string} key a dock key: a content tab or a docked view (explorer, flow, …)
 */
export function phoneBarTap(key) {
	const present = !!get(dockOccupants)[key]?.present;
	if (present) {
		if (get(visibleDockKey) === key && !get(dockMinimized)) dockMinimized.set(true);
		else activateDock(key);
		return;
	}
	if (PHONE_DOCK_TABS.includes(key) && !(WINDOW_TABS.includes(key) && get(mobileUndockAllowed))) {
		openPhoneTab(key);
		return;
	}
	// not in the dock: closed, or a floating window (undocking on). togglePanel opens a closed view
	// in its last mode; a floating one TOGGLES here (the desktop tree raises a buried window first,
	// which a bar on a phone has no use for: the window is either up or it is not).
	if (get(mobileUndockAllowed) && floatingOpen(key)) {
		closeFloating(key);
		return;
	}
	// 78 PL23: Chat / AI / Free assets have no entry in togglePanel's tree — a closed one opens (as a sheet / window)
	if (HOSTED_PHONE_TABS.includes(key)) {
		HOSTED[key].open();
		return;
	}
	togglePanel(key);
}

/**
 * uir-int (78 PL23 + uir-chat): the phone bar's Chat and AI assistant buttons are the two tabs of the ONE
 * Chat window, which is one phone dock tab. Asked for the tab the window is not showing, it switches the
 * tab and brings the window up (never minimizes); asked for the tab it shows, it is the bar's own tap.
 * @param {import('../stores/appStore').ChatTab} tab
 */
export function phoneChatTap(tab) {
	const open = get(chatHidden) === '';
	if (open && get(chatTab) !== tab) {
		chatTab.set(tab);
		if (get(dockOccupants).chat?.present) activateDock('chat');
		return;
	}
	chatTab.set(tab);
	phoneBarTap('chat');
}

/** @param {string} key */
const floatStore = (key) => (key === 'objects' ? objectListClose : closeStoreFor(key));
/** @param {string} key */
function floatingOpen(key) {
	if (key === 'stats') return get(statsOpen); // an open flag, not a close store
	if (HOSTED_PHONE_TABS.includes(key)) return HOSTED[key].isOpen(get(HOSTED[key].store));
	const store = floatStore(key);
	return !!store && get(store) === false;
}
/** @param {string} key */
function closeFloating(key) {
	if (key === 'stats') statsOpen.set(false);
	else if (HOSTED_PHONE_TABS.includes(key)) HOSTED[key].close();
	else floatStore(key)?.set(true);
}

// ---- the posture memory --------------------------------------------------------------------

// SESSION memory, deliberately not saved: a plain reload is a clean slate for which panels are
// open (the workspace rule, #20 P5), so a remembered open-set must not reopen yesterday's drawers on
// today's first unfold.
/** @type {{phone?: {open: string[], active: string|null}, wide?: {open: string[], active: string|null}}} */
const memory = {};

/** the content panels open right now, read the way the posture shows them @param {'phone'|'wide'} p */
function openNow(p) {
	const out = [];
	if (p === 'phone') {
		const t = get(inspTabs);
		if (t.properties) out.push('properties');
		if (t.scene) out.push('scene');
	} else if (!get(inspectorClose)) out.push(tabOfKind(get(inspectorKind)));
	if (!get(objectListClose)) out.push('objects');
	if (get(notesDrawerOpen)) out.push('notes');
	if (get(layoutsMenuOpen)) out.push('layouts');
	return out;
}
/** what was open when the current posture began (to tell what the user opened during it) */
let openAtEntry = /** @type {string[]} */ ([]);

/** @param {'phone'|'wide'} next */
function enterPosture(next) {
	const prev = posture;
	if (prev === next) return;
	if (prev === null) {
		// boot: nothing to carry, only the phone's two Inspector tabs to seed from the Inspector
		posture = next;
		if (next === 'phone') seedInspectorTabs();
		openAtEntry = openNow(next);
		return;
	}
	const now = openNow(prev);
	// 78 PL23: on a wider screen the view in front may be a HOSTED dock tab (Chat docked and showing): it stays in
	// front as the phone's tab on the fold
	const active = prev === 'phone' ? phoneActive() : (wideHostedFront() ?? (get(inspectorClose) ? null : tabOfKind(get(inspectorKind))));
	memory[prev] = { open: now, active };
	// what the user opened or closed during this posture carries over to the next one; the rest of
	// the next posture comes back as it was left there (its own memory) — which is what keeps a
	// panel the next posture can show and this one could not: both Inspector tabs on the phone,
	// where a wider screen has one drawer. The first time, the next posture starts as this one is.
	const opened = now.filter((k) => !openAtEntry.includes(k));
	// (a wider screen's drawer shows ONE Inspector kind: switching it is not closing the other)
	const drawerUp = prev === 'wide' && now.some((k) => INSPECTOR_TABS.includes(k));
	const closed = openAtEntry.filter((k) => !now.includes(k) && !(drawerUp && INSPECTOR_TABS.includes(k)));
	const base = memory[next]?.open ?? now;
	const target = [...new Set([...base, ...opened])].filter((k) => !closed.includes(k));
	// the panel you were LOOKING AT on the phone is on the wider screen too, even where that screen's
	// own memory had it set aside (the right column shows one drawer: applyPosture)
	if (prev === 'phone' && active && now.includes(active) && !target.includes(active)) target.push(active);
	posture = next;
	applyPosture(next, target, opened, active);
	openAtEntry = openNow(next);
}

/** 78 PL23: the hosted window (Chat, AI, Free assets) the wider screen's dock shows in front, else null — read
 *  from the dock itself, not `hostedDockShown`, which is derived from the posture that is changing right now */
function wideHostedFront() {
	const key = get(visibleDockKey);
	return key && !get(dockMinimized) && HOSTED_PHONE_TABS.includes(key) && get(hostedDocked)[key] ? key : null;
}

/** the phone tab the dock was showing (a content tab or a docked view), for the memory */
function phoneActive() {
	const key = get(visibleDockKey);
	return key ?? get(bottomDockActive) ?? null;
}

/**
 * @param {'phone'|'wide'} p @param {string[]} target the content panels to have open
 * @param {string[]} opened the ones opened during the posture we are leaving (newest wins the tab)
 * @param {string|null} prevActive what the posture we left was showing
 */
function applyPosture(p, target, opened, prevActive) {
	const has = (/** @type {string} */ k) => target.includes(k);
	quietly(() => {
		objectListClose.set(!has('objects'));
		notesDrawerOpen.set(has('notes'));
		layoutsMenuOpen.set(has('layouts'));
	});
	if (p === 'wide') {
		inspTabs.set({ properties: false, scene: false });
		// the right column holds the Inspector drawer OR the notes drawer (the notes drawer would
		// cover the Inspector): the one the phone had in front, else the Inspector. The other stays
		// in the phone's memory and is a tab again on the next fold.
		const insWanted = has('properties') || has('scene');
		if (insWanted && has('notes')) {
			const keep = prevActive === 'notes' ? 'notes' : 'inspector';
			target = keep === 'notes' ? target.filter((k) => !INSPECTOR_TABS.includes(k)) : target.filter((k) => k !== 'notes');
			quietly(() => notesDrawerOpen.set(keep === 'notes'));
		}
		// the right drawer shows ONE kind: the tab the phone had in front, else Properties
		const kind = get(inspectorKind);
		const scene = has('scene') && (!has('properties') || prevActive === 'scene');
		quietly(() => {
			if (scene) {
				inspectorKind.set('scene');
				inspectorClose.set(false);
			} else if (has('properties')) {
				inspectorKind.set(kind === 'file' ? 'file' : 'selection');
				inspectorClose.set(false);
			} else inspectorClose.set(true);
		});
		return;
	}
	inspTabs.set({ properties: has('properties'), scene: has('scene') });
	const remembered = memory.phone?.active ?? null;
	const fresh = opened.find((k) => target.includes(k)) ?? null;
	// 78 PL23: the hosted window that was in front of the wider screen's dock is the phone's front tab
	const hostedFront =
		prevActive && HOSTED_PHONE_TABS.includes(prevActive) && !get(mobileUndockAllowed) && HOSTED[prevActive].isOpen(get(HOSTED[prevActive].store)) ? prevActive : null;
	const front = hostedFront ?? fresh ?? (remembered && (target.includes(remembered) || !PHONE_DOCK_TABS.includes(remembered)) ? remembered : null);
	if (front) activateDock(front);
	if (!has('properties') && !has('scene')) {
		quietly(() => inspectorClose.set(true));
		return;
	}
	syncInspectorToDock();
	// the dock is showing something else: the Inspector still has to show one of its tabs' kinds
	if (get(inspectorClose)) {
		const kind = has('properties') ? (get(inspectorKind) === 'file' ? 'file' : 'selection') : 'scene';
		quietly(() => {
			inspectorKind.set(/** @type {any} */ (kind));
			inspectorClose.set(false);
		});
	}
}

/** the phone's Inspector tabs from an Inspector that is already open (boot, a restored layout) */
function seedInspectorTabs() {
	if (get(inspectorClose)) inspTabs.set({ properties: false, scene: false });
	else inspTabs.update((t) => ({ ...t, [tabOfKind(get(inspectorKind))]: true }));
}

// ---- the app's own writes, answered ----------------------------------------------------------

let lastShownKind = /** @type {string} */ ('selection');
let closeCheck = /** @type {ReturnType<typeof setTimeout>|null} */ (null);
/** how long a close may be "a kind switch in progress" (showSidebar reopens after 50 ms) */
const SWITCH_SETTLE_MS = 120;

/** @param {boolean} closed @param {string} kind */
function onInspector(closed, kind) {
	if (posture !== 'phone' || ours) {
		if (!closed) lastShownKind = kind;
		return;
	}
	if (!closed) {
		const tab = tabOfKind(kind);
		const isNew = !get(inspTabs)[/** @type {'properties'|'scene'} */ (tab)];
		const switched = tabOfKind(lastShownKind) !== tab;
		lastShownKind = kind;
		if (isNew) inspTabs.update((t) => ({ ...t, [tab]: true }));
		// the app opened (or switched) the Inspector: its tab comes to the front
		if (isNew || switched || get(visibleDockKey) !== tab || get(dockMinimized)) activateDock(tab);
		return;
	}
	// closed: wait out a showSidebar switch, then close the tab that was showing
	const was = tabOfKind(lastShownKind);
	if (closeCheck) clearTimeout(closeCheck);
	closeCheck = setTimeout(() => {
		closeCheck = null;
		if (posture !== 'phone' || !get(inspectorClose)) return; // reopened: a switch, not a close
		inspTabs.update((t) => ({ ...t, [was]: false }));
		// the other Inspector tab stays in the strip; the Inspector comes back for it only when that tab
		// is the one in front (never while Settings / spectating has the panels hidden)
		syncInspectorToDock();
	}, SWITCH_SETTLE_MS);
}

let started = false;
/** wire the posture watcher + the tab bookkeeping (once, from the always-mounted editor chrome) */
export function startPhoneDock() {
	if (started) return () => {};
	started = true;
	/** @type {(() => void)[]} */
	const offs = [];
	for (const key of PHONE_DOCK_TABS) {
		// 42 I6: on a wider screen the Objects list is a HOSTED dock tab ($lib/dockHost) — a "+"
		// row docks the floating window there instead of opening a phone tab
		offs.push(registerDockOpener(key, () => (posture !== 'phone' && HOSTED_DOCK_TABS.includes(key) ? dockHostedView(key) : openPhoneTab(key))));
		offs.push(registerDockCloser(key, () => closePhoneTab(key)));
	}
	offs.push(phoneShell.subscribe((on) => enterPosture(on ? 'phone' : 'wide')));
	// showSidebar / openSceneSection asked for an Inspector kind that is already open: on the phone
	// its tab may be covered by another one — bring it to the front (true = it was covered)
	setInspectorRevealer((kind) => {
		if (posture !== 'phone') return false;
		const tab = tabOfKind(kind);
		if (phoneTabShown(tab)) return false;
		activateDock(tab);
		return true;
	});
	offs.push(() => setInspectorRevealer(null));
	// Settings / spectating hide the panels and bring them back: the tab that was in front comes
	// back in front (the reopening panels would otherwise each take the front in turn)
	let frontBeforeHide = /** @type {string|null} */ (null);
	setPanelsHook((phase) => {
		panelsHidden = phase === 'hide';
		if (posture !== 'phone') return;
		if (phase === 'hide') frontBeforeHide = get(dockMinimized) ? null : get(visibleDockKey);
		else if (frontBeforeHide) {
			const key = frontBeforeHide;
			frontBeforeHide = null;
			// after the Inspector's reopen has been answered (onInspector runs synchronously, its
			// close-check after SWITCH_SETTLE_MS)
			setTimeout(() => {
				if (posture === 'phone' && get(dockOccupants)[key]?.present) activateDock(key);
			}, SWITCH_SETTLE_MS + 30);
		}
	});
	offs.push(() => setPanelsHook(null));
	// occupancy: every open content panel is a dock tab in the phone posture, at the dock's height —
	// 42 I6: and every DOCKED hosted window on a wider screen ($lib/dockHost). ONE writer for both
	// sets: the Objects list is in each, and two writers of one key would race.
	const occupancyKeys = [...new Set([...PHONE_DOCK_TABS, ...HOSTED_DOCK_TABS])];
	offs.push(
		derived([phoneTabsOpen, hostedTabsOpen, dockHeight], (x) => x).subscribe(([$open, $hosted, $h]) => {
			for (const key of occupancyKeys) setDockOccupant(key, !!(/** @type {any} */ ($open)[key] || /** @type {any} */ ($hosted)[key]), $h);
		})
	);
	offs.push(derived([inspectorClose, inspectorKind], (x) => x).subscribe(([c, k]) => onInspector(c, k)));
	offs.push(derived([visibleDockKey, dockMinimized], (x) => x).subscribe(() => syncInspectorToDock()));
	// a list opened by the app (the bar, More, a shortcut) comes to the front of the dock
	for (const [key, store, isOpen] of /** @type {[string, import('svelte/store').Readable<any>, (v: any) => boolean][]} */ ([
		['objects', objectListClose, (v) => !v],
		['notes', notesDrawerOpen, (v) => !!v],
		['layouts', layoutsMenuOpen, (v) => !!v],
		['stats', statsOpen, (v) => !!v],
		// 78 PL23
		['chat', chatHidden, (v) => v === ''],
		['assets', assetBrowserOpen, (v) => !!v]
	])) {
		let was = isOpen(get(store));
		offs.push(
			store.subscribe((v) => {
				const now = isOpen(v);
				if (now && !was && posture === 'phone' && !ours) activateDock(key);
				was = now;
			})
		);
	}
	return () => {
		started = false;
		for (const off of offs) off();
		for (const key of occupancyKeys) setDockOccupant(key, false);
	};
}

/** test seam: the posture memory as stored */
export function phoneDockMemory() {
	return JSON.parse(JSON.stringify(memory));
}
