// @ts-check
// Roadmap 99 K8 (lane 99-newops): SHORTEST-PATH SELECT on the kernel — the path between two picked elements of one
// kind: vertices along edges, edges through shared vertices, faces across shared edges. Cost = EDGE LENGTH (the
// distance between vertices, edge midpoints, face centres) or TOPOLOGICAL (one per step). Dijkstra on a binary heap
// over typed arrays, stopped when the target is settled; ties go to the lower ID, so two peers (and a re-run) pick
// the same path. Pure: no three.js, no stores.

import { NONE } from './kernel.js';

/** @typedef {import('./kernel.js').MeshKernel} MeshKernel */
/** @typedef {'vertex' | 'edge' | 'face'} PathKind */
/** @typedef {{ topological?: boolean, filter?: (id: number) => boolean }} PathOptions
 * `filter` = an element the path may use (the target and the source always may) */

/** a min-heap of (cost, id) on two growable typed arrays; ties pop the lower id */
class Heap {
	constructor() {
		this.cost = new Float64Array(64);
		this.id = new Int32Array(64);
		this.n = 0;
	}
	/** (c, i) sorts before slot j @param {number} c @param {number} i @param {number} j */
	before(c, i, j) {
		return c < this.cost[j] || (c === this.cost[j] && i < this.id[j]);
	}
	/** @param {number} c @param {number} id */
	push(c, id) {
		if (this.n === this.cost.length) {
			const cost = new Float64Array(this.n * 2);
			cost.set(this.cost);
			const ids = new Int32Array(this.n * 2);
			ids.set(this.id);
			this.cost = cost;
			this.id = ids;
		}
		let k = this.n++;
		while (k > 0) {
			const p = (k - 1) >> 1;
			if (!this.before(c, id, p)) break;
			this.cost[k] = this.cost[p];
			this.id[k] = this.id[p];
			k = p;
		}
		this.cost[k] = c;
		this.id[k] = id;
	}
	/** @returns {number} the id with the lowest cost */
	pop() {
		const top = this.id[0];
		const n = --this.n;
		const c = this.cost[n];
		const id = this.id[n];
		let k = 0;
		for (;;) {
			const l = k * 2 + 1;
			if (l >= n) break;
			const r = l + 1;
			const m = r < n && this.before(this.cost[r], this.id[r], l) ? r : l;
			if (!(this.cost[m] < c || (this.cost[m] === c && this.id[m] < id))) break;
			this.cost[k] = this.cost[m];
			this.id[k] = this.id[m];
			k = m;
		}
		this.cost[k] = c;
		this.id[k] = id;
		return top;
	}
}

/**
 * Dijkstra from `from` to `to` over `size` nodes; `visit(u, emit)` calls emit(v, stepCost) per neighbour.
 * @param {number} size @param {number} from @param {number} to
 * @param {(u: number, emit: (v: number, w: number) => void) => void} visit
 * @returns {number[] | null} from .. to, or null when `to` cannot be reached
 */
function dijkstra(size, from, to, visit) {
	const dist = new Float64Array(size).fill(Infinity);
	const prev = new Int32Array(size).fill(NONE);
	const done = new Uint8Array(size);
	const heap = new Heap();
	dist[from] = 0;
	heap.push(0, from);
	/** @type {number} */
	let u = NONE;
	const emit = (/** @type {number} */ v, /** @type {number} */ w) => {
		if (done[v]) return;
		const d = dist[u] + w;
		// a tie keeps the predecessor with the lower id (deterministic)
		if (d < dist[v] || (d === dist[v] && u < prev[v])) {
			dist[v] = d;
			prev[v] = u;
			heap.push(d, v);
		}
	};
	while (heap.n) {
		u = heap.pop();
		if (done[u]) continue;
		done[u] = 1;
		if (u === to) break;
		visit(u, emit);
	}
	if (!done[to]) return null;
	/** @type {number[]} */
	const path = [];
	for (let x = to; x !== NONE; x = prev[x]) path.push(x);
	return path.reverse();
}

/** @param {Float64Array} P @param {number} a @param {number} b */
function dist3(P, a, b) {
	return Math.hypot(P[a] - P[b], P[a + 1] - P[b + 1], P[a + 2] - P[b + 2]);
}

/**
 * The shortest path between two vertices along edges. @param {MeshKernel} mesh @param {number} from
 * @param {number} to @param {PathOptions} [options] @returns {{ vertices: number[], edges: number[] } | null}
 */
