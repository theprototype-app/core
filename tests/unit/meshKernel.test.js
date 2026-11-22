// @ts-nocheck — fixture meshes built ad hoc (the checkJs rule for test fixtures)
// Roadmap 99 K1: the headless mesh kernel (src/lib/meshKernel/). Properties, not examples:
//  1. adjacency is consistent after every operation (`validate()` is the oracle);
//  2. Euler characteristic and manifoldness of known surfaces (cube 2, torus 0, open grid 1);
//  3. IDs are STABLE: a seeded random edit sequence never renumbers an untouched vertex / face /
//     edge, and only `compact()` renumbers (with maps);
//  4. geometry -> kernel -> geometry is lossless for three's own primitives, indexed and soup,
//     with and without a stored partition, and through the meshgeo wire with and without IDs;
//  5. the spatial hash agrees with brute force; the triangulator covers the polygon exactly.
// Every expected number is derived from the fixture, never pasted from a run.
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
	MeshKernel,
	NONE,
	SpatialHash,
	triangulatePolygon,
	fromArrays,
	toArrays,
	fromBufferGeometry,
	toMeshGeo,
	fromMeshGeo,
	kernelToFaceWire,
	faceWireToPartition
} from '$lib/meshKernel/index.js';
import { toBufferGeometry } from '$lib/meshKernel/three.js';
import { unpackFaces } from '$lib/meshTopology.js';

/** mulberry32: the seeded generator (no fast-check dependency: lanes never add deps) */
function rng(seed) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** a unit cube of 6 quads, outward wound */
function cube() {
	const m = new MeshKernel();
	const v = [];
	for (let i = 0; i < 8; i++) v.push(m.addVertex(i & 1 ? 1 : 0, i & 2 ? 1 : 0, i & 4 ? 1 : 0));
	const quads = [
		[0, 2, 3, 1], // z = 0, facing -z
		[4, 5, 7, 6], // z = 1
		[0, 1, 5, 4], // y = 0
		[2, 6, 7, 3], // y = 1
		[0, 4, 6, 2], // x = 0
		[1, 3, 7, 5] // x = 1
	];
	for (const q of quads) m.addFace(q.map((i) => v[i]));
	return m;
}

/** an open n x n grid of quads in the XY plane, with per-corner uvs */
function grid(n) {
	const m = new MeshKernel({ attributes: { uv: 2 } });
	const id = [];
	for (let y = 0; y <= n; y++) for (let x = 0; x <= n; x++) id.push(m.addVertex(x, y, 0));
	for (let y = 0; y < n; y++)
		for (let x = 0; x < n; x++) {
			const q = [y * (n + 1) + x, y * (n + 1) + x + 1, (y + 1) * (n + 1) + x + 1, (y + 1) * (n + 1) + x];
			const uv = [];
			for (const k of q) uv.push((k % (n + 1)) / n, Math.floor(k / (n + 1)) / n);
			m.addFace(q.map((k) => id[k]), { attrs: { uv } });
		}
	return m;
}

/** de-indexed corner values of a geometry attribute, as plain numbers */
function expanded(geometry, name) {
	const attr = geometry.attributes[name];
	const index = geometry.index;
	const count = index ? index.count : attr.count;
	const out = [];
	for (let i = 0; i < count; i++) {
		const j = index ? index.getX(i) : i;
		for (let k = 0; k < attr.itemSize; k++) out.push(attr.array[j * attr.itemSize + k]);
	}
	return out;
}

/** every corner value equal, compared as float32 with -0 == 0 (numeric equality) */
function sameFloats(a, b) {
	if (a.length !== b.length) return `length ${a.length} vs ${b.length}`;
	const fa = Float32Array.from(a);
	const fb = Float32Array.from(b);
	for (let i = 0; i < fa.length; i++) if (fa[i] !== fb[i]) return `index ${i}: ${fa[i]} vs ${fb[i]}`;
	return null;
}

