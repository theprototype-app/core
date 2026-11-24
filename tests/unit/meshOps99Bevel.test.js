// @ts-nocheck — fixture geometry built ad hoc (the checkJs rule for test fixtures)
// Roadmap 99 K4 family 2 — THE PARITY GATE for the bevels: each ported bevel against the pre-port soup code
// (tests/unit/fixtures/soupOps99.js, frozen) on the fixture set. Same positions (<= eps; the weld snap on the
// scan), same stored partition (and order), same uvs and material groups.
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { readTriangles, trisToPositions, trisToGroups, trisToUVs, pairQuads } from '$lib/faceEdit.js';
import { composeFaces, appendOrigin } from '$lib/meshTopology.js';
import * as ops from '$lib/meshOps/index.js';
import * as soup from './fixtures/soupOps99.js';
import { fixtureSet } from './fixtures/meshOps99Fixtures.js';
import { editorPartition, opMeshOf, maxDiff, snappedCorners, targetFace, EPS, SNAP } from './fixtures/meshOps99Harness.js';

/** soup face bevel + composeFaces vs kernel bevelRegion + opOutput */
export function bothFaceBevel(geometry, region, options) {
	const tris = readTriangles(geometry);
	const partition = editorPartition(geometry, tris);
	const face = targetFace(tris, region);
	const r = soup.bevelFacesCore(tris, face, options);
	const old = {
		positions: Float32Array.from(trisToPositions(r.tris)),
		uvs: trisToUVs(r.tris) ? Float32Array.from(trisToUVs(r.tris)) : null,
		groups: trisToGroups(r.tris),
		faces: composeFaces(partition, appendOrigin(tris.length, r.tris.length), r.authored),
		cap: r.capTriIndices
	};
	const om = ops.beginOp(opMeshOf(geometry, partition));
	const k = ops.bevelRegion(om, region, [face.normal.x, face.normal.y, face.normal.z], options);
	const neu = { ...ops.opOutput(om, { order: 'appearance' }), cap: k.capTriIndices };
	return { old, neu };
}

const FACE_BEVELS = [
	{ width: 0.1, segments: 1, profile: 1, direction: 'out' },
	{ width: 0.15, segments: 3, profile: 1, direction: 'out' },
	{ width: 0.12, segments: 4, profile: -0.6, direction: 'in' },
	{ width: 0.08, segments: 2, profile: 0, direction: 'out' },
	{ width: 5, segments: 2, profile: 0.5, direction: 'out' } // oversized: saturates at 0.95 per piece
];

describe('99 K4 family 2: kernel face bevel = the soup face bevel', () => {
	for (const fx of fixtureSet({ big: !!process.env.MESHOPS_BIG })) {
		const geometry = fx.make();
		for (const [region, tris] of Object.entries(fx.regions(geometry))) {
			if (!tris.length) continue;
			for (const options of FACE_BEVELS) {
				it(`${fx.name} / ${region} / ${JSON.stringify(options)}`, () => {
					const { old, neu } = bothFaceBevel(geometry, tris, options);
					expect(neu.positions.length).toBe(old.positions.length);
					const snapped = snappedCorners(readTriangles(geometry));
					expect(maxDiff(neu.positions, old.positions)).toBeLessThanOrEqual(snapped.size ? SNAP * 2 : EPS);
					expect(neu.faces).toEqual(old.faces);
					expect(!!neu.uvs).toBe(!!old.uvs);
					if (old.uvs) expect(maxDiff(neu.uvs, old.uvs)).toBeLessThanOrEqual(snapped.size ? 1e-3 : EPS);
					expect(neu.groups).toEqual(old.groups);
					expect(neu.cap).toEqual(old.cap);
				});
			}
		}
	}
});

const keyOf = (v) => `${Math.round(v.x * 1e4)},${Math.round(v.y * 1e4)},${Math.round(v.z * 1e4)}`;

