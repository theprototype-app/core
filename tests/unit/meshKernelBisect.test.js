// @ts-nocheck — fixture meshes built ad hoc (the checkJs rule for test fixtures)
// Roadmap 99 K8 (lane 99-newops): bisect on the kernel — a cube, a grid with uvs, a concave n-gon, a partial pick,
// clear + fill (closed again: Euler 2, manifold), IDs kept, 67k timing.
import { describe, it, expect } from 'vitest';
import { MeshKernel } from '$lib/meshKernel/index.js';
import { bisect } from '$lib/meshKernel/bisect.js';

function cube(uv = false) {
	const m = new MeshKernel(uv ? { attributes: { uv: 2 } } : {});
	for (const p of [[-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1], [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]]) m.addVertex(...p);
	for (const f of [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [2, 3, 7, 6], [1, 2, 6, 5], [0, 4, 7, 3]])
		m.addFace(f, uv ? { attrs: { uv: [0, 0, 1, 0, 1, 1, 0, 1] } } : {});
	return m;
}
function grid(n, uv = true) {
	const m = new MeshKernel(uv ? { attributes: { uv: 2 } } : {});
	for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) m.addVertex(i, j, Math.sin(i) * 0.2);
	for (let j = 0; j < n; j++)
		for (let i = 0; i < n; i++) {
			const a = j * (n + 1) + i;
			const q = [a, a + 1, a + n + 2, a + n + 1];
			m.addFace(q, uv ? { attrs: { uv: q.flatMap((v) => [(v % (n + 1)) / n, Math.floor(v / (n + 1)) / n]) } } : {});
		}
	return m;
}
const plane = (point, normal) => ({ point, normal });

describe('99 K8 bisect', () => {
	it('a cube at z = 0.3: four crossings, four walls split, IDs kept', () => {
		const m = cube();
		const r = bisect(m, plane([0, 0, 0.3], [0, 0, 1]));
		expect(m.validate()).toEqual([]);
		expect(r.cutVertices.length).toBe(4);
		expect(r.newFaces.length).toBe(4);
		expect(r.cutEdges.length).toBe(4); // one chord per wall
		for (let v = 0; v < 8; v++) expect(m.hasVertex(v)).toBe(true);
		for (let f = 0; f < 6; f++) expect(m.hasFace(f)).toBe(true);
		for (const v of r.cutVertices) expect(m.position(v)[2]).toBeCloseTo(0.3, 12);
		expect(m.faceIds().length).toBe(10);
		expect(m.topologyReport().euler).toBe(2);
	});

	it('clear outer + fill: a closed box again, under the plane, the cap facing +z', () => {
		const m = cube(true);
		const r = bisect(m, plane([0, 0, 0.3], [0, 0, 1]), { clear: 'outer', fill: true });
		expect(m.validate()).toEqual([]);
		const rep = m.topologyReport();
		expect(rep.closed).toBe(true);
		expect(rep.manifold).toBe(true);
		expect(rep.euler).toBe(2);
		expect(rep.windingConflicts).toBe(0);
		expect(r.filled.length).toBe(1);
		expect(m.faceNormal(r.filled[0])[2]).toBeCloseTo(1, 9);
		for (const v of m.vertexIds()) expect(m.position(v)[2]).toBeLessThanOrEqual(0.3 + 1e-12);
		// uvs of the cap in the unit square
		for (const c of m.faceCorners(r.filled[0])) for (const x of m.cornerAttribute(c, 'uv')) expect(x).toBeGreaterThanOrEqual(-1e-9);
	});

	it('clear inner + fill on a slanted plane: cap faces -n', () => {
		const m = cube();
		const n = [1, 1, 0.5];
		const r = bisect(m, plane([0.2, 0, 0], n), { clear: 'inner', fill: true });
		expect(m.validate()).toEqual([]);
		const rep = m.topologyReport();
		expect(rep.closed).toBe(true);
		expect(rep.euler).toBe(2);
		expect(r.filled.length).toBe(1);
		const fn = m.faceNormal(r.filled[0]);
		expect(fn[0] * n[0] + fn[1] * n[1] + fn[2] * n[2]).toBeLessThan(0);
	});

	it('uvs are lerped at the crossing like the knife (per face)', () => {
		const m = grid(4);
		const r = bisect(m, plane([1.5, 0, 0], [1, 0, 0]));
		expect(m.validate()).toEqual([]);
		for (const v of r.cutVertices)
			for (const c of m.vertexCorners(v)) expect(m.cornerAttribute(c, 'uv')[0]).toBeCloseTo(1.5 / 4, 6);
	});

	it('a vertex on the plane makes no sliver; a pick bisects only itself and its neighbours gain the corner', () => {
		const m = grid(4, false);
		const before = m.faceIds().length;
		bisect(m, plane([2, 0, 0], [1, 0, 0])); // through a column of vertices: nothing to split
		expect(m.faceIds().length).toBe(before);
		const g = grid(4, false);
		const r = bisect(g, plane([1.5, 0, 0], [1, 0, 0]), { faces: [5] });
		expect(g.validate()).toEqual([]);
		expect(r.newFaces.length).toBe(1);
		expect(r.cutVertices.length).toBe(2);
		expect(g.faceSize(1)).toBe(5); // the neighbour below gained the crossing
		expect(g.faceSize(9)).toBe(5);
	});

	it('a concave U-shaped n-gon crossing the plane four times splits into three', () => {
		const m = new MeshKernel();
		const pts = [[0, 0], [3, 0], [3, 3], [2, 3], [2, 1], [1, 1], [1, 3], [0, 3]];
		for (const [x, y] of pts) m.addVertex(x, y, 0);
		m.addFace([0, 1, 2, 3, 4, 5, 6, 7]);
		const r = bisect(m, plane([0, 2, 0], [0, 1, 0]));
		expect(m.validate()).toEqual([]);
		expect(r.cutVertices.length).toBe(4);
		expect(m.faceIds().length).toBe(3);
	});

	it(`timing: ${process.env.MESHOPS_BIG === '1' ? '67k' : '8k'} triangles, a diagonal cut`, () => {
		const n = process.env.MESHOPS_BIG === '1' ? 183 : 64;
		const m = grid(n);
		const t0 = performance.now();
		const r = bisect(m, plane([n / 2, n / 2, 0], [1, 0.7, 0.2]), { clear: 'outer' });
		const ms = performance.now() - t0;
		expect(r.cutVertices.length).toBeGreaterThan(n);
		console.log(`[99 K8] bisect ${n * n * 2} tris: ${ms.toFixed(0)} ms`);
		expect(ms).toBeLessThan(10000);
	});
});
