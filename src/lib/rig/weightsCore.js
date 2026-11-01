// 57 M6 — SKIN WEIGHTS, the arithmetic (a LEAF: no three, runs in the worker and the unit suite).
//
// AUTOMATIC WEIGHTS are a heat-diffusion pass in the spirit of Baran & Popović's "bone heat": every
// vertex starts hot for the bone NEAREST to it (distance to the bone's segment, head -> tail), then
// the heat DIFFUSES over the mesh's own surface (explicit steps of the heat equation on the welded
// vertex graph: each step moves a vertex's weights part-way to its neighbours' average), so the
// weights blend smoothly across a joint instead of cutting along a Voronoi line, and a vertex is
// never weighted to a bone it is only near through empty space (the heat travels over the surface,
// not through the air between two legs). Each vertex keeps its 4 strongest bones, normalized.
// SMOOTH is the same diffusion on existing weights; NORMALIZE makes every vertex sum to 1 with at
// most 4 influences. The brush adds weight for one bone around a point with a smooth falloff.
//
// Weights are SPARSE while they diffuse (a small per-vertex map), so the cost is vertices × steps ×
// neighbours × (a few bones), not vertices × bones.

/**
 * @typedef {{positions: Float32Array, index: Uint32Array | Uint16Array | null}} WeightMesh
 *   positions in the BIND space the bones are given in; index = triangles (null = a soup)
 * @typedef {{head: number[], tail: number[]}} BoneSeg
 */

/** squared distance from p to the segment a-b @param {number[]} p @param {number[]} a @param {number[]} b */
export function segDist2(p, a, b) {
	const abx = b[0] - a[0],
		aby = b[1] - a[1],
		abz = b[2] - a[2];
	const apx = p[0] - a[0],
		apy = p[1] - a[1],
		apz = p[2] - a[2];
	const len = abx * abx + aby * aby + abz * abz;
	const t = len > 0 ? Math.max(0, Math.min(1, (apx * abx + apy * aby + apz * abz) / len)) : 0;
	const dx = apx - abx * t,
		dy = apy - aby * t,
		dz = apz - abz * t;
	return dx * dx + dy * dy + dz * dz;
}

/**
 * Weld coincident vertices (a UV seam splits one surface point into several) and list each welded
 * vertex's neighbours over the triangles.
 * @param {WeightMesh} mesh @returns {{weld: Int32Array, neighbours: number[][], count: number}}
 */
export function surfaceGraph(mesh) {
	const p = mesh.positions;
	const n = p.length / 3;
	const weld = new Int32Array(n);
	/** @type {Map<string, number>} */
	const key = new Map();
	let count = 0;
	for (let i = 0; i < n; i++) {
		const k =
			Math.round(p[i * 3] * 1e5) +
			',' +
			Math.round(p[i * 3 + 1] * 1e5) +
			',' +
			Math.round(p[i * 3 + 2] * 1e5);
		let w = key.get(k);
		if (w === undefined) {
			w = count++;
			key.set(k, w);
		}
		weld[i] = w;
	}
	/** @type {Set<number>[]} */
	const sets = Array.from({ length: count }, () => new Set());
	const tri = mesh.index ?? null;
	const triCount = tri ? tri.length / 3 : n / 3;
	for (let t = 0; t < triCount; t++) {
		const a = weld[tri ? tri[t * 3] : t * 3];
		const b = weld[tri ? tri[t * 3 + 1] : t * 3 + 1];
		const c = weld[tri ? tri[t * 3 + 2] : t * 3 + 2];
		if (a !== b) (sets[a].add(b), sets[b].add(a));
		if (b !== c) (sets[b].add(c), sets[c].add(b));
		if (a !== c) (sets[a].add(c), sets[c].add(a));
	}
	return { weld, neighbours: sets.map((s) => [...s]), count };
}

