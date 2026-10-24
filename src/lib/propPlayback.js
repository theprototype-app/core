// 68 — PLAYBACK of the sequencer's property tracks: write a prop track's value onto its
// target object, remember the object's authored BASE, and put it back.
//
// NETCODE (golden rule 8, deterministic): nothing here sends. Every peer evaluates the same
// replicated keys on the same synced clock and poses its own copy of the object, exactly like
// a shot's camera glide. So a posed value is LOCAL scene state that must never be saved or
// broadcast as authored: the base is captured on the first write, restored when the owning
// run ends (or the editor lets go of a scrub), and PARKED for every serializer through
// parkHooks (flowRuntime.parkAnimatedAtBase, golden rule 10).
//
// Film mode adds its live camera to `skipTargets`: while you film, the take's own tracks
// must not fight the phone for the camera.

import { get } from 'svelte/store';
import { objectsGroup, pokeScene } from '../stores/sceneStore';
import { getProp, setProp } from './propTracks';
import { registerParkHook } from './parkHooks';

/** "uuid|path" -> {uuid, path, base, owner, value} */
/** @type {Map<string, {uuid: string, path: string, base: any, owner: string, value: any}>} */
const posed = new Map();

/** Targets the player must leave alone (Film mode's live camera). LOCAL. */
export const skipTargets = new Set();

/** @param {string} uuid */
function objectOf(uuid) {
	return /** @type {any} */ (get(objectsGroup))?.getObjectByProperty?.('uuid', uuid) ?? null;
}

/**
 * Pose every value of `list` (propsAt's output) on behalf of `owner` (a run id).
 * @param {string} owner @param {{target: string, path: string, value: any}[]} list
 */
export function applyProps(owner, list) {
	let changed = false;
	for (const { target, path, value } of list) {
		if (value === null || value === undefined || skipTargets.has(target)) continue;
		const object = objectOf(target);
		if (!object) continue; // a late joiner's scene may not have it yet
		const key = target + '|' + path;
		let entry = posed.get(key);
		if (!entry) {
			const base = getProp(object, path);
			if (base === null) continue; // not allowlisted / does not apply to this object
			entry = { uuid: target, path, base, owner, value };
			posed.set(key, entry);
		}
		entry.owner = owner;
		entry.value = value;
		if (setProp(object, path, value)) changed = true;
	}
	if (changed) pokeScene();
}

/** Put back every value `owner` posed (its run ended). @param {string} owner */
export function releaseProps(owner) {
	let changed = false;
	for (const [key, entry] of [...posed]) {
		if (entry.owner !== owner) continue;
		posed.delete(key);
		const object = objectOf(entry.uuid);
		if (object && setProp(object, entry.path, entry.base)) changed = true;
	}
	if (changed) pokeScene();
}

/** Is anything posed on this object right now? @param {string} uuid */
export function isPosed(uuid) {
	for (const entry of posed.values()) if (entry.uuid === uuid) return true;
	return false;
}

/**
 * Forget a posed value WITHOUT restoring it — the object was edited for real (a take wrote
 * a new base, an undo moved it) and the current pose is now authored.
 * @param {string} uuid
 */
export function adoptBase(uuid) {
	for (const [key, entry] of [...posed]) if (entry.uuid === uuid) posed.delete(key);
}

/** test/debug view */
export function propPlaybackDebug() {
	return [...posed.values()].map((e) => ({ uuid: e.uuid, path: e.path, owner: e.owner, base: e.base, value: e.value }));
}

// every serializer parks: restore the bases, then re-apply what was showing
registerParkHook(() => {
	if (!posed.size) return null;
	const live = [...posed.values()];
	for (const e of live) {
		const object = objectOf(e.uuid);
		if (object) {
			setProp(object, e.path, e.base);
			object.updateMatrix?.();
		}
	}
	return () => {
		for (const e of live) {
			const object = objectOf(e.uuid);
			if (object && posed.get(e.uuid + '|' + e.path) === e) setProp(object, e.path, e.value);
		}
	};
});