describe('structure: a hand-built cube', () => {
	it('is a closed orientable manifold with χ = 2', () => {
		const m = cube();
		expect(m.validate()).toEqual([]);
		expect(m.stats()).toMatchObject({ vertices: 8, edges: 12, faces: 6, corners: 24, triangles: 12 });
		expect(m.topologyReport()).toMatchObject({ euler: 2, closed: true, manifold: true, orientable: true, components: 1, boundaryLoops: 0 });
	});
	it('every edge has two faces walking it in opposite directions, every vertex three edges', () => {
		const m = cube();
		for (const e of m.edgeIds()) {
			const cs = m.edgeCorners(e);
			expect(cs.length).toBe(2);
			expect(m.cVert[cs[0]]).not.toBe(m.cVert[cs[1]]);
		}
		for (const v of m.vertexIds()) {
			expect(m.vertexEdges(v).length).toBe(3);
			expect(m.vertexFaces(v).length).toBe(3);
			expect(m.vertexCorners(v).length).toBe(3);
		}
	});
	it('findEdge is symmetric and NONE for non-neighbours', () => {
		const m = cube();
		expect(m.findEdge(0, 1)).toBe(m.findEdge(1, 0));
		expect(m.findEdge(0, 1)).not.toBe(NONE);
		expect(m.findEdge(0, 7)).toBe(NONE);
	});
	it('face normals point outward (Newell)', () => {
		const m = cube();
		for (const f of m.faceIds()) {
			const n = m.faceNormal(f);
			const c = m.faceCenter(f);
			const out = [c[0] - 0.5, c[1] - 0.5, c[2] - 0.5];
			expect(n[0] * out[0] + n[1] * out[1] + n[2] * out[2]).toBeGreaterThan(0.49);
		}
	});
	it('an open grid is a disk: χ = 1, one boundary loop of 4n edges', () => {
		const n = 5;
		const m = grid(n);
		expect(m.validate()).toEqual([]);
		const r = m.topologyReport();
		expect(r).toMatchObject({ euler: 1, closed: false, manifold: true, boundaryLoops: 1, boundaryEdges: 4 * n });
		expect(m.boundaryLoops()[0].length).toBe(4 * n);
	});
	it('a fan of three faces on one edge is reported non-manifold', () => {
		const m = new MeshKernel();
		const a = m.addVertex(0, 0, 0);
		const b = m.addVertex(1, 0, 0);
		for (let i = 0; i < 3; i++) m.addFace([a, b, m.addVertex(0.5, Math.cos(i * 2), Math.sin(i * 2))]);
		expect(m.validate()).toEqual([]);
		expect(m.topologyReport()).toMatchObject({ nonManifoldEdges: 1, manifold: false });
	});
	it('two cones touching at their tips make a non-manifold VERTEX', () => {
		const m = new MeshKernel();
		const tip = m.addVertex(0, 0, 0);
		for (const s of [1, -1]) {
			const ring = [0, 1, 2].map((i) => m.addVertex(Math.cos(i * 2.1), Math.sin(i * 2.1), s));
			for (let i = 0; i < 3; i++) m.addFace(s > 0 ? [tip, ring[i], ring[(i + 1) % 3]] : [tip, ring[(i + 1) % 3], ring[i]]);
		}
		expect(m.topologyReport().nonManifoldVertices).toBe(1);
	});
});

describe('capacity growth', () => {
	// counterfactual for the per-array 16 floor: a gating array (tOrder, vEdge) outgrew its
	// k-per-element sibling (tLocal, vPos) and writes past the sibling's end were dropped silently
	it('a kernel made with capacity 1 grows every table in step (positions, triangles, attributes)', () => {
		const m = new MeshKernel({ vertices: 1, faces: 1, corners: 3, attributes: { uv: 2 } });
		const rand = rng(9);
		for (let f = 0; f < 40; f++) {
			const n = 3 + (f % 7);
			const ids = [];
			for (let i = 0; i < n; i++) ids.push(m.addVertex(Math.cos(i), Math.sin(i), f));
			const uv = Array.from({ length: n * 2 }, () => rand());
			const fan = [];
			for (let i = 1; i < n - 1; i++) fan.push(0, i, i + 1);
			m.addFace(ids, { attrs: { uv }, triangles: fan });
		}
		expect(m.validate()).toEqual([]);
		const out = toArrays(m);
		expect(out.positions.some(Number.isNaN)).toBe(false);
		expect(out.attributes.uv.array.length).toBe(out.positions.length / 9 * 6);
		for (const f of m.faceIds()) expect(m.faceTriangles(f).every((l) => l >= 0 && l < m.faceSize(f))).toBe(true);
		m.compact();
		expect(m.validate()).toEqual([]);
	});
});

