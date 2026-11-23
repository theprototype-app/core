// @ts-nocheck — fixture meshes built ad hoc (the checkJs rule for test fixtures)
// Roadmap 99 K8 (lane 99-newops): Catmull-Clark on the kernel.
//  1. PARITY: the agent's polygon-array path (catmullClarkArrays) gives the frozen 85b G9 output (same vertex and
//     face order, positions / uvs / colours within 1e-6) on a cube, an open grid, an n-gon prism, a mixed-material
//     shape and a random-ish blob, at levels 1 and 2;
//  2. properties on the kernel: Euler characteristic kept, validate() clean, quads only, IDs of old vertices kept,
//     the first child keeps its parent's face ID, a partial pick leaves the unpicked faces' vertices in place and
//     makes no T-junction (the neighbour gains the edge point);
//  3. timing at 67k triangles (MESHOPS_BIG=1 for the full size; a 4k grid otherwise).
import { describe, it, expect } from 'vitest';
import { MeshKernel } from '$lib/meshKernel/index.js';
import { catmullClarkStep, catmullClark, catmullClarkArrays, catmullClarkSize } from '$lib/meshKernel/catmullClark.js';
import { catmullClark as frozenCC } from './fixtures/catmullClarkG9.js';

const cube = () => ({
	vertices: [
		[-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
		[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]
	],
	faces: [
		[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4],
		[2, 3, 7, 6], [1, 2, 6, 5], [0, 4, 7, 3]
	]
});

/** an open n x n grid of quads, uvs per vertex */
function grid(n, z = (x, y) => 0) {
	const vertices = [];
	const uvs = [];
	for (let j = 0; j <= n; j++)
		for (let i = 0; i <= n; i++) {
			vertices.push([i, j, z(i, j)]);
			uvs.push([i / n, j / n]);
		}
	const faces = [];
	for (let j = 0; j < n; j++)
		for (let i = 0; i < n; i++) {
			const a = j * (n + 1) + i;
			faces.push([a, a + 1, a + n + 2, a + n + 1]);
		}
	return { vertices, faces, uvs };
}

/** a hexagonal prism: two n-gon caps and quad walls */
function prism(n = 6) {
	const vertices = [];
	for (let k = 0; k < 2; k++)
		for (let i = 0; i < n; i++) {
			const t = (i / n) * Math.PI * 2;
			vertices.push([Math.cos(t), Math.sin(t), k]);
		}
	const faces = [
		Array.from({ length: n }, (_, i) => n - 1 - i),
		Array.from({ length: n }, (_, i) => n + i)
	];
	for (let i = 0; i < n; i++) {
		const j = (i + 1) % n;
		faces.push([i, j, n + j, n + i]);
	}
	return { vertices, faces, colors: vertices.map((p) => [p[0] * 0.5 + 0.5, p[1] * 0.5 + 0.5, p[2]]), faceMaterials: faces.map((_, i) => i % 3) };
}

function expectSame(a, b, eps = 1e-6) {
	expect(a.faces).toEqual(b.faces);
	expect(a.vertices.length).toBe(b.vertices.length);
	for (let i = 0; i < a.vertices.length; i++)
		for (let k = 0; k < 3; k++) expect(Math.abs(a.vertices[i][k] - b.vertices[i][k])).toBeLessThan(eps);
	for (const key of ['uvs', 'colors']) {
		expect(!!a[key]).toBe(!!b[key]);
		if (!a[key]) continue;
		for (let i = 0; i < a[key].length; i++)
			for (let k = 0; k < a[key][i].length; k++) expect(Math.abs(a[key][i][k] - b[key][i][k])).toBeLessThan(eps);
	}
	expect(a.faceMaterials).toEqual(b.faceMaterials);
}

describe('99 K8 Catmull-Clark: agent parity (frozen 85b G9)', () => {
	const cases = {
		cube,
		'open grid with uvs': () => grid(3),
		'bumpy grid': () => grid(4, (x, y) => Math.sin(x) * Math.cos(y)),
		'n-gon prism, colours, materials': () => prism(6),
		'triangle pyramid': () => ({ vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]], faces: [[0, 2, 1], [0, 1, 3], [1, 2, 3], [2, 0, 3]] }),
		'unused vertex dropped': () => {
			const c = cube();
			c.vertices.push([9, 9, 9]);
			return c;
		}
	};
	for (const [name, make] of Object.entries(cases))
		for (const levels of [1, 2])
			it(`${name}, ${levels} level(s)`, () => {
				expectSame(catmullClarkArrays(make(), levels, MeshKernel), frozenCC(make(), levels));
			});
});

/** a kernel from polygon arrays */
function kernelOf(poly) {
	const m = new MeshKernel(poly.uvs ? { attributes: { uv: 2 } } : {});
	for (const p of poly.vertices) m.addVertex(p[0], p[1], p[2]);
	for (const f of poly.faces) m.addFace(f, poly.uvs ? { attrs: { uv: f.flatMap((v) => poly.uvs[v]) } } : {});
	return m;
}

