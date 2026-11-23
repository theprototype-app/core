// @ts-check
// Roadmap 99 K4 family 5: MERGE BY DISTANCE / DISSOLVE / DELETE on the kernel (lane 99-ops-b).
//
// The soup operators' recipes on the op mesh, computed from the same corner positions in the same order, so the
// output triangles, their order and the stored partition are the soup's:
// - merge: distance clusters (99 K6: every pair within eps, through the kernel's SpatialHash — the soup's one-cell
//   grid never merged two points across a cell wall), the mean of every CORNER in one, the soup's degenerate-triangle
//   drop, then the kernel's own `mergeVertices` (lowest ID of a cluster survives) — after the degenerate triangles
//   are gone, so every surviving face keeps its corners, triangulation and order keys;
// - dissolve edges: the two triangles on the edge plus their quad partners, fanned from a corner off the edge, as
//   ONE n-gon face; dissolve vertices: the faces around the vertex become one n-gon (or the vertex leaves each face);
// - delete: the faces go (a face only partly picked keeps the rest of itself), and the vertices nothing uses.
//
// Pure (no three.js, no stores): node tests, a Worker and the page run the same code.

import { appendToView, newGroup, isolateTriangles } from './opMesh.js';
import { sub, add, scale, dot, cross, triNormal, pos, keyOfPos } from './rebuild.js';
import { lengthSq, triVerts, triUv, pairKey, removeTriangles, boundaryLoopOf } from './bridgeFill.js';
import { SpatialHash } from '../meshKernel/spatialHash.js';

/** @typedef {import('./opMesh.js').OpMesh} OpMesh @typedef {[number, number, number]} Vec */

/**
 * The editor's vertex picks (welded position keys, faceEdit keyOf) as vertex IDs, one per distinct key in pick order;
 * a key with no vertex gives -1. @param {OpMesh} om @param {string[]} keys @returns {number[]}
 */
export function verticesOfKeys(om, keys) {
	const want = [...new Set(keys ?? [])];
	const need = new Set(want);
	const m = om.mesh;
	/** @type {Map<string, number>} */
	const byKey = new Map();
	for (let v = 0; v < m.vTop; v++) {
		if (!m.hasVertex(v)) continue;
		const k = keyOfPos(pos(om, v));
		if (need.has(k) && !byKey.has(k)) byKey.set(k, v);
	}
	return want.map((k) => byKey.get(k) ?? -1);
}

/** output triangles with a corner on one of `verts`, ascending @param {OpMesh} om @param {number[]} verts */
export function trianglesTouching(om, verts) {
	const set = new Set(verts.filter((v) => v >= 0));
	/** @type {number[]} */
	const out = [];
	for (let t = 0; t < om.view.count; t++) if (triVerts(om, t).some((v) => set.has(v))) out.push(t);
	return out;
}

/** output triangles with a side on one of the vertex pairs (diagonals count, as the soup's welded keys did),
 * ascending @param {OpMesh} om @param {[number, number][]} pairs */
export function trianglesOnSides(om, pairs) {
	const set = new Set(pairs.filter(([a, b]) => a >= 0 && b >= 0).map(([a, b]) => pairKey(om, a, b)));
	/** @type {number[]} */
	const out = [];
	for (let t = 0; t < om.view.count; t++) {
		const v = triVerts(om, t);
		for (let e = 0; e < 3; e++)
			if (set.has(pairKey(om, v[e], v[(e + 1) % 3]))) {
				out.push(t);
				break;
			}
	}
	return out;
}

/**
 * DELETE output triangles: their faces go (a face only partly picked is split first and the rest of it keeps its
 * stored face), and so do the vertices nothing uses any more. @param {OpMesh} om @param {number[]} tris
 * @returns {{ ok: true, dropped: number }}
 */
export function deleteTriangles(om, tris) {
	const list = [...new Set(tris)].filter((t) => t >= 0 && t < om.view.count);
	if (list.length) removeTriangles(om, list);
	return { ok: true, dropped: list.length };
}

