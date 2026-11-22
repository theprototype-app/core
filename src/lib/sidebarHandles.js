import { writable, derived, get } from 'svelte/store';
import { safeStorage } from './safeStorage';
import { onLayoutRestore } from './uiLayoutsCore';
import { deviceClass, coarsePointer } from './deviceClass.js';
import { phoneShell } from './ui/phoneShell.js';
import { SIDES, sidebarsWide, sidebarVisible, toggleSidebar } from './sidebars';

// showhide-v8 (owner 2026-11-09, R3 + "Handle icons") — THE VIEWPORT SIDEBAR HANDLES. One slim tab on each screen
// edge ("Notch": the edge with a bump toward where the column comes from) that opens / closes that side's column.
//
//   desktop (a mouse)  on by default, and drawn ONLY while its column is CLOSED (Blender's collapsed-region arrow):
//                      an open column closes by its border (drag it narrower), its shortcut or the command palette
//   unfolded phone     off by default (the side-panels button is the way there)
//   tablet             on by default, drawn open or closed (the handles replace the button)
//
// Settings ▸ Interface ▸ "Show viewport sidebar handles" (Auto / On / Off, LOCAL to this device). A handle never
// covers the logo or the profile button: it sits BELOW them (SidebarHandles measures the chrome), plus the offset
// the person dragged it to along the edge, saved per side in the named layouts (`sidebar:` keys are layout keys).
// Its menu (right-click, a long press on touch): Hide handles · Move up / down · Reset position · Dim at rest.

/** @typedef {'left'|'right'} Side */
/** @typedef {'auto'|'on'|'off'} HandlesMode */

const MODE_KEY = 'sidebarHandles';
const DIM_KEY = 'sidebarHandles:dim';
/** @param {Side} side */
const yKey = (side) => 'sidebar:handleY:' + side;
/** @param {Side} side */
const fracKey = (side) => 'sidebar:handleFrac:' + side;

const ls = typeof localStorage !== 'undefined';
/** @param {any} v @returns {HandlesMode} */
const asMode = (v) => (v === 'on' || v === 'off' ? v : 'auto');

/** the person's choice (LOCAL, persisted): 'auto' = the device's default from the table above */
export const sidebarHandlesMode = writable(/** @type {HandlesMode} */ (asMode(ls ? safeStorage.getItem(MODE_KEY) : null)));
sidebarHandlesMode.subscribe((v) => ls && safeStorage.setItem(MODE_KEY, v));

/** dim (semi-transparent) at rest, full on hover / focus (LOCAL, persisted; default on) */
export const sidebarHandlesDim = writable(!(ls && safeStorage.getItem(DIM_KEY) === 'false'));
sidebarHandlesDim.subscribe((v) => ls && safeStorage.setItem(DIM_KEY, String(!!v)));

/** @param {Side} side @returns {number} */
function readY(side) {
	const v = ls ? parseInt(safeStorage.getItem(yKey(side)) ?? '') : NaN;
	return Number.isFinite(v) ? Math.max(0, v) : 0;
}
/** @param {Side} side @returns {number|null} */
function readFrac(side) {
	const v = ls ? parseFloat(safeStorage.getItem(fracKey(side)) ?? '') : NaN;
	return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : null;
}
/** how far below its resting place (under the top chrome) each handle was dragged, px (layout-saved) */
export const sidebarHandleY = writable(/** @type {Record<Side, number>} */ ({ left: readY('left'), right: readY('right') }));
/**
 * uir-polish A2 (owner 2026-11-11): the same spot as a FRACTION of the free height it can travel (below the top
 * chrome, above the bottom margin; the dock is NOT part of it, the dock only clamps where it is drawn). A window made
 * taller or shorter moves the handle proportionally. null = no fraction recorded (a spot set in px, e.g. by an older
 * release or a test): the px offset is drawn as is.
 */
export const sidebarHandleFrac = writable(/** @type {Record<Side, number|null>} */ ({ left: readFrac('left'), right: readFrac('right') }));
/**
 * @param {Side} side @param {number} y the offset below the resting place, px
 * @param {boolean=} persist
 * @param {number=} range the free height the handle travels (px): given = also record the spot as a fraction of it
 */
