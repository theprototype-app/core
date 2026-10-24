// 64 D3: the scene half of BOOLEANS, OUTLINE STROKE and INSET / OUTSET. Reached ONLY by dynamic
// import (the object menu, the Inspector, suites) so polygon-clipping stays a lazy chunk.
//
// Each command is ONE undo step (a history batch) built from the ordinary pieces: the subject's
// record replaced through `applyGeometry` (the `geometry` message), its position nudged by the
// re-centring offset (the `move` message + a transform entry) so nothing moves in the world, and
// the consumed shapes removed through the normal delete path. The FIRST shape is the subject: it
// keeps its look, and subtract takes the others away from it. The others' outlines are carried
// into its frame by the 2D part of inverse(subject.matrixWorld) * other.matrixWorld — which is
// only right when they lie in the subject's plane, so a shape tilted out of it is refused.
import * as THREE from 'three';
import { get } from 'svelte/store';
import { objectsGroup, pokeScene } from '../../stores/sceneStore';
import { peers, showToast } from '../../stores/appStore';
import { recordTransform, beginHistoryBatch, endHistoryBatch, historyBatchOpen } from '../history';
import { applyGeometry } from '../geometryEdit';
import { deleteObjectsByUuid, applySelectionSet } from '../objectActions';
import { booleanShapes, outlineStroke, offsetShape, BOOLEAN_OPS } from './vectorBoolean.js';
import { isVector, vectorParamsOf, addVectorShape } from './vectorActions.js';

export { BOOLEAN_OPS };
export const OP_LABELS = { union: 'Union', subtract: 'Subtract', intersect: 'Intersect', exclude: 'Exclude' };

/** how far out of the subject's plane another shape may sit (m) and how tilted (|cos|) */
const PLANE_TOL = 0.05;
const TILT_TOL = 1e-3;

/** @param {string} uuid */
const objectOf = (uuid) => get(objectsGroup)?.getObjectByProperty('uuid', uuid) ?? null;

/** the 2D affine carrying `other`'s outline into `subject`'s frame, or null when it is out of plane
 * @param {THREE.Object3D} subject @param {THREE.Object3D} other @returns {number[] | null} */
export function affineInto(subject, other) {
	subject.updateMatrixWorld(true);
	other.updateMatrixWorld(true);
	const m = subject.matrixWorld.clone().invert().multiply(other.matrixWorld);
	const e = m.elements;
	// the other's local Z must stay our Z, and its origin must sit on our plane
	const z = new THREE.Vector3(e[8], e[9], e[10]).normalize();
	if (1 - Math.abs(z.z) > TILT_TOL || Math.abs(e[14]) > PLANE_TOL) return null;
	return [e[0], e[1], e[4], e[5], e[12], e[13]];
}

/** move an object by a local (dx, dy) offset as one transform entry + one move message
 * @param {THREE.Object3D} object @param {number} dx @param {number} dy */
function shiftLocal(object, dx, dy) {
	if (!dx && !dy) return;
	const before = { pos: object.position.toArray(), rot: object.rotation.toArray(), scale: object.scale.toArray() };
	object.updateMatrixWorld(true);
	const world = new THREE.Vector3(dx, dy, 0).applyMatrix4(object.matrixWorld);
	object.position.copy(object.parent ? object.parent.worldToLocal(world) : world);
	object.updateMatrixWorld(true);
	const after = { pos: object.position.toArray(), rot: object.rotation.toArray(), scale: object.scale.toArray() };
	recordTransform({ uuid: object.uuid, before, after });
	/** @type {any} */
	const peer = get(peers);
	if (peer) peer.send({ type: 'move', uuid: object.uuid, pos: after.pos, rot: after.rot, scale: after.scale });
}

/** run `body` as one undo step @param {string} label @param {() => any} body */
function asOneStep(label, body) {
	const own = !historyBatchOpen();
	if (own) beginHistoryBatch();
	try {
		return body();
	} finally {
		if (own) endHistoryBatch(label);
		pokeScene();
	}
}

