// @ts-check
// Roadmap 99 K4 family 6 (lane 99-ops-b): SUBDIVIDE (picked faces as a 2x2 quad grid / a 4-way triangle split,
// picked edges at their midpoints) and SYMMETRIZE (keep one side of an axis plane, clip what straddles it, append
// the mirror) on the op mesh. Every new triangle takes the output slot the soup operator gave it: a parent's
// children sit where the parent was (order keys between the parent's and the next triangle's, the kernel's order
// keys being Float64), a mirror right after its source. Element IDs: every vertex the op does not drop keeps its
// ID; a midpoint, a quad centre, a plane crossing and a mirror twin are new vertices, shared by every face that
// meets them. Pure (no three.js, no stores).

import { isolateTriangles, newGroup } from './opMesh.js';
import { dot, triNormal, pos, keyOfPos, uvLerp } from './rebuild.js';
import { triVerts, triUv, pairKey } from './bridgeFill.js';

/** @typedef {import('./opMesh.js').OpMesh} OpMesh */

/** the order key of every output triangle (the view is sorted by them) @param {OpMesh} om */
function triOrders(om) {
	const { mesh: m, view } = om;
	const ord = new Float64Array(view.count);
	for (let t = 0; t < view.count; t++) {
		const f = view.tFace[t];
		const first = m.fTriFirst[f];
		const a = view.tLoc[t * 3];
		const b = view.tLoc[t * 3 + 1];
		const c = view.tLoc[t * 3 + 2];
		let o = t > 0 ? ord[t - 1] : -1;
		for (let r = first; r < first + m.fTriLen[f]; r++)
			if (m.tLocal[r * 3] === a && m.tLocal[r * 3 + 1] === b && m.tLocal[r * 3 + 2] === c) {
				o = m.tOrder[r];
				break;
			}
		ord[t] = o;
	}
	return ord;
}

/** n order keys in output triangle t's slot (between its key and the next one's) @param {Float64Array} ord
 * @param {number} t @param {number} n @returns {number[]} */
function slotOrders(ord, t, n) {
	const base = ord[t];
	const next = t + 1 < ord.length ? ord[t + 1] : base + 1;
	const step = (next - base) / n;
	return Array.from({ length: n }, (_, i) => base + step * i);
}

/** one triangle face; `group` undefined = a new logical group (an authored face)
 * @param {OpMesh} om @param {number[]} verts @param {number} material @param {number[][]} uvs @param {number} order
 * @param {number} [group] */
function addTri(om, verts, material, uvs, order, group) {
	const m = om.mesh;
	/** @type {Record<string, number[]>} */
	const attrs = {};
	if (m.attrs.uv) attrs.uv = [uvs[0][0], uvs[0][1], uvs[1][0], uvs[1][1], uvs[2][0], uvs[2][1]];
	const f = m.addFace(verts, { material, attrs, triangles: [0, 1, 2], orders: [order] });
	if (group === undefined) newGroup(om, f);
	else om.logical[f] = group;
	return f;
}

/** the soup's pushQuad as one kernel face at two given order keys (bridgeFill addQuad's winding rule): corners
 * q wound so the first triangle faces `want`, triangulated a-b-c / a-c-d (flipped a-c-b / a-d-c)
 * @param {OpMesh} om @param {number[]} q @param {number[][]} p @param {number[]} want @param {number} material
 * @param {number[][]} uvs @param {number[]} orders */
function addQuadAt(om, q, p, want, material, uvs, orders) {
	const m = om.mesh;
	const [a, b, c, d] = q;
	const flip = dot(triNormal(p[0], p[1], p[2]), want) < 0;
	const verts = flip ? [a, d, c, b] : [a, b, c, d];
	const triangles = flip ? [0, 2, 3, 0, 1, 2] : [0, 1, 2, 0, 2, 3];
	const order = flip ? [0, 3, 2, 1] : [0, 1, 2, 3];
	/** @type {Record<string, number[]>} */
	const attrs = {};
	if (m.attrs.uv) attrs.uv = order.flatMap((i) => uvs[i]);
	const f = m.addFace(verts, { material, attrs, triangles, orders });
	newGroup(om, f);
	return { f, triangles };
}

