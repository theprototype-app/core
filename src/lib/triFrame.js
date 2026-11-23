// Roadmap 99 K5 (lane 99-live, row 1): the edit session's TRIANGLE FRAME — flat arrays over the live geometry,
// replacing the Vector3 triangle soup (`FS.workingTris`, ~200k Vector3 at 67k triangles, rebuilt on every swap).
//
// A frame reads exactly what is drawn: the position attribute itself (zero-copy when it is a plain non-indexed
// Float32 attribute — every geometry an operator commits — else one expanded copy), the material slot per
// triangle and the uv per corner. Its triangle order is the op mesh's output view, so a triangle index means the
// same thing to the frame, the selection, the overlay and the kernel. `weld` adds an integer vertex id per corner
// whose classes are exactly faceEdit's `keyOf` grid (= the op mesh's OP_WELD), built once per frame and only when
// an adjacency reader asks.
//
// The helpers below are the ONE implementation of each topology reader; faceEdit's soup-shaped exports (VR, the
// agent path, the e2e suites) reach them through `frameOfTris`. A live edit (row 2) writes the position attribute
// in place, so the frame stays valid while a grab runs (positions are read live; the weld describes the grab's
// start, which is what every grab-time reader wants).
import * as THREE from 'three';

/** the editor's weld grid (faceEdit `keyOf`, meshOps OP_WELD) */
const SCALE = 1e4;

/** the welded key of a point (faceEdit's keyOf, verbatim) @param {number} x @param {number} y @param {number} z */
export function keyOf(x, y, z) {
	return `${Math.round(x * SCALE)},${Math.round(y * SCALE)},${Math.round(z * SCALE)}`;
}

/** the canonical key of the edge between two vertex keys @param {string} a @param {string} b */
export const edgeKey = (a, b) => (a < b ? a + '|' + b : b + '|' + a);

/**
 * @typedef {{
 *   count: number,
 *   P: Float32Array | Float64Array,
 *   M: Int32Array | null,
 *   UV: Float32Array | Float64Array | null,
 *   V: Int32Array | null,
 *   nV: number,
 *   geometry: any,
 *   live: boolean
 * }} TriFrame
 * `P` = x,y,z per corner (corner c of triangle t at (3t+c)*3); `M` = slot per triangle (null = all 0);
 * `UV` = u,v per corner (null = untextured); `V` = the weld (null until `weld`); `live` = `P` IS the
 * geometry's position array (a write to one is a write to the other).
 */

/**
 * The frame of a geometry (index expanded, interleaved / normalized attributes read through the accessors —
 * readTriangles' values exactly). @param {any} geometry @returns {TriFrame}
 */
export function frameOfGeometry(geometry) {
	const pos = geometry.attributes.position;
	const index = geometry.index;
	const corners = index ? index.count : pos.count;
	const count = Math.floor(corners / 3);
	const plain =
		!index && !pos.isInterleavedBufferAttribute && !pos.normalized && pos.itemSize === 3 && pos.array instanceof Float32Array;
	/** @type {Float32Array} */
	let P;
	if (plain) P = pos.array;
	else {
		P = new Float32Array(count * 9);
		for (let i = 0; i < count * 3; i++) {
			const j = index ? index.getX(i) : i;
			P[i * 3] = pos.getX(j);
			P[i * 3 + 1] = pos.getY(j);
			P[i * 3 + 2] = pos.getZ(j);
		}
	}
	/** @type {Int32Array | null} */
	let M = null;
	if (geometry.groups?.length) {
		const slots = new Int32Array(corners);
		for (const group of geometry.groups) {
			const start = Math.max(group.start | 0, 0);
			const end = Math.min(start + (group.count | 0), corners);
			for (let i = start; i < end; i++) slots[i] = group.materialIndex || 0;
		}
		M = new Int32Array(count);
		let any = false;
		for (let t = 0; t < count; t++) if ((M[t] = slots[t * 3] || 0)) any = true;
		if (!any) M = null;
	}
	const uvAttr = geometry.attributes.uv;
	/** @type {Float32Array | null} */
	let UV = null;
	if (uvAttr) {
		UV = new Float32Array(count * 6);
		for (let i = 0; i < count * 3; i++) {
			const j = index ? index.getX(i) : i;
			UV[i * 2] = uvAttr.getX(j);
			UV[i * 2 + 1] = uvAttr.getY(j);
		}
	}
	return { count, P, M, UV, V: null, nV: 0, geometry, live: plain };
}

