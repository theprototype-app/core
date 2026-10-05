import { get } from 'svelte/store';
import { objectsGroup, pokeScene } from '../../stores/sceneStore';
import { peers } from '../../stores/appStore';
import { recordEntry } from '../history';
import { normalizeEmitter, normalizeInteraction } from './fluidEmitterCore.js';
import { normalizeFlowPath } from './flowPathCore.js';
import { applyFlowPathTo } from './flowPathObject.js';

// 36-fb F23: the ONE write path for a Fluid emitter's `userData.fluidEmitter` and a mesh's
// `userData.fluidInteraction` — the setFluidFor shape: merge, one `props` undo entry, the
// existing `objectParameters` message, a poke. The particles never travel; these do.

/** @param {string} uuid */
const objectOf = (uuid) => get(objectsGroup)?.getObjectByProperty('uuid', uuid);

/**
 * @param {string} uuid @param {any} patch shallow; `area` merges one level down
 * @returns {any | null} the new block
 */
export function setFluidEmitterFor(uuid, patch) {
	const object = objectOf(uuid);
	if (!object?.userData?.fluidEmitter) return null;
	const before = JSON.parse(JSON.stringify(object.userData.fluidEmitter));
	const merged = { ...before, ...patch };
	if (patch.area) merged.area = { ...before.area, ...patch.area };
	const next = normalizeEmitter(merged);
	object.userData.fluidEmitter = next;
	recordEntry({ kind: 'props', uuid, before: { fluidEmitter: before }, after: { fluidEmitter: next } });
	/** @type {any} */
	const peer = get(peers);
	peer?.send({ type: 'objectParameters', parameter: 'fluidEmitter', uuid, fluidEmitter: next });
	pokeScene();
	return next;
}

/**
 * How each of `uuids` meets particle fluid. 'auto' clears the key (byte-identical saves).
 * ONE undo entry per object, one message each (the wire has no batch).
 * @param {string[]} uuids @param {string} mode
 */
export function setFluidInteractionFor(uuids, mode) {
	const v = normalizeInteraction(mode);
	/** @type {any} */
	const peer = get(peers);
	let n = 0;
	for (const uuid of uuids) {
		const object = objectOf(uuid);
		if (!object) continue;
		const before = object.userData.fluidInteraction ?? null;
		const after = v === 'auto' ? null : v;
		if (before === after) continue;
		if (after) object.userData.fluidInteraction = after;
		else delete object.userData.fluidInteraction;
		recordEntry({ kind: 'props', uuid, before: { fluidInteraction: before }, after: { fluidInteraction: after } });
		peer?.send({ type: 'objectParameters', parameter: 'fluidInteraction', uuid, fluidInteraction: after });
		n++;
	}
	if (n) pokeScene();
	return n;
}

/**
 * 36-fb F24: the write path for a flow path's record (merge, rebuild, one undo entry, one
 * message). `points` replaces the list whole.
 * @param {string} uuid @param {any} patch @returns {any | null}
 */
export function setFlowPathFor(uuid, patch) {
	const object = objectOf(uuid);
	if (!object?.userData?.flowPath) return null;
	const before = JSON.parse(JSON.stringify(object.userData.flowPath));
	const next = normalizeFlowPath({ ...before, ...patch });
	applyFlowPathTo(object, next);
	recordEntry({ kind: 'props', uuid, before: { flowPath: before }, after: { flowPath: next } });
	/** @type {any} */
	const peer = get(peers);
	peer?.send({ type: 'objectParameters', parameter: 'flowPath', uuid, flowPath: next });
	pokeScene();
	return next;
}