export function setSidebarHandleY(side, y, persist = true, range) {
	const next = Math.max(0, Math.round(Number.isFinite(y) ? y : 0));
	sidebarHandleY.update((v) => ({ ...v, [side]: next }));
	const frac = range && range > 0 && next ? Math.min(1, next / range) : null;
	sidebarHandleFrac.update((v) => ({ ...v, [side]: frac }));
	if (persist && ls) {
		if (next) safeStorage.setItem(yKey(side), String(next));
		else safeStorage.removeItem(yKey(side));
		if (frac != null) safeStorage.setItem(fracKey(side), frac.toFixed(5));
		else safeStorage.removeItem(fracKey(side));
	}
}
/** "Reset position": back under the top chrome @param {Side} side */
export function resetSidebarHandleY(side) {
	setSidebarHandleY(side, 0);
}
/** the offset to draw for a free height of `range` px: the fraction when one is recorded, else the px offset
 *  @param {number} px @param {number|null} frac @param {number} range */
export function handleOffset(px, frac, range) {
	return frac != null && range > 0 ? Math.round(frac * range) : px;
}
onLayoutRestore(() => {
	sidebarHandleY.set({ left: readY('left'), right: readY('right') });
	sidebarHandleFrac.set({ left: readFrac('left'), right: readFrac('right') });
});

/**
 * 1.64 (owner): THE HANDLES REST BELOW THE PROFILE MENU, open or not. Clicking the profile used to move them: the open
 * menu answered the chrome measurement, the handles jumped down below it and back up when it closed. The owner liked
 * the lower place (clear of the header and the top buttons) and asked for it always, so the menu's bottom edge is a
 * floor of its own: measured whenever the menu is open, remembered here (LOCAL, persisted), and before it has ever
 * opened on this device the desktop menu's own height below its trigger (MENU_BELOW_TRIGGER, measured).
 */
const MENU_KEY = 'sidebarHandles:menuBottom';
/** px from the profile button's top to the bottom of the desktop profile menu with no cloud rows (measured 2026-11-10: the menu opens level with the button, 288 x 233; desktop 8 -> 241, tablet 60 -> 293) */
export const MENU_BELOW_TRIGGER = 233;
function readMenuBottom() {
	const v = ls ? parseInt(safeStorage.getItem(MENU_KEY) ?? '') : NaN;
	return Number.isFinite(v) && v > 0 ? v : 0;
}
/** the profile menu's bottom edge (px from the top of the screen), 0 = never measured here */
export const profileMenuBottom = writable(readMenuBottom());
/** the open menu was measured @param {number} px */
export function noteProfileMenuBottom(px) {
	const next = Math.round(px);
	if (!(next > 0) || Math.abs(next - get(profileMenuBottom)) <= 1) return;
	profileMenuBottom.set(next);
	if (ls) safeStorage.setItem(MENU_KEY, String(next));
}

/** are the handles on here: the person's choice, else the device's default (off on the unfolded phone) */
export const sidebarHandlesOn = derived([sidebarHandlesMode, deviceClass], ([$mode, $class]) => ($mode === 'auto' ? $class !== 'phone' : $mode === 'on'));

/** only while the column is closed (a mouse: the column's border closes it) or always (touch: the handle closes it too) */
export const handlesClosedOnly = derived(coarsePointer, ($coarse) => !$coarse);

/** is each side's handle drawn */
export const sidebarHandleShown = derived(
	[sidebarHandlesOn, handlesClosedOnly, sidebarsWide, phoneShell, sidebarVisible],
	([$on, $closedOnly, $wide, $phone, $vis]) => {
		/** @type {Record<Side, boolean>} */
		const out = { left: false, right: false };
		if (!$on || !$wide || $phone) return out;
		for (const side of SIDES) out[side] = $closedOnly ? !$vis[side] : true;
		return out;
	}
);

/** a handle's press: open a closed column, close an open one @param {Side} side */
export function pressSidebarHandle(side) {
	toggleSidebar(side, !get(sidebarVisible)[side]);
}

/** "Hide handles" (the handle's menu): the setting goes Off; Settings (or the toast's Undo) brings them back @returns {HandlesMode} the mode it had */
export function hideSidebarHandles() {
	const was = get(sidebarHandlesMode);
	sidebarHandlesMode.set('off');
	return was;
}