/** soup vertex bevel + its wrapper's authoring vs kernel bevelVertices + opOutput */
export function bothVertexBevel(geometry, keys, options) {
	const tris = readTriangles(geometry);
	const r = soup.bevelVerticesCore(tris, keys, options);
	const authored = [];
	for (const cap of r.caps) {
		const set = new Set(cap);
		const face = [];
		r.tris.forEach((t, ti) => {
			if (t.every((v) => set.has(keyOf(v)))) face.push(ti);
		});
		if (face.length) authored.push(face);
	}
	const old = {
		done: r.done,
		positions: Float32Array.from(trisToPositions(r.tris)),
		uvs: trisToUVs(r.tris) ? Float32Array.from(trisToUVs(r.tris)) : null,
		groups: trisToGroups(r.tris),
		faces: composeFaces(null, appendOrigin(0, r.tris.length), authored)
	};
	const om = ops.beginOp(opMeshOf(geometry, editorPartition(geometry, tris)));
	const k = ops.bevelVertices(om, keys, options);
	const neu = { done: k.done, ...ops.opOutput(om, { order: 'appearance' }) };
	return { old, neu };
}

const VERTEX_BEVELS = [
	{ width: 0.2, profile: 0, segments: 1 },
	{ width: 0.15, profile: 0.6, segments: 1 },
	{ width: 0.1, profile: -0.5, segments: 3 },
	{ width: 0.3, profile: 0, segments: 2 },
	{ width: 9, profile: 1, segments: 1 } // clamped to 0.45 of each edge
];

/** vertex picks per region: its first triangle's first corner, and all three (adjacent, processed in turn) */
function vertexPicks(geometry, region) {
	const t = readTriangles(geometry)[region[0]];
	return { one: [keyOf(t[0])], three: t.map(keyOf) };
}

describe('99 K4 family 2: kernel vertex bevel = the soup vertex bevel', () => {
	for (const fx of fixtureSet({ big: !!process.env.MESHOPS_BIG })) {
		const geometry = fx.make();
		for (const [region, tris] of Object.entries(fx.regions(geometry))) {
			if (!tris.length) continue;
			for (const [pick, keys] of Object.entries(vertexPicks(geometry, tris)))
				for (const options of VERTEX_BEVELS) {
					it(`${fx.name} / ${region} / ${pick} / ${JSON.stringify(options)}`, () => {
						const { old, neu } = bothVertexBevel(geometry, keys, options);
						expect(neu.done).toBe(old.done);
						expect(neu.positions.length).toBe(old.positions.length);
						const snapped = snappedCorners(readTriangles(geometry));
						expect(maxDiff(neu.positions, old.positions)).toBeLessThanOrEqual(snapped.size ? SNAP * 2 : EPS);
						expect(neu.faces).toEqual(old.faces);
						expect(!!neu.uvs).toBe(!!old.uvs);
						if (old.uvs) expect(maxDiff(neu.uvs, old.uvs)).toBeLessThanOrEqual(snapped.size ? 1e-3 : EPS);
						expect(neu.groups).toEqual(old.groups);
					});
				}
		}
	}
});

const edgeKeyOf = (a, b) => {
	const x = keyOf(a);
	const y = keyOf(b);
	return x < y ? x + '|' + y : y + '|' + x;
};

/** soup edge bevel vs kernel bevelEdges; the partition is derived on both outputs (the commit's rule) */
export function bothEdgeBevel(geometry, edgeKeys, options) {
	const tris = readTriangles(geometry);
	const r = soup.bevelEdgesCore(tris, edgeKeys, options);
	const old = {
		counts: [r.done, r.refusedValence, r.refusedBorder],
		positions: Float32Array.from(trisToPositions(r.tris)),
		uvs: trisToUVs(r.tris) ? Float32Array.from(trisToUVs(r.tris)) : null,
		groups: trisToGroups(r.tris),
		pairs: pairQuads(r.tris)
	};
	const om = ops.beginOp(opMeshOf(geometry, editorPartition(geometry, tris)));
	const k = ops.bevelEdges(om, edgeKeys, options);
	const out = ops.opOutput(om, { order: 'appearance' });
	const neu = { counts: [k.done, k.refusedValence, k.refusedBorder], ...out, pairs: pairQuads(ops.toSoup(om)) };
	return { old, neu };
}

