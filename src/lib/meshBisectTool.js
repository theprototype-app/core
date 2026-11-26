// @ts-check
// Roadmap 99 K8 (lane 99-newops): the BISECT tool's FIRST half — what has to answer at once, whether or not the
// plane chunk (meshBisectGesture.js, lazy, fetched the moment Bisect is armed) has arrived yet.
// 102-boot-diet-3: this half rides the faceEdit chunk (faceEdit.js imports it), so neither boot carries it: Bisect
// is armed only inside a face session, and a session implies faceEdit is loaded. The boot reaches it the knife's
// way, `faceEditNow()?.bisectClick(…)`; its two stores live in faceEditState.js (the boot reads them). It holds:
// - the two stores the toolbox and the overlay read;
// - the first click (it only starts the rubber band) and the band following the pointer;
// - Esc (drops a pending line or plane and KEEPS the session) and Enter (applies a placed plane), in the CAPTURE
//   phase, so the session's own Escape handlers — faceEdit's window listener and the toolbox's — see a
//   `defaultPrevented` event and stand down (the knife's rule);
// - cancelling when another tool is armed or the session ends.
// The second click hands the line to the plane chunk (waiting for it if a slow link has not delivered it yet; a
// cancel in between wins). Nothing here edits, records or sends.

import { get } from 'svelte/store';
import { showToast } from '../stores/appStore';
import { faceEditOp, faceEditObject, bisectPreview, bisectPlaced } from './faceEditState';

// the two stores, re-exported (the toolbox and the plane chunk import them from here)
export { bisectPreview, bisectPlaced };

/** @type {any} */ let gesture = null;
/** @type {Promise<any> | null} */ let loading = null;
const load = () => (loading ??= import('./meshBisectGesture.js').then((m) => (gesture = m)));
/** bumped by every cancel: a second click still waiting for the chunk checks it was not cancelled meanwhile */
let epoch = 0;

/**
 * One click of the armed tool: the first starts the band, the second places the plane.
 * @param {number[]} point client pixels @returns {'started' | 'placed' | 'pending' | 'refused'}
 */
export function bisectClick(point) {
	if (!get(faceEditObject)) return 'refused';
	const pending = get(bisectPreview);
	if (!pending) {
		gesture?.dropPlane();
		bisectPreview.set({ from: point, to: point });
		showToast('Bisect: click the other end of the cut line — Esc cancels');
		load();
		return 'started';
	}
	bisectPreview.set(null);
	if (Math.hypot(point[0] - pending.from[0], point[1] - pending.from[1]) < 6) {
		showToast('Bisect: draw a longer line across the mesh');
		return 'refused';
	}
	if (gesture) return gesture.finishLine(pending.from, point) ? 'placed' : 'refused';
	const mine = epoch;
	load().then((m) => {
		if (mine === epoch && get(faceEditOp) === 'bisect') m.finishLine(pending.from, point);
	});
	return 'pending';
}

/** the band follows the pointer @param {number[]} point */
export function bisectHover(point) {
	const pending = get(bisectPreview);
	if (pending) bisectPreview.set({ ...pending, to: point });
}

/** the gizmo moved the plane (Scene's onchange for the proxy) */
export function onBisectPlaneMoved() {
	gesture?.onBisectPlaneMoved();
}

/** Apply: cut with the plane as placed. @returns {boolean} */
export function applyBisect() {
	if (!gesture || !get(bisectPlaced)) {
		showToast('Bisect: draw the cut line first (two clicks)');
		return false;
	}
	return gesture.applyBisect();
}

/** Cancel everything pending (Esc, another tool, the session ending). @returns {boolean} whether anything was */
export function cancelBisect() {
	epoch++;
	const had = !!get(bisectPreview) || get(bisectPlaced);
	bisectPreview.set(null);
	gesture?.dropPlane();
	if (get(bisectPlaced)) bisectPlaced.set(false);
	return had;
}

/** @param {KeyboardEvent} event */
function onKey(event) {
	const t = /** @type {any} */ (event.target);
	if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
	if (event.key === 'Escape') {
		if (event.defaultPrevented || !cancelBisect()) return;
		event.preventDefault();
	} else if (event.key === 'Enter' && get(bisectPlaced)) {
		event.preventDefault();
		applyBisect();
	}
}
if (typeof window !== 'undefined') window.addEventListener('keydown', onKey, true);

// arming fetches the plane chunk; the tool lives only while it is armed in a session
faceEditOp.subscribe((op) => {
	if (op === 'bisect' && typeof window !== 'undefined') load();
	else cancelBisect();
});
faceEditObject.subscribe((uuid) => {
	if (!uuid) cancelBisect();
});