/**
 * The frame of a triangle soup (`[Vector3, Vector3, Vector3]` with `mi` / `uv`): Float64, the soup's values
 * exactly. @param {any[]} tris @returns {TriFrame}
 */
export function frameOfTris(tris) {
	const count = tris.length;
	const P = new Float64Array(count * 9);
	/** @type {Int32Array | null} */
	let M = null;
	const textured = tris.some((t) => !!t.uv);
	const UV = textured ? new Float64Array(count * 6) : null;
	for (let t = 0; t < count; t++) {
		const tri = tris[t];
		for (let c = 0; c < 3; c++) {
			const v = tri[c];
			P[t * 9 + c * 3] = v.x;
			P[t * 9 + c * 3 + 1] = v.y;
			P[t * 9 + c * 3 + 2] = v.z;
			if (UV && tri.uv) {
				UV[t * 6 + c * 2] = tri.uv[c][0];
				UV[t * 6 + c * 2 + 1] = tri.uv[c][1];
			}
		}
		if (tri.mi) (M ??= new Int32Array(count))[t] = tri.mi;
	}
	return { count, P, M, UV, V: null, nV: 0, geometry: null, live: false };
}

/** the empty frame (no session) @type {TriFrame} */
export const EMPTY_FRAME = Object.freeze({
	count: 0,
	P: new Float32Array(0),
	M: null,
	UV: null,
	V: new Int32Array(0),
	nV: 0,
	geometry: null,
	live: false
});

/** does triangle `t` exist @param {TriFrame} f @param {number} t */
export const hasTri = (f, t) => t >= 0 && t < f.count;

/** material slot of triangle `t` @param {TriFrame} f @param {number} t */
export const slotOf = (f, t) => (f.M ? f.M[t] : 0);

/** corner `c` of triangle `t` into `out` (a Vector3, default a new one) @param {TriFrame} f @param {number} t
 * @param {number} c @param {any} [out] @returns {THREE.Vector3} */
export function cornerOf(f, t, c, out = new THREE.Vector3()) {
	const o = (t * 3 + c) * 3;
	return out.set(f.P[o], f.P[o + 1], f.P[o + 2]);
}

