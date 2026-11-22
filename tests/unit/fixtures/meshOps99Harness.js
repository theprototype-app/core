// @ts-nocheck — fixture geometry built ad hoc (the checkJs rule for test fixtures)
// Roadmap 99 K4: the parity harness every family's gate shares — the editor's partition, the op mesh the way
// faceEdit builds it, the op target, and the comparison bounds.
import * as THREE from 'three';
import { readTriangles, pairQuads } from '$lib/faceEdit.js';
import { plainAttribute, storedPartition } from '$lib/meshKernel/index.js';
import * as ops from '$lib/meshOps/index.js';

export const EPS = 1e-6;
/** a vertex of a weld cluster takes the cluster's first position: within one keyOf cell (1e-4 per axis) */
export const SNAP = 1e-4;

/** corners whose source position is not its key cell's first position (the weld moves them) */
export function snappedCorners(tris) {
	const first = new Map();
	const out = new Set();
	tris.forEach((t, ti) =>
		t.forEach((v, k) => {
			const key = `${Math.round(v.x * 1e4) + 0},${Math.round(v.y * 1e4) + 0},${Math.round(v.z * 1e4) + 0}`;
			const f = first.get(key);
			if (!f) first.set(key, v);
			else if (f.x !== v.x || f.y !== v.y || f.z !== v.z) out.add(ti * 3 + k);
		})
	);
	return out;
}

/** the partition the editor sees: stored, else derived from the quad pairing */
export function editorPartition(geometry, tris) {
	const stored = storedPartition(geometry);
	if (stored) return stored;
	const partner = pairQuads(tris);
	const out = [];
	const claimed = new Uint8Array(tris.length);
	for (let t = 0; t < tris.length; t++) {
		if (claimed[t]) continue;
		const m = partner[t] ?? -1;
		if (m > t && !claimed[m]) {
			claimed[t] = claimed[m] = 1;
			out.push([t, m]);
		} else {
			claimed[t] = 1;
			out.push([t]);
		}
	}
	return out;
}

/** the op mesh of a geometry, the way faceEdit builds it */
export function opMeshOf(geometry, partition) {
	const pos = plainAttribute(geometry.attributes.position).array;
	const uv = geometry.attributes.uv ? plainAttribute(geometry.attributes.uv).array : null;
	return ops.opMeshFromArrays({
		positions: pos,
		index: geometry.index ? plainAttribute(geometry.index).array : null,
		uv,
		groups: geometry.groups,
		partition
	});
}

export function targetFace(tris, triIndices) {
	const normal = new THREE.Vector3();
	const centroid = new THREE.Vector3();
	for (const ti of triIndices) {
		const t = tris[ti];
		normal.add(new THREE.Vector3().subVectors(t[1], t[0]).cross(new THREE.Vector3().subVectors(t[2], t[0])).normalize());
		t.forEach((v) => centroid.add(v));
	}
	return { triIndices, normal: normal.normalize(), centroid: centroid.divideScalar(triIndices.length * 3) };
}

export function maxDiff(a, b) {
	let d = 0;
	for (let i = 0; i < a.length; i++) d = Math.max(d, Math.abs(a[i] - b[i]));
	return d;
}

/** faceEdit keyOf / edgeKey (the op weld's grid) */
export const keyOfV = (v) => `${Math.round(v.x * 1e4)},${Math.round(v.y * 1e4)},${Math.round(v.z * 1e4)}`;
const edgeKeyOf = (a, b) => (a < b ? a + '|' + b : b + '|' + a);

/**
 * faceEdit `faceLoopRing` without a session (family 3's parity input): buildQuadTopology + the walk, over
 * `tris` and the quad pairing `partner`. @returns {{ quad: number, cross: string[] }[]}
 */
export function ringOf(tris, partner, tri, axis = 0) {
	const edges = new Map();
	const byEdge = new Map();
	for (let ti = 0; ti < tris.length; ti++) {
		const mate = partner[ti] ?? -1;
		if (mate < 0 || mate < ti) continue;
		const ka = tris[ti].map(keyOfV);
		const kb = tris[mate].map(keyOfV);
		const shared = ka.filter((k) => kb.includes(k));
		if (shared.length !== 2) continue;
		const ra = ka.find((k) => !shared.includes(k));
		const rb = kb.find((k) => !shared.includes(k));
		if (!ra || !rb) continue;
		const ring = [shared[0], ra, shared[1], rb];
		const quadEdges = [0, 1, 2, 3].map((i) => edgeKeyOf(ring[i], ring[(i + 1) % 4]));
		edges.set(ti, quadEdges);
		for (const ek of quadEdges) {
			if (!byEdge.has(ek)) byEdge.set(ek, []);
			byEdge.get(ek).push(ti);
		}
	}
	const mate = partner[tri] ?? -1;
	const start = mate < 0 ? -1 : Math.min(tri, mate);
	const startEdges = edges.get(start);
	if (!startEdges) return [];
	const a = axis % 2;
	const out = [{ quad: start, cross: [startEdges[a], startEdges[a + 2]] }];
	const seen = new Set([start]);
	for (const first of [startEdges[a], startEdges[a + 2]]) {
		let quad = start;
		let edge = first;
		for (let guard = 0; guard < tris.length; guard++) {
			const others = (byEdge.get(edge) ?? []).filter((q) => q !== quad);
			const next = others.length === 1 ? others[0] : undefined;
			if (next === undefined || seen.has(next)) break;
			const e = edges.get(next);
			const at = e ? e.indexOf(edge) : -1;
			if (!e || at < 0) break;
			seen.add(next);
			const o = e[(at + 2) % 4];
			out.push({ quad: next, cross: [edge, o] });
			edge = o;
			quad = next;
		}
	}
	return out;
}
