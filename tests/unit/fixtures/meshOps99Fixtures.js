// @ts-nocheck — fixture geometry built ad hoc (the checkJs rule for test fixtures)
// Roadmap 99 K4: the parity fixture set — cube, n-gon cap, a 67k "scan", a mesh with authored split
// normals and uvs, a skinned mesh — and the region selections every family-1 operator runs on.
import * as THREE from 'three';
import { readTriangles, groupFaces } from '$lib/faceEdit.js';

/** a partition of a geometry's triangles into its coplanar + adjacent faces (what a user sees) */
function coplanarPartition(geometry) {
	return groupFaces(readTriangles(geometry)).map((f) => [...f.triIndices].sort((a, b) => a - b));
}

/** @param {any} g @param {number[][]} partition */
function store(g, partition) {
	g.userData.__topo = { counts: partition.map((f) => f.length), tris: partition.flat() };
	return g;
}

/** deterministic noise */
function rng(seed) {
	let s = seed >>> 0;
	return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

export function cube() {
	// indexed, uv per face, split normals, SIX material groups
	const g = new THREE.BoxGeometry(1, 1, 1);
	return store(g, coplanarPartition(g));
}

export function ngonPrism() {
	// a hexagonal prism, non-indexed, each cap ONE stored 6-triangle n-gon, single material
	const g = new THREE.CylinderGeometry(1, 1, 1, 6, 1).toNonIndexed();
	g.clearGroups();
	return store(g, coplanarPartition(g));
}

export function scan67k({ cracked = false } = {}) {
	// a noisy sphere at ~67k triangles, no stored partition (the editor derives one), a uv seam.
	// The noise is a function of POSITION, so coincident points stay coincident (a scan's shared
	// vertices); `cracked` jitters per INDEX instead, which splits the pole fan and the seam into
	// unconnected near-duplicates (the documented key-collision exception in the lane STATUS)
	const g = new THREE.SphereGeometry(1, 260, 130);
	const p = g.attributes.position;
	const r = rng(7);
	/** @type {Map<string, number>} */
	const byKey = new Map();
	for (let i = 0; i < p.count; i++) {
		const key = `${p.getX(i).toFixed(6)},${p.getY(i).toFixed(6)},${p.getZ(i).toFixed(6)}`;
		let k = cracked ? undefined : byKey.get(key);
		if (k === undefined) byKey.set(key, (k = 1 + (r() - 0.5) * 0.02));
		p.setXYZ(i, p.getX(i) * k, p.getY(i) * k, p.getZ(i) * k);
	}
	return g.toNonIndexed();
}

export function splitNormalsUv() {
	// authored split normals + uvs on an indexed mesh with seams: a box with a bevel-like chamfer row
	const g = new THREE.BoxGeometry(2, 1, 1, 3, 2, 2);
	const n = g.attributes.normal;
	for (let i = 0; i < n.count; i++) n.setXYZ(i, n.getX(i) * 0.9 + 0.1, n.getY(i), n.getZ(i)); // hand-authored, not derivable
	g.clearGroups();
	return store(g, coplanarPartition(g).flatMap((f) => (f.length > 2 ? pairs(f) : [f])));
}

/** split a big coplanar face into consecutive pairs (the grid quads) */
function pairs(face) {
	const out = [];
	for (let i = 0; i < face.length; i += 2) out.push(face.slice(i, i + 2));
	return out;
}

export function skinned() {
	// a box with skin attributes (two bones), as a SkinnedMesh's geometry carries them
	const g = new THREE.BoxGeometry(1, 2, 1, 1, 2, 1);
	const count = g.attributes.position.count;
	const idx = new Uint16Array(count * 4);
	const w = new Float32Array(count * 4);
	for (let i = 0; i < count; i++) {
		const up = g.attributes.position.getY(i) > 0;
		idx[i * 4] = up ? 1 : 0;
		w[i * 4] = 1;
	}
	g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(idx, 4));
	g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(w, 4));
	g.clearGroups();
	return store(g, pairs(coplanarPartition(g).flat().sort((a, b) => a - b)));
}

/** triangles whose normal points along `dir` (within cos) @param {any} geometry */
export function facing(geometry, dir, cos = 0.9) {
	const tris = readTriangles(geometry);
	const d = new THREE.Vector3(...dir).normalize();
	const out = [];
	tris.forEach((t, i) => {
		const n = new THREE.Vector3().subVectors(t[1], t[0]).cross(new THREE.Vector3().subVectors(t[2], t[0])).normalize();
		if (n.dot(d) > cos) out.push(i);
	});
	return out;
}

/** triangles with every corner within r of a point @param {any} geometry */
export function near(geometry, point, r) {
	const tris = readTriangles(geometry);
	const c = new THREE.Vector3(...point);
	const out = [];
	tris.forEach((t, i) => {
		if (t.every((v) => v.distanceTo(c) < r)) out.push(i);
	});
	return out;
}

/** every fixture with its selections: name -> { geometry(), regions: { name: tris } } */
export function fixtureSet({ big = true } = {}) {
	const set = [
		{ name: 'cube', make: cube, regions: (g) => ({ top: facing(g, [0, 1, 0]), topAndSide: [...facing(g, [0, 1, 0]), ...facing(g, [1, 0, 0])], halfQuad: [facing(g, [0, 1, 0])[0]], twoShellsLike: [...facing(g, [0, 1, 0]), ...facing(g, [0, -1, 0])] }) },
		{ name: 'ngon', make: ngonPrism, regions: (g) => ({ cap: facing(g, [0, 1, 0]), capAndBottom: [...facing(g, [0, 1, 0]), ...facing(g, [0, -1, 0])], side: [facing(g, [1, 0, 0], 0.8)[0], facing(g, [1, 0, 0], 0.8)[1]].filter((x) => x !== undefined) }) },
		{ name: 'splitNormalsUv', make: splitNormalsUv, regions: (g) => ({ topRow: facing(g, [0, 1, 0]), one: [facing(g, [0, 0, 1])[0]], cornerPair: [...near(g, [1, 0.5, 0.5], 0.9)] }) },
		{ name: 'skinned', make: skinned, regions: (g) => ({ front: facing(g, [0, 0, 1]), upperSides: near(g, [0, 1, 0], 1.3) }) }
	];
	if (big) set.push({ name: 'scan67k', make: scan67k, regions: (g) => ({ patch: near(g, [0, 1, 0], 0.25), twoPatches: [...near(g, [0, 1, 0], 0.12), ...near(g, [1, 0, 0], 0.12)] }) });
	return set;
}
