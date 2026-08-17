// @ts-ignore - no bundled three type declarations (project-wide)
import * as THREE from 'three';
import { get } from 'svelte/store';
import { objectsGroup, globalCamera, globalRenderer } from '../stores/sceneStore';
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
 * @param {{excludeUuids?: string[], tinyProxies?: boolean}} [options]
 *   excludeUuids: uuids whose top-level subtree is skipped (a dragged object must
 *   not snap to itself). tinyProxies: also return a minimum-size hit for objects
 *   too small to raycast at all (selection only — see tinyProxyHits)
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
	const hits = raycaster.intersectObjects(targets, true);
	if (!options.tinyProxies) return hits;
	const proxies = tinyProxyHits(raycaster, targets, hits);
	if (!proxies.length) return hits;
	return [...hits, ...proxies].sort((a, b) => a.distance - b.distance);
}

// R2: an object animated (or scaled) down to nothing has no geometry left to hit,
// so a viewport click could not reach it and the object list was the only way back.
// Below a few projected pixels it gets a minimum-size hit target at its origin.
//
// SCREEN space, like the vertex handles: a world-space minimum is enormous on a
// small prop and invisible on a terrain (`vertexHandleAdaptive` is the precedent).
//
// OPT-IN (`tinyProxies`), and only Scene's selection asks for it: the snap engine
// and Explorer drops want real surfaces, and a synthetic hit carries no face — so
// their results stay byte-identical to before.

/** below this projected DIAMETER (css px) an object is unhittable in practice */
const TINY_PX = 4;
/** the click target it gets instead, as a projected diameter */
const PROXY_PX = 10;

const _proxyCentre = new THREE.Vector3();
const _proxyBox = new THREE.Box3();
const _proxySize = new THREE.Vector3();

/**
 * Synthetic hits for objects too small to raycast. One per top-level object,
 * never for something the real raycast already found.
 * @param {any} raycaster @param {any[]} targets @param {any[]} hits
 * @returns {any[]}
 */
function tinyProxyHits(raycaster, targets, hits) {
	/** @type {any} */
	const camera = get(globalCamera);
	/** @type {any} */
	const renderer = get(globalRenderer);
	const height = renderer?.domElement?.clientHeight ?? 0;
	// perspective only: the pixel-per-world factor below is a tan(fov) relation
	if (!camera?.isPerspectiveCamera || !height) return [];
	/** @type {any[]} */
	const out = [];
	const already = new Set();
	for (const hit of hits) {
		let node = hit.object;
		while (node && !targets.includes(node)) node = node.parent;
		if (node) already.add(node);
	}
	for (const object of targets) {
		if (already.has(object) || object.visible === false) continue;
		_proxyBox.setFromObject(object);
		if (_proxyBox.isEmpty()) continue;
		_proxyBox.getCenter(_proxyCentre);
		const distance = _proxyCentre.distanceTo(camera.position);
		if (!(distance > 0)) continue;
		// world units per css pixel at THIS depth
		const perPixel = (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * distance) / height;
		if (!(perPixel > 0)) continue;
		_proxyBox.getSize(_proxySize);
		const projected = Math.max(_proxySize.x, _proxySize.y, _proxySize.z) / perPixel;
		if (projected > TINY_PX) continue; // big enough to hit normally
		if (raycaster.ray.distanceToPoint(_proxyCentre) > (PROXY_PX * perPixel) / 2) continue;
		// no `face`: hitWorldNormal returns null for these, which is why snapping
		// and drops do not ask for them
		out.push({ object, distance, point: _proxyCentre.clone(), tinyProxy: true });
	}
	return out;
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
