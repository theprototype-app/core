// 103 H5 / H10 — how the editor camera flies, as two LOCAL prefs (a fact about this person's hands,
// never replicated or saved). A LEAF (svelte/store + safeStorage only): editorNavigation, shortcuts,
// Scene and the viewport menu all read it, and shortcuts sits inside history's import family.
//
//  flyWithWasd  'always' (default, today)  WASD + Q / E fly whenever the viewport has the keys
//               'rmb'                      they fly only while the RIGHT mouse button is held over
//                                          the viewport (Unity's fly mode), which frees bare W / A /
//                                          S / D / Q / E for commands — the Blender preset then binds
//                                          bare S to Resize now
//  flyDirection 'level' (default, today)   W / S move along the ground plane
//               'look'                     W / S move along the view direction (look up + W climbs);
//                                          Q / E stay straight down / up in both
import { writable, get } from 'svelte/store';
import { safeStorage } from './safeStorage';

/** @param {string} key @param {string} fallback @param {string[]} allowed */
function pref(key, fallback, allowed) {
	let initial = fallback;
	try {
		const raw = typeof localStorage !== 'undefined' ? safeStorage.getItem(key) : null;
		if (raw && allowed.includes(raw)) initial = raw;
	} catch {
		/* private mode: the default */
	}
	const store = writable(initial);
	store.subscribe((value) => {
		try {
			if (typeof localStorage === 'undefined') return;
			// the default is the ABSENT key, so a person who never touched it stores nothing
			if (value === fallback) safeStorage.removeItem(key);
			else safeStorage.setItem(key, value);
		} catch {
			/* private mode */
		}
	});
	return store;
}

/** @type {import('svelte/store').Writable<string>} 'always' | 'rmb' */
export const flyWithWasd = pref('flyWithWasd', 'always', ['always', 'rmb']);
/** @type {import('svelte/store').Writable<string>} 'level' | 'look' */
export const flyDirection = pref('flyDirection', 'level', ['level', 'look']);

let rightHeld = false;
let flew = false;

/** editorNavigation: the right button went down / up over the viewport. @param {boolean} held */
export function setRightHeld(held) {
	rightHeld = !!held;
	if (held) flew = false;
}
/** @returns {boolean} */
export function rightButtonHeld() {
	return rightHeld;
}
/** a fly key moved the camera during this right-button hold (its release must not open a menu) */
export function noteFlew() {
	flew = true;
}
/** @returns {boolean} */
export function flewThisHold() {
	return flew;
}
/** Do the fly keys fly right now? (the 'rmb' mode needs the right button held) */
export function flyKeysLive() {
	return get(flyWithWasd) !== 'rmb' || rightHeld;
}