/**
 * The new output view, written in output order while an operator walks the old one — cheaper than buildView
 * (which re-sorts every triangle by order key), and the same: the operators give their new triangles order keys
 * in exactly this order (a unit test holds the two equal). `keep` / `keepRange` copy from the OLD view.
 * @param {OpMesh} om @param {number} capacity a guess at the output count (it grows)
 */
function viewWriter(om, capacity) {
	const old = om.view;
	let F = new Int32Array(Math.max(16, capacity));
	let L = new Int32Array(F.length * 3);
	let n = 0;
	const grow = (/** @type {number} */ need) => {
		if (need <= F.length) return;
		const nf = new Int32Array(Math.max(need, F.length * 2));
		nf.set(F.subarray(0, n));
		const nl = new Int32Array(nf.length * 3);
		nl.set(L.subarray(0, n * 3));
		F = nf;
		L = nl;
	};
	const w = {
		/** @param {number} f @param {number} a @param {number} b @param {number} c */
		push(f, a, b, c) {
			grow(n + 1);
			F[n] = f;
			L[n * 3] = a;
			L[n * 3 + 1] = b;
			L[n * 3 + 2] = c;
			n++;
		},
		/** the old view's triangles t0 .. t1 - 1, unchanged @param {number} t0 @param {number} t1 */
		keepRange(t0, t1) {
			const k = t1 - t0;
			if (k <= 0) return;
			grow(n + k);
			F.set(old.tFace.subarray(t0, t1), n);
			L.set(old.tLoc.subarray(t0 * 3, t1 * 3), n * 3);
			n += k;
		},
		/** @param {number} t */
		keep(t) {
			w.keepRange(t, t + 1);
		},
		get count() {
			return n;
		},
		done() {
			om.view = { tFace: F.slice(0, n), tLoc: L.slice(0, n * 3), count: n };
		}
	};
	return w;
}

/** the order key of output triangle t (its face's triangulation record with the view's local corners)
 * @param {OpMesh} om @param {number} t */
function orderOf(om, t) {
	const m = om.mesh;
	const { view } = om;
	const f = view.tFace[t];
	const first = m.fTriFirst[f];
	const a = view.tLoc[t * 3];
	const b = view.tLoc[t * 3 + 1];
	const c = view.tLoc[t * 3 + 2];
	for (let r = first; r < first + m.fTriLen[f]; r++)
		if (m.tLocal[r * 3] === a && m.tLocal[r * 3 + 1] === b && m.tLocal[r * 3 + 2] === c) return m.tOrder[r];
	return NaN;
}

/** n order keys in output triangle t's slot, read before anything is removed
 * @param {OpMesh} om @param {number} t @param {number} n @returns {number[]} */
function slotOf(om, t, n) {
	const base = orderOf(om, t);
	const next = t + 1 < om.view.count ? orderOf(om, t + 1) : base + 1;
	const step = (next - base) / n;
	return Array.from({ length: n }, (_, i) => base + step * i);
}

/** a shared midpoint vertex per vertex pair ((p + q) * 0.5: the soup's clone().add().multiplyScalar(0.5)).
 * The pairs live in an open-addressed table of two Int32 vertex IDs: a Map keyed by pairKey hashes a
 * double (the key passes 2^31), which was the op's hottest line at 67k.
 * @param {OpMesh} om @param {number} expected a guess at the pair count (the table grows) */