// ---- MERGE BY DISTANCE --------------------------------------------------------------------------------

/**
 * faceEdit `mergeByDistance` on the op mesh. The vertices the output corners use are CLUSTERED BY DISTANCE through
 * the kernel's `SpatialHash` (99 K6: the query reaches the neighbouring cells, so two copies 1e-6 apart on either side
 * of a cell wall merge — the soup's round(p / eps) grid left exactly that pair apart). THE RULE IS GREEDY, Blender's
 * "merge by distance": in first-corner order, a vertex not yet claimed becomes a cluster's TARGET and claims every
 * unclaimed vertex within `eps` of it (inclusive). A cluster is therefore at most `eps` around its target — a strip
 * of vertices spaced closer than `eps` merges into a coarser strip, never end to end (a transitive rule would chain the
 * whole run into one point), the same bound the grid had (a cell's extent).
 * A cluster of two CORNERS or more then moves them all to their MEAN (summed in output corner order — the soup's
 * arithmetic); a triangle left with no area or two corners on one welded key is dropped; the vertices of a cluster
 * then merge into its lowest ID (`mergeVertices`). Clusters are numbered in first-corner order, the order the grid's
 * cells were. The refusal is the soup's toast text.
 * @param {OpMesh} om @param {number} [threshold]
 * @returns {{ ok: true, moved: number, dropped: number, eps: number } | { error: string }}
 *   moved = corners that moved (the soup's count), dropped = degenerate triangles removed
 */
