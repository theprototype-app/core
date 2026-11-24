// 102b-papercuts (scout row 15): A ROUNDED BOX IS A BOX SETTING. The official scenes carried 147 rounded boxes
// BAKED into plain meshes (23.6 MB of their 30 MB: "Core's Box params carry no bevel", author-templates.cjs),
// about 270 KB each. Now a Box has a corner radius, and the file keeps only its numbers.
//
// THE FILE TRICK: `RoundedBox` is three's RoundedBoxGeometry (MIT, examples/jsm — the generator's port is of
// the same code, so a baked box rebuilds to the same vertices) whose `type` says 'BoxGeometry' and whose
// `parameters` are a Box's plus `radius` / `radiusSegments`. BufferGeometry.toJSON writes a typed geometry as
// its parameters only, so a saved rounded box is a few numbers. On load, `BoxGeometry.fromJSON` (patched
// below, once, at import) builds the rounded one when the JSON names a radius; an OLDER build reads the same
// JSON as a plain box of the same size — the one thing it cannot show is the rounding.
//
// What is NOT parametric: GLTF (autosave, the join sync) writes vertices, as it always did; the object's
// `userData.geometryParams` carries the radius there, so its Geometry rows stay editable.
//
// A LAZY CHUNK: roundedBoxGate.js is the boot half (the Box builder, the ObjectLoader hook, the cheap tests)
// and loads this the first time a radius or a candidate mesh shows up.

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { MAX_RADIUS_SEGMENTS, DEFAULT_RADIUS_SEGMENTS } from './roundedBoxGate.js';
import { healSlotGroups } from './slotGroups.js';

export { MAX_RADIUS_SEGMENTS, DEFAULT_RADIUS_SEGMENTS };

export class RoundedBox extends RoundedBoxGeometry {
	/** @param {number} [width] @param {number} [height] @param {number} [depth] @param {number} [segments] @param {number} [radius] */
	constructor(width = 1, height = 1, depth = 1, segments = DEFAULT_RADIUS_SEGMENTS, radius = 0.1) {
		const segs = Math.max(1, Math.min(MAX_RADIUS_SEGMENTS, Math.round(Number(segments) || DEFAULT_RADIUS_SEGMENTS)));
		super(width, height, depth, segs, radius);
		// a BOX, as far as every reader (toJSON, ObjectLoader, geometryParamsOf, an older build) is concerned
		this.type = 'BoxGeometry';
		this.parameters = {
			width,
			height,
			depth,
			widthSegments: 1,
			heightSegments: 1,
			depthSegments: 1,
			radius: /** @type {any} */ (this).parameters.radius,
			radiusSegments: segs
		};
	}
}

/**
 * A Box's geometry from its params: rounded when `radius` > 0, else exactly the BoxGeometry it always was.
 * @param {any} p
 */
export function boxGeometryFor(p) {
	const radius = Number(p?.radius);
	if (Number.isFinite(radius) && radius > 0) return new RoundedBox(p.width, p.height, p.depth, p.radiusSegments ?? DEFAULT_RADIUS_SEGMENTS, radius);
	return new THREE.BoxGeometry(p?.width, p?.height, p?.depth, p?.widthSegments, p?.heightSegments, p?.depthSegments);
}

/** the rounded box for these params (the gate's builder, once this chunk is here) @param {any} p */
export function roundedBoxGeometry(p) {
	return new RoundedBox(p.width, p.height, p.depth, p.radiusSegments ?? DEFAULT_RADIUS_SEGMENTS, p.radius);
}

/**
 * A plain box an older build wrote back (it read our rounded box as a Box and dropped the radius) still carries
 * the radius in `userData.geometryParams`: rebuild it. Only for an unedited Box whose size still matches.
 * @param {any} root a parsed object tree @returns {number} how many were rebuilt
 */
