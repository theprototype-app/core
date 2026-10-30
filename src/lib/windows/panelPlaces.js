// 70 W2-W5 — WHERE EACH PANEL LIVES, as a store: the LIVE pop-out layout ($lib/windows/panelLayout)
// and what the main window derives from it. A LEAF (svelte/store, safeStorage and the pure model):
// App.svelte, Menu.svelte, sidebars.js and dockMenu.js all read it, and none of them may reach the
// window host ($lib/windows/panelHost), which imports components.
//
// The layout holds ONLY windows whose popup is open (a saved layout restores by opening windows,
// one per click when the browser blocks pop-ups). While a panel is in a pop-out window
// (`$panelAway[key]`) the main window's instance of it is unmounted — one panel, one place — and it
// remounts in its own last dock / float mode when the panel comes back ("returns where it was").
//
// The host registers itself (`registerPanelHost`) so the main window's menus can ask for a pop-out
// without importing it; every call is a no-op until it has.
import { writable, derived, get } from 'svelte/store';
import { safeStorage } from '../safeStorage';
import { emptyLayout, removeTab, windowOf, poppedKeys } from './panelLayout.js';

/** @typedef {import('./panelLayout.js').Layout} Layout */

/** the live layout: every OPEN pop-out window and its tabs */
export const panelLayout = writable(/** @type {Layout} */ (emptyLayout()));

/** key -> the id of the pop-out window it lives in (absent = the main window) */
export const panelAway = derived(panelLayout, ($l) => {
	/** @type {Record<string, string>} */
	const away = {};
	for (const w of $l.windows) for (const k of w.panels) away[k] = w.id;
	return away;
});

/** is `key` in a pop-out window right now? @param {string} key */
export function isAway(key) {
	return !!windowOf(get(panelLayout), key);
}

/** every key that is popped out @returns {string[]} */
export function awayKeys() {
	return poppedKeys(get(panelLayout));
}

/** W3 — Settings ▸ Interface ▸ Windows & chrome ▸ "Always show tab strip in windows" (LOCAL) */
export const alwaysShowTabStrip = writable(safeStorage.getItem('windows:alwaysStrip') === 'true');
alwaysShowTabStrip.subscribe((v) => safeStorage.setItem('windows:alwaysStrip', String(v)));

/**
 * W4 — the panel being dragged between windows (HTML5 DnD carries only a marker type; the key
 * rides here, in the realm every window shares). Every window's header shows its drop zone while
 * this is set.
 */
export const panelDrag = writable(/** @type {{key: string, from: string|null}|null} */ (null));
/** the DataTransfer type that marks a panel drag */
export const PANEL_DRAG_TYPE = 'application/x-tp-panel';

/**
 * The panel leaves its pop-out window (it is being docked or moved in the main window, or it
 * closed). The window it empties closes (the host follows the layout). No-op when it is not away.
 * @param {string} key
 */
export function releasePanel(key) {
	if (!isAway(key)) return;
	panelLayout.update((l) => removeTab(l, key));
}

/**
 * @typedef {{
 *   popOut: (key: string, opts?: {via?: Window|null, rect?: any}) => boolean,
 *   popOutDock: (keys: string[], origin: 'bottom'|'left'|'right', active?: string|null) => boolean,
 *   moveTo: (key: string, winId: string) => void,
 *   dockBack: (key: string) => void,
 *   bringAllBack: () => void,
 *   focus: (key: string) => boolean,
 *   canPop: (key: string) => boolean,
 *   titleOf: (key: string) => string,
 *   windows: () => {id: string, title: string}[]
 * }} PanelHostApi
 */
/** @type {PanelHostApi|null} */
let host = null;
/** @param {PanelHostApi|null} api */
export function registerPanelHost(api) {
	host = api;
}

/** can `key` be popped out here (desktop, a registered panel)? @param {string} key */
export function canPopOut(key) {
	return !!host?.canPop(key);
}

/** pop `key` out into a window of its own. MUST run inside a user gesture. @param {string} key @param {{via?: Window|null, rect?: any}=} opts */
export function popOutPanel(key, opts) {
	return !!host?.popOut(key, opts);
}

/** pop a whole dock out as one tabbed window (W3). MUST run inside a user gesture. @param {string[]} keys @param {'bottom'|'left'|'right'} origin @param {string|null=} active */
export function popOutDockPanels(keys, origin, active) {
	return !!host?.popOutDock(keys, origin, active);
}

/**
 * W4 — a main-window tab (the dock strip's, a sidebar's) dragged with the pointer and released
 * OUTSIDE the main window tears off into a new window there. The press that started the drag is
 * the gesture `window.open` needs (it holds for a few seconds); a blocked one says so with Try again.
 * @param {string} key @param {{clientX: number, clientY: number, screenX: number, screenY: number}} e
 * @returns {boolean} whether it tore off (false: released inside the window, or it cannot pop out)
 */
export function tearOffAt(key, e) {
	if (typeof window === 'undefined' || !canPopOut(key)) return false;
	const outside = e.clientX < 0 || e.clientY < 0 || e.clientX > window.innerWidth || e.clientY > window.innerHeight;
	if (!outside) return false;
	popOutPanel(key, { rect: { left: e.screenX - 60, top: e.screenY - 16 } });
	return true;
}

/** "Dock back": `key` returns to the main window, where it was @param {string} key */
export function dockPanelBack(key) {
	host?.dockBack(key);
}

/** W5 — "Bring all windows back": every pop-out closes, every panel returns to the main window */
export function bringAllWindowsBack() {
	host?.bringAllBack();
}

/** raise the pop-out window `key` lives in (false: it is not away) @param {string} key */
export function focusPanelWindow(key) {
	return !!host?.focus(key);
}

/**
 * The rows a main-window menu (a dock tab's, a sidebar tab's, a floating window's header) offers
 * for `key`: "Pop out into a new window", and "Move to window ▸" + "Bring all windows back" when
 * windows are open. Empty
 * where pop-outs are not supported (W6: a phone, a coarse pointer, VR).
 * @param {string} key
 * @returns {any[]}
 */
export function popOutItems(key) {
	if (!host || !host.canPop(key)) return [];
	const title = host.titleOf(key);
	/** @type {any[]} */
	const rows = [
		{
			label: 'Pop out into a new window',
			icon: 'external-link',
			tooltip: `Open ${title} in its own browser window (drag it to another monitor)`,
			action: () => popOutPanel(key)
		}
	];
	const wins = host.windows();
	if (wins.length)
		rows.push({
			label: 'Move to window',
			icon: 'app-window',
			tooltip: `Add ${title} as a tab of an open pop-out window`,
			children: wins.map((w) => ({ label: w.title, tooltip: `Move ${title} into the "${w.title}" window`, action: () => host?.moveTo(key, w.id) }))
		});
	if (wins.length) rows.push({ label: 'Bring all windows back', icon: 'undo-2', tooltip: 'Close every pop-out window and put its panels back in the app', action: () => bringAllWindowsBack() });
	return rows;
}