export function mergeByDistance(om, threshold = 0.001) {
	const m = om.mesh;
	const { view } = om;
	const eps = Math.max(1e-5, threshold);
	const T = view.count;
	const { fFirst, cVert, vPos } = m;
	const { tFace, tLoc } = view;
	/** output corner -> vertex */
	const VV = new Int32Array(T * 3);
	/** vertex -> its cluster ("cell"; one vertex = one position = one cluster) */
	const cellOfV = new Int32Array(m.vTop).fill(-1);
	// the used vertices in first-corner order, clustered by distance (the representative = the lowest local index,
	// i.e. the vertex of the cluster met first)
	const localOf = new Int32Array(m.vTop).fill(-1);
	const order = new Int32Array(Math.min(m.vTop, T * 3));
	let L = 0;
	for (let t = 0; t < T; t++) {
		const base = fFirst[tFace[t]];
		for (let k = 0; k < 3; k++) {
			const x = cVert[base + tLoc[t * 3 + k]];
			VV[t * 3 + k] = x;
			if (localOf[x] < 0) {
				localOf[x] = L;
				order[L++] = x;
			}
		}
	}
	const lp = new Float64Array(L * 3);
	for (let i = 0; i < L; i++) {
		lp[i * 3] = vPos[order[i] * 3];
		lp[i * 3 + 1] = vPos[order[i] * 3 + 1];
		lp[i * 3 + 2] = vPos[order[i] * 3 + 2];
	}
	// greedy targets in first-met order: rep[i] = the local index of the target that claimed i (itself for a target)
	const hash = new SpatialHash(lp, { cellSize: eps * 2, count: L });
	const rep = new Int32Array(L).fill(-1);
	for (let i = 0; i < L; i++) {
		if (rep[i] >= 0) continue;
		rep[i] = i;
		hash.query(lp[i * 3], lp[i * 3 + 1], lp[i * 3 + 2], eps, (j) => {
			if (rep[j] < 0) rep[j] = i;
		});
	}
	/** per cell: the corner sum (corner by corner in output order: the soup's arithmetic), the corner count, the
	 * vertices, the target (NaN = fewer than two corners: nothing moves) @type {number[]} */
	const sx = [];
	/** @type {number[]} */
	const sy = [];
	/** @type {number[]} */
	const sz = [];
	/** @type {number[]} */
	const cn = [];
	/** @type {number[][]} */
	const cverts = [];
	for (let t = 0; t < T; t++) {
		for (let k = 0; k < 3; k++) {
			const x = VV[t * 3 + k];
			const px = vPos[x * 3];
			const py = vPos[x * 3 + 1];
			const pz = vPos[x * 3 + 2];
			let c = cellOfV[x];
			if (c < 0) {
				const root = rep[localOf[x]];
				// a cluster's root is its first-met vertex, so it has its cluster already unless it is x itself
				c = root === localOf[x] ? -1 : cellOfV[order[root]];
				if (c < 0) {
					c = cn.length;
					sx.push(0), sy.push(0), sz.push(0), cn.push(0), cverts.push([]);
				}
				cellOfV[x] = c;
				cverts[c].push(x);
			}
			if (cn[c]) {
				sx[c] += px;
				sy[c] += py;
				sz[c] += pz;
			} else {
				sx[c] = px;
				sy[c] = py;
				sz[c] = pz;
			}
			cn[c]++;
		}
	}
	const C = cn.length;
	// THREE divideScalar(n) = multiplyScalar(1 / n)
	const tx = new Float64Array(C);
	const ty = new Float64Array(C);
	const tz = new Float64Array(C);
	for (let c = 0; c < C; c++) {
		if (cn[c] < 2) continue;
		const inv = 1 / cn[c];
		tx[c] = sx[c] * inv;
		ty[c] = sy[c] * inv;
		tz[c] = sz[c] * inv;
	}
	/** where vertex v ends, axis a @param {number} v @param {number} a */
	const at = (v, a) => {
		const c = cellOfV[v];
		if (cn[c] < 2) return vPos[v * 3 + a];
		return a === 0 ? tx[c] : a === 1 ? ty[c] : tz[c];
	};
	// the soup counted moved CORNERS: a vertex that moves counts once per corner it has in the output
	const movesV = new Uint8Array(m.vTop); // 0 unknown, 1 stays, 2 moves
	/** @type {(string | undefined)[]} the weld key where a vertex ends */
	const keyAt = new Array(m.vTop);
	let moved = 0;
	/** @type {number[]} */
	const degenerate = [];
	for (let t = 0; t < T; t++) {
		for (let k = 0; k < 3; k++) {
			const x = VV[t * 3 + k];
			if (!movesV[x]) {
				const c = cellOfV[x];
				let mv = false;
				if (cn[c] >= 2) {
					const dx = vPos[x * 3] - tx[c];
					const dy = vPos[x * 3 + 1] - ty[c];
					const dz = vPos[x * 3 + 2] - tz[c];
					mv = dx * dx + dy * dy + dz * dz > 1e-14;
				}
				movesV[x] = mv ? 2 : 1;
				keyAt[x] = keyOfPos([at(x, 0), at(x, 1), at(x, 2)]);
			}
			if (movesV[x] === 2) moved++;
		}
		const a = VV[t * 3];
		const b = VV[t * 3 + 1];
		const c = VV[t * 3 + 2];
		const ka = keyAt[a];
		const kb = keyAt[b];
		const kc = keyAt[c];
		let ok = ka !== kb && kb !== kc && kc !== ka;
		if (ok) {
			// faceEdit triNormal (normalized, THREE's zero rule) has lengthSq > 1e-12
			const ux = at(b, 0) - at(a, 0);
			const uy = at(b, 1) - at(a, 1);
			const uz = at(b, 2) - at(a, 2);
			const wx = at(c, 0) - at(a, 0);
			const wy = at(c, 1) - at(a, 1);
			const wz = at(c, 2) - at(a, 2);
			const nx = uy * wz - uz * wy;
			const ny = uz * wx - ux * wz;
			const nz = ux * wy - uy * wx;
			const l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
			ok = (nx / l) * (nx / l) + (ny / l) * (ny / l) + (nz / l) * (nz / l) > 1e-12;
		}
		if (!ok) degenerate.push(t);
	}
	if (!moved && !degenerate.length) return { error: 'No vertices closer than ' + eps + ' to merge' };
	// a face that would meet itself at a merged vertex without a degenerate triangle (two non-adjacent corners in one
	// cell) is split into its triangles first, so every face the merge touches keeps distinct corners. Only faces on
	// a cell holding two vertices or more can.
	/** @type {Set<number>} */
	const touched = new Set();
	for (let c = 0; c < C; c++)
		if (cn[c] >= 2 && cverts[c].length > 1) for (const x of cverts[c]) for (const k of m.vertexCorners(x)) touched.add(m.cFace[k]);
	/** @type {number[]} */
	const split = [...degenerate];
	if (touched.size) {
		/** @type {Set<number>} */
		const done = new Set();
		for (let t = 0; t < T; t++) {
			const f = tFace[t];
			if (!touched.has(f) || done.has(f)) continue;
			done.add(f);
			if (m.fTriLen[f] < 2) continue;
			/** @type {Set<number>} */
			const seen = new Set();
			for (const x of m.faceVertices(f)) {
				const id = cn[cellOfV[x]] >= 2 ? -1 - cellOfV[x] : x;
				if (seen.has(id)) {
					split.push(t);
					break;
				}
				seen.add(id);
			}
		}
	}
	if (split.length) isolateTriangles(om, split);
	if (degenerate.length) removeTriangles(om, degenerate);
	for (let c = 0; c < C; c++) {
		if (cn[c] < 2) continue;
		const alive = cverts[c].filter((v) => m.hasVertex(v)).sort((x, y) => x - y);
		if (!alive.length) continue;
		const keep = alive[0];
		m.vPos[keep * 3] = tx[c];
		m.vPos[keep * 3 + 1] = ty[c];
		m.vPos[keep * 3 + 2] = tz[c];
		for (let i = 1; i < alive.length; i++) m.mergeVertices(keep, alive[i]);
	}
	return { ok: true, moved, dropped: degenerate.length, eps };
}

