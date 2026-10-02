import { get } from 'svelte/store';
import { objectsGroup, pokeScene } from '../stores/sceneStore';
import { peers } from '../stores/appStore';
import { recordEntry } from './history';
import { normalizeLodGroup, generatedGroup, withThreshold } from './lodGroupCore';
import { effectiveGroupOf } from './lodGroup';
import { canEditObject, warnViewerReadOnly } from './objectPermissions';

// 33 (K6) — THE ONE WRITE PATH for a LOD group block (`userData.lod`), the setPickThrough /
// setCameraFor shape: apply locally, ONE `props` undo entry (objectActions' `props` kind
// carries a `lod` key), ONE replicated `objectParameters {parameter: 'lod'}` message, a
// poke so the runtime (lodGroup.js) and the panel re-read. A GESTURE (a threshold drag)
// calls `previewLodGroup` per move — local only, nothing recorded or sent — and commits
// with `setLodGroup(uuid, block, {before})` on release, so a drag is one entry and one
// message (the begin/end-gesture rule every scrubbed field here keeps).

/** @param {string} uuid */
function objectOf(uuid) {
	return get(objectsGroup)?.getObjectByProperty('uuid', uuid) ?? null;
}

/** The block as it is stored now (never the implicit pack one — that was never written).
 * @param {any} object */
function storedOf(object) {
	return object?.userData?.lod ? normalizeLodGroup(object.userData.lod) : null;
}

/**
 * Write a group block. `null` removes it (back to the pack's implicit group / auto LOD).
 * `opts.before` names the state an undo returns to when a gesture already changed the
 * object locally (previewLodGroup); `opts.record: false` skips the undo entry.
 * @param {string} uuid @param {any} block @param {{before?: any, record?: boolean}} [opts]
 * @returns {boolean} whether anything changed
 */
export function setLodGroup(uuid, block, opts = {}) {
	const object = objectOf(uuid);
	if (!object) return false;
	if (!canEditObject(object)) {
		warnViewerReadOnly();
		return false;
	}
	const before = opts.before !== undefined ? normalizeLodGroup(opts.before) : storedOf(object);
	const next = block ? normalizeLodGroup(block) : null;
	if (JSON.stringify(before) === JSON.stringify(next) && JSON.stringify(storedOf(object)) === JSON.stringify(next)) return false;
	if (next) object.userData.lod = next;
	else delete object.userData.lod;
	if (opts.record !== false && JSON.stringify(before) !== JSON.stringify(next)) recordEntry({ kind: 'props', uuid, before: { lod: before }, after: { lod: next } });
	/** @type {any} */
	const peer = get(peers);
	peer?.send?.({ type: 'objectParameters', parameter: 'lod', uuid, lod: next });
	pokeScene();
	return true;
}

/** A gesture frame: write the block locally only (no undo, no message). @param {string} uuid @param {any} block */
export function previewLodGroup(uuid, block) {
	const object = objectOf(uuid);
	const next = block ? normalizeLodGroup(block) : null;
	if (!object || !next) return false;
	object.userData.lod = next;
	pokeScene();
	return true;
}

/** The block an edit starts from: the stored one, else the implicit pack one, else none.
 * @param {string} uuid */
export function editableGroupOf(uuid) {
	const object = objectOf(uuid);
	return effectiveGroupOf(object)?.block ?? null;
}

/** Force LOD: 'auto' or a level index. @param {string} uuid @param {'auto' | number} level */
export function forceLodLevel(uuid, level) {
	const block = editableGroupOf(uuid);
	if (!block) return false;
	const next = level === 'auto' ? { ...block, mode: 'auto', forced: undefined } : { ...block, mode: 'forced', forced: level };
	return setLodGroup(uuid, next);
}

/**
 * Generate levels: a meshopt level per ratio (the runtime builds them in the worker). An
 * existing group keeps its LOD0 threshold, its pack/replaced levels are REPLACED by the
 * generated set — "Generate" means "these are the levels now", one undo away from the old.
 * @param {string} uuid @param {number[]} [ratios]
 */
export function generateLodLevels(uuid, ratios = [0.5, 0.25, 0.1]) {
	const fresh = generatedGroup(ratios);
	const old = editableGroupOf(uuid);
	if (old) {
		fresh.levels[0].screenSize = old.levels[0].screenSize;
		if (old.cull) fresh.cull = true;
		if (old.bias) fresh.bias = old.bias;
	}
	return setLodGroup(uuid, fresh);
}

/** Change one level (its ratio, source, offset, material override…). `patch` keys with
 * value undefined are REMOVED. @param {string} uuid @param {number} i @param {any} patch
 * @param {{before?: any, record?: boolean, preview?: boolean}} [opts] */
export function updateLodLevel(uuid, i, patch, opts = {}) {
	const block = editableGroupOf(uuid);
	if (!block?.levels[i]) return false;
	const levels = block.levels.map((l, k) => {
		if (k !== i) return l;
		/** @type {any} */
		const next = { ...l, ...patch };
		for (const key of Object.keys(patch)) if (patch[key] === undefined) delete next[key];
		return next;
	});
	const next = { ...block, levels };
	return opts.preview ? previewLodGroup(uuid, next) : setLodGroup(uuid, next, opts);
}

/** Replace level `i`'s content with another model: an Explorer item (by content hash) or
 * another scene object (by uuid). Offset/override are kept. @param {string} uuid @param {number} i
 * @param {{source: 'explorer' | 'object' | 'generated' | 'pack', ref?: string, name?: string, ratio?: number}} with_ */
export function replaceLodLevel(uuid, i, with_) {
	if (i === 0) return false; // LOD0 is the object itself — edit it as the object
	if ((with_.source === 'explorer' || with_.source === 'object') && !with_.ref) return false;
	return updateLodLevel(uuid, i, { source: with_.source, ref: with_.ref, name: with_.name, ratio: with_.ratio });
}

/** Add a level after the last (generated at half the last level's ratio). @param {string} uuid */
export function addLodLevel(uuid) {
	const block = editableGroupOf(uuid) ?? generatedGroup([]);
	const last = block.levels[block.levels.length - 1];
	const ratio = Math.max(0.02, Number(((last.ratio ?? 1) * 0.5).toFixed(3)));
	const screenSize = Math.max(0.006, last.screenSize * 0.4);
	return setLodGroup(uuid, { ...block, levels: [...block.levels, { source: 'generated', ratio, screenSize }] });
}

/** Remove level `i` (never LOD0). A forced level past the end falls back to auto. @param {string} uuid @param {number} i */
export function removeLodLevel(uuid, i) {
	const block = editableGroupOf(uuid);
	if (!block || i <= 0 || !block.levels[i]) return false;
	const levels = block.levels.filter((_, k) => k !== i);
	if (levels.length < 2) return setLodGroup(uuid, null);
	return setLodGroup(uuid, { ...block, levels });
}

/** The bar drag: a frame moves threshold `i` locally; release commits ONE entry.
 * @param {string} uuid @param {number} i @param {number} value @param {{commit?: boolean, before?: any}} [opts] */
export function dragLodThreshold(uuid, i, value, opts = {}) {
	const block = editableGroupOf(uuid);
	if (!block) return false;
	const next = withThreshold(block, i, value);
	return opts.commit ? setLodGroup(uuid, next, { before: opts.before }) : previewLodGroup(uuid, next);
}

/** Replay for the `props` undo kind and the remote applier: write the block as given.
 * @param {any} object @param {any} lod */
export function writeLodBlock(object, lod) {
	const next = lod ? normalizeLodGroup(lod) : null;
	if (next) object.userData.lod = next;
	else delete object.userData.lod;
}