/** keep the k strongest, normalized @param {Map<number, number>} m @param {number} k */
function topK(m, k = 4) {
	const list = [...m.entries()]
		.filter(([, w]) => w > 1e-6)
		.sort((a, b) => b[1] - a[1] || a[0] - b[0])
		.slice(0, k);
	const sum = list.reduce((s, [, w]) => s + w, 0);
	/** @type {Map<number, number>} */
	const out = new Map();
	for (const [j, w] of list) out.set(j, sum > 0 ? w / sum : 0);
	return out;
}

/**
 * Diffuse sparse per-vertex weights over the welded surface.
 * @param {Map<number, number>[]} w per WELDED vertex @param {number[][]} neighbours @param {number} steps @param {number} rate 0..1
 * @param {Uint8Array} [pinned] welded vertices that keep their weights
 */
function diffuse(w, neighbours, steps, rate, pinned) {
	let cur = w;
	for (let s = 0; s < steps; s++) {
		/** @type {Map<number, number>[]} */
		const next = new Array(cur.length);
		for (let i = 0; i < cur.length; i++) {
			if (pinned?.[i] || !neighbours[i].length) {
				next[i] = cur[i];
				continue;
			}
			/** @type {Map<number, number>} */
			const m = new Map();
			for (const [j, v] of cur[i]) m.set(j, v * (1 - rate));
			const share = rate / neighbours[i].length;
			for (const nb of neighbours[i])
				for (const [j, v] of cur[nb]) m.set(j, (m.get(j) ?? 0) + v * share);
			next[i] = topK(m, 6);
		}
		cur = next;
	}
	return cur.map((m) => topK(m, 4));
}

/** sparse welded weights -> per-vertex vec4 arrays @param {Map<number, number>[]} w @param {Int32Array} weld */
function unpack(w, weld) {
	const n = weld.length;
	const joints = new Uint16Array(n * 4);
	const weights = new Float32Array(n * 4);
	for (let i = 0; i < n; i++) {
		let k = 0;
		for (const [j, v] of w[weld[i]]) {
			if (k >= 4) break;
			joints[i * 4 + k] = j;
			weights[i * 4 + k] = v;
			k++;
		}
		if (!k) weights[i * 4] = 1;
	}
	return { joints, weights };
}

/** per-vertex vec4 arrays -> sparse welded weights (the first vertex of a weld group wins) @param {Uint16Array | Uint8Array | Uint32Array} joints @param {Float32Array} weights @param {Int32Array} weld @param {number} count */
function pack(joints, weights, weld, count) {
	/** @type {Map<number, number>[]} */
	const w = new Array(count);
	for (let i = 0; i < weld.length; i++) {
		if (w[weld[i]]) continue;
		/** @type {Map<number, number>} */
		const m = new Map();
		for (let k = 0; k < 4; k++)
			if (weights[i * 4 + k] > 0)
				m.set(joints[i * 4 + k], (m.get(joints[i * 4 + k]) ?? 0) + weights[i * 4 + k]);
		w[weld[i]] = m;
	}
	for (let i = 0; i < count; i++) w[i] = w[i] ?? new Map();
	return w;
}

/**
 * Automatic weights.
 * @param {WeightMesh} mesh @param {BoneSeg[]} bones (index = the skin's joint index; a bone that
 *   must not deform — a root, an IK helper — is passed as null)
 * @param {{steps?: number, rate?: number}} [opts] diffusion steps (default 12) and rate (0.5)
 */
