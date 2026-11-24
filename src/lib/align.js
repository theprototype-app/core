import * as THREE from 'three';
import { get } from 'svelte/store';
import { objectsGroup, selectedObjects, lockedObjects, pokeScene } from '../stores/sceneStore';
import { peers, showToast } from '../stores/appStore';
import { recordTransformSet } from './history';
import { withWireBatch } from './wireBatch';
import { suspendAnimation, resumeAnimation } from './flowRuntime';
import { dropToSurface } from './snapping';
import { canEditObject } from './objectPermissions';
import { reseatPivot } from './multiTransform';
import { alignDeltas, distributeDeltas, axisIndex } from './alignCore';

// 47 M2: Align / Distribute / Drop to ground over the SELECTION — the multi-select Inspector's
// Arrange section and the object menu's Transform ▸ rows. Each op is ONE undo entry (a
// `transformSet`, the kind multi-transform already undoes with) and replicates through the
// ordinary `move` path inside one wire batch, so a peer needs nothing new. The arithmetic is
// the `alignCore` leaf; this half measures world boxes, moves objects and records.

/** @typedef {{uuid: string, before: any, after: any}} TransformItem */

const AXIS_NAME = ['X', 'Y', 'Z'];

/** the editable objects named by `uuids` (default: the selection SET), in selection order —
 * an object another peer has locked or a viewer cannot edit is left where it is
 * @param {string[]} [uuids] @returns {any[]} */
export function arrangeTargets(uuids) {
	const group = get(objectsGroup);
	if (!group) return [];
	const locks = /** @type {any[]} */ (get(lockedObjects));
	const ids = uuids ?? /** @type {string[]} */ (get(selectedObjects));
	return ids
		.map((uuid) => group.getObjectByProperty('uuid', uuid))
		.filter((/** @type {any} */ o) => o && canEditObject(o) && !locks.some((lock) => lock[1] === o.uuid));
}

/** @param {any} object */
function poseOf(object) {
	return { pos: object.position.toArray(), rot: object.rotation.toArray(), scale: object.scale.toArray() };
}

/** the object's box in world metres — or, 64-vector-edit, in a FRAME's axes (a shape's own plane:
 * its x / y are the plane's right / up), measured off every mesh's own box so a rotated plane stays tight
 * @param {any} object @param {THREE.Matrix4 | null} [frame] world matrix of the frame (rotation + position)
 * @returns {{min: number[], max: number[]} | null} */
function worldBox(object, frame = null) {
	object.updateMatrixWorld(true);
	if (!frame) {
		const box = new THREE.Box3().setFromObject(object);
		return box.isEmpty() ? null : { min: box.min.toArray(), max: box.max.toArray() };
	}
	const inv = frame.clone().invert();
	const box = new THREE.Box3();
	const m = new THREE.Matrix4();
	object.traverse((/** @type {any} */ o) => {
		if (!o.geometry) return;
		if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
		if (o.geometry.boundingBox.isEmpty()) return;
		box.union(o.geometry.boundingBox.clone().applyMatrix4(m.multiplyMatrices(inv, o.matrixWorld)));
	});
	return box.isEmpty() ? null : { min: box.min.toArray(), max: box.max.toArray() };
}

/**
 * The shared tail of every op: park animated targets at their base, let `plan` measure (after
 * the park, so a mid-swing pose is never what gets aligned) and hand back the mover, move, then
 * record + replicate the whole set as ONE entry.
 * @param {any[]} objects @param {() => (object: any, i: number) => boolean} plan
 * @param {string} what for the toast
 * @returns {number} how many objects moved
 */
function commitArrange(objects, plan, what) {
	objects.forEach((object) => suspendAnimation(object.uuid));
	/** @type {TransformItem[]} */
	const items = [];
	try {
		const move = plan();
		objects.forEach((object, i) => {
			const before = poseOf(object);
			if (move(object, i)) items.push({ uuid: object.uuid, before, after: poseOf(object) });
		});
	} finally {
		objects.forEach((object) => resumeAnimation(object.uuid)); // the new spot is the new base
	}
	if (!items.length) {
		showToast(`${what}: already in place`);
		return 0;
	}
	recordTransformSet(items);
	/** @type {any} */
	const peer = get(peers);
	if (peer)
		withWireBatch(() => {
			for (const item of items)
				peer.send({ type: 'move', uuid: item.uuid, pos: item.after.pos, rot: item.after.rot, scale: item.after.scale });
		});
	if (get(selectedObjects).length > 1) reseatPivot(); // the gizmo follows the set it just moved
	pokeScene();
	showToast(`${what}: ${items.length} object${items.length === 1 ? '' : 's'} moved`);
	return items.length;
}