function midpointMaker(om, expected) {
	const m = om.mesh;
	let size = 64;
	while (size < expected * 2) size *= 2;
	let lo = new Int32Array(size).fill(-1);
	let hi = new Int32Array(size);
	let val = new Int32Array(size);
	let used = 0;
	const slot = (/** @type {number} */ a, /** @type {number} */ b) => {
		const mask = size - 1;
		let h = (Math.imul(a, 0x9e3779b1) ^ Math.imul(b, 0x85ebca6b)) & mask;
		while (lo[h] !== -1 && (lo[h] !== a || hi[h] !== b)) h = (h + 1) & mask;
		return h;
	};
	const grow = () => {
		const [ol, oh, ov] = [lo, hi, val];
		size *= 2;
		lo = new Int32Array(size).fill(-1);
		hi = new Int32Array(size);
		val = new Int32Array(size);
		for (let k = 0; k < ol.length; k++)
			if (ol[k] !== -1) {
				const h = slot(ol[k], oh[k]);
				lo[h] = ol[k];
				hi[h] = oh[k];
				val[h] = ov[k];
			}
	};
	return (/** @type {number} */ a, /** @type {number} */ b) => {
		const x = a < b ? a : b;
		const y = a < b ? b : a;
		let h = slot(x, y);
		if (lo[h] !== -1) return val[h];
		const P = m.vPos;
		const v = m.addVertex((P[a * 3] + P[b * 3]) * 0.5, (P[a * 3 + 1] + P[b * 3 + 1]) * 0.5, (P[a * 3 + 2] + P[b * 3 + 2]) * 0.5);
		if ((used + 1) * 2 > size) {
			grow();
			h = slot(x, y);
		}
		lo[h] = x;
		hi[h] = y;
		val[h] = v;
		used++;
		return v;
	};
}

// ---- SUBDIVIDE FACES ---------------------------------------------------------------------------------

/**
 * The soup's subdivideFaceUnits on the op mesh: each picked quad (both halves picked, paired in `partner`)
 * becomes a 2x2 grid of quad faces, every other picked triangle a 4-way split (four triangle faces).
 * Unpicked neighbours keep their full edge (the soup's T-junction). Each new face is its own logical group,
 * in the soup's authored order.
 * @param {OpMesh} om @param {number[]} targetTris output triangles
 * @param {ArrayLike<number> | null} partner quad pairing over the output triangles (-1 = none)
 * @returns {{ newTris: number[], created: number[], count: number }}
 */
