// @ts-nocheck — fixture geometry built ad hoc (the checkJs rule for test fixtures)
// Roadmap 99 K5 (lane 99-live, row 1): the triangle FRAME readers against the soup readers they replace (frozen in
// fixtures/soupReaders99live.js): the same faces, quads, shells, components, borders, loops, keys and commit state on
// every fixture, the 67k scan included behind MESHOPS_BIG=1.
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import * as old from './fixtures/soupReaders99live.js';
import { fixtureSet, scan67k } from './fixtures/meshOps99Fixtures.js';
import {
	frameOfGeometry,
	frameOfTris,
	weld,
	shellsOf,
	componentsOf,
	groupFacesOf,
	pairQuadsOf,
	boundaryEdgesOf,
	boundaryLoopOf,
	vertexKeysOf,
	internalEdgeKeysOf,
	centroidOf,
	stateOf,
	keyAt,
	normalOf
} from '$lib/triFrame.js';

const BIG = process.env.MESHOPS_BIG === '1';

/** two cubes merged into one multi-material, textured, non-indexed geometry with a loose plane + a degenerate tri */
function multiPart() {
	const a = new THREE.BoxGeometry(1, 1, 1, 2, 2, 2).toNonIndexed();
	const b = new THREE.BoxGeometry(0.5, 0.5, 0.5).toNonIndexed();
	b.translate(2, 0, 0);
	const pos = [...a.attributes.position.array, ...b.attributes.position.array, 0, 3, 0, 0, 3, 0, 1, 3, 0];
	const uv = [...a.attributes.uv.array, ...b.attributes.uv.array, 0, 0, 0, 0, 1, 0];
	const g = new THREE.BufferGeometry();
	g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
	g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
	const na = a.attributes.position.count;
	g.addGroup(0, na, 0);
	g.addGroup(na, b.attributes.position.count, 2);
	g.addGroup(na + b.attributes.position.count, 3, 1);
	return g;
}

/** an interleaved, indexed geometry (glTF-style storage) */
function interleaved() {
	const src = new THREE.TorusGeometry(1, 0.3, 8, 12);
	const pos = src.attributes.position;
	const uv = src.attributes.uv;
	const buf = new THREE.InterleavedBuffer(new Float32Array(pos.count * 5), 5);
	for (let i = 0; i < pos.count; i++) buf.array.set([pos.getX(i), pos.getY(i), pos.getZ(i), uv.getX(i), uv.getY(i)], i * 5);
	const g = new THREE.BufferGeometry();
	g.setAttribute('position', new THREE.InterleavedBufferAttribute(buf, 3, 0));
	g.setAttribute('uv', new THREE.InterleavedBufferAttribute(buf, 2, 3));
	g.setIndex(src.index);
	return g;
}

const cases = [
	...fixtureSet({ big: false }).map((f) => ({ name: f.name, make: f.make })),
	{ name: 'multiPart', make: multiPart },
	{ name: 'interleaved', make: interleaved },
	{ name: 'sphere', make: () => new THREE.SphereGeometry(1, 24, 12) },
	...(BIG ? [{ name: 'scan67k', make: () => scan67k() }, { name: 'scan67k cracked', make: () => scan67k({ cracked: true }) }] : [])
];

/** a few selections per mesh: a patch around the first triangle, every 7th triangle, a band */
function selections(tris) {
	const n = tris.length;
	const every7 = [];
	for (let i = 0; i < n; i += 7) every7.push(i);
	const c = tris[0][0];
	const patch = [];
	tris.forEach((t, i) => t.every((v) => v.distanceTo(c) < 0.6) && patch.push(i));
	const band = [];
	tris.forEach((t, i) => Math.abs(t[0].y) < 0.15 && band.push(i));
	return { patch, every7, band, one: [Math.min(3, n - 1)] };
}

/** a face list as comparable data */
const faceData = (faces) => faces.map((f) => ({ t: f.triIndices, n: f.normal.toArray(), c: f.centroid.toArray() }));
const edgeData = (dir) => dir.map((d) => ({ ek: d.ek, p0: d.p0.toArray(), p1: d.p1.toArray(), ti: d.ti, c0: d.c0, c1: d.c1 }));