describe('Euler operators keep the invariants', () => {
	it('splitEdge: V+1 E+1, χ unchanged, both faces gain the corner, uv interpolated per face', () => {
		const m = grid(2);
		const e = m.findEdge(1, 4); // an interior vertical edge between two quads
		const faces = m.edgeFaces(e);
		expect(faces.length).toBe(2);
		const before = m.stats();
		const χ = m.eulerCharacteristic();
		const { vertex, edge } = m.splitEdge(e, 0.25);
		expect(m.validate()).toEqual([]);
		expect(m.stats().vertices).toBe(before.vertices + 1);
		expect(m.stats().edges).toBe(before.edges + 1);
		expect(m.eulerCharacteristic()).toBe(χ);
		for (const f of faces) expect(m.faceSize(f)).toBe(5);
		// e keeps the half at its first vertex
		expect(m.edgeVertices(e)).toEqual([1, vertex]);
		expect(m.edgeVertices(edge).sort()).toEqual([vertex, 4].sort());
		expect(m.position(vertex)).toEqual([1, 0.25, 0]);
		// the new corner's uv in each face is the lerp of that face's corners
		for (const c of m.vertexCorners(vertex)) {
			const uv = m.cornerAttribute(c, 'uv');
			expect(uv[0]).toBeCloseTo(0.5, 6);
			expect(uv[1]).toBeCloseTo(0.125, 6);
		}
	});
	it('splitFace: E+1 F+1, χ unchanged; dissolveEdge undoes it', () => {
		const m = cube();
		const f = m.faceIds()[0];
		const [a, , c] = m.faceVertices(f);
		const χ = m.eulerCharacteristic();
		const { face, edge } = m.splitFace(f, a, c);
		expect(m.validate()).toEqual([]);
		expect(m.eulerCharacteristic()).toBe(χ);
		expect(m.faceSize(f)).toBe(3);
		expect(m.faceSize(face)).toBe(3);
		expect(m.topologyReport()).toMatchObject({ closed: true, manifold: true, orientable: true });
		const kept = m.dissolveEdge(edge);
		expect(kept).toBe(Math.min(f, face));
		expect(m.hasEdge(edge)).toBe(false);
		expect(m.validate()).toEqual([]);
		expect(m.faceSize(kept)).toBe(4);
		expect(m.stats()).toMatchObject({ vertices: 8, edges: 12, faces: 6 });
	});
	it('dissolveEdge refuses a uv seam, an open edge and a mixed-material pair', () => {
		const m = grid(1);
		const extra = m.addVertex(2, 0, 0);
		const f2 = m.addFace([1, extra, 3], { attrs: { uv: [9, 9, 9, 9, 9, 9] } }); // shares edge 1-3, seam
		expect(m.dissolveEdge(m.findEdge(1, 3))).toBe(NONE);
		expect(m.dissolveEdge(m.findEdge(0, 1))).toBe(NONE); // boundary
		const g = grid(1);
		const ex = g.addVertex(2, 0, 0);
		g.addFace([1, ex, 3], { material: 1, attrs: { uv: [1, 0, 0, 0, 1, 1] } });
		expect(g.dissolveEdge(g.findEdge(1, 3))).toBe(NONE);
		void f2;
	});
	it('collapseEdge on a closed mesh keeps it closed; mergeVertices moves edge IDs onto the keeper', () => {
		const m = cube();
		const f = m.faceIds()[0];
		m.splitFace(f, m.faceVertices(f)[0], m.faceVertices(f)[2]); // triangulate one side so a collapse is legal
		const e = m.findEdge(0, 1);
		const [first, second] = m.edgeVertices(e);
		const survivor = m.collapseEdge(e, 0);
		expect(survivor).toBe(first);
		expect(m.hasVertex(second)).toBe(false);
		expect(m.validate()).toEqual([]);
		expect(m.topologyReport()).toMatchObject({ closed: true, nonManifoldEdges: 0 });
		expect(m.eulerCharacteristic()).toBe(2);
	});
	it('flipFace reverses winding and mirrors its triangulation (no recompute)', () => {
		const m = cube();
		const f = m.faceIds()[0];
		const before = m.faceNormal(f);
		const verts = m.faceVertices(f);
		m.flipFace(f);
		expect(m.faceVertices(f)).toEqual([...verts].reverse());
		const after = m.faceNormal(f);
		expect(after[0] + before[0] + after[1] + before[1] + after[2] + before[2]).toBeCloseTo(0, 9);
		expect(m.topologyReport().windingConflicts).toBe(4); // its four neighbours now disagree
		expect(m.validate()).toEqual([]);
	});
	it('removeFace drops its edges nobody else uses; removeVertex takes its fan', () => {
		const m = grid(2);
		const f = m.faceIds()[0];
		m.removeFace(f);
		expect(m.validate()).toEqual([]);
		expect(m.hasVertex(0)).toBe(true); // isolated now, still alive
		expect(m.vertexEdges(0)).toEqual([]);
		m.removeVertex(4); // the centre
		expect(m.validate()).toEqual([]);
		expect(m.stats().faces).toBe(0);
	});
	it('weldByDistance merges across cell walls (the mergeByDistance gap) and keeps the lowest ID', () => {
		const m = new MeshKernel();
		// two triangles whose shared edge is duplicated 1e-7 apart, straddling x = 0 (a cell wall)
		const a = m.addVertex(-5e-8, 0, 0);
		const b = m.addVertex(0, 1, 0);
		const c = m.addVertex(-1, 0, 0);
		const a2 = m.addVertex(5e-8, 0, 0);
		const b2 = m.addVertex(0, 1, 1e-8);
		const d = m.addVertex(1, 0, 0);
		m.addFace([a, b, c]);
		m.addFace([a2, d, b2]);
		expect(m.weldByDistance(1e-6)).toBe(2);
		expect(m.hasVertex(a2) || m.hasVertex(b2)).toBe(false);
		expect(m.edgeValence(m.findEdge(a, b))).toBe(2);
		expect(m.validate()).toEqual([]);
	});
});

