// 64-vector-edit (D5): ARRANGING flat shapes on their plane — align / distribute in the plane's own
// axes (row 2) and the layer order (row 3). A lazy chunk: the object menu reaches it by a dynamic import.
//
// ALIGN: the world-axis Align rows (47 M2) read "X min" on a shape drawn on a tilted wall as nonsense,
// so the shape rows measure and move in the ACTIVE shape's frame — its right is "left / right", its up
// "top / bottom". The arithmetic and the one-undo, one-batch commit are align.js's own (its `box` / `shift` seam).
// ORDER: see the layer-order section below.
import * as THREE from 'three';
import { get } from 'svelte/store';
import { objectsGroup, selectedObjects, pokeScene } from '../../stores/sceneStore';
import { showToast } from '../../stores/appStore';
import { alignSelection, distributeSelection } from '../align';
import { beginHistoryBatch, endHistoryBatch, historyBatchOpen } from '../history';
import { withWireBatch } from '../wireBatch';
import { applyGeometry } from '../geometryEdit';
import { heldByOther } from '../lockHeld';
import { isVectorObject } from './vectorGate.js';
import { stackOrder, reorder, layersFor, layerOnTop } from './vectorOrder.js';

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

/** measure and move in a frame (the active shape's plane): its x / y are the plane's right / up
 * @param {THREE.Matrix4} frame @returns {{box: (o: any) => any, shift: (o: any, axis: number, delta: number) => boolean}} */
function inFrame(frame) {
	const inv = frame.clone().invert();
	return {
		box(object) {
			object.updateMatrixWorld(true);
			const box = new THREE.Box3();
			const m = new THREE.Matrix4();
			object.traverse((/** @type {any} */ o) => {
				if (!o.geometry) return;
				if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
				if (o.geometry.boundingBox.isEmpty()) return;
				box.union(o.geometry.boundingBox.clone().applyMatrix4(m.multiplyMatrices(inv, o.matrixWorld)));
			});
			return box.isEmpty() ? null : { min: box.min.toArray(), max: box.max.toArray() };
		},
		shift(object, axis, delta) {
			if (Math.abs(delta) < 1e-9) return false;
			const world = object.getWorldPosition(new THREE.Vector3()).addScaledVector(new THREE.Vector3().setFromMatrixColumn(frame, axis).normalize(), delta);
			object.parent.updateMatrixWorld(true);
			object.position.copy(object.parent.worldToLocal(world));
			object.updateMatrixWorld(true);
			return true;
		}
	};
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
	return alignSelection(row[2], row[3], { uuids: shapes.map((o) => o.uuid), ...inFrame(frame), label: `Align ${row[1].toLowerCase()}` });
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
	return distributeSelection(dir === 'h' ? 'x' : 'y', 'gaps', { uuids: shapes.map((o) => o.uuid), ...inFrame(frame), label: dir === 'h' ? 'Distribute across' : 'Distribute up' });
}

/* ------------------------------------------------------------ layer order ---- */
// ROW 3: forward / backward / to front / to back for shapes on ONE plane (the active shape's plane,
// facing the same way, within STACK_TOL of it). The order is vectorOrder.js's: by height along the
// normal, then uuid. Only layers change (applyGeometry, the `geometry` message every peer knows),
// every changed shape in ONE history batch and ONE wire batch: one undo step, one burst.

/** metres between two parallel planes that still count as one stack (a 4 mm surface lift is in) */
export const STACK_TOL = 0.05;

/**
 * Every vector shape on the plane of `active` (same facing, within STACK_TOL), as stack items.
 * @param {any} active @returns {{items: import('./vectorOrder.js').StackItem[], objects: Map<string, any>}}
 */
export function stackOf(active) {
	const n = normalOf(active);
	const base0 = active.getWorldPosition(new THREE.Vector3()).dot(n);
	/** @type {import('./vectorOrder.js').StackItem[]} */
	const items = [];
	const objects = new Map();
	/** @type {any} */ (get(objectsGroup))?.traverse((/** @type {any} */ o) => {
		if (!isVectorObject(o)) return;
		if (normalOf(o).dot(n) < 1 - PARALLEL) return; // another plane direction, or facing away
		const base = o.getWorldPosition(new THREE.Vector3()).dot(n);
		if (Math.abs(base - base0) > STACK_TOL) return;
		items.push({ id: o.uuid, base, layer: o.userData.geometryParams.params?.layer ?? 0 });
		objects.set(o.uuid, o);
	});
	return { items, objects };
}

/** the four moves a menu offers: [op, label, tip] */
export const ORDER_OPS = /** @type {const} */ ([
	['front', 'Bring to front', 'Put the shapes on top of every shape on their plane'],
	['forward', 'Bring forward', 'Move the shapes one place up on their plane'],
	['backward', 'Send backward', 'Move the shapes one place down on their plane'],
	['back', 'Send to back', 'Put the shapes under every shape on their plane']
]);

/**
 * Reorder the shapes on their plane. ONE undo step for every layer that changed.
 * @param {'forward' | 'backward' | 'front' | 'back'} op @param {string[]} [uuids] @returns {number} shapes whose layer changed
 */
export function orderShapes(op, uuids) {
	const shapes = planeShapes(uuids);
	const active = shapes[shapes.length - 1];
	if (!active) {
		showToast('Order: pick a shape');
		return 0;
	}
	const { items, objects } = stackOf(active);
	const moving = shapes.map((o) => o.uuid).filter((id) => objects.has(id));
	const before = stackOrder(items);
	const after = reorder(before, moving, op);
	const layers = layersFor(items, after);
	const changed = items.filter((it) => layers.get(it.id) !== it.layer);
	if (!changed.length || before.every((id, i) => id === after[i])) {
		showToast(op === 'front' || op === 'forward' ? 'Already on top' : 'Already at the back');
		return 0;
	}
	// 80a: a shape another peer holds cannot be relayered under them
	const held = changed.find((it) => heldByOther(it.id));
	if (held) {
		showToast(`${objects.get(held.id)?.name || 'A shape'} on this plane is locked by another peer`);
		return 0;
	}
	const open = historyBatchOpen();
	if (!open) beginHistoryBatch();
	try {
		withWireBatch(() => {
			for (const it of changed) applyGeometry(it.id, { layer: layers.get(it.id) ?? 0 });
		});
	} finally {
		if (!open) endHistoryBatch(ORDER_OPS.find((r) => r[0] === op)?.[1] ?? 'Order');
	}
	pokeScene();
	return changed.length;
}

/**
 * The layer a NEW shape drawn on `object`'s plane takes so it lands on top. @param {any} object a shape on the plane
 * @param {THREE.Vector3} origin the new shape's world origin
 */
export function layerAbove(object, origin) {
	const { items } = stackOf(object);
	return layerOnTop(items, origin.dot(normalOf(object)));
}

/** suites: the stack of a shape's plane, bottom-up, with layers @param {string} uuid */
export function stackDebug(uuid) {
	const o = objectOf(uuid);
	if (!o) return [];
	const { items } = stackOf(o);
	const byId = new Map(items.map((it) => [it.id, it]));
	return stackOrder(items).map((id) => ({ uuid: id, layer: byId.get(id)?.layer ?? 0, base: byId.get(id)?.base ?? 0 }));
}
