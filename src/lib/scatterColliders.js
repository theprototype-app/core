// @ts-ignore - no bundled three type declarations (project-wide)
import * as THREE from 'three';
import { ConvexHull } from 'three/addons/math/ConvexHull.js';

// 48 B1 — COLLIDERS FOR SCATTER SETS. A set's `collider` (box / sphere / hull, terrainScatterCore)
// turns every instance it draws into a STATIC rapier collider while a simulation runs. Pure:
// three + the RAPIER namespace passed in (physics.js lazy-loads the wasm), so the unit suite
// builds the SAME descs into a real headless world and drops a ball on a scattered rock — the
// colliderDescs.js shape.
//
// ONE SHAPE PER SET, measured once from the parts the set draws (a primitive, or every mesh of a
// Library model in the model's own frame, base at y 0): its local AABB (box), its bounding sphere
// (sphere) or its convex hull's vertices (hull — three's ConvexHull runs ONCE per set, so rapier
// hulls a few dozen points per instance instead of the whole model 2,000 times). Each instance
// then places that shape by its world matrix: the instance's scale is baked into the extents /
// radius / hull points (rapier shapes carry no scale), its rotation and position ride the desc.
// Nothing here is stored or sent — every peer derives the same colliders from the replicated set.

/** hull points kept per set: a hull above this is decimated to its first N vertices (still convex
 * enough for a rock; rapier re-hulls them) so a dense model never costs a huge hull per instance */
export const HULL_MAX_POINTS = 64;

/** @typedef {{kind: 'box'|'sphere'|'hull', center: number[], half: number[], radius: number, hull: Float32Array | null}} ScatterShape */

const _v = new THREE.Vector3();

/**
 * The shape one set's instances share, in the INSTANCE frame (scale 1). Null when the parts
 * have no vertices at all.
 * @param {{geometry: any}[]} parts @param {string} kind 'box' | 'sphere' | 'hull'
 * @returns {ScatterShape | null}
 */
export function scatterShapeOf(parts, kind) {
	const box = new THREE.Box3();
	/** @type {any[]} */
	const points = [];
	for (const part of parts) {
		const pos = part.geometry?.attributes?.position;
		if (!pos) continue;
		for (let i = 0; i < pos.count; i++) {
			_v.fromBufferAttribute(pos, i);
			box.expandByPoint(_v);
			if (kind === 'hull' || kind === 'sphere') points.push(_v.clone());
		}
	}
	if (box.isEmpty()) return null;
	const c = box.getCenter(new THREE.Vector3());
	const size = box.getSize(new THREE.Vector3());
	const half = [Math.max(size.x / 2, 0.01), Math.max(size.y / 2, 0.01), Math.max(size.z / 2, 0.01)];
	/** @type {ScatterShape} */
	const shape = { kind: /** @type {any} */ (kind), center: [c.x, c.y, c.z], half, radius: 0, hull: null };
	if (kind === 'sphere') {
		// around the AABB centre (a rock's mass sits there, not at its base), reaching its farthest vertex
		let r = 0;
		for (const p of points) r = Math.max(r, p.distanceTo(c));
		shape.radius = Math.max(r, 0.01);
	} else if (kind === 'hull') {
		// a flat part (a plane, a card) has no volume to hull: its box (0.01 m thick) stands in
		const thin = Math.min(size.x, size.y, size.z) < 1e-4;
		/** @type {any[]} */
		let verts = [];
		if (!thin && points.length >= 4) {
			try {
				// the hull's CORNERS: walk every face's edge loop (`hull.vertices` keeps every input
				// point, a triangle soup's duplicates included) and keep each position once
				const hull = new ConvexHull().setFromPoints(points);
				const seen = new Set();
				for (const face of hull.faces) {
					let edge = face.edge;
					do {
						const p = edge.head().point;
						const key = `${p.x.toFixed(5)},${p.y.toFixed(5)},${p.z.toFixed(5)}`;
						if (!seen.has(key)) (seen.add(key), verts.push(p));
						edge = edge.next;
					} while (edge !== face.edge);
				}
			} catch {
				verts = [];
			}
		}
		if (verts.length > HULL_MAX_POINTS) {
			const step = verts.length / HULL_MAX_POINTS;
			verts = Array.from({ length: HULL_MAX_POINTS }, (_, k) => verts[Math.floor(k * step)]);
		}
		const flat = new Float32Array(verts.length * 3);
		verts.forEach((p, k) => {
			flat[k * 3] = p.x;
			flat[k * 3 + 1] = p.y;
			flat[k * 3 + 2] = p.z;
		});
		shape.hull = verts.length >= 4 ? flat : null;
		if (!shape.hull) shape.kind = 'box';
	}
	return shape;
}

