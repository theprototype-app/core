import { get } from 'svelte/store';
import { objectsGroup, pokeScene } from '../../stores/sceneStore';
import { peers } from '../../stores/appStore';
import { recordEntry } from '../history';
import { normalizeSplat } from './splatCore.js';
import { applySplatTo } from './splatObject.js';

// 102-splats: the ONE write path for `userData.splat` (the setTextPathFor shape): merge, normalize,
// one `props` undo entry, the existing `objectParameters` message, a poke. A slider scrub is ONE
// undo step through the history's gesture merge (DragRow). The bytes never travel here: the record
// names them by hash and each peer's runtime pulls them.

/** @param {string} uuid */
const objectOf = (uuid) => get(objectsGroup)?.getObjectByProperty('uuid', uuid);

/**
 * @param {string} uuid @param {Partial<import('./splatCore.js').SplatRecord>} patch shallow
 * @returns {import('./splatCore.js').SplatRecord | null}
 */
export function setSplatFor(uuid, patch) {
	const object = objectOf(uuid);
	if (!object?.userData?.splat || !patch || typeof patch !== 'object') return null;
	const before = normalizeSplat(object.userData.splat);
	const next = normalizeSplat({ ...before, ...patch });
	if (JSON.stringify(next) === JSON.stringify(before)) return before;
	applySplatTo(object, next);
	recordEntry({ kind: 'props', uuid, before: { splat: before }, after: { splat: next } });
	/** @type {any} */
	const peer = get(peers);
	peer?.send({ type: 'objectParameters', parameter: 'splat', uuid, splat: next });
	pokeScene();
	return next;
}

/**
 * Start a crop box over the whole scan (the user then pulls its faces in).
 * @param {string} uuid
 */
export function startCrop(uuid) {
	const object = objectOf(uuid);
	if (!object?.userData?.splat) return null;
	const rec = normalizeSplat(object.userData.splat);
	return setSplatFor(uuid, { crop: [...rec.bounds] });
}
