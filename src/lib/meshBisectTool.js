// @ts-check
// Roadmap 99 K8 (lane 99-newops): the BISECT tool's BOOT SHIM — the two stores the toolbox and the overlay read,
// and thin entries that hand off to the gesture (meshBisectGesture.js, a lazy chunk loaded the moment Bisect is
// armed, so a user who never bisects never downloads it). Nothing here edits, records or sends.

import { writable } from 'svelte/store';
import { faceEditOp } from './faceEdit';

/** the rubber band while the cut line is being drawn: {from, to} client pixels, or null
 * @type {import('svelte/store').Writable<{ from: number[], to: number[] } | null>} */
export const bisectPreview = writable(null);
/** a plane is placed and waiting for Apply (the pane shows Apply / Cancel) */
export const bisectPlaced = writable(false);

/** @type {any} */ let gesture = null;
/** @type {Promise<any> | null} */ let loading = null;
const load = () => (loading ??= import('./meshBisectGesture.js').then((m) => (gesture = m)));

// arming the tool fetches the gesture, so the first click finds it loaded
faceEditOp.subscribe((op) => {
	if (op === 'bisect' && typeof window !== 'undefined') load();
});

/** one click of the armed tool @param {number[]} point client pixels */
export function bisectClick(point) {
	if (gesture) return gesture.bisectClick(point);
	load().then((m) => m.bisectClick(point));
	return 'started';
}
/** @param {number[]} point */
export function bisectHover(point) {
	gesture?.bisectHover(point);
}
export function onBisectPlaneMoved() {
	gesture?.onBisectPlaneMoved();
}
/** @returns {boolean} */
export function applyBisect() {
	return gesture ? gesture.applyBisect() : false;
}
/** @returns {boolean} */
export function cancelBisect() {
	return gesture ? gesture.cancelBisect() : false;
}