export function heatWeights(mesh, bones, opts = {}) {
	const g = surfaceGraph(mesh);
	const p = mesh.positions;
	/** @type {Map<number, number>[]} */
	const w = new Array(g.count);
	const first = new Int32Array(g.count).fill(-1);
	for (let i = 0; i < g.weld.length; i++) if (first[g.weld[i]] < 0) first[g.weld[i]] = i;
	for (let v = 0; v < g.count; v++) {
		const i = first[v];
		const pt = [p[i * 3], p[i * 3 + 1], p[i * 3 + 2]];
		// heat from the NEAREST bone only (bone heat's rule) — ties included, so a vertex right at a
		// joint starts shared; a bone across empty space never seeds a vertex, and the diffusion
		// below spreads heat only along the surface
		const d = /** @type {{j: number, d: number}[]} */ (
			bones.map((b, j) => (b ? { j, d: segDist2(pt, b.head, b.tail) } : null)).filter(Boolean)
		);
		d.sort((a, b) => a.d - b.d);
		/** @type {Map<number, number>} */
		const m = new Map();
		for (const e of d) if (e.d <= d[0].d * 1.2 + 1e-12) m.set(e.j, 1 / Math.max(1e-8, e.d));
		w[v] = topK(m, 4);
	}
	const out = diffuse(w, g.neighbours, opts.steps ?? 12, opts.rate ?? 0.5);
	return unpack(out, g.weld);
}

/**
 * Smooth existing weights (a few diffusion steps). @param {WeightMesh} mesh
 * @param {Uint16Array | Uint8Array | Uint32Array} joints @param {Float32Array} weights @param {{steps?: number, rate?: number}} [opts]
 */
export function smoothWeights(mesh, joints, weights, opts = {}) {
	const g = surfaceGraph(mesh);
	return unpack(
		diffuse(
			pack(joints, weights, g.weld, g.count),
			g.neighbours,
			opts.steps ?? 3,
			opts.rate ?? 0.5
		),
		g.weld
	);
}

/** every vertex sums to 1 with at most 4 influences @param {Uint16Array | Uint8Array | Uint32Array} joints @param {Float32Array} weights */
export function normalizeWeights(joints, weights) {
	const n = weights.length / 4;
	const J = new Uint16Array(n * 4);
	const W = new Float32Array(n * 4);
	for (let i = 0; i < n; i++) {
		/** @type {Map<number, number>} */
		const m = new Map();
		for (let k = 0; k < 4; k++)
			if (weights[i * 4 + k] > 0)
				m.set(joints[i * 4 + k], (m.get(joints[i * 4 + k]) ?? 0) + weights[i * 4 + k]);
		const t = topK(m, 4);
		let k = 0;
		for (const [j, v] of t) {
			J[i * 4 + k] = j;
			W[i * 4 + k] = v;
			k++;
		}
		if (!k) W[i * 4] = 1;
	}
	return { joints: J, weights: W };
}

/**
 * The brush: add `strength` × falloff weight for `bone` to vertices within `radius` of `center`
 * (positions in the same space as center), then renormalize. Returns the vertex count touched.
 * @param {Float32Array} positions @param {Uint16Array} joints @param {Float32Array} weights
 * @param {number[]} center @param {number} radius @param {number} bone @param {number} strength -1..1 (negative removes)
 */
export function brushWeights(positions, joints, weights, center, radius, bone, strength) {
	const n = positions.length / 3;
	const r2 = radius * radius;
	let touched = 0;
	for (let i = 0; i < n; i++) {
		const dx = positions[i * 3] - center[0],
			dy = positions[i * 3 + 1] - center[1],
			dz = positions[i * 3 + 2] - center[2];
		const d2 = dx * dx + dy * dy + dz * dz;
		if (d2 > r2) continue;
		const f = Math.pow(1 - d2 / r2, 2) * strength; // smooth falloff
		/** @type {Map<number, number>} */
		const m = new Map();
		for (let k = 0; k < 4; k++)
			if (weights[i * 4 + k] > 0)
				m.set(joints[i * 4 + k], (m.get(joints[i * 4 + k]) ?? 0) + weights[i * 4 + k]);
		m.set(bone, Math.max(0, (m.get(bone) ?? 0) + f));
		const t = topK(m, 4);
		if (!t.size) continue; // erasing a vertex's only bone leaves it as it was
		let k = 0;
		for (const [j, v] of t) {
			joints[i * 4 + k] = j;
			weights[i * 4 + k] = v;
			k++;
		}
		for (; k < 4; k++) {
			joints[i * 4 + k] = 0;
			weights[i * 4 + k] = 0;
		}
		touched++;
	}
	return touched;
}
