// 77 L1 — TAP TO FOCUS: arm a pick for a camera, click (or tap) the picture, and that camera
// keeps the clicked point sharp — the point is stored in the hit object's LOCAL frame, so focus
// follows the object as it (or the camera) moves. Alt-click (or `distanceOnly`) sets a plain
// distance instead. The write goes through setCameraFor (props undo + objectParameters), so
// every peer's DOF follows; the arm itself is LOCAL.
import { writable, get } from 'svelte/store';
import * as THREE from 'three';
import { objectsGroup, globalRenderer } from '../stores/sceneStore';
import { findCameraObject, isCameraObject, setCameraFor } from './cameraObjects';
import { currentRenderCamera } from './filmLook';

/** the camera a pick is armed for, or null. LOCAL. @type {import('svelte/store').Writable<string|null>} */
export const focusPickArm = writable(/** @type {string|null} */ (null));

/** @param {string} uuid */
export function armFocusPick(uuid) {
	focusPickArm.set(findCameraObject(uuid) ? uuid : null);
}

export function cancelFocusPick() {
	focusPickArm.set(null);
}

const ray = new THREE.Raycaster();
const ndc = new THREE.Vector2();

/** @param {any} object */
function pickable(object) {
	for (let node = object; node; node = node.parent) {
		if (node.visible === false || isCameraObject(node)) return false;
		if (node === get(objectsGroup)) return true;
	}
	return false;
}

/**
 * Focus camera `uuid` on whatever is under (ndcX, ndcY) of the picture on screen.
 * @param {string} uuid @param {number} ndcX -1..1 @param {number} ndcY -1..1 (up)
 * @param {{distanceOnly?: boolean}} [opts]
 * @returns {{target: string, point: number[]|null, distance: number}|null}
 */
export function focusAt(uuid, ndcX, ndcY, opts = {}) {
	const marker = findCameraObject(uuid);
	const camera = currentRenderCamera();
	const group = /** @type {any} */ (get(objectsGroup));
	if (!marker || !camera || !group) return null;
	camera.updateMatrixWorld?.();
	ray.setFromCamera(ndc.set(ndcX, ndcY), camera);
	const hit = ray.intersectObject(group, true).find((h) => pickable(h.object));
	if (!hit) return null;
	// the distance the lens will see: along the MARKER's view axis (the camera being focused)
	const view = new THREE.Vector3().copy(hit.point);
	marker.updateWorldMatrix(true, false);
	const depth = -marker.worldToLocal(view).z;
	if (opts.distanceOnly || !(depth > 0)) {
		const distance = Math.max(0.05, depth > 0 ? depth : hit.distance);
		setCameraFor(uuid, { focus: Math.round(distance * 1000) / 1000, focusTarget: '', focusPoint: null });
		return { target: '', point: null, distance };
	}
	const local = hit.object.worldToLocal(hit.point.clone()).toArray().map((n) => Math.round(n * 1e4) / 1e4);
	setCameraFor(uuid, { focusTarget: hit.object.uuid, focusPoint: local, focus: Math.round(depth * 1000) / 1000 });
	return { target: hit.object.uuid, point: local, distance: depth };
}

/** Client coords → the picture's NDC (the canvas rect). @param {number} x @param {number} y */
export function clientToNdc(x, y) {
	const canvas = /** @type {any} */ (get(globalRenderer))?.domElement;
	const rect = canvas?.getBoundingClientRect?.();
	if (!rect || !rect.width || !rect.height) return null;
	return { x: ((x - rect.left) / rect.width) * 2 - 1, y: -((y - rect.top) / rect.height) * 2 + 1 };
}
