// @ts-nocheck — fixture meshes built ad hoc (the checkJs rule for test fixtures)
// Roadmap 99 K8 (lane 99-newops): shortest-path select on the kernel. The path is checked against a brute-force
// Bellman-Ford on the same graph (its LENGTH must be minimal, every step must be adjacent), for vertices, edges and
// faces, by length and by step count, on a bumpy grid and a cube; ties are deterministic; 67k timing.
import { describe, it, expect } from 'vitest';
import { MeshKernel } from '$lib/meshKernel/index.js';
import { vertexPath, edgePath, facePath, shortestPath } from '$lib/meshKernel/shortestPath.js';

function grid(n, z = () => 0) {
	const m = new MeshKernel();
	for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) m.addVertex(i, j, z(i, j));
	for (let j = 0; j < n; j++)
		for (let i = 0; i < n; i++) {
			const a = j * (n + 1) + i;
			m.addFace([a, a + 1, a + n + 2, a + n + 1]);
		}
	return m;
}

/** all-pairs-free reference: Bellman-Ford distances from `from` over an adjacency function */
function reference(size, from, neighbours) {
	const d = new Array(size).fill(Infinity);
	d[from] = 0;
	for (let it = 0; it < size; it++) {
		let changed = false;
		for (let u = 0; u < size; u++) {
			if (d[u] === Infinity) continue;
			for (const [v, w] of neighbours(u))
				if (d[u] + w < d[v] - 1e-12) {
					d[v] = d[u] + w;
					changed = true;
				}
		}
		if (!changed) break;
	}
	return d;
}

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const mid = (m, e) => {
	const [a, b] = m.edgeVertices(e).map((v) => m.position(v));
	return a.map((x, k) => (x + b[k]) / 2);
};

describe('99 K8 shortest path', () => {
	const bumpy = () => grid(6, (i, j) => Math.sin(i * 1.3) * Math.cos(j * 0.7) * 1.5);

	it('vertices: minimal by length and by steps, every step an edge', () => {
		const m = bumpy();
		const nb = (u, topo) => m.vertexEdges(u).map((e) => { const v = m.otherVertex(e, u); return [v, topo ? 1 : dist(m.position(u), m.position(v))]; });
		for (const topo of [false, true]) {
			const ref = reference(m.vTop, 0, (u) => nb(u, topo));
			for (const to of [6, 48, 30, 17]) {
				const p = vertexPath(m, 0, to, { topological: topo });
				expect(p.vertices[0]).toBe(0);
				expect(p.vertices.at(-1)).toBe(to);
				let len = 0;
				p.edges.forEach((e, i) => {
					expect(e).not.toBe(-1);
					len += topo ? 1 : dist(m.position(p.vertices[i]), m.position(p.vertices[i + 1]));
				});
				expect(len).toBeCloseTo(ref[to], 9);
			}
		}
	});

	it('edges: minimal midpoint-to-midpoint, consecutive edges share a vertex', () => {
		const m = bumpy();
		const edges = m.edgeIds();
		const from = edges[0];
		const nb = (u, topo) => {
			const out = [];
			for (const v of m.edgeVertices(u)) for (const e of m.vertexEdges(v)) if (e !== u) out.push([e, topo ? 1 : dist(mid(m, u), mid(m, e))]);
			return out;
		};
		for (const topo of [false, true]) {
			const ref = reference(m.eTop, from, (u) => (m.hasEdge(u) ? nb(u, topo) : []));
			for (const to of [edges.at(-1), edges[40], edges[23]]) {
				const p = edgePath(m, from, to, { topological: topo }).edges;
				let len = 0;
				for (let i = 1; i < p.length; i++) {
					const shared = m.edgeVertices(p[i - 1]).filter((v) => m.edgeVertices(p[i]).includes(v));
					expect(shared.length).toBe(1);
					len += topo ? 1 : dist(mid(m, p[i - 1]), mid(m, p[i]));
				}
				expect(len).toBeCloseTo(ref[to], 9);
			}
		}
	});

	it('faces: minimal centre-to-centre across shared edges', () => {
		const m = bumpy();
		const nb = (u, topo) => m.faceNeighbors(u).map((g) => [g, topo ? 1 : dist(m.faceCenter(u), m.faceCenter(g))]);
		for (const topo of [false, true]) {
			const ref = reference(m.fTop, 0, (u) => nb(u, topo));
			for (const to of [35, 5, 30, 14]) {
				const p = facePath(m, 0, to, { topological: topo }).faces;
				let len = 0;
				for (let i = 1; i < p.length; i++) {
					expect(m.faceNeighbors(p[i - 1])).toContain(p[i]);
					len += topo ? 1 : dist(m.faceCenter(p[i - 1]), m.faceCenter(p[i]));
				}
				expect(len).toBeCloseTo(ref[to], 9);
			}
		}
	});

	it('deterministic on ties; unreachable = null; same element = itself; a filter fences the path', () => {
		const m = grid(4);
		const a = shortestPath(m, 'vertex', 0, 24, { topological: true });
		for (let k = 0; k < 5; k++) expect(shortestPath(m, 'vertex', 0, 24, { topological: true })).toEqual(a);
		expect(a.length).toBe(9);
		expect(shortestPath(m, 'face', 3, 3)).toEqual([3]);
		// a second, disconnected quad
		const v = [m.addVertex(9, 9, 0), m.addVertex(10, 9, 0), m.addVertex(10, 10, 0), m.addVertex(9, 10, 0)];
		const f = m.addFace(v);
		expect(shortestPath(m, 'face', 0, f)).toBeNull();
		expect(shortestPath(m, 'vertex', 0, v[0])).toBeNull();
		// fence: faces of column 1 are off limits, so 0 -> 2 goes round
		const open = shortestPath(m, 'face', 0, 2);
		expect(open).toEqual([0, 1, 2]);
		const fenced = shortestPath(m, 'face', 0, 2, { filter: (g) => g % 4 !== 1 || g >= 12 });
		expect(fenced.length).toBeGreaterThan(3);
		expect(fenced.includes(1)).toBe(false);
	});

	it(`timing: corner to corner on a ${process.env.MESHOPS_BIG === '1' ? '67k' : '8k'}-triangle grid`, () => {
		const n = process.env.MESHOPS_BIG === '1' ? 183 : 64;
		const m = grid(n, (i, j) => Math.sin(i * 0.2) * Math.cos(j * 0.3));
		const out = [];
		for (const kind of ['vertex', 'edge', 'face']) {
			const ids = kind === 'vertex' ? m.vertexIds() : kind === 'edge' ? m.edgeIds() : m.faceIds();
			const t0 = performance.now();
			const p = shortestPath(m, kind, ids[0], ids.at(-1));
			const ms = performance.now() - t0;
			expect(p.length).toBeGreaterThan(n);
			out.push(`${kind} ${ms.toFixed(0)} ms`);
			expect(ms).toBeLessThan(5000);
		}
		console.log(`[99 K8] shortest path ${n * n * 2} tris: ${out.join(', ')}`);
	});
});
