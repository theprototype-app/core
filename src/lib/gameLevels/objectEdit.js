// 93 LP1 / LP3 — the write path for a portal's / checkpoint's record: merge, normalize, ONE `props` undo entry,
// ONE `objectParameters` message (the setFlowPathFor precedent). Reaches history: load it dynamically.
import { get } from 'svelte/store';
import { objectsGroup, pokeScene } from '../../stores/sceneStore';
import { peers } from '../../stores/appStore';
import { recordEntry } from '../history';
import { normalizePortal, normalizeCheckpoint } from './objects.js';

/** @param {string} uuid @param {'portal' | 'checkpoint'} key @param {any} patch @returns {any | null} the new record */
export function setLevelObjectRecord(uuid, key, patch) {
	const object = /** @type {any} */ (get(objectsGroup))?.getObjectByProperty('uuid', uuid);
	if (!object?.userData?.[key]) return null;
	const before = JSON.parse(JSON.stringify(object.userData[key]));
	const merged = { ...before, ...patch };
	for (const [k, v] of Object.entries(patch ?? {})) if (v === null || v === '') delete merged[k];
	const next = key === 'portal' ? normalizePortal(merged) : normalizeCheckpoint(merged);
	if (JSON.stringify(next) === JSON.stringify(before)) return next;
	object.userData[key] = next;
	recordEntry({ kind: 'props', uuid, before: { [key]: before }, after: { [key]: next } });
	/** @type {any} */
	const peer = get(peers);
	peer?.send({ type: 'objectParameters', parameter: key, uuid, [key]: next });
	pokeScene();
	return next;
}
