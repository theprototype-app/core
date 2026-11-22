// @ts-nocheck — fixture geometry built ad hoc (the checkJs rule for test fixtures)
// Roadmap 99 K4 families 4-6 (lane 99-ops-b): the parity fixtures beyond family 1's set (meshOps99Fixtures.js)
// — meshes with HOLES (fill), OPEN surfaces (solidify) and separate SHELLS (bridge) — built from that set
// so every family runs on the same cube / n-gon / scan / split-normals / skinned meshes.
import * as THREE from 'three';
import { readTriangles, trisToPositions, trisToGroups, trisToUVs } from '$lib/faceEdit.js';
import { composeFaces } from '$lib/meshTopology.js';
import { storedPartition } from '$lib/meshKernel/index.js';
import { cube, ngonPrism, scan67k, splitNormalsUv, skinned, facing, near } from './meshOps99Fixtures.js';

/** welded key (faceEdit keyOf) */
export const keyOf = (v) => `${Math.round(v.x * 1e4)},${Math.round(v.y * 1e4)},${Math.round(v.z * 1e4)}`;
export const edgeKey = (a, b) => (a < b ? a + '|' + b : b + '|' + a);

/** a non-indexed geometry from a soup, its partition stored */
export function geometryOf(tris, partition) {
	const g = new THREE.BufferGeometry();
	g.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(trisToPositions(tris)), 3));
	const uvs = trisToUVs(tris);
	if (uvs) g.setAttribute('uv', new THREE.BufferAttribute(Float32Array.from(uvs), 2));
	for (const gr of trisToGroups(tris) ?? []) g.addGroup(gr.start, gr.count, gr.materialIndex);
	if (partition) g.userData.__topo = { counts: partition.map((f) => f.length), tris: partition.flat() };
	return g;
}

/** the geometry with some triangles removed (the partition carried, like a face delete) */
export function without(geometry, drop) {
	const tris = readTriangles(geometry);
	const gone = new Set(drop);
	const keep = [];
	const origin = [];
	tris.forEach((t, i) => {
		if (gone.has(i)) return;
		origin.push(i);
		keep.push(t);
	});
	const stored = storedPartition(geometry);
	return geometryOf(keep, stored ? composeFaces(stored, origin, []) : null);
}

/** two geometries as one soup (separate shells), both partitions stored */
export function merged(a, b, offset) {
	const ta = readTriangles(a);
	const tb = readTriangles(b).map((t) => {
		const moved = t.map((v) => v.clone().add(new THREE.Vector3(...offset)));
		moved.mi = t.mi;
		if (t.uv) moved.uv = t.uv;
		return moved;
	});
	const pa = storedPartition(a) ?? ta.map((_, i) => [i]);
	const pb = (storedPartition(b) ?? tb.map((_, i) => [i])).map((f) => f.map((i) => i + ta.length));
	return geometryOf([...ta, ...tb], [...pa, ...pb]);
}

/** every border edge key (used by exactly one triangle side), in triangle order */
export function borderKeys(geometry) {
	const tris = readTriangles(geometry);
	const count = new Map();
	const order = [];
	for (const t of tris)
		for (let e = 0; e < 3; e++) {
			const k = edgeKey(keyOf(t[e]), keyOf(t[(e + 1) % 3]));
			if (!count.has(k)) order.push(k);
			count.set(k, (count.get(k) ?? 0) + 1);
		}
	return order.filter((k) => count.get(k) === 1);
}

/** a quad grid plane with stored quads (PlaneGeometry pairs its cell triangles) */
export function grid(n, size = 2) {
	const g = new THREE.PlaneGeometry(size, size, n, n).toNonIndexed();
	const faces = [];
	for (let i = 0; i < n * n; i++) faces.push([i * 2, i * 2 + 1]);
	g.userData.__topo = { counts: faces.map((f) => f.length), tris: faces.flat() };
	return g;
}

/** a 4x4 grid with an L-shaped (non-convex) hole in its middle */
export function lHole() {
	const g = grid(4);
	const cell = (x, y) => [(y * 4 + x) * 2, (y * 4 + x) * 2 + 1];
	return without(g, [...cell(1, 1), ...cell(2, 1), ...cell(1, 2)]);
}