// ---- DISSOLVE EDGES -----------------------------------------------------------------------------------

/**
 * faceEdit `dissolveEdges` on the op mesh: for each picked edge (vertex pair) on exactly two triangles, those two and
 * their quad partners (`partner`, the editor's quadPartner per output triangle) — when coplanar (0.999) and one
 * closed outline — become ONE n-gon face fanned from the first outline corner off the edge (each triangle wound to
 * the first one's normal), so the dissolved edge cannot come back. All picks read the mesh as it was; the faces go
 * in at the end, one new stored face each, the first triangle's material. The refusal is the soup's toast text.
 * @param {OpMesh} om @param {[number, number][]} pairs @param {ArrayLike<number> | null} partner
 * @returns {{ ok: true, dissolved: number, skipped: number } | { error: string }}
 */
export function dissolveEdges(om, pairs, partner) {
	const m = om.mesh;
	const { view } = om;
	const T = view.count;
	/** @type {number[][]} */
	const V = new Array(T);
	/** @type {Map<number, number[]>} every triangle side by vertex pair -> its triangles (the soup's byEdge) */
	const byPair = new Map();
	for (let t = 0; t < T; t++) {
		const v = (V[t] = triVerts(om, t));
		for (let e = 0; e < 3; e++) {
			const k = pairKey(om, v[e], v[(e + 1) % 3]);
			let list = byPair.get(k);
			if (!list) byPair.set(k, (list = []));
			list.push(t);
		}
	}
	/** @type {(Vec | undefined)[]} */
	const normals = new Array(T);
	/** @param {number} t */
	const normalOf = (t) => (normals[t] ??= triNormal(pos(om, V[t][0]), pos(om, V[t][1]), pos(om, V[t][2])));
	/** @type {Set<number>} */
	const drop = new Set();
	/** @type {{ ring: number[], uvs: number[][], flips: boolean[], material: number }[]} */
	const fans = [];
	let dissolved = 0;
	let skipped = 0;
	for (const [a, b] of pairs) {
		const pair = a >= 0 && b >= 0 ? byPair.get(pairKey(om, a, b)) : undefined;
		if (!pair || pair.length !== 2 || pair.some((t) => drop.has(t))) {
			skipped++;
			continue;
		}
		/** @type {Set<number>} */
		const patch = new Set();
		for (const t of pair) {
			patch.add(t);
			const mate = partner?.[t] ?? -1;
			if (mate >= 0) patch.add(mate);
		}
		const pt = [...patch];
		const n0 = normalOf(pt[0]);
		if (pt.some((t) => dot(normalOf(t), n0) < 0.999)) {
			skipped++; // dissolving a non-flat join would change the silhouette
			continue;
		}
		const loop = boundaryLoopOf(om, pt);
		if (!loop || loop.length < 3) {
			skipped++;
			continue;
		}
		/** @type {Map<number, number[]>} vertex -> its uv, first seen over the patch */
		const corner = new Map();
		for (const t of pt) for (let k = 0; k < 3; k++) if (!corner.has(V[t][k])) corner.set(V[t][k], triUv(om, t, k));
		const startAt = loop.findIndex((v) => v !== a && v !== b);
		if (startAt < 0) {
			skipped++;
			continue;
		}
		const n = loop.length;
		const ring = loop.map((_, i) => loop[(startAt + i) % n]);
		/** @type {boolean[]} */
		const flips = [];
		for (let i = 1; i < n - 1; i++)
			flips.push(dot(triNormal(pos(om, ring[0]), pos(om, ring[i]), pos(om, ring[i + 1])), n0) < 0);
		fans.push({ ring, uvs: ring.map((v) => corner.get(v) ?? [0, 0]), flips, material: m.fMat[view.tFace[pt[0]]] });
		for (const t of pt) drop.add(t);
		dissolved++;
	}
	if (!dissolved)
		return {
			error:
				'Nothing to dissolve — an edge must join TWO COPLANAR faces (a model corner cannot be dissolved without changing the shape)'
		};
	const keep = new Set(fans.flatMap((f) => f.ring));
	removeTriangles(om, [...drop], keep);
	const hasUv = !!m.attrs.uv;
	/** @type {number[]} */
	const added = [];
	for (const fan of fans) {
		const n = fan.ring.length;
		// the face winds like its first triangle; a triangle wound the other way is stored with its corners swapped
		const reversed = fan.flips[0];
		/** ring index -> face corner @param {number} i */
		const loc = (i) => (reversed ? (n - i) % n : i);
		const order = fan.ring.map((_, j) => (reversed ? (n - j) % n : j));
		/** @type {number[]} */
		const triangles = [];
		for (let i = 1; i < n - 1; i++) {
			const [x, y] = fan.flips[i - 1] ? [i + 1, i] : [i, i + 1];
			triangles.push(loc(0), loc(x), loc(y));
		}
		/** @type {Record<string, number[]>} */
		const attrs = {};
		if (hasUv) attrs.uv = order.flatMap((i) => [fan.uvs[i][0], fan.uvs[i][1]]);
		const f = m.addFace(
			order.map((i) => fan.ring[i]),
			{ material: fan.material, attrs, triangles }
		);
		newGroup(om, f);
		added.push(f);
	}
	appendToView(om, added);
	return { ok: true, dissolved, skipped };
}