export function subdivideUnits(om, targetTris, partner) {
	const m = om.mesh;
	const T = om.view.count;
	// a mask, not a Set: the walk below reads it once per picked triangle and its mate
	const picked = new Uint8Array(T);
	for (const t of targetTris) if (t >= 0 && t < T) picked[t] = 1;
	/** @type {number[]} the picked triangles in output order */
	const sorted = [];
	for (let t = 0; t < T; t++) if (picked[t]) sorted.push(t);
	if (!sorted.length) return { newTris: [], created: [], count: T };
	const targets = { has: (/** @type {number} */ t) => picked[t] === 1 };
	isolateTriangles(om, sorted);
	const { view } = om;
	const mid = midpointMaker(om, sorted.length * 2);
	/** @type {{ t: number, kind: 'tri' | 'quad', mate: number, ring: number[] | null }[]} */
	const units = [];
	const done = new Uint8Array(T);
	/** @type {Set<number>} */
	const parents = new Set();
	for (const t of sorted) {
		if (done[t]) continue;
		parents.add(view.tFace[t]);
		const mate = partner?.[t] ?? -1;
		const ring = mate >= 0 && mate < T && targets.has(mate) ? quadRing(om, t, mate) : null;
		if (ring) {
			done[t] = done[mate] = 1;
			parents.add(view.tFace[mate]);
		}
		units.push({ t, kind: ring ? 'quad' : 'tri', mate, ring });
	}
	// read every corner before anything is removed
	const read = units.map((u) => ({
		verts: triVerts(om, u.t),
		uvs: [0, 1, 2].map((k) => triUv(om, u.t, k)),
		mateVerts: u.ring ? triVerts(om, u.mate) : null,
		mateUvs: u.ring ? [0, 1, 2].map((k) => triUv(om, u.mate, k)) : null,
		material: m.fMat[view.tFace[u.t]],
		orders: slotOf(om, u.t, u.ring ? 8 : 4)
	}));
	for (const f of parents) m.removeFace(f);
	/** @type {number[]} */
	const created = [];
	/** @type {number[]} */
	const newTris = [];
	const out = viewWriter(om, T + units.length * 6);
	/** @type {Map<number, number>} */
	const unitAt = new Map();
	units.forEach((u, i) => unitAt.set(u.t, i));
	let from = 0;
	for (const t of sorted) {
		out.keepRange(from, t);
		from = t + 1;
		const i = unitAt.get(t);
		if (i === undefined) continue; // a picked quad's second half: its unit emitted it
		const u = units[i];
		const { verts, uvs, material, orders } = read[i];
		if (!u.ring) {
			// subdivideFaceTris: [a, ab, ca] [ab, b, bc] [ca, bc, c] [ab, bc, ca]
			const [a, b, c] = verts;
			const ab = mid(a, b);
			const bc = mid(b, c);
			const ca = mid(c, a);
			const [uA, uB, uC] = uvs;
			const uAB = uvLerp(uA, uB, 0.5);
			const uBC = uvLerp(uB, uC, 0.5);
			const uCA = uvLerp(uC, uA, 0.5);
			/** @type {[number[], number[][]][]} */
			const kids = [
				[[a, ab, ca], [uA, uAB, uCA]],
				[[ab, b, bc], [uAB, uB, uBC]],
				[[ca, bc, c], [uCA, uBC, uC]],
				[[ab, bc, ca], [uAB, uBC, uCA]]
			];
			kids.forEach(([vs, us], n) => {
				const f = addTri(om, vs, material, us, orders[n]);
				created.push(f);
				newTris.push(out.count);
				out.push(f, 0, 1, 2);
			});
			continue;
		}
		// the ring [p, ra, q, rb] (quadRingKeysIn), each corner's uv the first seen (this triangle, then its mate)
		/** @type {Map<number, number[]>} */
		const uvOf = new Map();
		verts.forEach((v, k) => uvOf.has(v) || uvOf.set(v, uvs[k]));
		/** @type {number[]} */ (read[i].mateVerts).forEach(
			(v, k) => uvOf.has(v) || uvOf.set(v, /** @type {number[][]} */ (read[i].mateUvs)[k])
		);
		const [A, B, C, D] = /** @type {number[]} */ (u.ring);
		const want = triNormal(pos(om, verts[0]), pos(om, verts[1]), pos(om, verts[2]));
		const mAB = mid(A, B);
		const mBC = mid(B, C);
		const mCD = mid(C, D);
		const mDA = mid(D, A);
		const pa = pos(om, A);
		const pc = pos(om, C);
		const ctr = m.addVertex((pa[0] + pc[0]) * 0.5, (pa[1] + pc[1]) * 0.5, (pa[2] + pc[2]) * 0.5);
		const uv = (/** @type {number} */ v) => /** @type {number[]} */ (uvOf.get(v));
		const uAB = uvLerp(uv(A), uv(B), 0.5);
		const uBC = uvLerp(uv(B), uv(C), 0.5);
		const uCD = uvLerp(uv(C), uv(D), 0.5);
		const uDA = uvLerp(uv(D), uv(A), 0.5);
		const uCtr = uvLerp(uv(A), uv(C), 0.5);
		const cell = (/** @type {number[]} */ q, /** @type {number[][]} */ quv, /** @type {number} */ n) => {
			const { f, triangles } = addQuadAt(om, q, q.map((v) => pos(om, v)), want, material, quv, [orders[n * 2], orders[n * 2 + 1]]);
			created.push(f);
			for (let r = 0; r < 2; r++) {
				newTris.push(out.count);
				out.push(f, triangles[r * 3], triangles[r * 3 + 1], triangles[r * 3 + 2]);
			}
		};
		cell([A, mAB, ctr, mDA], [uv(A), uAB, uCtr, uDA], 0);
		cell([mAB, B, mBC, ctr], [uAB, uv(B), uBC, uCtr], 1);
		cell([ctr, mBC, C, mCD], [uCtr, uBC, uv(C), uCD], 2);
		cell([mDA, ctr, mCD, D], [uDA, uCtr, uCD, uv(D)], 3);
	}
	out.keepRange(from, T);
	out.done();
	return { newTris, created, count: om.view.count };
}

/** the quad's ring from two triangles sharing two vertices: [shared0, t's other, shared1, mate's other] (the
 * soup's quadRingKeysIn, shared in t's corner order), or null @param {OpMesh} om @param {number} t @param {number} mate */