/** shift an object's WORLD position by `delta` on `axis` (parent-frame corrected); with a `frame`,
 * along that frame's axis instead of the world's
 * @param {any} object @param {number} axis @param {number} delta @param {THREE.Matrix4 | null} [frame] */
function shiftWorld(object, axis, delta, frame = null) {
	if (Math.abs(delta) < 1e-9) return false;
	const world = object.getWorldPosition(new THREE.Vector3());
	if (frame) {
		const dir = new THREE.Vector3().setFromMatrixColumn(frame, axis).normalize();
		world.addScaledVector(dir, delta);
	} else world.setComponent(axis, world.getComponent(axis) + delta);
	object.parent.updateMatrixWorld(true);
	object.position.copy(object.parent.worldToLocal(world));
	object.updateMatrixWorld(true);
	return true;
}

/**
 * Align the selection on one axis.
 * @param {'x'|'y'|'z'} axis @param {'min'|'center'|'max'} edge
 * @param {{to?: 'selection'|'active', uuids?: string[], frame?: THREE.Matrix4, label?: string}} [opts] `to: 'active'` lines
 *   everything up with the ACTIVE (last picked) object, which stays; default = the selection's bounds. `frame`
 *   (64-vector-edit): measure and move in that frame's axes (a shape's plane), `label` names the op in the toast
 * @returns {number} objects moved
 */
export function alignSelection(axis, edge, opts = {}) {
	const objects = arrangeTargets(opts.uuids);
	if (objects.length < 2) {
		showToast('Align: select two or more objects');
		return 0;
	}
	const a = axisIndex(axis);
	const toActive = opts.to === 'active';
	const label = opts.label ?? `Align ${AXIS_NAME[a]} ${edge === 'center' ? 'centre' : edge}${toActive ? ' to active' : ''}`;
	const frame = opts.frame ?? null;
	return commitArrange(
		objects,
		() => {
			const boxes = objects.map((o) => worldBox(o, frame));
			const keep = boxes.map((b) => !!b); // an empty group has no box: it stays put
			const deltas = alignDeltas(/** @type {any} */ (boxes.filter(Boolean)), a, edge, toActive ? keep.filter(Boolean).length - 1 : -1);
			const deltaOf = indexMap(keep, deltas);
			return (object, i) => shiftWorld(object, a, deltaOf[i], frame);
		},
		label
	);
}

/** spread deltas computed over the boxed subset back onto every object (0 for the unboxed)
 * @param {boolean[]} keep @param {number[]} deltas */
function indexMap(keep, deltas) {
	let k = 0;
	return keep.map((has) => (has ? deltas[k++] : 0));
}

/**
 * Distribute 3+ selected objects on one axis (the two outermost stay).
 * @param {'x'|'y'|'z'} axis @param {'centers'|'gaps'} mode
 * @param {{uuids?: string[], frame?: THREE.Matrix4, label?: string}} [opts] @returns {number} objects moved
 */
export function distributeSelection(axis, mode, opts = {}) {
	const objects = arrangeTargets(opts.uuids);
	if (objects.length < 3) {
		showToast('Distribute: select three or more objects');
		return 0;
	}
	const a = axisIndex(axis);
	const frame = opts.frame ?? null;
	return commitArrange(
		objects,
		() => {
			const boxes = objects.map((o) => worldBox(o, frame));
			const keep = boxes.map((b) => !!b);
			const deltaOf = indexMap(keep, distributeDeltas(/** @type {any} */ (boxes.filter(Boolean)), a, mode));
			return (object, i) => shiftWorld(object, a, deltaOf[i], frame);
		},
		opts.label ?? `Distribute ${AXIS_NAME[a]} ${mode === 'gaps' ? 'gaps' : 'centres'}`
	);
}

/**
 * Drop to ground: each object rests its bounding-box bottom on the nearest surface below it, or
 * on y = 0. Lowest first, so a stack of selected objects settles onto itself instead of every
 * piece passing through the one under it.
 * @param {{uuids?: string[]}} [opts] @returns {number} objects moved
 */
export function dropSelection(opts = {}) {
	const group = get(objectsGroup);
	const objects = arrangeTargets(opts.uuids);
	if (!objects.length || !group) {
		showToast('Drop to ground: nothing selected');
		return 0;
	}
	const order = objects
		.map((object) => ({ object, y: worldBox(object)?.min[1] ?? Infinity }))
		.sort((p, q) => p.y - q.y)
		.map((p) => p.object);
	return commitArrange(
		order,
		() => (object) => {
			const moved = dropToSurface(object, group);
			object.updateMatrixWorld(true); // the next one down-casts onto THIS pose, not the old
			return moved;
		},
		'Drop to ground'
	);
}
