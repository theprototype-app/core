import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { fbm2, valueNoise2 } from './noise';

// Architectural building-block geometries. All builders return a BufferGeometry
// centered on X/Z and resting on y=0 (bbox bottom at the floor), so surface
// snapping and Align to ground behave. Registered by name in createGeometry —
// the replicated '/create Wedge 2 1 2' command builds the same shape on every peer.

/** @param {any} a @param {number} fallback */
const num = (a, fallback) => {
	const value = parseFloat(a);
	return Number.isFinite(value) && value > 0 ? value : fallback;
};

/** Triangular prism ramp: width x, height y, depth z */
/** @param {any=} a @param {any=} b @param {any=} c */
function wedge(a, b, c) {
	const w = num(a, 2), h = num(b, 1), d = num(c, 2);
	const shape = new THREE.Shape();
	shape.moveTo(0, 0);
	shape.lineTo(w, 0);
	shape.lineTo(0, h);
	shape.closePath();
	const geometry = new THREE.ExtrudeGeometry(shape, { depth: d, bevelEnabled: false });
	geometry.translate(-w / 2, 0, -d / 2);
	return geometry;
}

/** Staircase: width, total height, total depth, step count */
/** @param {any=} a @param {any=} b @param {any=} c @param {any=} s */
function stairs(a, b, c, s) {
	const w = num(a, 2), h = num(b, 1.5), d = num(c, 2);
	const steps = Math.min(Math.max(Math.round(num(s, 6)), 2), 32);
	const shape = new THREE.Shape();
	shape.moveTo(0, 0);
	for (let i = 0; i < steps; i++) {
		shape.lineTo((d / steps) * i, (h / steps) * (i + 1));
		shape.lineTo((d / steps) * (i + 1), (h / steps) * (i + 1));
	}
	shape.lineTo(d, 0);
	shape.closePath();
	const geometry = new THREE.ExtrudeGeometry(shape, { depth: w, bevelEnabled: false });
	// profile is depth(x) * height(y); extrusion becomes the width
	geometry.rotateY(Math.PI / 2);
	geometry.translate(-w / 2, 0, d / 2);
	return geometry;
}

/** Wall with an arched opening: width, height, thickness */
/** @param {any=} a @param {any=} b @param {any=} c */
function arch(a, b, c) {
	const w = num(a, 2), h = num(b, 2), d = num(c, 0.5);
	const r = Math.min(w * 0.3, h * 0.45);
	const legTop = Math.min(h * 0.45, h - r - 0.05);
	const shape = new THREE.Shape();
	shape.moveTo(-w / 2, 0);
	shape.lineTo(-r, 0);
	shape.lineTo(-r, legTop);
	shape.absarc(0, legTop, r, Math.PI, 0, true);
	shape.lineTo(r, 0);
	shape.lineTo(w / 2, 0);
	shape.lineTo(w / 2, h);
	shape.lineTo(-w / 2, h);
	shape.closePath();
	const geometry = new THREE.ExtrudeGeometry(shape, { depth: d, bevelEnabled: false });
	geometry.translate(0, 0, -d / 2);
	return geometry;
}

/** L-shaped corner wall: side length, height, thickness */
/** @param {any=} a @param {any=} b @param {any=} c */
function corner(a, b, c) {
	const w = num(a, 2), h = num(b, 2), t = Math.min(num(c, 0.25), w);
	const shape = new THREE.Shape();
	shape.moveTo(0, 0);
	shape.lineTo(w, 0);
	shape.lineTo(w, t);
	shape.lineTo(t, t);
	shape.lineTo(t, w);
	shape.lineTo(0, w);
	shape.closePath();
	const geometry = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false });
	// footprint was drawn in XY; stand it up so the extrusion is the height
	geometry.rotateX(-Math.PI / 2);
	geometry.translate(-w / 2, 0, w / 2);
	return geometry;
}

/** any finite number (`num` above insists on > 0, which would reject a zero
 * amplitude, a zero seed and every negative tile offset).
 * @param {any} a @param {number} fallback */
const anyNum = (a, fallback) => {
	const value = parseFloat(a);
	return Number.isFinite(value) ? value : fallback;
};

/** @param {any} a @param {number} lo @param {number} hi @param {number} fallback */
const clampInt = (a, lo, hi, fallback) =>
	Math.min(Math.max(Math.round(anyNum(a, fallback)), lo), hi);

/** the three edge profiles. A tile's falloff is measured in its OWN local
 * coordinates, never the noise's offset frame, so 'bowl' gives every tile of a
 * tiled world its own raised rim — which is what a ring of mountains around a
 * flat middle is made of. @type {string[]} */
export const TERRAIN_FALLOFFS = ['flat', 'island', 'bowl'];

/** Edge weight for a vertex at LOCAL (x, z) on a tile of half-extent `half`.
 * Math.sqrt is safe here where sin/cos would not be: IEEE-754 requires sqrt to
 * be correctly rounded, so it is bit-identical across engines.
 * @param {number} x @param {number} z @param {number} half @param {string} kind */
function falloffWeight(x, z, half, kind) {
	if (kind !== 'island' && kind !== 'bowl') return 1;
	const d = Math.min(Math.sqrt(x * x + z * z) / half, 1);
	const s = d * d * (3 - 2 * d);
	return kind === 'bowl' ? s : 1 - s;
}

