import * as THREE from 'three';

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

/** @type {Record<string, (a?: any, b?: any, c?: any, d?: any) => THREE.BufferGeometry>} */
export const customGeometryBuilders = {
	Wedge: wedge,
	Stairs: stairs,
	Arch: arch,
	Corner: corner
};
