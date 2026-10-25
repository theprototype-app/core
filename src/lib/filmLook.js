// 77 L1 — the film look at RUN time: which camera's look is on screen, and where its focus is.
//
// `Outline.svelte` decides which camera the chain renders through (the one being previewed, or
// the watched peer's) and tells this module once per change — so the DOF effect, the live look
// overrides and the Inspector all read ONE answer instead of each re-deriving it.
//
// Nothing here sends or saves: the lens is replicated scene data on the camera marker
// (`userData.camera`, written through cameraObjects.setCameraFor), and every peer computes the
// same focus from it on its own frame.

import { get } from 'svelte/store';
import * as THREE from 'three';
import { objectsGroup } from '../stores/sceneStore';

/** uuid of the camera whose look the chain renders through ('' = the editor view) */
let lookCamera = '';

/** @param {string|null|undefined} uuid */
export function setLookCamera(uuid) {
	lookCamera = typeof uuid === 'string' ? uuid : '';
}

export function lookCameraUuid() {
	return lookCamera;
}

/** the camera threlte renders with right now (Outline sets it on every swap) — tap-to-focus rays */
/** @type {any} */
let renderCamera = null;

/** @param {any} camera */
export function setRenderCamera(camera) {
	renderCamera = camera ?? null;
}

export function currentRenderCamera() {
	return renderCamera;
}

/** @param {string} uuid */
export function objectByUuid(uuid) {
	return uuid ? (/** @type {any} */ (get(objectsGroup))?.getObjectByProperty?.('uuid', uuid) ?? null) : null;
}

/** The camera marker whose look is on screen, or null. */
export function lookCameraMarker() {
	return objectByUuid(lookCamera);
}

const point = new THREE.Vector3();
const box = new THREE.Box3();

/**
 * The world point a lens keeps in focus: the tapped point on its target (stored in the
 * target's LOCAL frame, so it rides the object), else the target's bounds centre.
 * @param {{focusTarget: string, focusPoint: number[]|null}} lens @param {THREE.Vector3} out
 */
export function focusWorldPoint(lens, out) {
	const target = objectByUuid(lens.focusTarget);
	if (!target) return null;
	target.updateWorldMatrix(true, false);
	if (lens.focusPoint) return target.localToWorld(out.fromArray(lens.focusPoint));
	box.setFromObject(target);
	return box.isEmpty() ? target.getWorldPosition(out) : box.getCenter(out);
}

/**
 * The focus distance a lens asks for, in metres ALONG THE VIEW AXIS — the depth the
 * circle-of-confusion pass compares against, so an off-centre subject is sharp too.
 * NaN when the lens names no target and carries no distance, or the target is behind.
 * @param {{focus: number, focusTarget: string, focusPoint: number[]|null}} lens @param {any} viewCamera
 */
export function desiredFocus(lens, viewCamera) {
	if (lens.focusTarget && viewCamera?.matrixWorldInverse) {
		const at = focusWorldPoint(lens, point);
		if (at) {
			viewCamera.updateMatrixWorld?.();
			const depth = -at.applyMatrix4(viewCamera.matrixWorldInverse).z;
			return depth > 0.05 ? depth : NaN;
		}
	}
	return lens.focus;
}
