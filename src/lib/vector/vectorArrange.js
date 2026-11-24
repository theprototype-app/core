// 64-vector-edit (D5): ARRANGING flat shapes on their plane — align / distribute in the plane's own
// axes (row 2) and the layer order (row 3). A lazy chunk: the object menu reaches it by a dynamic import.
//
// ALIGN: the world-axis Align rows (47 M2) read "X min" on a shape drawn on a tilted wall as nonsense,
// so the shape rows measure and move in the ACTIVE shape's frame — its right is "left / right", its up
// "top / bottom". The arithmetic and the one-undo, one-batch commit are align.js's own (`frame`).
import * as THREE from 'three';
import { get } from 'svelte/store';
import { objectsGroup, selectedObjects } from '../../stores/sceneStore';
import { showToast } from '../../stores/appStore';
import { alignSelection, distributeSelection } from '../align';
import { isVectorObject } from './vectorGate.js';

/** normals closer than this (1 - cos) count as one plane direction */
const PARALLEL = 1e-3;

/** @param {string} uuid */
function objectOf(uuid) {
	return /** @type {any} */ (get(objectsGroup))?.getObjectByProperty('uuid', uuid) ?? null;
}

/** a shape's plane frame: its world position and rotation, no scale @param {any} object */
export function planeFrameOf(object) {
	object.updateMatrixWorld(true);
	const p = new THREE.Vector3();
	const q = new THREE.Quaternion();
	const s = new THREE.Vector3();
	object.matrixWorld.decompose(p, q, s);
	return new THREE.Matrix4().compose(p, q, new THREE.Vector3(1, 1, 1));
}

/** a shape's world normal (+Z of its frame) @param {any} object */
export function normalOf(object) {
	object.updateMatrixWorld(true);
	return new THREE.Vector3().setFromMatrixColumn(object.matrixWorld, 2).normalize();
}

/**
 * The vector shapes among `uuids` (default the selection) whose plane is parallel to the ACTIVE one's
 * (the last picked), active last. @param {string[]} [uuids] @returns {any[]}
 */
export function planeShapes(uuids) {
	const ids = uuids ?? /** @type {string[]} */ (get(selectedObjects));
	const shapes = ids.map(objectOf).filter(isVectorObject);
	const active = shapes[shapes.length - 1];
	if (!active) return [];
	const n = normalOf(active);
	return shapes.filter((o) => 1 - Math.abs(normalOf(o).dot(n)) < PARALLEL);
}

/** the align rows a menu offers: [id, label, frame axis, edge] */
export const PLANE_ALIGN = /** @type {const} */ ([
	['left', 'Left', 'x', 'min'],
	['hcentre', 'Centre', 'x', 'center'],
	['right', 'Right', 'x', 'max'],
	['top', 'Top', 'y', 'max'],
	['vcentre', 'Middle', 'y', 'center'],
	['bottom', 'Bottom', 'y', 'min']
]);

/**
 * Align the shapes in their plane, to the selection's bounds. One undo entry.
 * @param {string} id a PLANE_ALIGN id @param {string[]} [uuids] @returns {number} shapes moved
 */
export function alignInPlane(id, uuids) {
	const row = PLANE_ALIGN.find((r) => r[0] === id);
	const shapes = planeShapes(uuids);
	if (!row || shapes.length < 2) {
		showToast('Align: pick two or more shapes on one plane');
		return 0;
	}
	const frame = planeFrameOf(shapes[shapes.length - 1]);
	return alignSelection(row[2], row[3], { uuids: shapes.map((o) => o.uuid), frame, label: `Align ${row[1].toLowerCase()}` });
}

/**
 * Distribute 3+ shapes across (h) or up (v) their plane, equal gaps. One undo entry.
 * @param {'h' | 'v'} dir @param {string[]} [uuids] @returns {number} shapes moved
 */
export function distributeInPlane(dir, uuids) {
	const shapes = planeShapes(uuids);
	if (shapes.length < 3) {
		showToast('Distribute: pick three or more shapes on one plane');
		return 0;
	}
	const frame = planeFrameOf(shapes[shapes.length - 1]);
	return distributeSelection(dir === 'h' ? 'x' : 'y', 'gaps', { uuids: shapes.map((o) => o.uuid), frame, label: dir === 'h' ? 'Distribute across' : 'Distribute up' });
}