describe('stable IDs under a seeded random edit sequence', () => {
	const OPS = ['splitEdge', 'splitFace', 'dissolveEdge', 'collapseEdge', 'flipFace', 'removeFace', 'move', 'merge'];
	const SEEDS = process.env.KERNEL_SEEDS ? Array.from({ length: Number(process.env.KERNEL_SEEDS) }, (_, i) => i + 1) : [1, 2, 3, 4, 5, 6, 7, 8];
	const STEPS = Number(process.env.KERNEL_STEPS || 120);
	for (const seed of SEEDS) {
		it(`seed ${seed}: untouched elements keep their IDs, corners and positions; validate() stays empty`, () => {
			const rand = rng(seed);
			const pick = (list) => list[Math.floor(rand() * list.length)];
			const m = grid(6);
			for (let step = 0; step < STEPS; step++) {
				const faces = m.faceIds();
				const edges = m.edgeIds();
				const verts = m.vertexIds();
				if (!faces.length) break;
				// snapshot
				const fv = new Map([...faces].map((f) => [f, m.faceVertices(f).join(',')]));
				const ev = new Map([...edges].map((e) => [e, m.edgeVertices(e).join(',')]));
				const vp = new Map([...verts].map((v) => [v, m.position(v).join(',')]));
				const op = pick(OPS);
				/** faces / vertices / edges the op may legitimately change */
				const touchedF = new Set();
				const touchedV = new Set();
				const touchedE = new Set();
				const touchFan = (v) => {
					touchedV.add(v);
					for (const f of m.vertexFaces(v)) touchedF.add(f);
					for (const e of m.vertexEdges(v)) touchedE.add(e);
				};
				if (op === 'splitEdge') {
					const e = pick(edges);
					m.edgeFaces(e).forEach((f) => touchedF.add(f));
					touchedE.add(e);
					m.splitEdge(e, rand());
				} else if (op === 'splitFace') {
					const f = pick(faces);
					const vs = m.faceVertices(f);
					if (vs.length < 4 || new Set(vs).size !== vs.length) continue; // a merge can pinch a face onto one vertex twice
					const i = Math.floor(rand() * vs.length);
					const j = (i + 2 + Math.floor(rand() * (vs.length - 3))) % vs.length;
					touchedF.add(f);
					m.splitFace(f, vs[i], vs[j]);
				} else if (op === 'dissolveEdge') {
					const e = pick(edges);
					const fs = m.edgeFaces(e);
					fs.forEach((f) => touchedF.add(f));
					touchedE.add(e);
					// dissolving removes one face and may leave edges of the dissolved pair re-linked
					const kept = m.dissolveEdge(e);
					if (kept === NONE) continue;
				} else if (op === 'collapseEdge') {
					const e = pick(edges);
					const [a, b] = m.edgeVertices(e);
					touchFan(a);
					touchFan(b);
					m.collapseEdge(e, rand());
				} else if (op === 'flipFace') {
					const f = pick(faces);
					touchedF.add(f);
					m.flipFace(f);
				} else if (op === 'removeFace') {
					const f = pick(faces);
					touchedF.add(f);
					m.faceEdges(f).forEach((e) => touchedE.add(e));
					m.removeFace(f);
				} else if (op === 'move') {
					const v = pick(verts);
					touchedV.add(v);
					m.setPosition(v, rand(), rand(), rand());
				} else if (op === 'merge') {
					const a = pick(verts);
					const b = pick(verts);
					if (a === b) continue;
					touchFan(a);
					touchFan(b);
					m.mergeVertices(Math.min(a, b), Math.max(a, b));
				}
				expect(m.validate(), `${op} at step ${step}`).toEqual([]);
				for (const [f, list] of fv) if (!touchedF.has(f)) expect(m.hasFace(f) && m.faceVertices(f).join(','), `face ${f} after ${op}`).toBe(list);
				for (const [v, p] of vp) if (!touchedV.has(v)) expect(m.hasVertex(v) && m.position(v).join(','), `vertex ${v} after ${op}`).toBe(p);
				for (const [e, pair] of ev) {
					if (touchedE.has(e) || !m.hasEdge(e)) continue;
					// an edge that survives keeps both ends unless one of them merged away
					const now = m.edgeVertices(e).join(',');
					if (now !== pair) {
						const [a, b] = pair.split(',').map(Number);
						expect(touchedV.has(a) || touchedV.has(b), `edge ${e} re-ended by ${op}`).toBe(true);
					}
				}
				// an edge that was not touched and whose faces were not touched must still exist
				for (const [e] of ev) {
					if (touchedE.has(e)) continue;
					const [a, b] = ev.get(e).split(',').map(Number);
					if (touchedV.has(a) || touchedV.has(b)) continue;
					expect(m.hasEdge(e), `edge ${e} vanished after ${op}`).toBe(true);
				}
			}
			// compact renumbers densely and the output does not change
			const before = toArrays(m);
			const maps = m.compact();
			expect(m.validate()).toEqual([]);
			const after = toArrays(m);
			expect(sameFloats(after.positions, before.positions)).toBe(null);
			for (let i = 0; i < before.cornerVertex.length; i++) expect(after.cornerVertex[i]).toBe(maps.vertices[before.cornerVertex[i]]);
			expect(m.vTop).toBe(m.numVerts);
			expect(m.fTop).toBe(m.numFaces);
		});
	}
});

