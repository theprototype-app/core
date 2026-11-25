// 100 C1 — the Cinematic view's two stores (a LEAF: svelte/store + safeStorage + the pure offer rules).
// The boot path and the lazy switch both read these, so this file stays small and imports nothing that
// reaches the rest of the app (a lazy chunk's preload list is its whole static import closure).
//
// The setting is THIS DEVICE'S: kept in safeStorage, never synced, never in the scene, never on the wire.
import { writable } from 'svelte/store';
import { safeStorage } from '../safeStorage';
import { asQuality, asLightMode } from './cinematicOffer.js';

const KEY = 'cinematicView';
const COSTS_KEY = 'cinematicCosts';

/** @typedef {import('./cinematicOffer.js').LightMode} LightMode */
/** @typedef {{ on: boolean, quality: import('./cinematicOffer.js').Quality, reflections: LightMode, globalLight: LightMode }} Prefs */

/** @param {any} v @returns {Prefs} */
function clean(v) {
	return { on: v?.on === true, quality: asQuality(v?.quality), reflections: asLightMode(v?.reflections), globalLight: asLightMode(v?.globalLight) };
}

/** @returns {Prefs} */
function load() {
	try {
		return clean(JSON.parse(safeStorage.getItem(KEY) || '{}'));
	} catch {
		return clean(null);
	}
}

/** this device's choice (persisted locally) */
export const cinematicPrefs = writable(load());
cinematicPrefs.subscribe((p) => {
	try {
		safeStorage.setItem(KEY, JSON.stringify(clean(p)));
	} catch {
		/* storage refused: the choice lives for this tab */
	}
});

/**
 * 106 S3: what Reflections and Global light measured on THIS device ({ ms, pixels } each: the frame work the pass
 * added, at that many drawn pixels), shown beside each switch once known. Kept locally like the prefs.
 * @type {import('svelte/store').Writable<{ reflections?: { ms: number, pixels: number }, globalLight?: { ms: number, pixels: number } }>}
 */
export const cinematicCosts = writable(loadCosts());
cinematicCosts.subscribe((c) => {
	try {
		safeStorage.setItem(COSTS_KEY, JSON.stringify(c));
	} catch {
		/* storage refused */
	}
});
function loadCosts() {
	try {
		const v = JSON.parse(safeStorage.getItem(COSTS_KEY) || '{}');
		/** @type {any} */
		const out = {};
		for (const k of ['reflections', 'globalLight']) if (v?.[k] && v[k].ms >= 0 && v[k].pixels > 0) out[k] = { ms: +v[k].ms, pixels: +v[k].pixels };
		return out;
	} catch {
		return {};
	}
}

/**
 * What the view is doing right now.
 *  mode     off | entering | on | leaving
 *  offered  null (not asked yet) | true | false, with `why` when false
 *  quality  what runs (the asked step, capped for the window's size, lowered by the dynamic drop)
 *  dropped  how many steps the dynamic drop took (the chip says so)
 *  off      106 S3: the switches set to On that the drop turned off ('reflections' / 'globalLight')
 *  stepped  106 S3: the step-down chip's words ('' = the drop took nothing)
 *  lighting 106 S3: what draws now ({ gi, ssr }: Global light, Reflections)
 *  notShown the chip line for what this scene draws as plain stand-ins ('' = nothing)
 *  disabled G30: the reason this session turned the view off after a failure ('' = none); the switch
 *           stays on screen, disabled, and says it
 */
export const cinematicState = writable({
	mode: /** @type {'off'|'entering'|'on'|'leaving'} */ ('off'),
	offered: /** @type {boolean|null} */ (null),
	why: '',
	quality: /** @type {import('./cinematicOffer.js').Quality} */ ('standard'),
	dropped: 0,
	off: /** @type {string[]} */ ([]),
	stepped: '',
	lighting: { gi: false, ssr: false },
	notShown: '',
	error: '',
	disabled: ''
});

/** the reason this session turned the view off after a failure ('' = none) */
export const cinematicDisabled = { reason: '' };

/**
 * Off for the rest of this session (a compile error, a lost device): the switch shows the reason, and
 * `on: false` is written so a reload does not walk into the same wall.
 * @param {string} reason
 */
export function disableCinematic(reason) {
	cinematicDisabled.reason = reason;
	cinematicPrefs.update((p) => ({ ...p, on: false }));
	cinematicState.update((s) => ({ ...s, offered: false, why: reason, disabled: reason }));
}
