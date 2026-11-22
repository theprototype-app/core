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