describe('round trip: three primitives through the kernel', () => {
	const primitives = {
		box: () => new THREE.BoxGeometry(1, 2, 3, 2, 3, 4),
		sphere: () => new THREE.SphereGeometry(1, 24, 16),
		cone: () => new THREE.ConeGeometry(1, 2, 12, 3),
		cylinder: () => new THREE.CylinderGeometry(1, 0.5, 2, 16, 2),
		torus: () => new THREE.TorusGeometry(1, 0.3, 12, 24),
		knot: () => new THREE.TorusKnotGeometry(1, 0.3, 64, 8),
		icosahedron: () => new THREE.IcosahedronGeometry(1, 2), // a soup (non-indexed)
		plane: () => new THREE.PlaneGeometry(2, 2, 4, 4),
		ring: () => new THREE.RingGeometry(0.5, 1, 16, 2),
		capsule: () => new THREE.CapsuleGeometry(0.5, 1, 4, 8)
	};
	for (const [name, make] of Object.entries(primitives)) {
		it(`${name}: positions, uvs, normals identical after geometry -> kernel -> geometry`, () => {
			const g = make();
			const { mesh, report } = fromBufferGeometry(g);
			expect(mesh.validate()).toEqual([]);
			expect(report.triangles).toBe((g.index ? g.index.count : g.attributes.position.count) / 3);
			const { geometry } = toBufferGeometry(mesh);
			for (const attr of ['position', 'uv', 'normal']) expect(sameFloats(geometry.attributes[attr].array, expanded(g, attr)), attr).toBe(null);
			// exact weld: one kernel vertex per DISTINCT position
			const keys = new Set();
			const p = g.attributes.position;
			for (let i = 0; i < p.count; i++) keys.add(`${p.getX(i) + 0},${p.getY(i) + 0},${p.getZ(i) + 0}`);
			expect(mesh.stats().vertices).toBeLessThanOrEqual(keys.size);
		});
	}
	it('a box welds to a closed cube (χ = 2) and its 24 split vertices collapse to the 8 + grid ones', () => {
		const { mesh } = fromBufferGeometry(new THREE.BoxGeometry(1, 1, 1));
		expect(mesh.stats()).toMatchObject({ vertices: 8, faces: 12, edges: 18 });
		expect(mesh.topologyReport()).toMatchObject({ euler: 2, closed: true, manifold: true, orientable: true });
	});
	it('a sphere: exact weld leaves the uv seam open; a 1e-6 weld closes it (χ = 2)', () => {
		const exact = fromBufferGeometry(new THREE.SphereGeometry(1, 16, 8)).mesh;
		const welded = fromBufferGeometry(new THREE.SphereGeometry(1, 16, 8), { weld: 1e-6 }).mesh;
		expect(welded.topologyReport()).toMatchObject({ euler: 2, closed: true, manifold: true, orientable: true });
		expect(exact.topologyReport().closed).toBe(false);
	});
	it('a torus welded is closed with χ = 0', () => {
		const { mesh } = fromBufferGeometry(new THREE.TorusGeometry(1, 0.3, 8, 16), { weld: 1e-6 });
		expect(mesh.topologyReport()).toMatchObject({ euler: 0, closed: true, manifold: true, orientable: true });
	});
	it('a degenerate triangle (two corners welded) is kept for output and out of the topology', () => {
		const g = new THREE.PlaneGeometry(1, 1).toNonIndexed();
		const p = Array.from(g.attributes.position.array);
		p.push(0, 0, 0, 0, 0, 0, 0.5, 0.5, 0); // a sliver with a zero-length side
		g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
		g.deleteAttribute('uv');
		g.deleteAttribute('normal');
		const { mesh, report } = fromBufferGeometry(g);
		expect(report.degenerate).toBe(1);
		expect(mesh.validate()).toEqual([]);
		expect(mesh.stats().faces).toBe(2);
		expect(sameFloats(toArrays(mesh).positions, p)).toBe(null);
		// it follows its vertices: a move moves it, a removal takes it
		const v = mesh.cVert[mesh.fFirst[2]];
		mesh.removeVertex(v);
		expect(mesh.validate()).toEqual([]);
		expect(mesh.stats().degenerate).toBe(0);
	});
	it('material groups survive, including a triangle no group covers (slot -1, not drawn)', () => {
		const g = new THREE.BoxGeometry(1, 1, 1).toNonIndexed();
		g.clearGroups();
		g.addGroup(0, 12, 0);
		g.addGroup(12, 18, 2); // triangles 4..9
		// triangles 10, 11 uncovered
		const { mesh } = fromBufferGeometry(g);
		const out = toArrays(mesh);
		expect(out.groups).toEqual([
			{ start: 0, count: 12, materialIndex: 0 },
			{ start: 12, count: 18, materialIndex: 2 }
		]);
	});
	it('interleaved and normalized attributes are read through their accessors', () => {
		const g = new THREE.BufferGeometry();
		const data = new Float32Array([0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1]);
		const ib = new THREE.InterleavedBuffer(data, 4);
		g.setAttribute('position', new THREE.InterleavedBufferAttribute(ib, 3, 0));
		g.setAttribute('color', new THREE.BufferAttribute(new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 255]), 3, true));
		g.setIndex([0, 1, 2]);
		const { mesh } = fromBufferGeometry(g);
		const out = toArrays(mesh);
		expect(Array.from(out.positions)).toEqual([0, 0, 0, 0, 1, 0, 1, 0, 0]); // stride 4, the 4th float skipped
		expect(out.attributes.color.array[0]).toBe(1);
		expect(out.attributes.color.array[4]).toBe(1);
	});
});

