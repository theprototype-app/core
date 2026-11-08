import { writable, derived, readable, get } from 'svelte/store';
import { safeStorage } from './safeStorage';
import { phoneShell } from './ui/phoneShell.js';
import { SIDES, sidebarsWide, sidebarVisible, sidebarWanted, sidebarTabs, toggleSidebar } from './sidebars';

// dock-fixes item 8 (owner 2026-11-08) — THE PANELS BUTTON. "On a phone UNFOLDED / tablet the sidebars
// must always be reachable": Ctrl+B / Ctrl+Alt+B (44 M7) have no keyboard there, and a column hidden by
// its strip's hide button (item 1) left nothing on screen to bring it back. One round button in the
// top-right group, beside the profile, shows / hides BOTH sidebars:
//
//   any column on screen  -> hide every visible column (its tabs stay open and mounted — 44 M7 'hidden'),
//                            remembering WHICH sides were showing
//   none on screen        -> show the remembered sides again; with nothing remembered, every side that
//                            holds tabs; with no tabs anywhere, the right column empty with its "+"
//
// WHERE: ON by default on a touch screen wide enough for sidebars (the unfolded N6, a tablet); off on a
// mouse desktop (its shortcuts are there) and absent on a folded / narrow phone (the phone shell has no
// sidebars and keeps today's behaviour). The person can switch it either way — the button's own menu
// (right-click, or a long press on touch: "Hide this button") and Settings ▸ Interface ▸ Panels button.
// LOCAL (this device), persisted. The generic "pin / unpin every chrome button" (item 5) is a proposal;
// this is its minimal form for one button.

/** @typedef {'auto'|'on'|'off'} PanelsButtonMode */
const KEY = 'panelsButton';

/** @param {any} v @returns {PanelsButtonMode} */
const asMode = (v) => (v === 'on' || v === 'off' ? v : 'auto');

/** the person's choice (LOCAL, persisted): 'auto' = on for touch screens with sidebars */
export const panelsButtonMode = writable(/** @type {PanelsButtonMode} */ (asMode(typeof localStorage !== 'undefined' ? safeStorage.getItem(KEY) : null)));
panelsButtonMode.subscribe((v) => {
	if (typeof localStorage !== 'undefined') safeStorage.setItem(KEY, v);
});

/** a touch screen (no hover, coarse pointer) — the unfolded phone and the tablet */
const coarse = readable(false, (set) => {
	if (typeof window === 'undefined' || !window.matchMedia) return;
	const mq = window.matchMedia('(pointer: coarse)');
	set(mq.matches);
	const on = () => set(mq.matches);
	mq.addEventListener?.('change', on);
	return () => mq.removeEventListener?.('change', on);
});

/** is the button drawn: sidebars exist here (not the phone shell, not <= 640 px) and the mode says so */
export const panelsButtonShown = derived([panelsButtonMode, coarse, sidebarsWide, phoneShell], ([$mode, $coarse, $wide, $phone]) => {
	if ($phone || !$wide) return false;
	return $mode === 'on' || ($mode === 'auto' && $coarse);
});

/** is any sidebar column on screen (the button's pressed state) */
export const panelsOpen = derived(sidebarVisible, ($v) => !!($v.left || $v.right));

/** the sides that were on screen when the button hid them @type {('left'|'right')[]} */
let remembered = [];

/** the button press: hide every visible column, or bring the remembered ones back.
 * dock-fixes A': it hides every column the person ASKED for, an auto-hidden one included — hiding only the visible
 * one gave its room back and the auto-hidden one came straight back by itself. They are remembered with the visible
 * ones LAST, so bringing them back reopens those last and the free-space rule keeps the same one on screen. */
export function togglePanels() {
	const vis = get(sidebarVisible);
	const showing = SIDES.filter((s) => vis[s]);
	if (showing.length) {
		const want = get(sidebarWanted);
		const tucked = SIDES.filter((s) => want[s] && !vis[s]);
		remembered = [...tucked, ...showing];
		for (const s of remembered) toggleSidebar(s, false);
		return;
	}
	const tabs = get(sidebarTabs);
	let back = remembered.length ? remembered : SIDES.filter((s) => tabs[s].length);
	if (!back.length) back = ['right'];
	for (const s of back) toggleSidebar(s, true);
}

/** "Hide this button" (its menu) — Settings brings it back @returns {void} */
export function hidePanelsButton() {
	panelsButtonMode.set('off');
}
