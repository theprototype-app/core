// @ts-nocheck — fixture geometry built ad hoc (the checkJs rule for test fixtures)
// Roadmap 99 K4 family 3 — THE PARITY GATE for the cuts: the kernel loop cut against the frozen soup
// loopCutCore (tests/unit/fixtures/soupOps99.js) on the fixture set (MESHOPS_BIG=1 adds the 67k scan).
// Same positions (<= eps; <= the key cell where the weld snaps), same stored partition and order, same uvs,
// slots and first-new index (the band the editor selects after the cut).
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
	readTriangles,
	trisToPositions,
	trisToGroups,
	trisToUVs,
	pairQuads
} from '$lib/faceEdit.js';
import { composeFaces } from '$lib/meshTopology.js';
import { storedPartition } from '$lib/meshKernel/index.js';
import * as ops from '$lib/meshOps/index.js';
import * as soup from './fixtures/soupOps99.js';
import { fixtureSet } from './fixtures/meshOps99Fixtures.js';
import {
	EPS,
	SNAP,
	snappedCorners,
	editorPartition,
	opMeshOf,
	maxDiff,
	ringOf,
	keyOfV
} from './fixtures/meshOps99Harness.js';

/** the session's quad pairing: the stored 2-triangle faces, else the derived pairing (faceEdit storedPartner) */
export function partnerOf(geometry, tris) {
	const stored = storedPartition(geometry);
	if (!stored) return pairQuads(tris);
	const partner = new Int32Array(tris.length).fill(-1);
	for (const f of stored)
		if (f.length === 2) {
			partner[f[0]] = f[1];
			partner[f[1]] = f[0];
		}
	return partner;
}

export function bothLoopCut(geometry, tri, axis, options) {
	const tris = readTriangles(geometry);
	const partition = editorPartition(geometry, tris);
	const partner = partnerOf(geometry, tris);
	const ring = ringOf(tris, partner, tri, axis);
	if (!ring.length) return null;
	const r = soup.loopCutCore(tris, ring, partner, options);
	const old = {
		positions: Float32Array.from(trisToPositions(r.tris)),
		uvs: trisToUVs(r.tris) ? Float32Array.from(trisToUVs(r.tris)) : null,
		groups: trisToGroups(r.tris),
		faces: composeFaces(partition, r.origin, r.authored),
		firstNew: r.firstNew
	};
	const om = ops.beginOp(opMeshOf(geometry, partition));
	const k = ops.loopCutRegion(om, ring, partner, options);
	const neu = { ...ops.opOutput(om, { order: 'appearance' }), firstNew: k.firstNew };
	return { old, neu, ring };
}

const CUTS = [
	{ cuts: 1, position: 0.5 },
	{ cuts: 1, position: 0.2 },
	{ cuts: 3 },
	{ cuts: 1, position: 0.995 } // clamped
];

/** start triangles per fixture region: the first triangle with a quad mate */
function starts(geometry, region) {
	const tris = readTriangles(geometry);
	const partner = partnerOf(geometry, tris);
	const t = region.find((ti) => (partner[ti] ?? -1) >= 0);
	return t === undefined ? [] : [t];
}

describe('99 K4 family 3: kernel loop cut = the soup loop cut', () => {
	for (const fx of fixtureSet({ big: !!process.env.MESHOPS_BIG })) {
		const geometry = fx.make();
		for (const [region, tris] of Object.entries(fx.regions(geometry))) {
			if (!tris.length) continue;
			for (const tri of starts(geometry, tris))
				for (const axis of [0, 1])
					for (const options of CUTS)
						it(`${fx.name} / ${region} / tri ${tri} axis ${axis} / ${JSON.stringify(options)}`, () => {
							const r = bothLoopCut(geometry, tri, axis, options);
							if (!r) return; // no ring through that quad on this axis (a pole): nothing to compare
							const { old, neu } = r;
							expect(neu.positions.length).toBe(old.positions.length);
							const snapped = snappedCorners(readTriangles(geometry));
							expect(maxDiff(neu.positions, old.positions)).toBeLessThanOrEqual(
								snapped.size ? SNAP : EPS
							);
							expect(neu.faces).toEqual(old.faces);
							expect(neu.firstNew).toBe(old.firstNew);
							expect(!!neu.uvs).toBe(!!old.uvs);
							if (old.uvs)
								expect(maxDiff(neu.uvs, old.uvs)).toBeLessThanOrEqual(snapped.size ? 1e-3 : EPS);
							expect(neu.groups).toEqual(old.groups);
						});
		}
	}
	it('the ring premise: a cube ring is 4 quads', () => {
		const fx = fixtureSet({ big: false }).find((f) => f.name === 'cube');
		const g = fx.make();
		const t = starts(g, fx.regions(g).top)[0];
		expect(bothLoopCut(g, t, 0, { cuts: 1 }).ring.length).toBe(4);
	});
});

// the scan's noise leaves its rings 1-2 quads long: a clean sphere of the same size walks a whole latitude
describe.runIf(!!process.env.MESHOPS_BIG)('99 K4 family 3: a 67k latitude ring', () => {
	it('sphere 260 x 130 (67k tris): a full-latitude loop cut matches the soup', () => {
		const g = new THREE.SphereGeometry(1, 260, 130).toNonIndexed();
		const tris = readTriangles(g);
		const partner = partnerOf(g, tris);
		// a triangle just north of the equator with a quad mate
		const t = tris.findIndex(
			(tr, i) => (partner[i] ?? -1) >= 0 && tr.every((v) => v.y > 0 && v.y < 0.03)
		);
		for (const axis of [0, 1]) {
			const r = bothLoopCut(g, t, axis, { cuts: 2 });
			expect(r.ring.length).toBeGreaterThan(100);
			expect(maxDiff(r.neu.positions, r.old.positions)).toBeLessThanOrEqual(EPS);
			expect(r.neu.faces).toEqual(r.old.faces);
			expect(r.neu.firstNew).toBe(r.old.firstNew);
			expect(maxDiff(r.neu.uvs, r.old.uvs)).toBeLessThanOrEqual(EPS);
		}
	}, 300000);
});

