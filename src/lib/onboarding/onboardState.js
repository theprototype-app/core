// 76 FW1 — the onboarding's LOCAL state, as a leaf (svelte/store + safeStorage only), so the
// toolbar, the logo menu and Settings can read it without joining the first-win module's imports.
//
//   onboardChoice    the Welcome card's answer ('' = never asked) — branches the flow, never sent
//   simpleUntilPlay  the progressive-disclosure switch: true only for a browser that met the new
//                    Welcome on its FIRST visit, until its first Play (or Settings ▸ Show everything).
//                    While on, the node editor / animation / pivot / click-mode buttons wait in the
//                    toolbar's "»" and the logo menu's Modules row under "More". A returning user
//                    never has it, so nobody who knows the app loses a button.

import { writable } from 'svelte/store';
import { safeStorage } from '../safeStorage';

const CHOICE_KEY = 'onboard.choice';
const SIMPLE_KEY = 'onboard.simple';

/** @param {string} key @param {string} dflt */
function stringPref(key, dflt) {
	const raw = safeStorage.getItem(key);
	const store = writable(raw === null ? dflt : raw);
	store.subscribe((v) => {
		if (v === dflt) safeStorage.removeItem(key);
		else safeStorage.setItem(key, v);
	});
	return store;
}

/** @type {import('svelte/store').Writable<string>} */
export const onboardChoice = stringPref(CHOICE_KEY, '');

const simple = stringPref(SIMPLE_KEY, '');
/** true while the advanced buttons wait behind More @type {import('svelte/store').Readable<boolean> & {set(v: boolean): void}} */
export const simpleUntilPlay = {
	subscribe: (/** @type {(v: boolean) => void} */ fn) => simple.subscribe((v) => fn(v === 'true')),
	set: (/** @type {boolean} */ on) => simple.set(on ? 'true' : '')
};

/** the bottom-bar ids that wait in "»" while `simpleUntilPlay` is on */
export const ADVANCED_TOOLBAR = Object.freeze(['flow', 'animation', 'pivot', 'mode']);

/**
 * The bar row with the advanced ids pulled out, and those ids (in row order) for the "»" menu.
 * Pure — Controls folds the rest by width as before.
 * @param {string[]} row @param {boolean} on
 * @returns {{row: string[], held: string[]}}
 */
export function holdAdvanced(row, on) {
	if (!on) return { row, held: [] };
	return {
		row: row.filter((id) => !ADVANCED_TOOLBAR.includes(id)),
		held: row.filter((id) => ADVANCED_TOOLBAR.includes(id))
	};
}