describe('99 K5 triangle frame = the soup readers', () => {
	for (const { name, make } of cases)
		it(name, () => {
			const g = make();
			const tris = old.readTriangles(g);
			const f = frameOfGeometry(g);
			const s = frameOfTris(tris);
			expect(f.count).toBe(tris.length);
			// corners, keys and normals
			for (let t = 0; t < tris.length; t += Math.max(1, Math.floor(tris.length / 500)))
				for (let c = 0; c < 3; c++) {
					expect(keyAt(f, t, c)).toBe(old.keyOf(tris[t][c].x, tris[t][c].y, tris[t][c].z));
					expect(normalOf(f, t).toArray()).toEqual(old.triNormal(tris[t]).toArray());
				}
			// the weld's classes are the key classes
			const V = weld(f);
			/** @type {Map<string, number>} */
			const idOfKey = new Map();
			tris.forEach((tri, t) =>
				tri.forEach((v, c) => {
					const k = old.keyOf(v.x, v.y, v.z);
					if (!idOfKey.has(k)) idOfKey.set(k, V[t * 3 + c]);
					expect(V[t * 3 + c]).toBe(idOfKey.get(k));
				})
			);
			expect(f.nV).toBe(idOfKey.size);
			// whole-mesh readers, on both frames (geometry + soup)
			for (const fr of [f, s]) {
				expect(shellsOf(fr)).toEqual(old.shellsOfTris(tris));
				expect(faceData(groupFacesOf(fr, 0.999))).toEqual(faceData(old.groupFaces(tris)));
				const partner = pairQuadsOf(fr, 0.999, old.quadScore);
				const want = old.pairQuads(tris);
				expect([...partner]).toEqual([...want]);
				expect([...internalEdgeKeysOf(fr, null, want)].sort()).toEqual([...old.internalEdgeKeys(tris, null, want)].sort());
				const part = old.derivePartition(tris, want);
				expect([...internalEdgeKeysOf(fr, part, want)].sort()).toEqual([...old.internalEdgeKeys(tris, part, want)].sort());
				expect(stateOf(fr).groups).toEqual(old.trisToGroups(tris));
				expect(stateOf(fr).uvs).toEqual(old.trisToUVs(tris));
				expect([...stateOf(fr).positions]).toEqual(old.trisToPositions(tris));
			}
			// selection readers
			for (const [sel, list] of Object.entries(selections(tris))) {
				if (!list.length) continue;
				expect(componentsOf(f, list), sel).toEqual(old.componentsOfTris(tris, list));
				expect(edgeData(boundaryEdgesOf(f, list)), sel).toEqual(edgeData(old.boundaryEdges(tris, { triIndices: list })));
				const loop = boundaryLoopOf(f, list);
				const want = old.boundaryLoop(tris, list);
				expect(loop && loop.map((v) => v.toArray()), sel).toEqual(want && want.map((v) => v.toArray()));
				expect([...vertexKeysOf(f, list)], sel).toEqual([...old.faceVertexKeys(tris, { triIndices: list })]);
				expect(centroidOf(f, list).toArray(), sel).toEqual(old.centroidOfTris(tris, list).toArray());
				const st = stateOf(f, { tris: list });
				const sub = old.cloneTris(list.map((t) => tris[t]));
				expect([...st.positions], sel).toEqual(old.trisToPositions(sub));
				expect(st.groups, sel).toEqual(old.trisToGroups(sub));
				expect(st.uvs, sel).toEqual(old.trisToUVs(sub));
				const flipped = old.flipFaceNormals(tris, list);
				const fs = stateOf(f, { flip: new Set(list) });
				expect([...fs.positions], sel).toEqual(old.trisToPositions(flipped));
				expect(fs.uvs, sel).toEqual(old.trisToUVs(flipped));
			}
		}, 120000);

	it('a plain non-indexed Float32 geometry is read in place (live)', () => {
		const g = new THREE.BoxGeometry(1, 1, 1).toNonIndexed();
		const f = frameOfGeometry(g);
		expect(f.live).toBe(true);
		expect(f.P).toBe(g.attributes.position.array);
		expect(frameOfGeometry(new THREE.BoxGeometry(1, 1, 1)).live).toBe(false);
	});
});