/** the welded key of corner `c` of triangle `t` @param {TriFrame} f @param {number} t @param {number} c */
export function keyAt(f, t, c) {
	const o = (t * 3 + c) * 3;
	return keyOf(f.P[o], f.P[o + 1], f.P[o + 2]);
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
/** triangle `t`'s unit normal (faceEdit triNormal's arithmetic: (b-a) x (c-a), a zero normal stays zero)
 * @param {TriFrame} f @param {number} t @param {any} [out] @returns {THREE.Vector3} */
export function normalOf(f, t, out = new THREE.Vector3()) {
	cornerOf(f, t, 0, _a);
	cornerOf(f, t, 1, _b);
	cornerOf(f, t, 2, _c);
	return out.subVectors(_b, _a).cross(_c.sub(_a)).normalize();
}

/** triangle `t` as a soup triangle (faceEdit withSlot's shape: fresh Vector3s, `mi`, `uv` when textured) — for
 * the few readers that hand a handful of triangles to a soup-shaped core @param {TriFrame} f @param {number} t */
export function triOf(f, t) {
	/** @type {any} */
	const tri = [cornerOf(f, t, 0), cornerOf(f, t, 1), cornerOf(f, t, 2)];
	tri.mi = slotOf(f, t);
	if (f.UV) {
		const o = t * 6;
		tri.uv = [
			[f.UV[o], f.UV[o + 1]],
			[f.UV[o + 2], f.UV[o + 3]],
			[f.UV[o + 4], f.UV[o + 5]]
		];
	}
	return tri;
}

/**
 * The integer weld: a vertex id per corner, equal exactly when the corners' `keyOf` keys are equal (the
 * editor's 1e-4 grid; ids in first-seen corner order). Built once per frame. @param {TriFrame} f
 * @returns {Int32Array}
 */
export function weld(f) {
	if (f.V) return f.V;
	const n = f.count * 3;
	const V = new Int32Array(n);
	const P = f.P;
	const R = new Int32Array(n * 3);
	let small = true;
	for (let i = 0; i < n * 3; i++) {
		const r = Math.round(P[i] * SCALE);
		if (!(r > -2147483648 && r < 2147483647)) {
			small = false;
			break;
		}
		R[i] = r === 0 ? 0 : r; // -0 keys as 0 (keyOf's template string does)
	}
	let nV = 0;
	if (small) {
		let size = 16;
		while (size < n * 2) size <<= 1;
		const mask = size - 1;
		const table = new Int32Array(size).fill(-1); // -> the representative corner
		const idOf = new Int32Array(n);
		for (let i = 0; i < n; i++) {
			const x = R[i * 3];
			const y = R[i * 3 + 1];
			const z = R[i * 3 + 2];
			let h = (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) & mask;
			for (;;) {
				const rep = table[h];
				if (rep < 0) {
					table[h] = i;
					idOf[i] = V[i] = nV++;
					break;
				}
				if (R[rep * 3] === x && R[rep * 3 + 1] === y && R[rep * 3 + 2] === z) {
					V[i] = idOf[rep];
					break;
				}
				h = (h + 1) & mask;
			}
		}
	} else {
		/** @type {Map<string, number>} */
		const ids = new Map();
		for (let i = 0; i < n; i++) {
			const k = keyOf(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]);
			let id = ids.get(k);
			if (id === undefined) ids.set(k, (id = nV++));
			V[i] = id;
		}
	}
	f.V = V;
	f.nV = nV;
	return V;
}

/** union-find over `n` items @param {number} n */
function unionFind(n) {
	const parent = new Int32Array(n);
	for (let i = 0; i < n; i++) parent[i] = i;
	/** @param {number} a */
	const find = (a) => {
		while (parent[a] !== a) {
			parent[a] = parent[parent[a]];
			a = parent[a];
		}
		return a;
	};
	return { parent, find };
}

/**
 * The connected components ("shells") of the whole frame, welded: tri-index groups in order of their first
 * triangle (shellsOfTris). @param {TriFrame} f @returns {number[][]}
 */
export function shellsOf(f) {
	const V = weld(f);
	const n = f.count;
	const { parent, find } = unionFind(n);
	const first = new Int32Array(f.nV).fill(-1);
	for (let t = 0; t < n; t++)
		for (let c = 0; c < 3; c++) {
			const v = V[t * 3 + c];
			if (first[v] < 0) first[v] = t;
			else parent[find(first[v])] = find(t);
		}
	return groupByRoot(n, find);
}

/** @param {number} n @param {(i: number) => number} find @returns {number[][]} */
function groupByRoot(n, find) {
	/** @type {Map<number, number[]>} */
	const groups = new Map();
	for (let i = 0; i < n; i++) {
		const root = find(i);
		let list = groups.get(root);
		if (!list) groups.set(root, (list = []));
		list.push(i);
	}
	return [...groups.values()];
}

/**
 * Split `triIndices` into connected components welded by vertex (componentsOfTris): groups in order of their
 * first member in `triIndices`. @param {TriFrame} f @param {number[]} triIndices @returns {number[][]}
 */