function quadRing(om, t, mate) {
	const a = triVerts(om, t);
	const b = triVerts(om, mate);
	const shared = a.filter((v) => b.includes(v));
	if (shared.length !== 2) return null;
	const ra = a.find((v) => !shared.includes(v));
	const rb = b.find((v) => !shared.includes(v));
	if (ra === undefined || rb === undefined) return null;
	return [shared[0], ra, shared[1], rb];
}

/**
 * The soup's subdivideLevels: `levels` passes, each re-targeting the previous pass's new triangles with the
 * quads it built paired. @param {OpMesh} om @param {number[]} targetTris
 * @param {ArrayLike<number> | null} partner @param {number} levels
 * @returns {{ newTris: number[], created: number[], count: number }}
 */
export function subdivideLevels(om, targetTris, partner, levels) {
	const passes = Math.max(1, Math.round(levels) || 1);
	let r = subdivideUnits(om, targetTris, partner);
	for (let pass = 1; pass < passes; pass++) {
		const created = new Set(r.created);
		const next = new Int32Array(om.view.count).fill(-1);
		/** @type {Map<number, number[]>} */
		const byFace = new Map();
		for (const t of r.newTris) {
			const f = om.view.tFace[t];
			if (!created.has(f)) continue;
			let list = byFace.get(f);
			if (!list) byFace.set(f, (list = []));
			list.push(t);
		}
		for (const list of byFace.values())
			if (list.length === 2) {
				next[list[0]] = list[1];
				next[list[1]] = list[0];
			}
		r = subdivideUnits(om, r.newTris, next);
	}
	return r;
}

// ---- SUBDIVIDE EDGES ---------------------------------------------------------------------------------

/**
 * The soup's subdivideSelectedEdges on the op mesh: every triangle with a picked side is split at that side's
 * midpoint (one shared midpoint vertex per edge); each piece stays in its parent's stored face (the soup
 * composed them back through their origin). @param {OpMesh} om @param {[number, number][]} pairs vertex pairs
 * @returns {{ midpoints: { ka: string, kb: string, km: string }[], split: number } | { error: string }}
 */
