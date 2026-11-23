// 92 (GC1 / GC2 / GC5 / GC8) — THE GAME'S MENUS AT RUN TIME: the authored rules (gameMenusCore, read
// off the scene's play block), the title screen's open state, the save slot in use and the menu's
// pause hold. A LEAF: svelte/store + the scene-settings store + appStore's toast. The heavy parts —
// the pause itself (physics, game state), the slots' storage, the title screen and the in-Play join
// card — are reached through dynamic imports or are their own lazy chunks.
import { writable, derived, get } from 'svelte/store';
import { scenePhysicsState_ } from './scenePhysics';
import { menusRules } from './gameMenusCore.js';
// the edit half (setGameMenus) and the newer-version notice live in gameMenusPlan / gameMenusRuntime (lazy)

/** the authored menus as the runtime reads them @type {import('svelte/store').Readable<ReturnType<typeof menusRules>>} */
export const gameMenus = derived(scenePhysicsState_, ($s) => menusRules($s?.play?.menus));

/* ------------------------------------------------------------------ the title screen --- */

/**
 * The title screen, LOCAL. `start` = before play on a play link / export (its Play is the gesture the
 * pointer lock wants); `play` = over editor Play (the author testing). `page` = a sub-page
 * (`settings` / `load`), '' = the buttons.
 * @type {import('svelte/store').Writable<{open: boolean, mode: 'start' | 'play', page: string}>}
 */
export const titleScreen = writable({ open: false, mode: /** @type {'start' | 'play'} */ ('play'), page: '' });

/** this play session already went past the title (a re-lock, a menu Resume must not show it again) */
let titlePassed = false;
export function titleWasPassed() {
	return titlePassed;
}
/** @param {boolean} on */
export function markTitlePassed(on) {
	titlePassed = !!on;
}

/** @param {'start' | 'play'} [mode] */
export function openTitleScreen(mode = 'play') {
	if (!get(gameMenus).title) return false;
	titleScreen.set({ open: true, mode, page: '' });
	return true;
}
export function closeTitleScreen() {
	const t = get(titleScreen);
	if (t.open || t.page) titleScreen.set({ open: false, mode: t.mode, page: '' });
}
/** @param {string} page */
export function showTitlePage(page) {
	titleScreen.update((t) => ({ ...t, page: String(page || '') }));
}

/* --------------------------------------------------------------------- the save slot --- */

/** the save slot this play session writes to (1..3), null = no slot chosen (the old single save) */
export const activeSlot = writable(/** @type {number | null} */ (null));

/* ------------------------------------------------------------------------ the pause --- */

/**
 * What the menu's pause holds right now (LOCAL): null = nothing; 'game' = the shell's round is paused
 * (shared rule, only taken alone); 'sim' = the simulation's own pause (a game with no round).
 * @type {import('svelte/store').Writable<null | 'game' | 'sim'>}
 */
export const menuPause = writable(/** @type {null | 'game' | 'sim'} */ (null));
/** the factor the audio buses are ducked by while a menu is up (1 = not ducked) */
export const menuDuck = writable(1);
/** how far the audio dips while a pause / title menu is open */
export const DUCK_LEVEL = 0.35;
/** the last time a pause was NOT taken because someone else plays (the menu says so) */
export const pauseRefused = writable(false);
