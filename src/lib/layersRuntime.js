import { writable, get } from 'svelte/store';
import { objectsGroup, sceneRevision, isLocked } from '../stores/sceneStore';
import { registerParkHook } from './parkHooks.js';

// 102b-arrange row 2 — HIDE A LAYER ON THIS SCREEN (a lazy chunk: loaded the first time someone hides
// a layer). Hiding is LOCAL: nothing is sent, and a hidden layer never reaches a save — a park hook
// shows the objects again for the moment a serializer reads the scene (golden rule 10's ritual), so a
// file saved here, an autosave or a joiner's full sync carries every object's own visibility. Play
// shows everything (you test the game you made, not your tidy view).
//
// Only what THIS module hid comes back: an object somebody hid with its own eye stays hidden.

/** @type {import('svelte/store').Writable<Set<string>>} the layer ids hidden on this screen */
export const hiddenLayers = writable(new Set());
/** @type {Set<any>} objects this module hid */
const hiddenByUs = new Set();

function reconcile() {
	const group = /** @type {any} */ (get(objectsGroup));
	const hidden = get(hiddenLayers);
	const playing = get(isLocked) === true;
	/** @type {Set<any>} */
	const want = new Set();
	if (group && hidden.size && !playing)
		group.traverse((/** @type {any} */ o) => {
			if (o !== group && o.userData?.layer && hidden.has(o.userData.layer)) want.add(o);
		});
	for (const o of hiddenByUs) {
		if (want.has(o)) continue;
		hiddenByUs.delete(o);
		if (o.visible === false) o.visible = true;
	}
	for (const o of want) {
		if (hiddenByUs.has(o) || o.visible === false) continue; // already hidden by its own eye
		o.visible = false;
		hiddenByUs.add(o);
	}
}

sceneRevision.subscribe(reconcile);
hiddenLayers.subscribe(reconcile);
isLocked.subscribe(reconcile);

registerParkHook(() => {
	if (!hiddenByUs.size) return null;
	const list = [...hiddenByUs];
	for (const o of list) o.visible = true;
	return () => {
		for (const o of list) if (hiddenByUs.has(o)) o.visible = false;
	};
});

/** hide or show one layer on this screen @param {string} id @param {boolean} hide */
export function setLayerHidden(id, hide) {
	hiddenLayers.update((s) => {
		const next = new Set(s);
		if (hide) next.add(id);
		else next.delete(id);
		return next;
	});
}

/** how many objects are hidden here right now (debug + suites) */
export function layersHiddenCount() {
	return hiddenByUs.size;
}