export function componentsOf(f, triIndices) {
	const V = weld(f);
	/** @type {Map<number, number>} */
	const parent = new Map();
	/** @param {number} k */
	const find = (k) => {
		let root = k;
		while (parent.get(root) !== root) root = /** @type {number} */ (parent.get(root));
		while (parent.get(k) !== root) {
			const next = /** @type {number} */ (parent.get(k));
			parent.set(k, root);
			k = next;
		}
		return root;
	};
	for (const t of triIndices) {
		const a = V[t * 3];
		for (let c = 0; c < 3; c++) if (!parent.has(V[t * 3 + c])) parent.set(V[t * 3 + c], V[t * 3 + c]);
		for (let c = 1; c < 3; c++) parent.set(find(a), find(V[t * 3 + c]));
	}
	/** @type {Map<number, number[]>} */
	const byRoot = new Map();
	for (const t of triIndices) {
		const root = find(V[t * 3]);
		let list = byRoot.get(root);
		if (!list) byRoot.set(root, (list = []));
		list.push(t);
	}
	return [...byRoot.values()];
}

/**
 * Every welded edge with the triangles touching it, in first-seen (triangle, side) order: `ends` = the two vertex
 * ids (as met), `tris` = the triangles. Keyed by the unordered vertex-id pair. @param {TriFrame} f
 * @returns {Map<number, number[]>} pair key -> triangle list
 */
function edgeTriangles(f) {
	const V = weld(f);
	const nV = f.nV;
	/** @type {Map<number, number[]>} */
	const map = new Map();
	for (let t = 0; t < f.count; t++)
		for (let e = 0; e < 3; e++) {
			const a = V[t * 3 + e];
			const b = V[t * 3 + ((e + 1) % 3)];
			const k = a < b ? a * nV + b : b * nV + a;
			let list = map.get(k);
			if (!list) map.set(k, (list = []));
			list.push(t);
		}
	return map;
}

/** the triangle normals of a frame (Vector3 each, triNormal's arithmetic) @param {TriFrame} f */
export function normalsOf(f) {
	const out = new Array(f.count);
	for (let t = 0; t < f.count; t++) out[t] = normalOf(f, t);
	return out;
}

/**
 * Logical faces: triangles that share a welded edge AND are coplanar (groupFaces). `[{triIndices, normal,
 * centroid}]` in order of their first triangle. @param {TriFrame} f @param {number} coplanar the |dot| bound
 */
export function groupFacesOf(f, coplanar) {
	const n = f.count;
	const { parent, find } = unionFind(n);
	const normals = normalsOf(f);
	for (const list of edgeTriangles(f).values())
		for (let i = 1; i < list.length; i++)
			if (Math.abs(normals[list[0]].dot(normals[list[i]])) > coplanar) parent[find(list[0])] = find(list[i]);
	return groupByRoot(n, find).map((triIndices) => {
		const normal = normals[triIndices[0]].clone();
		const centroid = new THREE.Vector3();
		const p = new THREE.Vector3();
		let count = 0;
		for (const t of triIndices) for (let c = 0; c < 3; c++) centroid.add(cornerOf(f, t, c, p)), count++;
		centroid.divideScalar(count || 1);
		return { triIndices, normal, centroid };
	});
}

/**
 * Pair coplanar co-facing neighbours into convex QUADS, greedy best-first by squareness (pairQuads, verbatim
 * arithmetic: the shared edge's ends are taken in the order of their key STRINGS, as the soup's split edge key
 * gave them, so equal-score ties sum identically). @param {TriFrame} f @param {number} coplanar
 * @param {(ring: any[], normal: any) => number | null} quadScore @returns {Int32Array}
 */
