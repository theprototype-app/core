// 100 C1 — the Cinematic view's two stores (a LEAF: svelte/store + safeStorage + the pure offer rules).
// The boot path and the lazy switch both read these, so this file stays small and imports nothing that
// reaches the rest of the app (a lazy chunk's preload list is its whole static import closure).
//
// The setting is THIS DEVICE'S: kept in safeStorage, never synced, never in the scene, never on the wire.
import { writable } from 'svelte/store';
import { safeStorage } from '../safeStorage';
import { asQuality } from './cinematicOffer.js';

const KEY = 'cinematicView';

/** @returns {{ on: boolean, quality: import('./cinematicOffer.js').Quality }} */
function load() {
	try {
		const v = JSON.parse(safeStorage.getItem(KEY) || '{}');
		return { on: v?.on === true, quality: asQuality(v?.quality) };
	} catch {
		return { on: false, quality: asQuality(null) };
	}
}

/** this device's choice (persisted locally) */
export const cinematicPrefs = writable(load());
cinematicPrefs.subscribe((p) => {
	try {
		safeStorage.setItem(KEY, JSON.stringify({ on: !!p.on, quality: asQuality(p.quality) }));
	} catch {
		/* storage refused: the choice lives for this tab */
	}
});

/**
 * What the view is doing right now.
 *  mode     off | entering | on | leaving
 *  offered  null (not asked yet) | true | false, with `why` when false
 *  quality  what runs (the asked step, capped for the window's size, lowered by the dynamic drop)
 *  dropped  how many steps the dynamic drop took (the chip says so)
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