export function subdivideEdges(om, pairs) {
	const m = om.mesh;
	/** @type {Set<number>} */
	const wanted = new Set();
	for (const [a, b] of pairs) if (a >= 0 && b >= 0 && a !== b) wanted.add(pairKey(om, a, b));
	// one midpoint per picked side some triangle has, in the soup's discovery order (triangle, then side)
	/** @type {Map<number, { a: number, b: number }>} */
	const found = new Map();
	/** @type {number[]} */
	const hit = [];
	for (let t = 0; t < om.view.count; t++) {
		const v = triVerts(om, t);
		let any = false;
		for (let e = 0; e < 3; e++) {
			const k = pairKey(om, v[e], v[(e + 1) % 3]);
			if (!wanted.has(k)) continue;
			any = true;
			if (!found.has(k)) found.set(k, { a: v[e], b: v[(e + 1) % 3] });
		}
		if (any) hit.push(t);
	}
	if (!found.size) return { error: 'Nothing to subdivide — no face uses those edges' };
	isolateTriangles(om, hit);
	const { view } = om;
	/** @type {Map<number, number>} */
	const midV = new Map();
	for (const [k, { a, b }] of found) {
		const pa = pos(om, a);
		const pb = pos(om, b);
		midV.set(k, m.addVertex((pa[0] + pb[0]) * 0.5, (pa[1] + pb[1]) * 0.5, (pa[2] + pb[2]) * 0.5));
	}
	const jobs = hit.map((t) => {
		const verts = triVerts(om, t);
		const f = view.tFace[t];
		const hits = [0, 1, 2].filter((e) => midV.has(pairKey(om, verts[e], verts[(e + 1) % 3]))).length;
		return {
			t,
			orders: slotOf(om, t, hits === 1 ? 2 : hits === 2 ? 3 : 4),
			verts,
			uvs: [0, 1, 2].map((k) => triUv(om, t, k)),
			material: m.fMat[f],
			group: om.logical[f],
			face: f
		};
	});
	for (const j of jobs) m.removeFace(j.face);
	const textured = !!m.attrs.uv;
	const T = view.count;
	const out = viewWriter(om, T + jobs.length * 3);
	let from = 0;
	for (const j of jobs) {
		out.keepRange(from, j.t);
		from = j.t + 1;
		const { verts: tri, uvs } = j;
		/** @type {{ e: number, m: number, uv: number[] }[]} */
		const hits = [];
		for (let e = 0; e < 3; e++) {
			const v = midV.get(pairKey(om, tri[e], tri[(e + 1) % 3]));
			if (v !== undefined) hits.push({ e, m: v, uv: uvLerp(uvs[e], uvs[(e + 1) % 3], 0.5) });
		}
		const faceNormal = triNormal(pos(om, tri[0]), pos(om, tri[1]), pos(om, tri[2]));
		const { orders } = j;
		let o = 0;
		/** the knife's push: one triangle wound like the parent @param {number[]} points @param {number[][]} puv */
		const emit = (points, puv) => {
			const flip = dot(triNormal(pos(om, points[0]), pos(om, points[1]), pos(om, points[2])), faceNormal) < 0;
			const wound = flip ? [points[0], points[2], points[1]] : points;
			const wuv = flip ? [puv[0], puv[2], puv[1]] : puv;
			out.push(addTri(om, wound, j.material, textured ? wuv : [[0, 0], [0, 0], [0, 0]], orders[o++], j.group), 0, 1, 2);
		};
		if (hits.length === 1) {
			const { e, m: mv, uv } = hits[0];
			emit([mv, tri[(e + 1) % 3], tri[(e + 2) % 3]], [uv, uvs[(e + 1) % 3], uvs[(e + 2) % 3]]);
			emit([mv, tri[(e + 2) % 3], tri[e]], [uv, uvs[(e + 2) % 3], uvs[e]]);
		} else if (hits.length === 2) {
			const [first, second] = hits.sort((x, y) => x.e - y.e);
			const shared = first.e + 1 === second.e ? second.e : 0;
			const ci = shared % 3;
			const p = first.e === (ci + 2) % 3 ? first : second;
			const q = p === first ? second : first;
			emit([p.m, tri[ci], q.m], [p.uv, uvs[ci], q.uv]);
			emit([q.m, tri[(ci + 1) % 3], tri[(ci + 2) % 3]], [q.uv, uvs[(ci + 1) % 3], uvs[(ci + 2) % 3]]);
			emit([q.m, tri[(ci + 2) % 3], p.m], [q.uv, uvs[(ci + 2) % 3], p.uv]);
		} else {
			const [m01, m12, m20] = [...hits].sort((x, y) => x.e - y.e);
			emit([tri[0], m01.m, m20.m], [uvs[0], m01.uv, m20.uv]);
			emit([m01.m, tri[1], m12.m], [m01.uv, uvs[1], m12.uv]);
			emit([m20.m, m12.m, tri[2]], [m20.uv, m12.uv, uvs[2]]);
			emit([m01.m, m12.m, m20.m], [m01.uv, m12.uv, m20.uv]);
		}
	}
	out.keepRange(from, T);
	out.done();
	/** @type {{ ka: string, kb: string, km: string }[]} */
	const midpoints = [];
	for (const [k, { a, b }] of found) {
		// the pick key's own order (faceEdit edgeKey sorts its two ends)
		const A = keyOfPos(pos(om, a));
		const B = keyOfPos(pos(om, b));
		const km = keyOfPos(pos(om, /** @type {number} */ (midV.get(k))));
		midpoints.push(A < B ? { ka: A, kb: B, km } : { ka: B, kb: A, km });
	}
	return { midpoints, split: jobs.length };
}

// ---- SYMMETRIZE --------------------------------------------------------------------------------------

/**
 * The soup's mirrorTrisCore on the op mesh: vertices within `tolerance` of the plane are pinned onto it, the
 * triangles wholly on the kept side stay (each followed by its mirror), the ones straddling the plane are
 * clipped (Sutherland-Hodgman, the crossings pinned onto the plane, shared per edge) into pieces that stay in
 * their parent's stored face, each followed by its mirror, and the rest go. A mirror joins ONE new face per
 * source face (a quad stays a quad on both sides). Nothing changes when nothing is on the kept side (null).
 * @param {OpMesh} om @param {'x'|'y'|'z'} axis @param {number} keep +1 / -1 @param {number} tolerance
 * @returns {{ kept: Map<number, number>, pairs: number, clipped: number, dropped: number } | null}
 */