export function pairQuadsOf(f, coplanar, quadScore) {
	const V = weld(f);
	const partner = new Int32Array(f.count).fill(-1);
	const normals = normalsOf(f);
	/** vertex id -> one corner carrying it (to read its position / key) */
	const rep = new Int32Array(f.nV);
	for (let i = V.length - 1; i >= 0; i--) rep[V[i]] = i;
	/** @param {number} v */
	const keyOfV = (v) => keyAt(f, Math.floor(rep[v] / 3), rep[v] % 3);
	/** the corner of `t` at vertex `v` (the first one: the soup's find) @param {number} t @param {number} v */
	const cornerAtV = (t, v) => (V[t * 3] === v ? 0 : V[t * 3 + 1] === v ? 1 : V[t * 3 + 2] === v ? 2 : -1);
	/** @type {{ a: number, b: number, score: number }[]} */
	const candidates = [];
	const nV = f.nV;
	for (const [k, list] of edgeTriangles(f)) {
		if (list.length !== 2) continue;
		const [a, b] = list;
		if (a === b) continue;
		if (normals[a].dot(normals[b]) < coplanar) continue;
		const lo = Math.floor(k / nV);
		const hi = k - lo * nV;
		// shared[0] / shared[1] = the ends in key-string order
		const [s0, s1] = keyOfV(lo) <= keyOfV(hi) ? [lo, hi] : [hi, lo];
		const off = (/** @type {number} */ t) => {
			for (let c = 0; c < 3; c++) if (V[t * 3 + c] !== s0 && V[t * 3 + c] !== s1) return c;
			return -1;
		};
		const ca = off(a);
		const cb = off(b);
		const cp = cornerAtV(a, s0);
		const cq = cornerAtV(a, s1);
		if (ca < 0 || cb < 0 || cp < 0 || cq < 0) continue;
		const score = quadScore([cornerOf(f, a, cp), cornerOf(f, a, ca), cornerOf(f, a, cq), cornerOf(f, b, cb)], normals[a]);
		if (score === null) continue;
		candidates.push({ a: Math.min(a, b), b: Math.max(a, b), score });
	}
	candidates.sort((x, y) => x.score - y.score || x.a - y.a || x.b - y.b);
	for (const { a, b } of candidates) {
		if (partner[a] !== -1 || partner[b] !== -1) continue;
		partner[a] = b;
		partner[b] = a;
	}
	return partner;
}

/**
 * Boundary edges of a triangle set: directed sides walked once (unordered) within the set (boundaryEdges):
 * `{ek, p0, p1, ti, c0, c1}` with fresh Vector3 ends, `ek` = the welded edge key string.
 * @param {TriFrame} f @param {number[]} triIndices
 */
export function boundaryEdgesOf(f, triIndices) {
	const V = weld(f);
	const nV = f.nV;
	/** @type {Map<number, number>} */
	const count = new Map();
	/** @type {{ k: number, t: number, e: number }[]} */
	const sides = [];
	for (const t of triIndices)
		for (let e = 0; e < 3; e++) {
			const a = V[t * 3 + e];
			const b = V[t * 3 + ((e + 1) % 3)];
			const k = a < b ? a * nV + b : b * nV + a;
			count.set(k, (count.get(k) || 0) + 1);
			sides.push({ k, t, e });
		}
	/** @type {any[]} */
	const out = [];
	for (const s of sides) {
		if (count.get(s.k) !== 1) continue;
		const c1 = (s.e + 1) % 3;
		out.push({
			ek: edgeKey(keyAt(f, s.t, s.e), keyAt(f, s.t, c1)),
			p0: cornerOf(f, s.t, s.e),
			p1: cornerOf(f, s.t, c1),
			v0: V[s.t * 3 + s.e],
			v1: V[s.t * 3 + c1],
			ti: s.t,
			c0: s.e,
			c1
		});
	}
	return out;
}

/** The ordered boundary LOOP of a triangle set (boundaryLoop): fresh Vector3s, null unless the boundary is ONE
 * closed loop. @param {TriFrame} f @param {number[]} triIndices @returns {THREE.Vector3[] | null} */
export function boundaryLoopOf(f, triIndices) {
	const dir = boundaryEdgesOf(f, triIndices);
	if (dir.length < 3) return null;
	/** @type {Map<number, any>} */
	const byStart = new Map();
	for (const e of dir) byStart.set(e.v0, e);
	const start = dir[0].v0;
	/** @type {THREE.Vector3[]} */
	const loop = [];
	let edge = dir[0];
	do {
		loop.push(edge.p0.clone());
		edge = byStart.get(edge.v1);
		if (!edge) return null;
	} while (edge.v0 !== start && loop.length <= dir.length);
	return loop.length === dir.length ? loop : null;
}

/** the welded vertex keys of a triangle set (faceVertexKeys) @param {TriFrame} f @param {number[]} triIndices
 * @returns {Set<string>} */
