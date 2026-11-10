import { writable, derived, get } from 'svelte/store';
import { objectListClose, chatHidden, aiAssistantHidden } from '../stores/appStore';
import { isLocked } from '../stores/sceneStore';
import { statsOpen } from './sceneBudget';
import { assetBrowserOpen } from './cc0/assetBrowserState.js';
import { phoneShell } from './ui/phoneShell.js';
import { safeStorage } from './safeStorage';
import { onLayoutRestore } from './uiLayoutsCore';
import {
	HOSTED_DOCK_TABS,
	PHONE_DOCK_TABS,
	dockModeArm,
	dockHeight,
	activateDock,
	forgetDockTab,
	visibleDockKey,
	dockMinimized,
	dockShownKeys
} from './bottomDock';
import { registerDockOpener, registerDockCloser, registerDockOpenState, registerFloatOpener } from './dockMenu';
import { groupOfKey, removeFromGroup } from './windowTabs';

// 42 I6 — HOSTED DOCK TABS: the floating windows with no docked layout of their own — the
// Objects list, Statistics, the Live profiler, Chat and the AI assistant — dock as tabs on a
// wider screen the way the phone already docks the Objects list (41b H1): the window keeps its
// component, its id, its stores and its handlers, and the dock frame (PhoneDockHost.svelte, now
// the host on every posture) places the element into its body by CSS (`[data-pd-host]`).
//
// WHY HOSTING AND NOT A SECOND RENDER BRANCH PER WINDOW: the nine editors that dock each grew a
// `docked` flag and a second layout over several rounds. Five more copies of that would be five
// more chances to drift; re-seating the element is one rule, it is what the phone already ships,
// and a tab that is open but behind another one stays mounted (its state — a chat draft, a
// filter, a scroll position — survives a tab switch for free).
//
// This module owns, for the WIDE posture: which hosted windows are docked (one flag each,
// persisted per device like every editor's `<x>Docked`), their dock-tab occupancy (reported
// through phoneDock's one occupancy writer), the `dockModeArm` answer for their keys (nobody
// else consumes those keys), and the "+" menu's open/close for them. The phone keeps its own
// rule for Objects (a dock tab unless undocking is allowed); the other hosted windows are not
// dock tabs on a phone.

/** each hosted window: its element, its open state, and how it opens and closes */
/** @type {Record<string, {sel: string, ls: string, store: import('svelte/store').Readable<any>, isOpen: (v: any) => boolean, open: () => void, close: () => void}>} */
export const HOSTED = {
	objects: { sel: '#object-list', ls: 'objectListDocked', store: objectListClose, isOpen: (v) => !v, open: () => objectListClose.set(false), close: () => objectListClose.set(true) },
	stats: { sel: '#stats-window', ls: 'statsDocked', store: statsOpen, isOpen: (v) => !!v, open: () => statsOpen.set(true), close: () => statsOpen.set(false) },
	chat: { sel: '#chat-window', ls: 'chatDocked', store: chatHidden, isOpen: (v) => v === '', open: () => chatHidden.set(''), close: () => chatHidden.set('hidden') },
	aiAssistant: { sel: '#ai-assistant-window', ls: 'aiAssistantDocked', store: aiAssistantHidden, isOpen: (v) => v === '', open: () => aiAssistantHidden.set(''), close: () => aiAssistantHidden.set('hidden') },
	// 47-cc0: the free CC0 asset browser
	assets: { sel: '#asset-browser-window', ls: 'assetBrowserDocked', store: assetBrowserOpen, isOpen: (v) => !!v, open: () => assetBrowserOpen.set(true), close: () => assetBrowserOpen.set(false) }
};

function readDocked() {
	/** @type {Record<string, boolean>} */
	const out = {};
	for (const key of HOSTED_DOCK_TABS) out[key] = safeStorage.getItem(HOSTED[key].ls) === 'true';
	return out;
}

/** which hosted windows are docked on a wider screen (absent = floating, today's behaviour) */
export const hostedDocked = writable(readDocked());
hostedDocked.subscribe((v) => {
	for (const key of HOSTED_DOCK_TABS) safeStorage.setItem(HOSTED[key].ls, String(!!v[key]));
});
// a named workspace layout rewrote the flags with the rest of localStorage
onLayoutRestore(() => hostedDocked.set(readDocked()));

/** the hosted windows' open state, one map */
const hostedOpenNow = derived(
	HOSTED_DOCK_TABS.map((k) => HOSTED[k].store),
	(values) => Object.fromEntries(HOSTED_DOCK_TABS.map((k, i) => [k, HOSTED[k].isOpen(values[i])]))
);

/**
 * each hosted window's dock-tab presence in the WIDE posture: docked AND open — and not in Play: the
 * editor's dock is gone while playing, but Chat and the AI assistant live outside the editor chrome
 * (they stay usable in Play), so a docked one floats as its own window until Play ends
 */
export const hostedTabsOpen = derived([phoneShell, hostedDocked, hostedOpenNow, isLocked], ([$phone, $docked, $open, $locked]) =>
	Object.fromEntries(HOSTED_DOCK_TABS.map((k) => [k, !$phone && $locked !== true && !!$docked[k] && !!$open[k]]))
);

/** the hosted tab on screen in the wide posture (null: none, the dock minimized, or a phone) */
export const hostedDockShown = derived([phoneShell, visibleDockKey, dockMinimized, hostedTabsOpen], ([$phone, $key, $min, $open]) =>
	!$phone && !$min && $key && /** @type {any} */ ($open)[$key] ? $key : null
);

