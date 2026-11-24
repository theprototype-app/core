// @ts-ignore - no bundled three type declarations (project-wide)
import * as THREE from 'three';
import { get } from 'svelte/store';
import { objectsGroup, pokeScene } from '../stores/sceneStore';
import { peers, showToast } from '../stores/appStore';
import { recordEntry, recordObjectPresence, beginHistoryBatch, endHistoryBatch, historyBatchOpen } from './history';
import { withWireBatch } from './wireBatch';
import { canEditObject, warnViewerReadOnly } from './objectPermissions';
import { duplicateObject, applySelectionSet } from './objectActions';
import { normalizeArray, arrayTotal, arraySummary, ARRAY_DEFAULTS } from './arrayCore.js';
import { copyPosesOf } from './arrayRuntime.js';
import { carrierRefusal } from './proxyCarrier.js'; // 102-int-2: a decal or splat has no mesh of its own to repeat
import { arraysChanged } from './arrayTick.js';

// 102b-arrange row 1 — THE ARRAY'S WRITE PATH (the Inspector's Array section, the object menu, the
// agent tool). A lazy chunk: nothing at boot reaches it.
//
// setArray: ONE `props` undo entry and ONE `objectParameters` message per edit, however many copies
// the record makes (a scrub folds into one step through DragRow's gesture). makeArrayReal: every
// copy becomes an ordinary object at exactly the pose it was drawn with — one history batch (one
// Ctrl+Z takes them all away and puts the array back) and one wire batch (one envelope to peers).

/** @param {string} uuid */
function objectOf(uuid) {
	return /** @type {any} */ (get(objectsGroup))?.getObjectByProperty('uuid', uuid) ?? null;
}

/** @param {any} object */
function editable(object) {
	if (!object) return false;
	if (!canEditObject(object)) {
		warnViewerReadOnly();
		return false;
	}
	return true;
}

/**
 * Give an object an array, change it, or (null) take it away.
 * @param {string} uuid @param {any} record a partial record merged over the current one (or the
 *   defaults), or null to remove @returns {boolean} whether anything changed
 */
export function setArray(uuid, record) {
	const object = objectOf(uuid);
	if (!editable(object)) return false;
	const carrier = record === null ? '' : carrierRefusal(object, 'repeat');
	if (carrier) {
		showToast(carrier);
		return false;
	}
	const before = object.userData.array ? normalizeArray(object.userData.array) : null;
	const next = record === null ? null : normalizeArray({ ...(before ?? ARRAY_DEFAULTS), ...record });
	if (JSON.stringify(before) === JSON.stringify(next)) return false;
	if (next) object.userData.array = next;
	else delete object.userData.array;
	recordEntry({ kind: 'props', uuid, before: { array: before }, after: { array: next } });
	/** @type {any} */
	const peer = get(peers);
	peer?.send?.({ type: 'objectParameters', parameter: 'array', uuid, array: next });
	arraysChanged();
	pokeScene();
	return true;
}

/** the array an object holds, cleaned (null when none) @param {string} uuid */
export function arrayOf(uuid) {
	const object = objectOf(uuid);
	return object?.userData?.array ? normalizeArray(object.userData.array) : null;
}

/** @param {any[]} q quaternion array → euler array (the `move` message's rot) */
function eulerOf(q) {
	return new THREE.Euler().setFromQuaternion(new THREE.Quaternion().fromArray(q)).toArray();
}

/**
 * Turn an array's copies into real objects. The object keeps its place and loses the record.
 * @param {string} uuid @returns {string[]} the new objects' uuids
 */
export function makeArrayReal(uuid) {
	const object = objectOf(uuid);
	if (!editable(object) || !object.userData.array) return [];
	const root = get(objectsGroup);
	const poses = copyPosesOf(object, root);
	if (!poses.length) {
		showToast('This array draws no copies yet');
		return [];
	}
	const rec = normalizeArray(object.userData.array);
	const own = !historyBatchOpen();
	if (own) beginHistoryBatch();
	/** @type {string[]} */
	const made = [];
	/** @type {any} */
	const peer = get(peers);
	const base = object.name || 'Object';
	try {
		withWireBatch(() => {
			// the record goes FIRST: a copy is a clone of the object (here and, from the `duplicate`
			// message, on every peer), so a source still holding the array would hand it to every copy
			setArray(uuid, null);
			poses.forEach((pose, i) => {
				const clone = duplicateObject(uuid, { select: false, history: false, at: pose.position, name: `${base} ${i + 2}` });
				if (!clone) return;
				clone.quaternion.fromArray(pose.quaternion);
				clone.scale.fromArray(pose.scale);
				clone.updateMatrixWorld(true);
				// the `duplicate` message carried the position; the turn and the size ride a `move`
				peer?.send?.({ type: 'move', uuid: clone.uuid, pos: clone.position.toArray(), rot: eulerOf(pose.quaternion), scale: clone.scale.toArray() });
				// recorded AFTER the pose is set, so a redo recreates the copy where it stands
				recordObjectPresence('create', clone);
				made.push(clone.uuid);
			});
		});
	} finally {
		if (own) endHistoryBatch('Make real objects');
	}
	if (made.length) applySelectionSet([uuid, ...made]);
	showToast(`${made.length + 1} objects made from ${rec ? arraySummary(rec) : 'the array'} (one undo)`);
	return made;
}

/** how many objects an object's array shows, itself included (0 = no array) @param {string} uuid */
export function arrayCountOf(uuid) {
	const rec = arrayOf(uuid);
	return rec ? arrayTotal(rec) : 0;
}