export function vertexKeysOf(f, triIndices) {
	const keys = new Set();
	for (const t of triIndices) for (let c = 0; c < 3; c++) keys.add(keyAt(f, t, c));
	return keys;
}

/**
 * The welded edge keys internal to a face (internalEdgeKeys): with `faces`, every edge met twice inside one face;
 * without, the quad diagonals of `partner`. @param {TriFrame} f @param {number[][] | null} faces
 * @param {Int32Array} partner @returns {Set<string>}
 */
export function internalEdgeKeysOf(f, faces, partner) {
	const out = new Set();
	if (!faces) {
		const V = weld(f);
		for (let i = 0; i < f.count; i++) {
			const mate = partner[i];
			if (mate == null || mate < 0 || mate < i || mate >= f.count) continue;
			/** @type {number[]} */
			const shared = [];
			for (let c = 0; c < 3; c++) {
				const v = V[i * 3 + c];
				// (no dedupe: a degenerate triangle meeting one key twice is skipped, as the soup's filter did)
				if (V[mate * 3] === v || V[mate * 3 + 1] === v || V[mate * 3 + 2] === v) shared.push(c);
			}
			if (shared.length === 2) out.add(edgeKey(keyAt(f, i, shared[0]), keyAt(f, i, shared[1])));
		}
		return out;
	}
	for (const face of faces) {
		if (face.length < 2) continue;
		/** @type {Map<string, number>} */
		const count = new Map();
		for (const t of face) {
			if (!hasTri(f, t)) continue;
			const keys = [keyAt(f, t, 0), keyAt(f, t, 1), keyAt(f, t, 2)];
			for (let e = 0; e < 3; e++) {
				const key = edgeKey(keys[e], keys[(e + 1) % 3]);
				count.set(key, (count.get(key) ?? 0) + 1);
			}
		}
		for (const [key, seen] of count) if (seen >= 2) out.add(key);
	}
	return out;
}

/** centroid of a triangle set (every corner counted) @param {TriFrame} f @param {number[]} triIndices */
export function centroidOf(f, triIndices) {
	const centroid = new THREE.Vector3();
	const p = new THREE.Vector3();
	let count = 0;
	for (const t of triIndices) for (let c = 0; c < 3; c++) centroid.add(cornerOf(f, t, c, p)), count++;
	return centroid.divideScalar(count || 1);
}

/**
 * A commit state of the frame's triangles (`trisToPositions` / `trisToGroups` / `trisToUVs` of the soup): all of
 * them, or the listed ones in list order; `flip` = triangles whose b/c corners (and uvs) swap. Positions are a
 * Float32Array for a geometry frame (the values the soup held), a plain array for a soup frame.
 * @param {TriFrame} f @param {{ tris?: ArrayLike<number> | null, flip?: Set<number> | null }} [options]
 * @returns {{ positions: Float32Array | number[], groups: any[] | null, uvs: number[] | null }}
 */
export function stateOf(f, options = {}) {
	const list = options.tris ?? null;
	const flip = options.flip ?? null;
	const n = list ? list.length : f.count;
	const positions = f.P instanceof Float32Array ? new Float32Array(n * 9) : new Array(n * 9);
	const uvs = f.UV ? new Array(n * 6) : null;
	/** @type {any[] | null} */
	let groups = null;
	let runStart = 0;
	let runSlot = -1;
	let anySlot = false;
	for (let i = 0; i < n; i++) {
		const t = list ? list[i] : i;
		const swap = !!flip && flip.has(t);
		for (let c = 0; c < 3; c++) {
			const src = swap && c > 0 ? 3 - c : c;
			const o = (t * 3 + src) * 3;
			positions[i * 9 + c * 3] = f.P[o];
			positions[i * 9 + c * 3 + 1] = f.P[o + 1];
			positions[i * 9 + c * 3 + 2] = f.P[o + 2];
			if (uvs && f.UV) {
				uvs[i * 6 + c * 2] = f.UV[(t * 3 + src) * 2];
				uvs[i * 6 + c * 2 + 1] = f.UV[(t * 3 + src) * 2 + 1];
			}
		}
		const slot = slotOf(f, t);
		if (slot > 0) anySlot = true;
		if (i === 0) runSlot = slot;
		else if (slot !== runSlot) {
			(groups ??= []).push({ start: runStart * 3, count: (i - runStart) * 3, materialIndex: runSlot });
			runStart = i;
			runSlot = slot;
		}
	}
	if (!anySlot || !n) return { positions, groups: null, uvs };
	(groups ??= []).push({ start: runStart * 3, count: (n - runStart) * 3, materialIndex: runSlot });
	return { positions, groups, uvs };
}