export function vertexPath(mesh, from, to, options = {}) {
	if (!mesh.hasVertex(from) || !mesh.hasVertex(to)) return null;
	const P = mesh.vPos;
	const ok = options.filter;
	const topo = !!options.topological;
	const path = dijkstra(mesh.vTop, from, to, (u, emit) => {
		for (const e of mesh.vertexEdges(u)) {
			const v = mesh.otherVertex(e, u);
			if (ok && v !== to && !ok(v)) continue;
			emit(v, topo ? 1 : dist3(P, u * 3, v * 3));
		}
	});
	if (!path) return null;
	const edges = [];
	for (let i = 1; i < path.length; i++) edges.push(mesh.findEdge(path[i - 1], path[i]));
	return { vertices: path, edges };
}

/** an edge's midpoint into out[0..2] @param {MeshKernel} mesh @param {number} e @param {Float64Array} out @param {number} o */
function midpoint(mesh, e, out, o) {
	const P = mesh.vPos;
	const a = mesh.eVert[e * 2] * 3;
	const b = mesh.eVert[e * 2 + 1] * 3;
	out[o] = (P[a] + P[b]) / 2;
	out[o + 1] = (P[a + 1] + P[b + 1]) / 2;
	out[o + 2] = (P[a + 2] + P[b + 2]) / 2;
}

/**
 * The shortest chain of edges between two edges, stepping through shared vertices (cost: midpoint to midpoint).
 * @param {MeshKernel} mesh @param {number} from @param {number} to @param {PathOptions} [options]
 * @returns {{ edges: number[] } | null}
 */
export function edgePath(mesh, from, to, options = {}) {
	if (!mesh.hasEdge(from) || !mesh.hasEdge(to)) return null;
	const ok = options.filter;
	const topo = !!options.topological;
	const mid = new Float64Array(6);
	const path = dijkstra(mesh.eTop, from, to, (u, emit) => {
		midpoint(mesh, u, mid, 0);
		for (let s = 0; s < 2; s++)
			for (const e of mesh.vertexEdges(mesh.eVert[u * 2 + s])) {
				if (e === u || (ok && e !== to && !ok(e))) continue;
				if (topo) emit(e, 1);
				else {
					midpoint(mesh, e, mid, 3);
					emit(e, Math.hypot(mid[0] - mid[3], mid[1] - mid[4], mid[2] - mid[5]));
				}
			}
	});
	return path ? { edges: path } : null;
}

/**
 * The shortest chain of faces between two faces, stepping across shared edges (cost: centre to centre).
 * @param {MeshKernel} mesh @param {number} from @param {number} to @param {PathOptions} [options]
 * @returns {{ faces: number[] } | null}
 */
export function facePath(mesh, from, to, options = {}) {
	if (!mesh.hasFace(from) || !mesh.hasFace(to)) return null;
	const ok = options.filter;
	const topo = !!options.topological;
	/** face centres, computed on first touch */
	const C = new Float64Array(mesh.fTop * 3);
	const have = new Uint8Array(mesh.fTop);
	const centre = (/** @type {number} */ f) => {
		if (!have[f]) {
			const c = mesh.faceCenter(f);
			C[f * 3] = c[0];
			C[f * 3 + 1] = c[1];
			C[f * 3 + 2] = c[2];
			have[f] = 1;
		}
		return f * 3;
	};
	const path = dijkstra(mesh.fTop, from, to, (u, emit) => {
		const cu = centre(u);
		for (const g of mesh.faceNeighbors(u)) {
			if (g === u || (ok && g !== to && !ok(g))) continue;
			emit(g, topo ? 1 : dist3(C, cu, centre(g)));
		}
	});
	return path ? { faces: path } : null;
}

/**
 * One entry for the three kinds. @param {MeshKernel} mesh @param {PathKind} kind @param {number} from
 * @param {number} to @param {PathOptions} [options] @returns {number[] | null} the element IDs from .. to
 */
export function shortestPath(mesh, kind, from, to, options = {}) {
	if (kind === 'vertex') return vertexPath(mesh, from, to, options)?.vertices ?? null;
	if (kind === 'edge') return edgePath(mesh, from, to, options)?.edges ?? null;
	return facePath(mesh, from, to, options)?.faces ?? null;
}
