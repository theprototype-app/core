// @ts-ignore - no bundled three type declarations (project-wide)
import * as THREE from 'three';

// CL-A: ONE source of truth for what an object's collider IS — consumed by BOTH
// the physics build path (physics.js) and the collider visualization
// (colliderHelpers.js), so the wireframe the user sees is what rapier gets by
// construction. Pure geometry: imports three ONLY.
//
// Frames convention (matches the physics hullDesc convention):
// - halfExtents / center: WORLD-scale dims from the object's LOCAL AABB (its
//   rotation stripped for the measure, restored after) — center is WORLD.
// - pieces[].verts: object-local verts with SCALE baked in but NOT rotation —
//   physics bakes `quat` into the verts at desc build (identity-start bodies),
//   viz applies `quat` live so the preview follows the object.

/** hull colliders bail out above this (matches physics) */
export const HULL_MAX_VERTS = 5000;
/** hard cap on stored custom-collider floats (~400 verts, replicated in userData) */
export const CUSTOM_MAX_FLOATS = 1200;

/**
 * @typedef {{ kind: 'box'|'sphere'|'capsule'|'cylinder'|'hull'|'custom',
 *   halfExtents: any, center: any, quat: any,
 *   pieces: {verts: Float32Array}[] | null, fallback: boolean }} ColliderSpec
 */

const measureBox = new THREE.Box3();
const measureSize = new THREE.Vector3();

/**
 * Measure the object's LOCAL AABB (rotation stripped, restored after) — the
 * shared shape source for every primitive collider kind.
 * @param {any} object @returns {{halfExtents: any, center: any, quat: any} | null}
 */
function measureLocalAABB(object) {
	const savedQuat = object.quaternion.clone();
	object.quaternion.set(0, 0, 0, 1);
	object.updateMatrixWorld(true);
	measureBox.setFromObject(object);
	object.quaternion.copy(savedQuat);
	object.updateMatrixWorld(true);
	if (!isFinite(measureBox.min.x)) return null; // lights/empties
	measureBox.getSize(measureSize).multiplyScalar(0.5);
	const halfExtents = new THREE.Vector3(
		Math.max(measureSize.x, 0.02),
		Math.max(measureSize.y, 0.02),
		Math.max(measureSize.z, 0.02)
	);
	// the unrotated-frame box center, swung back into the real orientation
	const center = measureBox
		.getCenter(new THREE.Vector3())
		.sub(object.position)
		.applyQuaternion(savedQuat)
		.add(object.position);
	return { halfExtents, center, quat: savedQuat };
}

/**
 * Extract scale-baked (NOT rotated) hull verts from a single mesh, or null when
 * ineligible (Groups, huge meshes) so the caller falls back to a box.
 * @param {any} object @returns {Float32Array | null}
 */
function hullVerts(object) {
	if (!object.isMesh || !object.geometry?.attributes?.position) return null;
	const position = object.geometry.attributes.position;
	if (position.count > HULL_MAX_VERTS) return null;
	const scaled = new Float32Array(position.count * 3);
	const s = object.scale;
	for (let i = 0; i < position.count; i++) {
		scaled[i * 3] = position.getX(i) * s.x;
		scaled[i * 3 + 1] = position.getY(i) * s.y;
		scaled[i * 3 + 2] = position.getZ(i) * s.z;
	}
	return scaled;
}

/**
 * Custom compound pieces from userData.physics.colliderVerts (flat local xyz,
 * capped) + colliderPieces ([[start,count]] float ranges per SHELL). Scale is
 * baked per vert; rotation stays in `quat`. Null when absent/over cap.
 * @param {any} object @returns {{verts: Float32Array}[] | null}
 */
function customPieces(object) {
	const p = object.userData?.physics;
	const flat = p?.colliderVerts;
	if (!Array.isArray(flat) || flat.length < 9 || flat.length % 3 !== 0) return null;
	if (flat.length > CUSTOM_MAX_FLOATS) return null;
	const ranges =
		Array.isArray(p.colliderPieces) && p.colliderPieces.length
			? p.colliderPieces
			: [[0, flat.length]];
	const s = object.scale;
	const pieces = [];
	for (const [start, count] of ranges) {
		if (!(count >= 9) || start < 0 || start + count > flat.length) continue;
		const verts = new Float32Array(count);
		for (let i = 0; i < count; i += 3) {
			verts[i] = flat[start + i] * s.x;
			verts[i + 1] = flat[start + i + 1] * s.y;
			verts[i + 2] = flat[start + i + 2] * s.z;
		}
		pieces.push({ verts });
	}
	return pieces.length ? pieces : null;
}

/**
 * The collider spec for an object: shape kind + dims + compound pieces.
 * `kindOverride` (the collectParams pick — node wins over userData) falls back
 * to userData.physics.collider, then 'box'. Hull/custom degrade to 'box' with
 * `fallback: true` when ineligible. Returns null for unmeasurable objects.
 * @param {any} object @param {string=} kindOverride @returns {ColliderSpec | null}
 */
export function colliderSpecOf(object, kindOverride) {
	if (!object) return null;
	const measured = measureLocalAABB(object);
	if (!measured) return null;
	let kind = kindOverride ?? object.userData?.physics?.collider ?? 'box';
	let pieces = null;
	let fallback = false;
	if (kind === 'hull') {
		const verts = hullVerts(object);
		if (verts) pieces = [{ verts }];
		else {
			kind = 'box';
			fallback = true;
		}
	} else if (kind === 'custom') {
		pieces = customPieces(object);
		if (!pieces) {
			kind = 'box';
			fallback = true;
		}
	} else if (!['box', 'sphere', 'capsule', 'cylinder'].includes(kind)) {
		kind = 'box';
	}
	return { kind, ...measured, pieces, fallback };
}