// ---- 99 K5 row 2: normals on a live edit -------------------------------------------------------------------------
// A move recomputes only the TOUCHED corners: every corner at a vertex of a triangle that moved. A touched corner whose
// normal was its own face normal (flat shading — every geometry an operator committed) gets its new face normal; the
// others keep their smoothing group (the corners at the same vertex whose normals were equal: an authored smooth vertex,
// a smooth-shaded object's welded vertex) and get the normalized sum of the group's new face normals. Every other normal
// stays byte-identical. The arithmetic is three's computeVertexNormals / faceEdit's smoothWeldedNormals exactly, so on a
// flat or smooth-shaded mesh the result equals a full recompute.

/** the normal tolerance that makes two corners one smoothing group, and a corner "flat" */
const SAME_NORMAL = 1e-5;

/**
 * three's per-triangle normal as computeVertexNormals stores it: (c-b) x (a-b), rounded to Float32, then normalized
 * from the rounded values and rounded again. Writes x,y,z at out[o..o+2]. @param {ArrayLike<number>} P
 * @param {number} t @param {Float32Array | Float64Array} out @param {number} o
 */
function faceNormalF32(P, t, out, o) {
	const i = t * 9;
	const ax = P[i], ay = P[i + 1], az = P[i + 2];
	const bx = P[i + 3], by = P[i + 4], bz = P[i + 5];
	const cbx = P[i + 6] - bx, cby = P[i + 7] - by, cbz = P[i + 8] - bz;
	const abx = ax - bx, aby = ay - by, abz = az - bz;
	const x = Math.fround(cby * abz - cbz * aby);
	const y = Math.fround(cbz * abx - cbx * abz);
	const z = Math.fround(cbx * aby - cby * abx);
	const len = Math.sqrt(x * x + y * y + z * z) || 1;
	const s = 1 / len;
	out[o] = Math.fround(x * s);
	out[o + 1] = Math.fround(y * s);
	out[o + 2] = Math.fround(z * s);
}

/**
 * The normal update for a set of corners about to move, planned from the CURRENT positions and normals (call before
 * the move). `null` when the geometry has no usable normal attribute (the caller recomputes in full).
 * @param {TriFrame} f @param {ArrayLike<number> | null} normals the normal attribute's array (x,y,z per corner)
 * @param {ArrayLike<number>} moved corner indices (3t + c) that will move
 * @param {{ smooth?: boolean }} [options] `smooth` = a smooth-shaded object (terrain, shading 'smooth'): every corner
 *   at a vertex is one group, smoothWeldedNormals' rule
 */