// ---- DISSOLVE VERTICES --------------------------------------------------------------------------------

/**
 * faceEdit `fanBest` on vertex IDs: the fan start whose smallest triangle is largest, no spoke on an `avoid` pair;
 * ties prefer a corner outside `preferNot`, then the lowest index. -1 = no valid start (or a degenerate best): the
 * caller fans from the centroid. @param {OpMesh} om @param {number[]} ring @param {Set<number>} avoid
 * @param {Set<number>} preferNot
 */
function fanStart(om, ring, avoid, preferNot) {
	const n = ring.length;
	const P = ring.map((v) => pos(om, v));
	let best = -1;
	let bestArea = -1;
	let bestPreferred = false;
	for (let s = 0; s < n; s++) {
		let valid = true;
		for (let i = 2; i < n - 1 && valid; i++) if (avoid.has(pairKey(om, ring[s], ring[(s + i) % n]))) valid = false;
		if (!valid) continue;
		let minArea = Infinity;
		for (let i = 1; i < n - 1; i++) {
			const a = P[s];
			minArea = Math.min(minArea, Math.sqrt(lengthSq(cross(sub(P[(s + i) % n], a), sub(P[(s + i + 1) % n], a)))));
		}
		const preferred = !preferNot.has(ring[s]);
		const better =
			minArea > bestArea * (1 + 1e-9) + 1e-12 ||
			(Math.abs(minArea - bestArea) <= bestArea * 1e-9 + 1e-12 && preferred && !bestPreferred);
		if (best < 0 || better) {
			best = s;
			bestArea = minArea;
			bestPreferred = preferred;
		}
	}
	return best >= 0 && bestArea > 1e-12 ? best : -1;
}