export function symmetrize(om, axis, keep, tolerance) {
	const m = om.mesh;
	const idx = axis === 'y' ? 1 : axis === 'z' ? 2 : 0;
	const { vPos, cVert, fFirst } = m; // read-only, and only before anything is added
	const T0 = om.view.count;
	// 0 = a sliver IN the plane (goes, uncounted) · 1 = kept whole · 2 = wholly on the far side · 3 = straddling
	const cls = new Int8Array(T0);
	let any = false;
	{
		const { tFace, tLoc } = om.view;
		for (let t = 0; t < T0; t++) {
			const first = fFirst[tFace[t]];
			let positives = 0;
			let negatives = 0;
			for (let k = 0; k < 3; k++) {
				const c = vPos[cVert[first + tLoc[t * 3 + k]] * 3 + idx];
				const d = (Math.abs(c) < tolerance ? 0 : c) * keep;
				if (d > 0) positives++;
				else if (d < 0) negatives++;
			}
			const kind = !positives && !negatives ? 0 : !negatives ? 1 : !positives ? 2 : 3;
			cls[t] = kind;
			if (kind === 1 || kind === 3) any = true;
		}
	}
	if (!any) return null;
	for (let v = 0; v < m.vTop; v++) if (m.hasVertex(v) && Math.abs(vPos[v * 3 + idx]) < tolerance) vPos[v * 3 + idx] = 0;
	/** @type {number[]} */
	const replace = [];
	for (let t = 0; t < T0; t++) if (cls[t] !== 1) replace.push(t);
	if (replace.length) isolateTriangles(om, replace);
	const { view } = om;
	const ord = triOrders(om);
	const textured = !!m.attrs.uv;
	// vertex -> its mirror (itself on the plane); only the vertices that exist now can be asked for
	const twin = new Int32Array(m.vTop).fill(-1);
	const mirrorOf = (/** @type {number} */ v) => {
		const P = m.vPos; // addVertex may grow (replace) the array
		if (P[v * 3 + idx] === 0) return v;
		if (v < twin.length && twin[v] >= 0) return twin[v];
		const p = [P[v * 3], P[v * 3 + 1], P[v * 3 + 2]];
		p[idx] = -p[idx];
		const w = m.addVertex(p[0], p[1], p[2]);
		if (v < twin.length) twin[v] = w;
		return w;
	};
	/** @type {Map<number, number>} source logical group -> the group of its mirror */
	const mirrorGroup = new Map();
	const groupOfMirror = (/** @type {number} */ g) => {
		let h = mirrorGroup.get(g);
		if (h === undefined) mirrorGroup.set(g, (h = om.nextGroup++));
		return h;
	};
	/** @type {Map<number, number>} the plane crossing of an edge (the first triangle to cut it decides it) */
	const crossing = new Map();
	// the straddling triangles' corners, read before their faces go
	/** @type {Map<number, { group: number, material: number, verts: number[], uvs: number[][] }>} */
	const straddle = new Map();
	/** @type {Set<number>} */
	const gone = new Set();
	/** @type {Set<number>} the vertices of what goes: the far side's are swept afterwards */
	const maybeOrphan = new Set();
	for (const t of replace) {
		const f = view.tFace[t];
		gone.add(f);
		for (const v of triVerts(om, t)) maybeOrphan.add(v);
		if (cls[t] === 3)
			straddle.set(t, { group: om.logical[f], material: m.fMat[f], verts: triVerts(om, t), uvs: [0, 1, 2].map((k) => triUv(om, t, k)) });
	}
	/** @type {Map<number, number>} */
	const kept = new Map();
	let pairs = 0;
	let clipped = 0;
	let dropped = 0;
	const zero = [[0, 0], [0, 0], [0, 0]];
	const out = viewWriter(om, T0 * 2);
	for (const f of gone) m.removeFace(f);
	// a kept triangle's face stays, so its corners are read as the walk reaches it (the arrays are read live:
	// adding faces and vertices may replace them)
	for (let t = 0; t < T0; t++) {
		const c = cls[t];
		if (c === 0) continue;
		if (c === 2) {
			dropped++;
			continue;
		}
		if (c === 1) {
			kept.set(t, out.count);
			out.keep(t);
			const f = view.tFace[t];
			const first = m.fFirst[f];
			const c0 = first + view.tLoc[t * 3];
			const c1 = first + view.tLoc[t * 3 + 1];
			const c2 = first + view.tLoc[t * 3 + 2];
			const base = ord[t];
			const o = base + ((t + 1 < T0 ? ord[t + 1] : base + 1) - base) / 2;
			const uvData = m.attrs.uv?.data;
			const uvs = uvData
				? [
						[uvData[c0 * 2], uvData[c0 * 2 + 1]],
						[uvData[c2 * 2], uvData[c2 * 2 + 1]],
						[uvData[c1 * 2], uvData[c1 * 2 + 1]]
					]
				: zero;
			const mv = [mirrorOf(m.cVert[c0]), mirrorOf(m.cVert[c2]), mirrorOf(m.cVert[c1])];
			out.push(addTri(om, mv, m.fMat[f], uvs, o, groupOfMirror(om.logical[f])), 0, 1, 2);
			pairs++;
			continue;
		}
		// straddling: keep the inside corners, add the crossings
		const j = /** @type {{ group: number, material: number, verts: number[], uvs: number[][] }} */ (straddle.get(t));
		const d = j.verts.map((v) => m.vPos[v * 3 + idx] * keep);
		/** @type {{ v: number, uv: number[] }[]} */
		const polygon = [];
		for (let i = 0; i < 3; i++) {
			const k = (i + 1) % 3;
			if (d[i] >= 0) polygon.push({ v: j.verts[i], uv: j.uvs[i] });
			if ((d[i] > 0 && d[k] < 0) || (d[i] < 0 && d[k] > 0)) {
				const s = d[i] / (d[i] - d[k]);
				const key = pairKey(om, j.verts[i], j.verts[k]);
				let x = crossing.get(key);
				if (x === undefined) {
					const p = pos(om, j.verts[i]);
					const q = pos(om, j.verts[k]);
					const at = [p[0] + (q[0] - p[0]) * s, p[1] + (q[1] - p[1]) * s, p[2] + (q[2] - p[2]) * s];
					at[idx] = 0;
					x = m.addVertex(at[0], at[1], at[2]);
					crossing.set(key, x);
				}
				polygon.push({ v: x, uv: uvLerp(j.uvs[i], j.uvs[k], s) });
			}
		}
		if (polygon.length < 3) {
			dropped++;
			continue;
		}
		clipped++;
		const normal = triNormal(pos(om, j.verts[0]), pos(om, j.verts[1]), pos(om, j.verts[2]));
		const orders = slotOrders(ord, t, (polygon.length - 2) * 2);
		for (let i = 1; i < polygon.length - 1; i++) {
			const piece = [polygon[0], polygon[i], polygon[i + 1]];
			const pv = piece.map((e) => e.v);
			const flip = dot(triNormal(pos(om, pv[0]), pos(om, pv[1]), pos(om, pv[2])), normal) < 0;
			const wound = flip ? [pv[0], pv[2], pv[1]] : pv;
			const puv = piece.map((e) => e.uv);
			const wuv = flip ? [puv[0], puv[2], puv[1]] : puv;
			out.push(addTri(om, wound, j.material, textured ? wuv : zero, orders[(i - 1) * 2], j.group), 0, 1, 2);
			const mf = addTri(
				om,
				[mirrorOf(wound[0]), mirrorOf(wound[2]), mirrorOf(wound[1])],
				j.material,
				textured ? [wuv[0], wuv[2], wuv[1]] : zero,
				orders[(i - 1) * 2 + 1],
				groupOfMirror(j.group)
			);
			out.push(mf, 0, 1, 2);
			pairs++;
		}
	}
	// the far side's vertices nothing uses any more
	for (const v of maybeOrphan) if (m.hasVertex(v) && !m.vertexCorners(v).length) m.removeVertex(v);
	out.done();
	return { kept, pairs, clipped, dropped };
}
