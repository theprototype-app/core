import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

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

/** Flat sculptable ground: size (metres) x segments per side. Segments are
 * clamped to 48 so a sculpted terrain's non-indexed snapshot (18*seg^2 floats =
 * 41,472 at 48) stays under the meshgeo cap (45,000) — see terrainSculpt / T-2.
 * A PlaneGeometry in XY rotated flat so up is +Y, resting at y=0.
 * @param {any=} a @param {any=} b */
function terrain(a, b) {
	const size = num(a, 24);
	const segments = Math.min(Math.max(Math.round(num(b, 48)), 2), 48);
	const geometry = new THREE.PlaneGeometry(size, size, segments, segments);
	geometry.rotateX(-Math.PI / 2);
	return geometry;
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