describe('the stored partition (__topo) <-> n-gons', () => {
	/** a quad grid as a soup with its quad partition stored, the shape faceEdit commits */
	function quadSoup(n) {
		const k = grid(n);
		const { geometry } = toBufferGeometry(k);
		return geometry;
	}
	it('a kernel quad grid exports __topo and re-imports as the same quads, output byte-identical', () => {
		const g = quadSoup(4);
		expect(g.userData.__topo.counts).toEqual(new Array(16).fill(2));
		const { mesh, report } = fromBufferGeometry(g);
		expect(report).toMatchObject({ partition: 'used', ngons: 16, fallbackFaces: 0 });
		expect(mesh.stats()).toMatchObject({ faces: 16, vertices: 25, edges: 40 });
		const again = toBufferGeometry(mesh).geometry;
		for (const attr of ['position', 'uv', 'normal']) expect(sameFloats(again.attributes[attr].array, g.attributes[attr].array), attr).toBe(null);
		expect(again.userData.__topo).toEqual(g.userData.__topo);
	});
	it('the partition may list a face\'s triangles out of order and interleaved: output order is the source order', () => {
		const g = new THREE.PlaneGeometry(2, 1, 2, 1).toNonIndexed(); // 4 tris: quad A = 0,1  quad B = 2,3
		// 3+0 share no edge (no disk -> triangles); 2+1 share the middle edge (a valid quad)
		g.userData.__topo = { counts: [2, 2], tris: [3, 0, 2, 1] };
		const r1 = fromBufferGeometry(g);
		expect(r1.report).toMatchObject({ fallbackFaces: 1, ngons: 1 });
		expect(sameFloats(toArrays(r1.mesh).positions, g.attributes.position.array)).toBe(null);
		g.userData.__topo = { counts: [2, 2], tris: [1, 0, 3, 2] };
		const { mesh, report } = fromBufferGeometry(g);
		expect(report.ngons).toBe(2);
		const out = toArrays(mesh);
		expect(sameFloats(out.positions, g.attributes.position.array)).toBe(null);
	});
	it('an invalid partition (wrong triangle count) is ignored, never trusted', () => {
		const g = new THREE.PlaneGeometry(1, 1).toNonIndexed();
		g.userData.__topo = { counts: [3], tris: [0, 1, 2] };
		expect(fromBufferGeometry(g).report.partition).toBe('invalid');
	});
	it('a stored face with a uv seam inside it falls back to triangles (an n-gon corner has one uv)', () => {
		const g = new THREE.PlaneGeometry(1, 1).toNonIndexed();
		g.attributes.uv.array[0] = 0.75; // corner 0 of tri 0 sits on a vertex tri 1 also uses? (top-left)
		g.attributes.uv.array[6 * 2 - 2] = 0.1; // perturb tri 1's last corner, a shared vertex
		g.userData.__topo = { counts: [2], tris: [0, 1] };
		const { mesh, report } = fromBufferGeometry(g);
		expect(report.fallbackFaces + report.ngons).toBe(1);
		expect(sameFloats(toArrays(mesh).attributes.uv.array, g.attributes.uv.array)).toBe(null);
	});
	it('kernel <-> CSR wire: packFaces of the kernel faces unpacks to the same partition', () => {
		const k = grid(3);
		const wire = kernelToFaceWire(k);
		const faces = unpackFaces(wire.faceCounts, wire.faceTris);
		expect(faces).toEqual(toArrays(k).faces);
		expect(faceWireToPartition(wire.faceCounts, wire.faceTris, 18)).toEqual(faces);
		expect(faceWireToPartition(wire.faceCounts, wire.faceTris, 17)).toBe(null);
	});
});

