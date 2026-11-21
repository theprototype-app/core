// 102b-flows row 1 — OBJECT TAGS: the write path. `userData.tags` (a short list of words) is what a
// tag-picking Object Selector looks for; the behaviours runtime already read the same field
// (behaviours/app.js tagsOfObject) but nothing outside code could set it.
//
// Scene data like userData.pick: one undo entry per object (its own `tags` history kind, kept out
// of objectActions' crowded 'props' handler), the existing `objectParameters` message with
// `parameter: 'tags'`, and it rides toJSON / GLTF extras into every save. ADDITIVE: no tags = no
// field, so an object that never had any serialises byte-identically; an older build keeps the
// field it does not know and ignores it.

import { get } from 'svelte/store';
import { objectsGroup, pokeScene } from '../stores/sceneStore';
import { peers, showToast } from '../stores/appStore';
import { registerHistoryKind, registerHistoryMerge, recordEntry, sameJson, beginHistoryBatch, endHistoryBatch } from './history';
import { withWireBatch } from './wireBatch';
import { normalizeTags, normalizeTag, tagsOf } from './selectorPick.js';

/** @param {string} uuid */
function objectOf(uuid) {
	return get(objectsGroup)?.getObjectByProperty('uuid', uuid) ?? null;
}

/** apply + replicate, no history @param {any} object @param {string[] | null} tags */
function writeTags(object, tags) {
	if (tags) object.userData.tags = [...tags];
	else delete object.userData.tags;
	/** @type {any} */
	const peer = get(peers);
	peer?.send({ type: 'objectParameters', parameter: 'tags', uuid: object.uuid, tags: tags ? [...tags] : null });
	pokeScene();
}

/**
 * Set an object's whole tag list (cleaned by normalizeTags; [] / null removes the field).
 * @param {string} uuid @param {any} tags @returns {boolean} whether anything changed
 */
export function setObjectTags(uuid, tags) {
	const object = objectOf(uuid);
	if (!object) return false;
	const before = normalizeTags(tagsOf(object));
	const after = normalizeTags(tags);
	if (sameJson(before, after)) return false;
	writeTags(object, after);
	recordEntry({ kind: 'tags', uuid, before: { tags: before }, after: { tags: after } });
	return true;
}

/**
 * Add one tag to every object in `uuids` (ONE undo step and one wire batch for a set).
 * @param {string[]} uuids @param {string} tag @returns {number} how many objects changed
 */
export function addTag(uuids, tag) {
	const clean = normalizeTag(tag);
	if (!clean) return 0;
	return fan(uuids, `Tag "${clean}"`, (o) => [...tagsOf(o), clean]);
}

/**
 * Take one tag off every object in `uuids` (case-insensitive).
 * @param {string[]} uuids @param {string} tag @returns {number} how many objects changed
 */
export function removeTag(uuids, tag) {
	const want = normalizeTag(tag).toLowerCase();
	if (!want) return 0;
	return fan(uuids, `Untag "${normalizeTag(tag)}"`, (o) => tagsOf(o).filter((t) => t.toLowerCase() !== want));
}

/** @param {string[]} uuids @param {string} label @param {(o: any) => string[]} next */
function fan(uuids, label, next) {
	const list = uuids.map(objectOf).filter(Boolean);
	if (!list.length) return 0;
	let changed = 0;
	const run = () => {
		for (const o of list) if (setObjectTags(o.uuid, next(o))) changed++;
	};
	if (list.length === 1) run();
	else {
		beginHistoryBatch();
		try {
			withWireBatch(run);
		} finally {
			endHistoryBatch(`${label} (${list.length})`);
		}
	}
	return changed;
}

registerHistoryKind('tags', (entry, state) => {
	const object = objectOf(entry.uuid);
	if (!object) {
		showToast('Cannot undo/redo: the object no longer exists');
		return false;
	}
	writeTags(object, normalizeTags(state?.tags));
	return true;
});

registerHistoryMerge('tags', {
	merge(top, next) {
		if (top.uuid !== next.uuid) return false;
		top.after = next.after;
		return true;
	},
	noop: (e) => sameJson(e.before, e.after)
});