/** 44 M9: every hosted tab RENDERING in the wide posture — both halves of a split can be hosted
 *  windows (Objects / Statistics), so a single "shown" key is not enough */
export const hostedDockShownKeys = derived([phoneShell, dockShownKeys, hostedTabsOpen], ([$phone, $keys, $open]) =>
	$phone ? [] : $keys.filter((k) => /** @type {any} */ ($open)[k])
);

/** @param {string} key */
export function isHosted(key) {
	return HOSTED_DOCK_TABS.includes(key);
}

/**
 * Dock (true) or float (false) one hosted window on a wider screen. Docking opens it and shows
 * its tab; a window in a floating tab group leaves the group first (its node stays mounted, so
 * nothing else would take it out). Undocking gives up its strip slot, so a re-dock is a fresh
 * add at the end (the editors' `setDocked(false)` rule).
 * @param {string} key @param {boolean} docked
 */
export function setHostedDocked(key, docked) {
	if (!isHosted(key)) return;
	if (docked && groupOfKey(key)) removeFromGroup(key);
	hostedDocked.update((v) => (v[key] === docked ? v : { ...v, [key]: docked }));
	if (docked) {
		HOSTED[key].open();
		activateDock(key);
	} else {
		forgetDockTab(key);
		clearOfDock(key);
	}
}

/** the last pointer release (a tab dragged off the strip ends in one) */
let lastUp = { x: -1, at: 0 };
/**
 * A window leaving the dock reappears at its floating rect — which, for one that was DROPPED on the
 * strip, is right over the dock (it was parked there by the drop). Put it back clear of the dock: just
 * above the dock's top edge, and under the pointer horizontally when a drag ended a moment ago (a tab
 * pulled off the strip lands where it was pulled to). The element's own drag code reads its position
 * from the DOM when the next drag starts, so an inline move is the whole of it.
 * @param {string} key
 */
function clearOfDock(key) {
	if (typeof document === 'undefined') return;
	const dockTop = window.innerHeight - get(dockHeight) - 24; // the strip rides 24px above the dock
	requestAnimationFrame(() => {
		const el = /** @type {HTMLElement|null} */ (document.querySelector(HOSTED[key].sel));
		if (!el || el.hasAttribute('data-pd-host')) return;
		const r = el.getBoundingClientRect();
		if (!r.height || r.top < dockTop - 8) return; // already clear of the dock
		const top = Math.max(64, dockTop - r.height - 8);
		el.style.top = Math.round(top) + 'px';
		if (Date.now() - lastUp.at < 600 && lastUp.x >= 0) {
			el.style.left = Math.round(Math.min(Math.max(0, lastUp.x - 100), window.innerWidth - r.width)) + 'px';
		}
	});
}

/** open a hosted window docked and show it (the "+" row, a group's Dock button) @param {string} key */
export function dockHostedView(key) {
	setHostedDocked(key, true);
}

let started = false;
/** wire the arm consumer, the "+" registrations and the open-brings-forward rule (once) */
export function startDockHost() {
	if (started) return () => {};
	started = true;
	/** @type {(() => void)[]} */
	const offs = [];
	const onUp = (/** @type {PointerEvent} */ e) => (lastUp = { x: e.clientX, at: Date.now() });
	window.addEventListener('pointerup', onUp, true);
	offs.push(() => window.removeEventListener('pointerup', onUp, true));
	// the arm every undock / dock route asks through (the tab menu's Undock row, a tab dragged
	// out of the strip, a window dropped on the strip or the bottom edge): hosted keys have no
	// component of their own to consume it, so this module does
	offs.push(
		dockModeArm.subscribe((arm) => {
			if (!arm || !isHosted(arm.key)) return;
			// on a phone the Objects list's mode is the "Allow undocking" setting's, and the other
			// hosted windows are not dock tabs at all — leave the arm for nobody, cleared
			queueMicrotask(() => {
				if (get(dockModeArm) === arm) dockModeArm.set(null);
				if (get(phoneShell)) return;
				setHostedDocked(arm.key, arm.docked);
			});
		})
	);
	for (const key of HOSTED_DOCK_TABS) {
		offs.push(registerDockOpenState(key, () => HOSTED[key].isOpen(get(HOSTED[key].store))));
		// 44 M7: a sidebar "+" opens it FLOATING (its column then takes it) — out of the dock first
		offs.push(
			registerFloatOpener(key, () => {
				if (get(hostedDocked)[key]) setHostedDocked(key, false);
				HOSTED[key].open();
			})
		);
		// the Objects list's opener/closer are phoneDock's (posture-aware); the rest are ours
		if (PHONE_DOCK_TABS.includes(key)) continue;
		offs.push(registerDockOpener(key, () => dockHostedView(key)));
		offs.push(registerDockCloser(key, () => HOSTED[key].close()));
	}
	// a docked hosted window opened by its own button / menu row comes to the front of the dock
	for (const key of HOSTED_DOCK_TABS) {
		let was = HOSTED[key].isOpen(get(HOSTED[key].store));
		offs.push(
			HOSTED[key].store.subscribe((v) => {
				const now = HOSTED[key].isOpen(v);
				if (now && !was && !get(phoneShell) && get(hostedDocked)[key]) activateDock(key);
				was = now;
			})
		);
	}
	return () => {
		started = false;
		for (const off of offs) off();
	};
}