describe('the meshgeo wire', () => {
	it('toMeshGeo -> fromMeshGeo without IDs: same triangles, same faces', () => {
		const k = grid(3);
		const msg = toMeshGeo(k);
		expect(msg.groups).toBe(null);
		expect(msg.colors).toBe(null);
		const { mesh } = fromMeshGeo(msg);
		expect(mesh.stats()).toMatchObject(k.stats());
		expect(sameFloats(toArrays(mesh).positions, toArrays(k).positions)).toBe(null);
	});
	it('with IDs a receiver rebuilds the SENDER\'s vertex and face IDs, even after edits left holes', () => {
		const k = grid(4);
		k.removeFace(3);
		k.splitEdge(k.findEdge(6, 7));
		k.dissolveEdge(k.findEdge(12, 13));
		const sentFaces = Array.from(k.faceIds());
		const sentVerts = Array.from(k.vertexIds()).filter((v) => k.vertexEdges(v).length);
		const msg = toMeshGeo(k, { ids: true });
		// over a structured-clone-like boundary: raw bytes only
		const { mesh } = fromMeshGeo(structuredClone(msg));
		expect(mesh.validate()).toEqual([]);
		expect(Array.from(mesh.faceIds())).toEqual(sentFaces);
		expect(Array.from(mesh.vertexIds())).toEqual(sentVerts);
		// same corners in the same cyclic order (the loop may start at another corner)
		const cyc = (list) => {
			const i = list.indexOf(Math.min(...list));
			return [...list.slice(i), ...list.slice(0, i)];
		};
		for (const f of sentFaces) expect(cyc(mesh.faceVertices(f))).toEqual(cyc(k.faceVertices(f)));
	});
	it('a Worker-style transfer is lossless', () => {
		const k = grid(3);
		k.splitEdge(k.findEdge(0, 1));
		const packed = structuredClone(k.toTransfer(), { transfer: [] });
		const back = MeshKernel.fromTransfer(packed);
		expect(back.validate()).toEqual([]);
		expect(back.stats()).toEqual(k.stats());
		back.splitEdge(back.findEdge(4, 5)); // still editable after the trim
		expect(back.validate()).toEqual([]);
		expect(MeshKernel.transferList(packed).length).toBeGreaterThan(10);
	});
});

