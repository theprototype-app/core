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
 * @typedef {{ kind: 'box'|'sphere'|'capsule'|'cylinder'|'cone'|'hull'|'custom',
 *   halfExtents: any, center: any, quat: any,
 *   pieces: {verts: Float32Array}[] | null, fallback: boolean }} ColliderSpec
 */

// 15-A3: type-based DEFAULT inference — when nothing explicit is stored, a
// primitive's stamped geometryParams.gtype picks its natural shape (spheres
// roll, ramps slide) instead of the universal box. Deterministic across peers:
// derives only from replicated object data.
/** @type {Record<string, string>} */
const INFERRED_KINDS = {
	Sphere: 'sphere',
	Cylinder: 'cylinder',
	Capsule: 'capsule',
	Cone: 'cone',
	Torus: 'hull',
	TorusKnot: 'hull',
	Dodecahedron: 'hull',
	Icosahedron: 'hull',
	Octahedron: 'hull',
	Tetrahedron: 'hull',
	Lathe: 'hull',
	Tube: 'hull',
	Wedge: 'hull',
	Stairs: 'hull',
	Arch: 'hull',
	Corner: 'hull'
};
/** kinds a userData.colliderHint stamp may request (never custom/object) */
const HINT_KINDS = new Set(['box', 'sphere', 'capsule', 'cylinder', 'cone', 'hull']);
/** the baked building blocks — identified by replicated NAME in legacy scenes */
const BLOCK_NAMES = new Set(['Wedge', 'Stairs', 'Arch', 'Corner']);

/**
 * The inferred default collider kind for an object, or null when there is
 * nothing to infer (caller falls back to 'box'). Signals, in order:
 * `userData.colliderHint` (stamped at creation for the building blocks, rides
 * toJSON/GLTF extras), `userData.geometryParams.gtype` (stock primitives),
 * and the block NAME for legacy scenes (created before the hint stamp — the
 * module-KIND-from-NAME precedent; a renamed legacy block reverts to box).
 * @param {any} object @returns {string | null}
 */
export function inferredColliderKind(object) {
	if (!object) return null;
	const hint = object.userData?.colliderHint;
	if (typeof hint === 'string' && HINT_KINDS.has(hint)) return hint;
	const gtype = object.userData?.geometryParams?.gtype;
	if (gtype && INFERRED_KINDS[gtype]) return INFERRED_KINDS[gtype];
	if (BLOCK_NAMES.has(object.name)) return 'hull';
	return null;
}

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
 * to userData.physics.collider, then the type-INFERRED default (15-A3:
 * sphere→ball, wedge→hull …), then 'box'. Hull/custom degrade to 'box' with
 * `fallback: true` when ineligible. Returns null for unmeasurable objects.
 * CL-C options: `sourceObject` backs kind 'object' (hull ANOTHER object's
 * geometry onto this body); `scale` multiplies the final shape.
 * @param {any} object @param {string=} kindOverride
 * @param {{sourceObject?: any, scale?: number}=} opts @returns {ColliderSpec | null}
 */
export function colliderSpecOf(object, kindOverride, opts = {}) {
	if (!object) return null;
	const measured = measureLocalAABB(object);
	if (!measured) return null;
	let kind = kindOverride ?? object.userData?.physics?.collider ?? inferredColliderKind(object) ?? 'box';
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
	} else if (kind === 'object') {
		// CL-C: the collider node's wired source — hull its geometry (its own
		// scale baked, hull convention); the shape rides THIS object's pose
		const verts = opts.sourceObject ? hullVerts(opts.sourceObject) : null;
		if (verts) {
			pieces = [{ verts }];
			kind = 'hull';
		} else {
			kind = 'box';
			fallback = true;
		}
	} else if (!['box', 'sphere', 'capsule', 'cylinder', 'cone'].includes(kind)) {
		kind = 'box';
	}
	// CL-C: uniform shape scale (node param) — primitives scale their extents,
	// piece verts scale about the object origin
	const s = opts.scale;
	if (typeof s === 'number' && s > 0 && s !== 1) {
		measured.halfExtents.multiplyScalar(s);
		if (pieces)
			for (const piece of pieces) for (let i = 0; i < piece.verts.length; i++) piece.verts[i] *= s;
	}
	return { kind, ...measured, pieces, fallback };
}