/**
 * 21-C1: PROCEDURAL ground — the parametric terrain every peer rebuilds from
 * ~11 numbers. Deterministic by construction (see noise.js on why value noise),
 * so a terrain never travels as geometry: the `geometry` message carries the
 * params and each peer runs this.
 *
 * Built as a PlaneGeometry rotated flat and then displaced in Y only, which is
 * what makes `amplitude: 0` BYTE-IDENTICAL to the flat plane this used to be —
 * including the ±7.3e-16 the rotation leaves in Y, since the displacement loop
 * is skipped entirely rather than writing zeros over it.
 *
 * Segments stay capped at 48: 18·seg² = 41,472 floats at 48, under the 45,000
 * meshgeo LIVE-PREVIEW budget a sculpt stroke streams (meshBudget.js raised the
 * COMMIT ceiling, not that one). Bigger worlds TILE — a shared `seed` plus
 * per-tile `offsetX/offsetZ` samples one continuous field, which is exactly why
 * the offsets are PARAMS and not a transform: a moved tile would sample the
 * noise in its own frame and seam at the join.
 *
 * @param {any=} params {size, segments, seed, amplitude, frequency, octaves,
 *   ridged, warp, falloff, offsetX, offsetZ}
 */
export function terrainGeometry(params = {}) {
	const size = num(params.size, 24);
	const segments = clampInt(params.segments, 2, 48, 48);
	const geometry = new THREE.PlaneGeometry(size, size, segments, segments);
	// a PlaneGeometry lies in XY; stand it flat so up is +Y, resting at y=0
	geometry.rotateX(-Math.PI / 2);

	const amplitude = anyNum(params.amplitude, 0);
	const frequency = num(params.frequency, 0.06);
	if (amplitude === 0) return geometry; // the flat plane, unchanged

	const seed = Math.round(anyNum(params.seed, 1)) | 0;
	const octaves = clampInt(params.octaves, 1, 6, 4);
	const ridged = !!params.ridged;
	const warp = anyNum(params.warp, 0);
	const falloff = TERRAIN_FALLOFFS.includes(params.falloff) ? params.falloff : 'flat';
	const offsetX = anyNum(params.offsetX, 0);
	const offsetZ = anyNum(params.offsetZ, 0);
	const half = size / 2;

	const position = geometry.attributes.position;
	for (let i = 0; i < position.count; i++) {
		const lx = position.getX(i);
		const lz = position.getZ(i);
		// sample in the SHARED world field, so neighbouring tiles line up
		let sx = (lx + offsetX) * frequency;
		let sz = (lz + offsetZ) * frequency;
		if (warp !== 0) {
			// domain warp: bend the sample point with a second, coarser field.
			// Measured in NOISE cells (no division by frequency, which would blow
			// up as frequency -> 0), so warp: 1 means "up to one cell of bend".
			sx += (valueNoise2(sx * 0.5 + 31.7, sz * 0.5 - 11.3, seed + 7717) * 2 - 1) * warp;
			sz += (valueNoise2(sx * 0.5 - 17.1, sz * 0.5 + 5.9, seed + 3313) * 2 - 1) * warp;
		}
		const h = fbm2(sx, sz, { seed, octaves, ridged, frequency: 1 });
		position.setY(i, position.getY(i) + h * amplitude * falloffWeight(lx, lz, half, falloff));
	}
	geometry.computeVertexNormals();
	return geometry;
}

/** The 2-arg creation shim: `/create Terrain 24 48` keeps working exactly as it
 * did (primitivesCatalog untouched), and amplitude 0 makes it the same flat
 * sculptable ground it has always been — the noise is opt-in from the Inspector.
 * @param {any=} a @param {any=} b */
function terrain(a, b) {
	return terrainGeometry({ size: num(a, 24), segments: clampInt(b, 2, 48, 48), amplitude: 0 });
}

/**
 * 16-P5: the body of a scene CAMERA object — a small box with a lens cone
 * pointing down -Z (three's camera view direction), so the marker reads as
 * "looking that way" and `getWorldDirection()` agrees with what you see. Unlike
 * the blocks above it is centered on its ORIGIN (a camera has no floor).
 * @param {any} a scale (defaults to 1)
 */
function cameraBody(a) {
	const scale = num(a, 1);
	const box = new THREE.BoxGeometry(0.36 * scale, 0.26 * scale, 0.42 * scale);
	const lens = new THREE.CylinderGeometry(0.07 * scale, 0.13 * scale, 0.2 * scale, 12);
	// cylinders build along +Y — lay it along -Z and push it out the front
	lens.rotateX(-Math.PI / 2);
	lens.translate(0, 0, -0.3 * scale);
	const merged = mergeGeometries([box, lens], false) ?? box;
	box.dispose?.();
	lens.dispose?.();
	return merged;
}

/** @type {Record<string, (a?: any, b?: any, c?: any, d?: any) => THREE.BufferGeometry>} */
export const customGeometryBuilders = {
	Wedge: wedge,
	Stairs: stairs,
	Arch: arch,
	Corner: corner,
	Terrain: terrain,
	// both camera kinds share one body; the KIND lives in userData.camera
	Camera: cameraBody,
	CameraOrtho: cameraBody
};
