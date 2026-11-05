// phone-polish item 3 — TOUCH SIZE (Settings ▸ Interface ▸ Appearance, beside Density).
//
// The HONOR touch audit measured most controls at 20-32 px against a 44 px touch guideline, and
// the phone tokens (styles/tokens.css, 44 px targets) only switch on UNDER 640 px — an unfolded
// foldable or a tablet is a touch screen at desktop width and got the mouse-sized chrome. This is
// one root attribute, `<html data-touch-ui>`, that styles/touch-density.css keys every larger
// control off (40-44 px buttons/fields/tabs, taller dock and sidebar strips, 44 px menu rows).
//
//   auto      on for a coarse pointer (the default) — follows the pointer live (a tablet's
//             keyboard cover, a mouse plugged into a phone)
//   touch     always on (a touch laptop with a trackpad reports fine)
//   standard  always off (the old chrome, also on a phone above 640 px)
// Saved per DEVICE (LOCAL, like Theme and Density). `?density=touch|compact|auto` in the URL SETS
// it on this device — the switch the owner flips while trying it on the phone (compact = standard).
// static/boot-prefs.js applies the saved value before first paint; this module takes over after.
// A LEAF: svelte/store + safeStorage.
import { writable, get } from 'svelte/store';
import { safeStorage } from './safeStorage';

export const TOUCH_SIZE_KEY = 'ui:touchSize';
export const DEFAULT_TOUCH_SIZE = 'auto';
export const TOUCH_SIZES = [
	{ value: 'auto', label: 'Auto' },
	{ value: 'touch', label: 'Large' },
	{ value: 'standard', label: 'Standard' }
];

/** @param {unknown} v @returns {'auto'|'touch'|'standard'} */
export function normalizeTouchSize(v) {
	return v === 'touch' || v === 'standard' ? v : 'auto';
}

/** the URL switch: `?density=touch|compact|auto` → a setting, or null when absent/unknown
 * @param {string} search @returns {'auto'|'touch'|'standard'|null} */
export function touchSizeFromUrl(search) {
	let v = '';
	try {
		v = new URLSearchParams(search).get('density') ?? '';
	} catch {
		return null;
	}
	if (v === 'touch' || v === 'large') return 'touch';
	if (v === 'compact' || v === 'standard') return 'standard';
	if (v === 'auto') return 'auto';
	return null;
}

/** is the large chrome on? @param {string} pref @param {boolean} coarse */
export function touchUiOn(pref, coarse) {
	const p = normalizeTouchSize(pref);
	return p === 'touch' || (p === 'auto' && coarse);
}

/** @param {boolean} on @param {HTMLElement} [root] */
export function applyTouchUi(on, root = document.documentElement) {
	if (on) root.dataset.touchUi = '';
	else delete root.dataset.touchUi;
}

const fromUrl = typeof location === 'undefined' ? null : touchSizeFromUrl(location.search);
if (fromUrl) {
	if (fromUrl === DEFAULT_TOUCH_SIZE) safeStorage.removeItem(TOUCH_SIZE_KEY);
	else safeStorage.setItem(TOUCH_SIZE_KEY, fromUrl);
}

/** 'auto' | 'touch' | 'standard' */
export const touchSize = writable(normalizeTouchSize(fromUrl ?? safeStorage.getItem(TOUCH_SIZE_KEY)));

const mq = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(pointer: coarse)') : null;
/** live: is the primary pointer coarse? */
export const coarseNow = writable(!!mq?.matches);
mq?.addEventListener?.('change', (e) => coarseNow.set(e.matches));

/** the effective state (true = the large chrome is on) */
export const touchUi = writable(touchUiOn(get(touchSize), get(coarseNow)));
const recompute = () => touchUi.set(touchUiOn(get(touchSize), get(coarseNow)));
coarseNow.subscribe(recompute);
touchSize.subscribe((v) => {
	const p = normalizeTouchSize(v);
	// the default is an ABSENT key, so a fresh device and a reset read the same
	if (p === DEFAULT_TOUCH_SIZE) safeStorage.removeItem(TOUCH_SIZE_KEY);
	else safeStorage.setItem(TOUCH_SIZE_KEY, p);
	recompute();
});
touchUi.subscribe((on) => {
	if (typeof document !== 'undefined') applyTouchUi(on);
});