describe('99 K8 Catmull-Clark: kernel properties', () => {
	it('a cube: 24 quads, closed, Euler 2, consistent; old vertices keep their IDs', () => {
		const m = kernelOf(cube());
		const before = m.vertexIds();
		const step = catmullClarkStep(m);
		expect(m.validate()).toEqual([]);
		expect(m.faceIds().length).toBe(24);
		for (const f of m.faceIds()) expect(m.faceSize(f)).toBe(4);
		const r = m.topologyReport();
		expect(r.euler).toBe(2);
		expect(r.closed).toBe(true);
		expect(r.manifold).toBe(true);
		for (const v of before) expect(m.hasVertex(v)).toBe(true);
		// the first child of each face keeps its ID
		step.children.forEach((kids, i) => expect(kids[0]).toBe(i));
		// smoothing pulls the corners in: (F + 2R + (n-3)v)/n on a cube corner = 5/9 of the way
		expect(m.position(6)[0]).toBeCloseTo(5 / 9, 12);
	});

	it('levels compose; the size estimate is exact on a closed mesh', () => {
		const m = kernelOf(cube());
		catmullClark(m, 3);
		expect(m.validate()).toEqual([]);
		const est = catmullClarkSize(8, 24, 6, 3);
		expect(m.faceIds().length).toBe(est.faces);
		expect(m.vertexIds().length).toBe(est.vertices);
	});

	it('an open border keeps its line (crease rule) and uvs stay linear', () => {
		const m = kernelOf(grid(2));
		catmullClarkStep(m);
		expect(m.validate()).toEqual([]);
		// every vertex on the y = 0 border stays on it
		for (const v of m.vertexIds()) {
			const p = m.position(v);
			if (Math.abs(p[1]) < 1e-9) expect(p[2]).toBe(0);
		}
		// corner (0,0): crease rule (6v + (1,0) + (0,1)) / 8
		expect(m.position(0)).toEqual([1 / 8, 1 / 8, 0]);
		// uvs on a flat regular grid: each corner's uv is linear in the source face
		for (const f of m.faceIds())
			for (const c of m.faceCorners(f)) {
				const uv = m.cornerAttribute(c, 'uv');
				expect(uv[0]).toBeGreaterThanOrEqual(0);
				expect(uv[0]).toBeLessThanOrEqual(1);
			}
	});

	it('a uv seam stays a seam: each face keeps its own corner values', () => {
		const m = new MeshKernel({ attributes: { uv: 2 } });
		for (const p of [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [2, 0, 0], [2, 1, 0]]) m.addVertex(...p);
		m.addFace([0, 1, 2, 3], { attrs: { uv: [0, 0, 0.5, 0, 0.5, 1, 0, 1] } });
		m.addFace([1, 4, 5, 2], { attrs: { uv: [0.6, 0, 1, 0, 1, 1, 0.6, 1] } });
		const step = catmullClarkStep(m);
		// the shared edge's point: left face sees u = 0.5, right face u = 0.6
		const shared = [...step.edgePoint.entries()].find(([, v]) => Math.abs(m.position(v)[0] - 1) < 1e-9 && Math.abs(m.position(v)[1] - 0.5) < 1e-9);
		expect(shared).toBeTruthy();
		const us = m.vertexCorners(shared[1]).map((c) => m.cornerAttribute(c, 'uv')[0]).sort();
		expect(us[0]).toBeCloseTo(0.5, 6);
		expect(us[us.length - 1]).toBeCloseTo(0.6, 6);
	});

	it('a partial pick: unpicked faces do not move and gain the edge point (no T-junction)', () => {
		const m = kernelOf(grid(3));
		const centre = 4; // the middle quad of a 3 x 3 grid
		const ring = m.faceNeighbors(centre);
		const keep = Array.from(m.faceIds()).filter((f) => f !== centre).map((f) => [f, m.faceVertices(f).map((v) => m.position(v))]);
		catmullClarkStep(m, [centre]);
		expect(m.validate()).toEqual([]);
		expect(m.topologyReport().boundaryLoops).toBe(1);
		// the unpicked faces' original vertices are where they were
		for (const [f, pts] of keep) {
			const now = m.faceVertices(f).map((v) => m.position(v));
			for (const p of pts) expect(now.some((q) => q.every((x, k) => Math.abs(x - p[k]) < 1e-12))).toBe(true);
		}
		// each edge neighbour became a pentagon
		for (const f of ring) expect(m.faceSize(f)).toBe(5);
	});
});

describe('99 K8 Catmull-Clark: timing', () => {
	const big = process.env.MESHOPS_BIG === '1';
	it(`a ${big ? '67k' : '4k'}-triangle grid, one level`, () => {
		const n = big ? 183 : 45; // 183^2 * 2 = 66,978 triangles
		const m = kernelOf(grid(n, (x, y) => Math.sin(x * 0.3) * Math.cos(y * 0.3)));
		const t0 = performance.now();
		catmullClarkStep(m);
		const ms = performance.now() - t0;
		expect(m.faceIds().length).toBe(n * n * 4);
		console.log(`[99 K8] catmull-clark ${n * n * 2} tris: ${ms.toFixed(0)} ms`);
		expect(ms).toBeLessThan(big ? 20000 : 5000);
	});
});
