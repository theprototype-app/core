// @ts-nocheck — fixture geometry built ad hoc (the checkJs rule for test fixtures)
// Roadmap 99 K4 families 4-6 (lane 99-ops-b): the shared half of the parity tests — the editor's partition of a
// fixture, its op mesh, and the "same result" assertion (positions <= eps, the same stored partition in the same
// order, the same uvs and material groups).
import { expect } from 'vitest';
import { trisToPositions, trisToGroups, trisToUVs, pairQuads } from '$lib/faceEdit.js';
import { plainAttribute, storedPartition } from '$lib/meshKernel/index.js';
import * as ops from '$lib/meshOps/index.js';

export const EPS = 1e-6;
export const SNAP = 1e-4;

/** corners whose source position is not its key cell's first position (the weld moves them) */
export function snappedCorners(tris) {
	const first = new Map();
	let n = 0;
	tris.forEach((t) =>
		t.forEach((v) => {
			const key = `${Math.round(v.x * 1e4) + 0},${Math.round(v.y * 1e4) + 0},${Math.round(v.z * 1e4) + 0}`;
			const f = first.get(key);
			if (!f) first.set(key, v);
			else if (f.x !== v.x || f.y !== v.y || f.z !== v.z) n++;
		})
	);
	return n;
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

/** the editor's quadPartner for a partition (faceEdit storedPartner: the two triangles of every 2-triangle face) */
export function partnerOf(partition, count) {
	const partner = new Int32Array(count).fill(-1);
	for (const f of partition)
		if (f.length === 2) {
			partner[f[0]] = f[1];
			partner[f[1]] = f[0];
		}
	return partner;
}

export function opMeshOf(geometry, partition) {
	return ops.opMeshFromArrays({
		positions: plainAttribute(geometry.attributes.position).array,
		index: geometry.index ? plainAttribute(geometry.index).array : null,
		uv: geometry.attributes.uv ? plainAttribute(geometry.attributes.uv).array : null,
		groups: geometry.groups,
		partition
	});
}

export function maxDiff(a, b) {
	let d = 0;
	for (let i = 0; i < a.length; i++) d = Math.max(d, Math.abs(a[i] - b[i]));
	return d;
}

export const stateOf = (tris, faces) => ({
	positions: Float32Array.from(trisToPositions(tris)),
	uvs: trisToUVs(tris) ? Float32Array.from(trisToUVs(tris)) : null,
	groups: trisToGroups(tris),
	faces
});

export function expectSame({ old, neu, snapped }) {
	expect(neu.positions.length).toBe(old.positions.length);
	expect(maxDiff(neu.positions, old.positions)).toBeLessThanOrEqual(snapped ? SNAP : EPS);
	expect(neu.faces).toEqual(old.faces);
	expect(!!neu.uvs).toBe(!!old.uvs);
	if (old.uvs) expect(maxDiff(neu.uvs, old.uvs)).toBeLessThanOrEqual(snapped ? 1e-3 : EPS);
	expect(neu.groups).toEqual(old.groups);
}