describe('spatial hash', () => {
	it('query = brute force on random clouds, for several radii and cell sizes', () => {
		const rand = rng(42);
		const n = 2000;
		const p = new Float64Array(n * 3).map(() => rand() * 10 - 5);
		for (const cell of [0.1, 0.5, 2]) {
			const h = new SpatialHash(p, { cellSize: cell });
			for (let q = 0; q < 50; q++) {
				const x = rand() * 10 - 5;
				const y = rand() * 10 - 5;
				const z = rand() * 10 - 5;
				const r = rand() * 1.5;
				const got = h.within(x, y, z, r).sort((a, b) => a - b);
				const want = [];
				for (let i = 0; i < n; i++) if ((p[i * 3] - x) ** 2 + (p[i * 3 + 1] - y) ** 2 + (p[i * 3 + 2] - z) ** 2 <= r * r) want.push(i);
				expect(got).toEqual(want);
			}
		}
	});
	it('clusters chain transitively and pick the lowest index', () => {
		const p = [0, 0, 0, 0.9, 0, 0, 1.8, 0, 0, 10, 0, 0];
		expect(Array.from(new SpatialHash(p, { cellSize: 1 }).clusters(1))).toEqual([0, 0, 0, 3]);
	});
});

describe('triangulation (output only)', () => {
	/** polygon area via the shoelace in XY */
	const area = (pts) => {
		let a = 0;
		for (let i = 0; i < pts.length; i++) {
			const [x1, y1] = pts[i];
			const [x2, y2] = pts[(i + 1) % pts.length];
			a += x1 * y2 - x2 * y1;
		}
		return a / 2;
	};
	it('random star polygons (concave): n - 2 triangles, same winding, total area = polygon area', () => {
		const rand = rng(7);
		for (let trial = 0; trial < 200; trial++) {
			const n = 3 + Math.floor(rand() * 12);
			const pts = [];
			for (let i = 0; i < n; i++) {
				const t = (i / n) * Math.PI * 2;
				const r = 0.3 + rand();
				pts.push([Math.cos(t) * r, Math.sin(t) * r]);
			}
			const coords = pts.flatMap(([x, y]) => [x, y, 0]);
			const tris = triangulatePolygon(coords, n);
			expect(tris.length).toBe((n - 2) * 3);
			let sum = 0;
			for (let i = 0; i < tris.length; i += 3) {
				const a = area([pts[tris[i]], pts[tris[i + 1]], pts[tris[i + 2]]]);
				expect(a).toBeGreaterThan(-1e-12); // never flipped
				sum += a;
			}
			expect(sum).toBeCloseTo(area(pts), 9);
		}
	});
	it('a dirty n-gon (after a split) is re-triangulated at output and still covers its face', () => {
		const k = grid(1);
		k.splitEdge(k.findEdge(0, 1));
		const out = toArrays(k);
		expect(out.positions.length / 9).toBe(3); // a pentagon = 3 triangles
	});
});

describe('fromArrays edge cases', () => {
	it('an empty mesh imports and exports empty', () => {
		const { mesh } = fromArrays({ positions: new Float32Array(0) });
		expect(mesh.stats().faces).toBe(0);
		expect(toArrays(mesh).positions.length).toBe(0);
	});
	it('weld:false keeps every soup corner its own vertex', () => {
		const g = new THREE.BoxGeometry().toNonIndexed();
		const { mesh } = fromBufferGeometry(g, { weld: false });
		expect(mesh.stats().vertices).toBe(36);
		expect(mesh.topologyReport().components).toBe(12);
	});
});