/** edge picks per region: its first boundary side, and two boundary sides in a row */
function edgePicks(geometry, region) {
	const tris = readTriangles(geometry);
	const count = new Map();
	const sides = [];
	for (const ti of region)
		for (let e = 0; e < 3; e++) {
			const k = edgeKeyOf(tris[ti][e], tris[ti][(e + 1) % 3]);
			count.set(k, (count.get(k) ?? 0) + 1);
			sides.push(k);
		}
	const border = [...new Set(sides.filter((k) => count.get(k) === 1))];
	if (!border.length) return {};
	const [a0, a1] = border[0].split('|');
	const second = border.find((k, i) => i > 0 && (k.split('|').includes(a0) || k.split('|').includes(a1)));
	const picks = { one: [border[0]], two: second ? [border[0], second] : [border[0]] };
	// a side the op ACCEPTS (on a curved scan the first border side lies inside one coplanar region and is
	// refused, so `one` / `two` would only cover the refusal there); found on the kernel, then held to the soup
	const om0 = opMeshOf(geometry, editorPartition(geometry, tris));
	for (const k of border.slice(0, 60)) {
		if (ops.bevelEdges(ops.beginOp(ops.cloneOpMesh(om0)), [k], { width: 0.01, segments: 1, profile: 0 }).done) {
			picks.bevels = [k];
			break;
		}
	}
	return picks;
}

const EDGE_BEVELS = [
	{ width: 0.1, segments: 1, profile: 0 },
	{ width: 0.15, segments: 3, profile: 0 },
	{ width: 0.1, segments: 2, profile: 0.5 },
	{ width: 0.2, segments: 4, profile: -0.4 },
	{ width: 9, segments: 1, profile: 0 } // clamped
];

describe('99 K4 family 2: kernel edge bevel = the soup edge bevel', () => {
	for (const fx of fixtureSet({ big: !!process.env.MESHOPS_BIG })) {
		const geometry = fx.make();
		for (const [region, tris] of Object.entries(fx.regions(geometry))) {
			if (!tris.length) continue;
			for (const [pick, keys] of Object.entries(edgePicks(geometry, tris)))
				for (const options of EDGE_BEVELS) {
					it(`${fx.name} / ${region} / ${pick} / ${JSON.stringify(options)}`, () => {
						const { old, neu } = bothEdgeBevel(geometry, keys, options);
						expect(neu.counts).toEqual(old.counts);
						expect(neu.positions.length).toBe(old.positions.length);
						const snapped = snappedCorners(readTriangles(geometry));
						expect(maxDiff(neu.positions, old.positions)).toBeLessThanOrEqual(snapped.size ? SNAP * 2 : EPS);
						expect(Array.from(neu.pairs)).toEqual(Array.from(old.pairs));
						expect(!!neu.uvs).toBe(!!old.uvs);
						if (old.uvs) expect(maxDiff(neu.uvs, old.uvs)).toBeLessThanOrEqual(snapped.size ? 1e-3 : EPS);
						expect(neu.groups).toEqual(old.groups);
					});
				}
		}
	}
});

describe('99 K4 family 2: edge bevel MITERED ends (an apex with 2+ other regions)', () => {
	const shapes = {
		pyramid4: () => new THREE.ConeGeometry(1, 1.5, 4, 1),
		cone6: () => new THREE.ConeGeometry(1, 1.5, 6, 1),
		pyramid5Uv: () => new THREE.ConeGeometry(0.8, 1.2, 5, 2)
	};
	for (const [name, make] of Object.entries(shapes)) {
		const geometry = make();
		const tris = readTriangles(geometry);
		const apex = tris.flat().reduce((a, v) => (v.y > a.y ? v : a));
		// every edge from the apex down a slant
		const slants = [...new Set(tris.flatMap((t) => [0, 1, 2].filter((e) => keyOf(t[e]) === keyOf(apex)).flatMap((e) => [edgeKeyOf(t[e], t[(e + 1) % 3]), edgeKeyOf(t[e], t[(e + 2) % 3])])))];
		const picks = { one: [slants[0]], two: slants.slice(0, 2) };
		for (const [pick, keys] of Object.entries(picks))
			for (const options of EDGE_BEVELS)
				it(`${name} / ${pick} / ${JSON.stringify(options)}`, () => {
					const { old, neu } = bothEdgeBevel(geometry, keys, options);
					expect(neu.counts).toEqual(old.counts);
					expect(neu.positions.length).toBe(old.positions.length);
					expect(maxDiff(neu.positions, old.positions)).toBeLessThanOrEqual(EPS);
					expect(Array.from(neu.pairs)).toEqual(Array.from(old.pairs));
					if (old.uvs) expect(maxDiff(neu.uvs, old.uvs)).toBeLessThanOrEqual(EPS);
					expect(neu.groups).toEqual(old.groups);
				});
	}
});
