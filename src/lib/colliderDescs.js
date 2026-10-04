// @ts-ignore - no bundled three type declarations (project-wide)
import * as THREE from 'three';

// 36 X2: the colliderSpec -> rapier ColliderDesc step, lifted out of physics.js so
// it is a pure function of (RAPIER, spec, frame) — the headless unit tests build
// the SAME descs into a real rapier world and drop bodies through them. Imports
// three ONLY; RAPIER is passed in (physics.js lazy-loads the wasm).

/**
 * 36 X2: trimesh flags. FIX_INTERNAL_EDGES stops a ball rolling across a flat
 * ramp from "ghost bumping" on the shared edges between its triangles (it merges
 * duplicate vertices first, which three's non-indexed extrusions need anyway).
 * Falls back to 0 on a rapier without the enum.
 * @param {any} RAPIER */
export function trimeshFlags(RAPIER) {
	return RAPIER.TriMeshFlags?.FIX_INTERNAL_EDGES ?? 0;
}

/**
 * Collider shape from the Inspector's collider pick + the object's LOCAL half
 * extents (PFX-C follow-up: sphere/capsule/cylinder join box + hull; 15-A3
 * adds cone). Capsule, cylinder and cone stand along the object's local Y;
 * sphere takes the largest extent so nothing pokes through.
 * @param {any} RAPIER @param {string|undefined} kind @param {any} he half extents
 */
export function shapeDesc(RAPIER, kind, he) {
	if (kind === 'sphere') return RAPIER.ColliderDesc.ball(Math.max(he.x, he.y, he.z));
	if (kind === 'capsule') {
		const radius = Math.max(he.x, he.z, 0.02);
		return RAPIER.ColliderDesc.capsule(Math.max(he.y - radius, 0.01), radius);
	}
	if (kind === 'cylinder') return RAPIER.ColliderDesc.cylinder(he.y, Math.max(he.x, he.z, 0.02));
	if (kind === 'cone') return RAPIER.ColliderDesc.cone(he.y, Math.max(he.x, he.z, 0.02));
	return RAPIER.ColliderDesc.cuboid(he.x, he.y, he.z);
}

const bakeVertex = new THREE.Vector3();

/**
 * The ColliderDescs for one spec, placed in a BODY frame: `origin` = the object
 * origin in body-local coords (pieces are origin-relative), `center` = the AABB
 * centre in body-local coords (primitives), `relQuat` = the object rotation in
 * the body frame. Hull/custom/trimesh pieces get `relQuat` baked into their
 * verts; primitives carry it on the desc. An empty piece list (every hull
 * degenerate) degrades to a box, exactly as the inline construction did.
 * `onHull` (36-sim buoyancy) sees each convex piece's baked verts that made a desc.
 * @param {any} RAPIER @param {any} spec colliderSpecOf result
 * @param {{origin: any, center: any, relQuat: any, onHull?: (baked: Float32Array) => void}} frame
 * @returns {any[]}
 */
export function colliderDescsFor(RAPIER, spec, frame) {
	const { origin, center, relQuat } = frame;
	/** @type {any[]} */
	const descs = [];
	if (spec.pieces) {
		for (const piece of spec.pieces) {
			const baked = new Float32Array(piece.verts.length);
			for (let i = 0; i < piece.verts.length; i += 3) {
				bakeVertex.set(piece.verts[i], piece.verts[i + 1], piece.verts[i + 2]).applyQuaternion(relQuat);
				baked[i] = bakeVertex.x;
				baked[i + 1] = bakeVertex.y;
				baked[i + 2] = bakeVertex.z;
			}
			const desc = piece.indices
				? RAPIER.ColliderDesc.trimesh(baked, piece.indices, trimeshFlags(RAPIER))
				: RAPIER.ColliderDesc.convexHull(baked);
			if (!desc) continue;
			descs.push(desc.setTranslation(origin.x, origin.y, origin.z));
			if (!piece.indices) frame.onHull?.(baked);
		}
	}
	if (!descs.length) {
		descs.push(
			shapeDesc(RAPIER, spec.pieces ? 'box' : spec.kind, spec.halfExtents)
				.setTranslation(center.x, center.y, center.z)
				.setRotation({ x: relQuat.x, y: relQuat.y, z: relQuat.z, w: relQuat.w })
		);
	}
	return descs;
}