/**
 * Add one polygon as fanBest emits it, ONE stored face: an n-gon fanned from its best start, or (no valid start)
 * a hub vertex at the centroid and one triangle face per side. @param {OpMesh} om @param {number[]} ring
 * @param {number[][]} uvs per ring corner @param {number} material @param {Set<number>} avoid
 * @param {Set<number>} preferNot @param {number[]} added receives the new face IDs
 */
function addFan(om, ring, uvs, material, avoid, preferNot, added) {
	const m = om.mesh;
	const n = ring.length;
	const hasUv = !!m.attrs.uv;
	const group = om.nextGroup++;
	/** @param {number[]} verts @param {number[][]} cornerUvs @param {number[]} triangles */
	const face = (verts, cornerUvs, triangles) => {
		/** @type {Record<string, number[]>} */
		const attrs = {};
		if (hasUv) attrs.uv = cornerUvs.flatMap((q) => [q[0], q[1]]);
		const f = m.addFace(verts, { material, attrs, triangles });
		om.logical[f] = group;
		added.push(f);
	};
	const s = fanStart(om, ring, avoid, preferNot);
	if (s >= 0) {
		/** @type {number[]} */
		const triangles = [];
		for (let i = 1; i < n - 1; i++) triangles.push(s, (s + i) % n, (s + i + 1) % n);
		face(ring, uvs, triangles);
		return;
	}
	/** @type {Vec} */
	let hubPos = [0, 0, 0];
	const hubUv = [0, 0];
	for (let i = 0; i < n; i++) {
		hubPos = add(hubPos, pos(om, ring[i]));
		hubUv[0] += uvs[i][0] / n;
		hubUv[1] += uvs[i][1] / n;
	}
	hubPos = scale(hubPos, 1 / n);
	const hub = m.addVertex(hubPos[0], hubPos[1], hubPos[2]);
	for (let i = 0; i < n; i++) face([hub, ring[i], ring[(i + 1) % n]], [hubUv, uvs[i], uvs[(i + 1) % n]], [0, 1, 2]);
}

/**
 * faceEdit `dissolveVerticesCore` on the op mesh, one vertex after another against the mesh as it stands. The
 * stored faces around the vertex become ONE n-gon (their union's outline without the vertex, fanned from its best
 * corner off the vertex's neighbours); a vertex with exactly two neighbours instead leaves each face it is on; a
 * border vertex leaves the border. The partition keeps its order (the soup's replaceFaces: the stored faces left in
 * order, the new ones after), so the result is read with `opOutput(om, { order: 'stored' })`.
 * @param {OpMesh} om @param {number[]} verts vertex IDs (-1 = a pick with no vertex: skipped)
 * @returns {{ done: number, skipped: number }}
 */
