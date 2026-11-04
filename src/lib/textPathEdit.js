import { get } from 'svelte/store';
import { objectsGroup, pokeScene } from '../stores/sceneStore';
import { peers } from '../stores/appStore';
import { recordEntry, beginHistoryBatch, endHistoryBatch, historyBatchOpen } from './history';
import { normalizeTextPath, normalizeLetterStyle, remapLetters, MAX_STYLED } from './textPathCore.js';
import { applyTextPathTo } from './textPathObject.js';
import { textPathSourceFor } from './textPathSources.js';
import { spawnAtPoint } from './addObjects.js';
import { isSplineObject, normalizeSpline } from './splineTube';

// 64 D2: the ONE write path for `userData.textPath` — the setFlowPathFor shape: merge,
// normalize, one `props` undo entry, the existing `objectParameters` message, a poke. A scrub
// (DragRow) or a typing session is ONE undo step through the 37 R26 gesture merge. The letters
// themselves never travel: every peer lays them out from the record (textPathRuntime).

/** @param {string} uuid */
const objectOf = (uuid) => get(objectsGroup)?.getObjectByProperty('uuid', uuid);

/**
 * @param {string} uuid
 * @param {any} patch shallow; `path` merges one level down; a new `text` carries the letter
 *   styles along with their letters (remapLetters) unless the patch brings its own `letters`
 * @returns {import('./textPathCore.js').TextPathRecord | null}
 */
export function setTextPathFor(uuid, patch) {
	const object = objectOf(uuid);
	if (!object?.userData?.textPath || !patch || typeof patch !== 'object') return null;
	const before = normalizeTextPath(object.userData.textPath);
	const merged = { ...before, ...patch };
	if (patch.path) merged.path = { ...before.path, ...patch.path };
	if (typeof patch.text === 'string' && !('letters' in patch)) merged.letters = remapLetters(before.text, patch.text, before.letters);
	const next = normalizeTextPath(merged);
	if (JSON.stringify(next) === JSON.stringify(before)) return before;
	applyTextPathTo(object, next);
	recordEntry({ kind: 'props', uuid, before: { textPath: before }, after: { textPath: next } });
	/** @type {any} */
	const peer = get(peers);
	peer?.send({ type: 'objectParameters', parameter: 'textPath', uuid, textPath: next });
	pokeScene();
	return next;
}

/**
 * Style some letters (character indices): `patch` fields merge into each letter's style; a
 * field set to null goes back to "no change" (`{}` with `reset: true` clears them whole).
 * @param {string} uuid @param {number[]} indices @param {any} patch @param {{reset?: boolean}=} opts
 */
export function setLetterStyle(uuid, indices, patch, opts = {}) {
	const object = objectOf(uuid);
	if (!object?.userData?.textPath) return null;
	const rec = normalizeTextPath(object.userData.textPath);
	/** @type {Record<string, any>} */
	const letters = { ...rec.letters };
	for (const i of indices) {
		if (!Number.isInteger(i) || i < 0 || i >= rec.text.length) continue;
		const k = String(i);
		/** @type {Record<string, any>} */
		const merged = opts.reset ? {} : { ...(letters[k] ?? {}) };
		for (const [f, v] of Object.entries(patch ?? {})) {
			if (v === null || v === undefined) delete merged[f];
			else merged[f] = v;
		}
		const style = normalizeLetterStyle(merged);
		if (style) letters[k] = style;
		else delete letters[k];
	}
	if (Object.keys(letters).length > MAX_STYLED) return null;
	return setTextPathFor(uuid, { letters });
}

/** how far above a source's curve the baseline sits by default @param {any} o */
function clearanceOf(o) {
	if (isSplineObject(o)) {
		const data = normalizeSpline(o.userData.spline);
		return Math.max(0, ...data.points.map((p) => p.radius)) + 0.04;
	}
	return 0.02;
}

/**
 * "Put text on this path": a new text object linked to `targetUuid` (a spline, a flow path, a
 * registered 64-vector shape). ONE undo step for the create and the link.
 * @param {string} targetUuid @param {string=} text @returns {any | null} the text object
 */
export function putTextOnPath(targetUuid, text) {
	const target = objectOf(targetUuid);
	if (!target || !textPathSourceFor(target) || target.userData?.textPath) return null;
	target.updateWorldMatrix(true, false);
	const at = target.matrixWorld.elements;
	const own = !historyBatchOpen();
	if (own) beginHistoryBatch();
	let object = null;
	try {
		object = spawnAtPoint('/create Text', [at[12], at[13], at[14]]);
		if (object?.uuid)
			setTextPathFor(object.uuid, {
				...(typeof text === 'string' ? { text } : {}),
				path: { kind: 'object', target: targetUuid },
				align: 'start',
				offset: 0.02,
				shift: clearanceOf(target)
			});
	} finally {
		if (own) endHistoryBatch('Put text on a path');
	}
	return object;
}
