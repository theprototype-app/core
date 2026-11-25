// 103 H2 — PEN AND FINGERS. A LEAF (svelte/store + safeStorage): the UV editor and the model painter both ask it
// whether a finger may draw.
//
// A tablet with a pen is held with the other hand resting on, or pinching, the screen. Once this tab has seen a pen
// event, fingers stop drawing (they pan and pinch-zoom instead) — "Pen only draws", ON by default, which can be
// turned off for someone who wants to paint with a finger as well. Before any pen shows up a finger draws as
// before, so a phone without a pen loses nothing. LOCAL prefs: a fact about this device, never sent.
import { writable, get } from 'svelte/store';
import { safeStorage } from './safeStorage';

/** once a pen is seen, only the pen draws (fingers pan and zoom) */
export const penOnlyDraws = writable(safeStorage.getItem('penOnlyDraws') !== 'false');
penOnlyDraws.subscribe((v) => safeStorage.setItem('penOnlyDraws', String(v)));

/** has this tab seen a pen? (per page load: a pen's first touch switches the rule on) */
export const penSeen = writable(false);

/** note a pointer event: a pen's switches `penSeen` on @param {any} e */
export function notePointer(e) {
	if (e?.pointerType === 'pen' && !get(penSeen)) penSeen.set(true);
}

/** may this pointer draw? A pen or a mouse always; a finger unless a pen was seen and "Pen only draws" is on
 * @param {any} e */
export function mayDraw(e) {
	return e?.pointerType !== 'touch' || !(get(penSeen) && get(penOnlyDraws));
}