export function dissolveVertices(om, verts) {
	const m = om.mesh;
	let done = 0;
	let skipped = 0;
	for (const v of verts) {
		const { view } = om;
		const T = view.count;
		/** @type {Map<number, number[]>} stored face (logical group) -> its output triangles, ascending */
		const trisOf = new Map();
		/** @type {Set<number>} */
		const at = new Set();
		for (let t = 0; t < T; t++) {
			const g = om.logical[view.tFace[t]];
			let list = trisOf.get(g);
			if (!list) trisOf.set(g, (list = []));
			list.push(t);
			if (v >= 0 && triVerts(om, t).includes(v)) at.add(g);
		}
		const groups = [...at].sort((x, y) => x - y); // the soup walks its partition in order
		if (!groups.length) {
			skipped++;
			continue;
		}
		const rings = groups.map((g) => boundaryLoopOf(om, /** @type {number[]} */ (trisOf.get(g))));
		if (rings.some((r) => !r)) {
			skipped++;
			continue;
		}
		/** @type {Set<number>} */
		const neighbours = new Set();
		for (const r of /** @type {number[][]} */ (rings)) {
			const n = r.length;
			const i = r.indexOf(v);
			if (i < 0) continue;
			neighbours.add(r[(i - 1 + n) % n]);
			neighbours.add(r[(i + 1) % n]);
		}
		/** @type {number[]} the union, face by face (the soup's drop Set) */
		const union = [];
		for (const g of groups) union.push(.../** @type {number[]} */ (trisOf.get(g)));
		const drop = new Set(union);
		/** vertex -> uv, first seen over `tris` (faceEdit cornerData) @param {number[]} tris */
		const cornerUv = (tris) => {
			/** @type {Map<number, number[]>} */
			const map = new Map();
			for (const t of tris) {
				const tv = triVerts(om, t);
				for (let k = 0; k < 3; k++) if (!map.has(tv[k])) map.set(tv[k], triUv(om, t, k));
			}
			return map;
		};
		/** @type {Set<number>} every side of the triangles that stay */
		const avoid = new Set();
		for (let t = 0; t < T; t++) {
			if (drop.has(t)) continue;
			const tv = triVerts(om, t);
			for (let e = 0; e < 3; e++) avoid.add(pairKey(om, tv[e], tv[(e + 1) % 3]));
		}
		/** @type {{ ring: number[], uvs: number[][], material: number, preferNot: Set<number> }[]} */
		const plans = [];
		let ok = true;
		if (neighbours.size === 2) {
			// JOIN the two edges: the vertex leaves every face it is a corner of
			for (let i = 0; i < groups.length && ok; i++) {
				const tris = /** @type {number[]} */ (trisOf.get(groups[i]));
				const uv = cornerUv(tris);
				const ring = /** @type {number[]} */ (rings[i]).filter((x) => x !== v);
				if (ring.length < 3) ok = false;
				else
					plans.push({
						ring,
						uvs: ring.map((x) => uv.get(x) ?? [0, 0]),
						material: m.fMat[view.tFace[tris[0]]],
						preferNot: new Set()
					});
			}
		} else {
			const loop = boundaryLoopOf(om, union);
			if (!loop) ok = false;
			else {
				const uv = cornerUv(union);
				const ring = loop.filter((x) => x !== v); // a BORDER vertex leaves the border loop
				if (ring.length < 3) ok = false;
				else
					plans.push({
						ring,
						uvs: ring.map((x) => uv.get(x) ?? [0, 0]),
						material: m.fMat[view.tFace[union[0]]],
						preferNot: neighbours
					});
			}
		}
		if (!ok) {
			skipped++;
			continue;
		}
		removeTriangles(om, union, new Set(plans.flatMap((p) => p.ring)));
		/** @type {number[]} */
		const added = [];
		for (const p of plans) addFan(om, p.ring, p.uvs, p.material, avoid, p.preferNot, added);
		appendToView(om, added);
		done++;
	}
	// nothing counts as authored: the partition keeps the soup's order (stored faces, then the new ones by number)
	om.baseGroup = om.nextGroup;
	return { done, skipped };
}