/** the vector shapes among these uuids, in order @param {string[]} uuids */
export function vectorTargets(uuids) {
	return uuids.map(objectOf).filter((o) => isVector(o));
}

/**
 * Union / subtract / intersect / exclude the shapes (the first one is the subject).
 * @param {string} op @param {string[]} uuids @returns {string | null} the result's uuid
 */
export function combineShapes(op, uuids) {
	if (!BOOLEAN_OPS.includes(op)) return null;
	const objects = vectorTargets(uuids);
	if (objects.length < 2) {
		showToast('Select two or more vector shapes');
		return null;
	}
	const [subject, ...others] = objects;
	const inputs = [{ params: /** @type {any} */ (vectorParamsOf(subject)), matrix: null }];
	for (const other of others) {
		const matrix = affineInto(subject, other);
		if (!matrix) {
			showToast(`${other.name || 'A shape'} is not in the same plane as ${subject.name || 'the first shape'}`);
			return null;
		}
		inputs.push({ params: /** @type {any} */ (vectorParamsOf(other)), matrix: /** @type {any} */ (matrix) });
	}
	let result;
	try {
		result = booleanShapes(op, inputs);
	} catch (error) {
		console.warn('vector boolean failed', error);
		showToast('That combination could not be computed');
		return null;
	}
	const label = /** @type {Record<string, string>} */ (OP_LABELS)[op];
	if (!result) {
		showToast(`${label}: nothing is left`);
		return null;
	}
	const done = /** @type {any} */ (result);
	return asOneStep(label, () => {
		applyGeometry(subject.uuid, done.params);
		shiftLocal(subject, done.cx, done.cy);
		deleteObjectsByUuid(others.map((o) => o.uuid));
		applySelectionSet([subject.uuid]);
		return subject.uuid;
	});
}

/**
 * Outline stroke: the stroke becomes a filled shape of its own. A shape with a fill keeps it
 * (its stroke goes) and the outline is added beside it; a pen line BECOMES its outline.
 * @param {string} uuid @returns {string | null} the outline's uuid
 */
export function outlineShape(uuid) {
	const object = objectOf(uuid);
	const params = vectorParamsOf(object);
	if (!object || !params) return null;
	const result = outlineStroke(params);
	if (!result) {
		showToast('This shape has no stroke to outline');
		return null;
	}
	return asOneStep('Outline stroke', () => {
		if (params.fillType === 'none') {
			applyGeometry(uuid, result.params);
			shiftLocal(object, result.cx, result.cy);
			return uuid;
		}
		applyGeometry(uuid, { strokeWidth: 0 });
		object.updateMatrixWorld(true);
		const world = new THREE.Vector3(result.cx, result.cy, 0).applyMatrix4(object.matrixWorld);
		const parent = object.parent ?? get(objectsGroup);
		const made = addVectorShape(result.params, {
			position: parent ? parent.worldToLocal(world) : world,
			quaternion: object.quaternion,
			scale: object.scale,
			name: (object.name || 'Shape') + ' outline',
			select: false
		});
		if (made) {
			applySelectionSet([made.uuid]);
		}
		return made?.uuid ?? null;
	});
}

/**
 * Inset (negative) / outset (positive) a shape's fill by `distance` metres, in place.
 * @param {string} uuid @param {number} distance @returns {boolean}
 */
export function offsetVector(uuid, distance) {
	const object = objectOf(uuid);
	const params = vectorParamsOf(object);
	if (!object || !params || !distance) return false;
	let result;
	try {
		result = offsetShape(params, distance);
	} catch (error) {
		console.warn('vector offset failed', error);
		result = null;
	}
	if (!result) {
		showToast(distance < 0 ? 'An inset that large leaves nothing' : 'This shape could not be offset');
		return false;
	}
	const done = result;
	return asOneStep(distance < 0 ? 'Inset' : 'Outset', () => {
		applyGeometry(uuid, done.params);
		shiftLocal(object, done.cx, done.cy);
		return true;
	});
}