/** a face's boundary keys in loop order (faceEdit boundaryLoop by key), or null */
function loopKeys(tris, face) {
	const count = new Map();
	const sides = [];
	for (const t of face)
		for (let e = 0; e < 3; e++) {
			const a = keyOfV(tris[t][e]);
			const b = keyOfV(tris[t][(e + 1) % 3]);
			const k = a < b ? a + '|' + b : b + '|' + a;
			count.set(k, (count.get(k) ?? 0) + 1);
			sides.push([a, b, k]);
		}
	const next = new Map();
	for (const [a, b, k] of sides) if (count.get(k) === 1) next.set(a, b);
	if (next.size < 3) return null;
	const start = next.keys().next().value;
	const out = [start];
	for (let k = next.get(start); k !== start; k = next.get(k)) {
		if (k === undefined || out.length > next.size) return null;
		out.push(k);
	}
	return out.length === next.size ? out : null;
}

export function bothConnect(geometry, keyA, keyB) {
	const tris = readTriangles(geometry);
	const partition = editorPartition(geometry, tris);
	const r = soup.connectVerticesCore(tris, partition, keyA, keyB);
	const om = ops.beginOp(opMeshOf(geometry, partition));
	const k = ops.connectVerticesRegion(om, keyA, keyB);
	if ('error' in r) return { old: { error: r.error }, neu: { error: k.error ?? null } };
	const out = ops.opOutput(om, { order: 'replace' });
	return {
		old: {
			positions: Float32Array.from(trisToPositions(r.tris)),
			uvs: trisToUVs(r.tris) ? Float32Array.from(trisToUVs(r.tris)) : null,
			groups: trisToGroups(r.tris),
			faces: r.faces
		},
		neu: { ...out, error: k.error ?? null }
	};
}

/** connect picks per region: a diagonal pair of its first 4+-corner face, a far pair, and two refusals */
function connectPicks(geometry, region) {
	const tris = readTriangles(geometry);
	const partition = editorPartition(geometry, tris);
	const inRegion = new Set(region);
	const faces = partition.filter((f) => f.some((t) => inRegion.has(t)));
	const face = faces.find((f) => (loopKeys(tris, f)?.length ?? 0) >= 4);
	if (!face) return {};
	const ring = loopKeys(tris, face);
	const picks = { diagonal: [ring[0], ring[2]], neighbours: [ring[0], ring[1]] };
	if (ring.length >= 6) picks.far = [ring[1], ring[Math.floor(ring.length / 2) + 1]];
	const other = partition.find(
		(f) => f !== face && !f.some((t) => tris[t].some((v) => ring.includes(keyOfV(v))))
	);
	if (other) picks.otherFace = [ring[0], keyOfV(tris[other[0]][0])]; // may still share a neighbouring face (a split)
	return picks;
}

describe('99 K4 family 3: kernel connect = the soup connect', () => {
	for (const fx of fixtureSet({ big: !!process.env.MESHOPS_BIG })) {
		const geometry = fx.make();
		for (const [region, tris] of Object.entries(fx.regions(geometry))) {
			if (!tris.length) continue;
			for (const [pick, [a, b]] of Object.entries(connectPicks(geometry, tris)))
				it(`${fx.name} / ${region} / ${pick}`, () => {
					const { old, neu } = bothConnect(geometry, a, b);
					if (old.error) {
						expect(neu.error).toBe(old.error);
						return;
					}
					expect(neu.error).toBe(null);
					expect(neu.positions.length).toBe(old.positions.length);
					const snapped = snappedCorners(readTriangles(geometry));
					expect(maxDiff(neu.positions, old.positions)).toBeLessThanOrEqual(
						snapped.size ? SNAP : EPS
					);
					expect(neu.faces).toEqual(old.faces);
					expect(!!neu.uvs).toBe(!!old.uvs);
					if (old.uvs)
						expect(maxDiff(neu.uvs, old.uvs)).toBeLessThanOrEqual(snapped.size ? 1e-3 : EPS);
					expect(neu.groups).toEqual(old.groups);
				});
		}
	}
	it('premise: the cube diagonal pick splits (not a refusal), the neighbour pick refuses', () => {
		const fx = fixtureSet({ big: false }).find((f) => f.name === 'cube');
		const g = fx.make();
		const p = connectPicks(g, fx.regions(g).top);
		expect(bothConnect(g, ...p.diagonal).old.error).toBeUndefined();
		expect(bothConnect(g, ...p.neighbours).old.error).toMatch(/already share an edge/);
		// the diametrically opposite corner shares no face with it (a corner of a neighbouring face may: a side quad)
		const opposite = p.diagonal[0]
			.split(',')
			.map((n) => String(-Number(n)))
			.join(',');
		const far = bothConnect(g, p.diagonal[0], opposite);
		expect(far.old.error).toMatch(/SAME face/);
		expect(far.neu.error).toBe(far.old.error);
	});
});
