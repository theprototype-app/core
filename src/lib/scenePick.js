// @ts-ignore - no bundled three type declarations (project-wide)
import * as THREE from 'three';
import { get } from 'svelte/store';
import { objectsGroup } from '../stores/sceneStore';
import { editingObject } from './meshEdit';
import { faceEditObject } from './faceEdit';
import { sculptObject } from './terrainSculpt';
import { ensureBoundsTrees } from './bvhPicking';

// 19-B P1: the ONE scene pick path.
//
// Every raycast into the replicated scene goes through `sceneHits` so the BVH
// bounds trees are current first (17-D3) and the object of a live edit/sculpt
// session is excluded — its geometry changes per frame, and its own tools keep
// the stock raycast path. Shared by Scene's click selection, Explorer drops and
// the snap engine, so all three see the same targets and the same acceleration.
//
// Cycle note: this module reaches terrainSculpt (-> objectActions ->
// multiTransform), which is fine only while nothing in that chain imports back
// here. Never import snapEngine/multiTransform/objectActions into scenePick.

/**
 * Raycast the replicated scene (objectsGroup), keeping the bounds trees current.
 * @param {any} raycaster a THREE.Raycaster already aimed
 * @param {{excludeUuids?: string[]}} [options] uuids whose top-level subtree is
 *   skipped (a dragged object must not snap to itself)
 * @returns {any[]} the raw intersection list, nearest first
 */
export function sceneHits(raycaster, options = {}) {
	/** @type {any} */
	const group = get(objectsGroup);
	if (!group) return [];
	const busy = /** @type {string[]} */ (
		[get(editingObject), get(faceEditObject), get(sculptObject)].filter(Boolean)
	);
	ensureBoundsTrees(group, busy);
	const excludeUuids = options.excludeUuids;
	// `getObjectByProperty` matches the child itself too, so this one test covers
	// both "is the excluded object" and "contains it" (the dropToSurface idiom).
	const targets =
		excludeUuids && excludeUuids.length > 0
			? group.children.filter(
					(/** @type {any} */ child) =>
						!excludeUuids.some((uuid) => child.getObjectByProperty('uuid', uuid))
				)
			: group.children;
	return raycaster.intersectObjects(targets, true);
}

const _hitNormalMatrix = new THREE.Matrix3();
const _hitWorldNormal = new THREE.Vector3();

/**
 * World-space normal of a raycast hit, or null when the hit carries no face.
 * Returns a CLONE: callers store these (snap candidates), and a shared temp
 * would be rewritten by the next call.
 * @param {any} hit
 * @returns {any} THREE.Vector3 | null
 */
export function hitWorldNormal(hit) {
	if (!hit?.face?.normal || !hit.object) return null;
	return _hitWorldNormal
		.copy(hit.face.normal)
		.applyNormalMatrix(_hitNormalMatrix.getNormalMatrix(hit.object.matrixWorld))
		.normalize()
		.clone();
}