export const openBox = () => {
	const g = cube();
	return without(g, facing(g, [0, 1, 0]));
};
export const openPrism = () => {
	const g = ngonPrism();
	return without(g, facing(g, [0, 1, 0]));
};
export const openSplit = () => {
	const g = splitNormalsUv();
	return without(g, near(g, [1, 0.5, 0.5], 0.9));
};
export const openSkinned = () => {
	const g = skinned();
	return without(g, facing(g, [0, 0, 1]));
};
export const twoCubes = () => merged(cube(), cube(), [3, 0.5, 0.2]);
export const twoPrisms = () => merged(ngonPrism(), ngonPrism(), [0.3, 3, 0]);
/** a border edge of the open scan's HOLE (the scan has border edges of its own at the poles) */
export function scanHoleRim() {
	const own = new Set(borderKeys(scan67k()));
	return borderKeys(openScan()).filter((k) => !own.has(k));
}
/** the scan with a window cut out of its side between sphere rows 59-70 and columns 119-140, by direction (the
 * noise is radial, so the cut cannot straddle a row), far from the seam — the scan's seam is OPEN (its twin points
 * key differently, z = sin(2 pi) = -2.4e-16, and take different noise), so a hole touching it is not one loop */
export const openScan = () => {
	const g = scan67k();
	const theta = [(59.5 / 130) * Math.PI, (70.5 / 130) * Math.PI];
	const phi = [(119.5 / 260) * 2 * Math.PI, (140.5 / 260) * 2 * Math.PI];
	const inside = (v) => {
		const t = Math.acos(Math.max(-1, Math.min(1, v.y / v.length())));
		let f = Math.atan2(v.z, -v.x);
		if (f < 0) f += 2 * Math.PI;
		return t > theta[0] && t < theta[1] && f > phi[0] && f < phi[1];
	};
	const cut = [];
	readTriangles(g).forEach((t, i) => {
		if (t.every(inside)) cut.push(i);
	});
	return without(g, cut);
};

// ---- family 5 (merge / dissolve / delete) -------------------------------------------------------------

/** a 4x4 grid whose odd cells are shifted 4e-4 along x: a crack inside the merge threshold (0.001) but outside the
 * editor's weld (1e-4), so the kernel holds two vertices per crack point and a merge has work to do */
export function crackedGrid() {
	const g = grid(4);
	const p = g.attributes.position;
	for (let i = 0; i < p.count; i++) {
		const cell = Math.floor(i / 6);
		if ((cell + Math.floor(cell / 4)) % 2) p.setX(i, p.getX(i) + 4e-4);
	}
	return g;
}

/** the cube with one corner pulled to within 5e-4 of a neighbour: a merge collapses that edge and drops the
 * triangles on it (degenerate) */
export function sliverCube() {
	const g = cube();
	const p = g.attributes.position;
	for (let i = 0; i < p.count; i++)
		if (p.getX(i) > 0 && p.getY(i) > 0 && p.getZ(i) > 0) p.setXYZ(i, 0.5, 0.5, -0.4995);
	return g;
}

/** welded edge keys between two different stored faces (dissolvable candidates), in triangle order */
export function interiorEdgeKeys(geometry) {
	const tris = readTriangles(geometry);
	const stored = storedPartition(geometry) ?? tris.map((_, i) => [i]);
	const faceOf = new Int32Array(tris.length);
	stored.forEach((f, i) => f.forEach((t) => (faceOf[t] = i)));
	const uses = new Map();
	const order = [];
	tris.forEach((t, ti) => {
		for (let e = 0; e < 3; e++) {
			const k = edgeKey(keyOf(t[e]), keyOf(t[(e + 1) % 3]));
			if (!uses.has(k)) {
				uses.set(k, []);
				order.push(k);
			}
			uses.get(k).push(ti);
		}
	});
	return order.filter((k) => uses.get(k).length === 2 && faceOf[uses.get(k)[0]] !== faceOf[uses.get(k)[1]]);
}

/** welded vertex keys of the mesh, in first-corner order */
export function vertexKeys(geometry) {
	const out = [];
	const seen = new Set();
	for (const t of readTriangles(geometry))
		for (const v of t) {
			const k = keyOf(v);
			if (!seen.has(k)) seen.add(k), out.push(k);
		}
	return out;
}

export { cube, ngonPrism, scan67k, splitNormalsUv, skinned, facing, near };