export function restoreRoundedBoxes(root) {
	let n = 0;
	root?.traverse?.((/** @type {any} */ o) => {
		const gp = o.userData?.geometryParams;
		const g = o.geometry;
		if (!o.isMesh || gp?.gtype !== 'Box' || !(Number(gp.params?.radius) > 0) || o.userData.faceEdited || o.userData.vertexEdited) return;
		if (g?.type !== 'BoxGeometry' || g instanceof RoundedBox || !g.parameters) return;
		const same = ['width', 'height', 'depth'].every((k) => Math.abs(Number(g.parameters[k]) - Number(gp.params[k])) < 1e-6);
		if (!same) return;
		const fresh = boxGeometryFor(gp.params);
		g.dispose();
		o.geometry = fresh;
		healSlotGroups(o); // 105: a slot list saved before the fix gets its groups back on the rounded geometry
		n++;
	});
	return n;
}

/** a rounded box as a plain BufferGeometry (what a baked one is) @param {any} p */
export function bakedRoundedBox(p) {
	const g = new RoundedBox(p.width, p.height, p.depth, p.radiusSegments ?? DEFAULT_RADIUS_SEGMENTS, p.radius);
	const out = new THREE.BufferGeometry();
	for (const name of ['position', 'normal', 'uv']) out.setAttribute(name, g.attributes[name].clone());
	g.dispose();
	return out;
}

/** the vertex count a rounded box of `segments` has (non-indexed: 6 faces x (2s+1)^2 quads x 6) @param {number} segments */
export function roundedBoxVertexCount(segments) {
	const t = segments * 2 + 1;
	return 36 * t * t;
}

/**
 * Is this baked mesh exactly a rounded box? Returns its Box params (with radius) or null. Never changes
 * anything: the Inspector OFFERS a Convert for what this recognises.
 * @param {any} geometry a BufferGeometry @param {number} [eps]
 * @returns {{width: number, height: number, depth: number, radius: number, radiusSegments: number} | null}
 */
export function matchRoundedBox(geometry, eps = 1e-4) {
	if (!geometry?.isBufferGeometry || geometry instanceof RoundedBox || geometry.index) return null;
	if (geometry.parameters) return null; // a typed geometry is not baked
	const pos = geometry.attributes?.position;
	if (!pos || pos.itemSize !== 3) return null;
	let segments = 0;
	for (let s = 1; s <= MAX_RADIUS_SEGMENTS; s++) if (roundedBoxVertexCount(s) === pos.count) segments = s;
	if (!segments) return null;
	geometry.computeBoundingBox();
	const b = geometry.boundingBox;
	const width = b.max.x - b.min.x;
	const height = b.max.y - b.min.y;
	const depth = b.max.z - b.min.z;
	// centred, as the builder makes it
	if (Math.abs(b.max.x + b.min.x) > eps || Math.abs(b.max.y + b.min.y) > eps || Math.abs(b.max.z + b.min.z) > eps) return null;
	// the radius: on the +X face's flat part, y reaches height / 2 - radius
	const a = pos.array;
	let maxY = -Infinity;
	for (let i = 0; i < a.length; i += 3) if (Math.abs(a[i] - b.max.x) < eps) maxY = Math.max(maxY, Math.abs(a[i + 1]));
	const radius = height / 2 - maxY;
	if (!(radius > eps)) return null;
	const test = new RoundedBox(width, height, depth, segments, radius);
	const t = test.attributes.position.array;
	let ok = t.length === a.length;
	const tol = Math.max(eps, 1e-5 * Math.max(width, height, depth));
	for (let i = 0; ok && i < a.length; i++) if (Math.abs(t[i] - a[i]) > tol) ok = false;
	test.dispose();
	return ok ? { width: round6(width), height: round6(height), depth: round6(depth), radius: round6(radius), radiusSegments: segments } : null;
}

/** @param {number} v */
const round6 = (v) => Math.round(v * 1e6) / 1e6;