const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _off = new THREE.Vector3();

/**
 * One ColliderDesc per instance, in WORLD space (the caller attaches them to one fixed body at
 * the origin). A hull rapier cannot build (all points coplanar after scaling) falls back to the
 * instance's box, never to nothing.
 * @param {any} RAPIER @param {ScatterShape} shape @param {any[]} worldMatrices THREE.Matrix4 per instance
 * @returns {any[]}
 */
export function scatterColliderDescs(RAPIER, shape, worldMatrices) {
	/** @type {any[]} */
	const out = [];
	for (const m of worldMatrices) {
		m.decompose(_pos, _quat, _scale);
		const sx = Math.abs(_scale.x);
		const sy = Math.abs(_scale.y);
		const sz = Math.abs(_scale.z);
		if (!(sx > 1e-6 && sy > 1e-6 && sz > 1e-6)) continue;
		const rotation = { x: _quat.x, y: _quat.y, z: _quat.z, w: _quat.w };
		/** @type {any} */
		let desc = null;
		if (shape.kind === 'hull' && shape.hull) {
			const scaled = new Float32Array(shape.hull.length);
			for (let i = 0; i < scaled.length; i += 3) {
				scaled[i] = shape.hull[i] * sx;
				scaled[i + 1] = shape.hull[i + 1] * sy;
				scaled[i + 2] = shape.hull[i + 2] * sz;
			}
			desc = RAPIER.ColliderDesc.convexHull(scaled);
			if (desc) out.push(desc.setTranslation(_pos.x, _pos.y, _pos.z).setRotation(rotation));
			if (desc) continue;
		}
		// box / sphere (and a hull that would not build): the shape centre, scaled, swung into place
		_off.set(shape.center[0] * sx, shape.center[1] * sy, shape.center[2] * sz).applyQuaternion(_quat).add(_pos);
		desc =
			shape.kind === 'sphere'
				? RAPIER.ColliderDesc.ball(shape.radius * Math.max(sx, sy, sz))
				: RAPIER.ColliderDesc.cuboid(shape.half[0] * sx, shape.half[1] * sy, shape.half[2] * sz);
		out.push(desc.setTranslation(_off.x, _off.y, _off.z).setRotation(rotation));
	}
	return out;
}

/**
 * Every collider desc for one terrain's scatter: `sets` from terrainSurface.scatterPhysicsSets
 * (terrain-LOCAL matrices), placed through the terrain's world matrix.
 * @param {any} RAPIER @param {{collider: string, parts: {geometry: any}[], matrices: any[]}[]} sets
 * @param {any} terrainWorld THREE.Matrix4
 * @returns {any[]}
 */
export function terrainScatterDescs(RAPIER, sets, terrainWorld) {
	/** @type {any[]} */
	const out = [];
	const world = new THREE.Matrix4();
	for (const set of sets) {
		const shape = scatterShapeOf(set.parts, set.collider);
		if (!shape) continue;
		const matrices = set.matrices.map((m) => world.clone().multiplyMatrices(terrainWorld, m));
		out.push(...scatterColliderDescs(RAPIER, shape, matrices));
	}
	return out;
}