export function normalPlan(f, normals, moved, options = {}) {
	if (!normals || normals.length < f.count * 9) return null;
	const V = weld(f);
	const nV = f.nV;
	/** vertices of the touched triangles */
	const hot = new Uint8Array(nV);
	const touchedTri = new Uint8Array(f.count);
	for (let i = 0; i < moved.length; i++) touchedTri[Math.floor(moved[i] / 3)] = 1;
	for (let t = 0; t < f.count; t++) if (touchedTri[t]) for (let c = 0; c < 3; c++) hot[V[t * 3 + c]] = 1;
	/** @type {number[]} */
	const list = [];
	for (let i = 0; i < f.count * 3; i++) if (hot[V[i]]) list.push(i);
	const corners = Int32Array.from(list);
	const n = corners.length;
	const flat = new Uint8Array(n);
	const face = new Float64Array(3);
	for (let k = 0; k < n && !options.smooth; k++) {
		const ci = corners[k];
		faceNormalF32(f.P, Math.floor(ci / 3), face, 0);
		const o = ci * 3;
		flat[k] =
			Math.abs(normals[o] - face[0]) < SAME_NORMAL &&
			Math.abs(normals[o + 1] - face[1]) < SAME_NORMAL &&
			Math.abs(normals[o + 2] - face[2]) < SAME_NORMAL
				? 1
				: 0;
	}
	// smoothing groups among the non-flat corners of each vertex: equal old normals (members in corner order)
	const group = new Int32Array(n).fill(-1);
	/** @type {number[][]} */
	const groups = [];
	/** vertex -> its groups so far (indices into `groups`) @type {Map<number, number[]>} */
	const byVertex = new Map();
	for (let k = 0; k < n; k++) {
		if (flat[k]) continue;
		const ci = corners[k];
		const v = V[ci];
		const o = ci * 3;
		let mine = byVertex.get(v);
		if (!mine) byVertex.set(v, (mine = []));
		let gi = options.smooth && mine.length ? mine[0] : -1;
		for (const g of gi < 0 ? mine : []) {
			const r = corners[groups[g][0]] * 3;
			if (
				Math.abs(normals[o] - normals[r]) < SAME_NORMAL &&
				Math.abs(normals[o + 1] - normals[r + 1]) < SAME_NORMAL &&
				Math.abs(normals[o + 2] - normals[r + 2]) < SAME_NORMAL
			) {
				gi = g;
				break;
			}
		}
		if (gi < 0) {
			gi = groups.length;
			groups.push([]);
			mine.push(gi);
		}
		groups[gi].push(k);
		group[k] = gi;
	}
	return { corners, flat, group, groups };
}

/**
 * Apply a normal plan after the move: writes the touched corners' normals into `normals` (Float32).
 * @param {TriFrame} f @param {Float32Array} normals @param {{ corners: Int32Array, flat: Uint8Array, group: Int32Array,
 * groups: number[][] }} plan
 */
export function applyNormalPlan(f, normals, plan) {
	const { corners, flat, groups } = plan;
	const n = corners.length;
	const face = new Float64Array(n * 3);
	for (let k = 0; k < n; k++) faceNormalF32(f.P, Math.floor(corners[k] / 3), face, k * 3);
	for (let k = 0; k < n; k++) {
		if (!flat[k]) continue;
		const o = corners[k] * 3;
		normals[o] = face[k * 3];
		normals[o + 1] = face[k * 3 + 1];
		normals[o + 2] = face[k * 3 + 2];
	}
	for (const members of groups) {
		let x = 0, y = 0, z = 0;
		for (const k of members) (x += face[k * 3]), (y += face[k * 3 + 1]), (z += face[k * 3 + 2]);
		if (members.length < 2) {
			// a lone smooth corner (its vertex's other corners are flat or split): its own face normal, as
			// computeVertexNormals gives it (smoothWeldedNormals skips a group of one)
			const o = corners[members[0]] * 3;
			normals[o] = x;
			normals[o + 1] = y;
			normals[o + 2] = z;
			continue;
		}
		const len = Math.sqrt(x * x + y * y + z * z) || 1;
		const s = 1 / len;
		const nx = Math.fround(x * s), ny = Math.fround(y * s), nz = Math.fround(z * s);
		for (const k of members) {
			const o = corners[k] * 3;
			normals[o] = nx;
			normals[o + 1] = ny;
			normals[o + 2] = nz;
		}
	}
}

/**
 * The corners whose positions differ between two arrays of the same length (x,y,z per corner).
 * @param {ArrayLike<number>} a @param {ArrayLike<number>} b @returns {Int32Array}
 */
export function changedCorners(a, b) {
	/** @type {number[]} */
	const out = [];
	for (let i = 0, n = Math.min(a.length, b.length) / 3; i < n; i++) {
		const o = i * 3;
		if (a[o] !== b[o] || a[o + 1] !== b[o + 1] || a[o + 2] !== b[o + 2]) out.push(i);
	}
	return Int32Array.from(out);
}
