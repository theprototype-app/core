// Roadmap 99 K4 family 1: extrude / inset / move on the kernel.
//
// Each operator takes the REGION as output-triangle indices (the editor's selection) and works
// on its faces. The soup operators these replace walked triangles, so the order in which walls and
// rings are emitted follows the region's triangles, each triangle's corners in order — that is
// what keeps every output triangle at the index the soup gave it (survivors in place, new quads
// appended, the cap's indices unchanged, which the selection and the agent's `kept` rely on).
//
// The topology rule (the soup's, made explicit): a region vertex is DUPLICATED when it sits on the
// region's border or is used by a face outside the region (the region detaches there; a border
// edge gets a wall / ring quad, a corner-only contact gets none); every other region vertex moves
// in place. Every face keeps its ID; a region face keeps its corner order and triangulation.

import { NONE } from '../meshKernel/kernel.js';
import { isolateTriangles, refaceKeep, appendToView, newGroup, cornerOf } from './opMesh.js';

/** @typedef {import('./opMesh.js').OpMesh} OpMesh @typedef {[number, number, number]} Vec */

/** @param {number[] | Float64Array} a @param {number[] | Float64Array} b @returns {Vec} */
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
/** @param {number[]} a @param {number[]} b @returns {Vec} */
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
/** @param {number[]} a @param {number[]} b */
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
/** three's Vector3.normalize: a zero vector stays zero @param {number[]} a @returns {Vec} */
function normalize(a) {
	const l = Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]) || 1;
	return [a[0] / l, a[1] / l, a[2] / l];
}
/** @param {number[]} a @param {number[]} b @param {number[]} c */
const triNormal = (a, b, c) => normalize(cross(sub(b, a), sub(c, a)));

/** @param {OpMesh} om @param {number} v @returns {Vec} */
function pos(om, v) {
	const p = om.mesh.vPos;
	return [p[v * 3], p[v * 3 + 1], p[v * 3 + 2]];
}

/** @param {OpMesh} om @param {number} c @returns {[number, number]} */
function uvOf(om, c) {
	const uv = om.mesh.attrs.uv;
	return uv ? [uv.data[c * 2], uv.data[c * 2 + 1]] : [0, 0];
}

/** the unit normal of output triangle t (current positions) @param {OpMesh} om @param {number} t */
export function triangleNormal(om, t) {
	const m = om.mesh;
	return triNormal(pos(om, m.cVert[cornerOf(om, t, 0)]), pos(om, m.cVert[cornerOf(om, t, 1)]), pos(om, m.cVert[cornerOf(om, t, 2)]));
}

/** the soup's averagedNormal: the unit normals of the triangles summed, then normalized
 * @param {OpMesh} om @param {number[]} tris @returns {Vec} */
export function averagedNormal(om, tris) {
	let n = [0, 0, 0];
	for (const t of tris) {
		const tn = triangleNormal(om, t);
		n = [n[0] + tn[0], n[1] + tn[1], n[2] + tn[2]];
	}
	if (dot(n, n) < 1e-9) n = triangleNormal(om, tris[0]);
	return normalize(n);
}

/**
 * Connected pieces of a triangle set (shared vertex = connected), in the soup's order: pieces by
 * their first triangle, triangles in input order. @param {OpMesh} om @param {number[]} tris
 * @returns {number[][]}
 */
export function triangleComponents(om, tris) {
	const m = om.mesh;
	/** @type {Map<number, number>} */
	const parent = new Map();
	/** @param {number} v */
	const find = (v) => {
		let r = v;
		while (parent.get(r) !== r) r = /** @type {number} */ (parent.get(r));
		while (parent.get(v) !== r) {
			const next = /** @type {number} */ (parent.get(v));
			parent.set(v, r);
			v = next;
		}
		return r;
	};
	const vertsOf = (/** @type {number} */ t) => [0, 1, 2].map((k) => m.cVert[cornerOf(om, t, k)]);
	for (const t of tris) {
		const vs = vertsOf(t);
		for (const v of vs) if (!parent.has(v)) parent.set(v, v);
		for (let i = 1; i < 3; i++) parent.set(find(vs[0]), find(vs[i]));
	}
	/** @type {Map<number, number[]>} */
	const byRoot = new Map();
	for (const t of tris) {
		const root = find(vertsOf(t)[0]);
		let list = byRoot.get(root);
		if (!list) byRoot.set(root, (list = []));
		list.push(t);
	}
	return [...byRoot.values()];
}

/**
 * The region's border, in soup order: every side of a region triangle that is a face side walked
 * by exactly one region face. @param {OpMesh} om @param {number[]} tris @param {Set<number>} faces
 * @returns {{ t: number, va: number, vb: number, ca: number, cb: number, f: number }[]}
 */
function borderOf(om, tris, faces) {
	const m = om.mesh;
	/** @type {{ t: number, va: number, vb: number, ca: number, cb: number, f: number }[]} */
	const out = [];
	for (const t of tris) {
		const f = om.view.tFace[t];
		const n = m.fLen[f];
		for (let e = 0; e < 3; e++) {
			const la = om.view.tLoc[t * 3 + e];
			const lb = om.view.tLoc[t * 3 + ((e + 1) % 3)];
			if ((la + 1) % n !== lb) continue; // a diagonal: inside the face
			const ca = m.fFirst[f] + la;
			const edge = m.cEdge[ca];
			if (edge === NONE) continue;
			let sides = 0;
			for (const c of m.edgeCorners(edge)) if (faces.has(m.cFace[c])) sides++;
			if (sides !== 1) continue;
			out.push({ t, va: m.cVert[ca], vb: m.cVert[m.fFirst[f] + lb], ca, cb: m.fFirst[f] + lb, f });
		}
	}
	return out;
}

/**
 * Detach the region and give its vertices new positions. Returns the old -> new vertex map (a
 * duplicated vertex keeps the OLD position for the outside; an undupli­cated one was moved in place).
 * @param {OpMesh} om @param {Set<number>} faces @param {Set<number>} borderVerts
 * @param {(v: number) => Vec} target the new position of a region vertex (read before any write)
 * @param {(f: number, corner: number, local: number) => [number, number] | null} [uvAt] a corner's new uv
 * @returns {Map<number, number>}
 */
function detachRegion(om, faces, borderVerts, target, uvAt) {
	const m = om.mesh;
	/** @type {Set<number>} */
	const verts = new Set();
	for (const f of faces) for (const v of m.faceVertices(f)) verts.add(v);
	/** @type {Map<number, Vec>} */
	const next = new Map();
	for (const v of verts) next.set(v, target(v));
	/** @type {Map<number, number>} */
	const dup = new Map();
	for (const v of verts) {
		let split = borderVerts.has(v);
		if (!split)
			for (const c of m.vertexCorners(v))
				if (!faces.has(m.cFace[c])) {
					split = true;
					break;
				}
		const p = /** @type {Vec} */ (next.get(v));
		if (split) dup.set(v, m.addVertex(p[0], p[1], p[2]));
		else m.setPosition(v, p[0], p[1], p[2]);
	}
	for (const f of faces) {
		const verts2 = m.faceVertices(f);
		const changed = verts2.some((v) => dup.has(v));
		if (!changed && !uvAt) continue;
		let attrs = m._faceAttrs(f);
		if (uvAt && attrs.uv) {
			const first = m.fFirst[f];
			for (let i = 0; i < verts2.length; i++) {
				const uv = uvAt(f, first + i, i);
				if (uv) {
					attrs.uv[i * 2] = uv[0];
					attrs.uv[i * 2 + 1] = uv[1];
				}
			}
		}
		refaceKeep(m, f, verts2.map((v) => dup.get(v) ?? v), attrs);
	}
	return dup;
}

/**
 * The soup's pushQuad as a kernel face: corners a, b, c, d wound so the first triangle faces
 * `wantDir`, triangulated a-b-c / a-c-d (or a-c-b / a-d-c flipped), uvs following the corners.
 * @param {OpMesh} om @param {number[]} q [a, b, c, d] vertex IDs @param {number[]} wantDir
 * @param {number} material @param {number[][] | null} uvs
 */
function pushQuad(om, q, wantDir, material, uvs) {
	const m = om.mesh;
	const [a, b, c, d] = q;
	const flip = dot(triNormal(pos(om, a), pos(om, b), pos(om, c)), wantDir) < 0;
	// flipped: the soup's triangles [a,c,b] [a,d,c] are the quad a-d-c-b's [0,2,3] [0,1,2]
	const verts = flip ? [a, d, c, b] : [a, b, c, d];
	const triangles = flip ? [0, 2, 3, 0, 1, 2] : [0, 1, 2, 0, 2, 3];
	const order = flip ? [0, 3, 2, 1] : [0, 1, 2, 3];
	/** @type {Record<string, number[]>} */
	const attrs = {};
	if (m.attrs.uv) attrs.uv = order.flatMap((i) => (uvs ? uvs[i] : [0, 0]));
	const f = m.addFace(verts, { material, attrs, triangles });
	newGroup(om, f);
	return f;
}

/**
 * EXTRUDE the region by `offset`, stitching a wall quad on every border side.
 * The wall's uv runs ALONG the extrusion at the base edge's texel density (the soup's M1 rule).
 * @param {OpMesh} om @param {number[]} tris @param {number[]} normal unit direction @param {number} dist
 */
export function extrudeRegion(om, tris, normal, dist) {
	const m = om.mesh;
	const faces = isolateTriangles(om, tris);
	const border = borderOf(om, tris, faces);
	const offset = [normal[0] * dist, normal[1] * dist, normal[2] * dist];
	// everything the walls need, read before the region moves
	const walls = border.map((b) => {
		const p0 = pos(om, b.va);
		const p1 = pos(om, b.vb);
		const tn = triangleNormal(om, b.t);
		let out = cross(sub(p1, p0), tn);
		const want = dot(out, out) < 1e-12 ? tn : normalize(out);
		const uvA = uvOf(om, b.ca);
		const uvB = uvOf(om, b.cb);
		const along = [uvB[0] - uvA[0], uvB[1] - uvA[1]];
		const uvLen = Math.hypot(along[0], along[1]);
		const worldLen = Math.hypot(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]);
		const step = uvLen > 1e-9 && worldLen > 1e-9 ? (uvLen / worldLen) * dist : dist;
		const perp = uvLen > 1e-9 ? [(-along[1] / uvLen) * step, (along[0] / uvLen) * step] : [0, step];
		const uvA2 = [uvA[0] + perp[0], uvA[1] + perp[1]];
		const uvB2 = [uvB[0] + perp[0], uvB[1] + perp[1]];
		return { b, want, uvs: [uvA, uvB, uvB2, uvA2], material: m.fMat[b.f] };
	});
	const borderVerts = new Set(border.flatMap((b) => [b.va, b.vb]));
	const dup = detachRegion(om, faces, borderVerts, (v) => {
		const p = pos(om, v);
		return [p[0] + offset[0], p[1] + offset[1], p[2] + offset[2]];
	});
	const added = walls.map((w) =>
		pushQuad(om, [w.b.va, w.b.vb, /** @type {number} */ (dup.get(w.b.vb)), /** @type {number} */ (dup.get(w.b.va))], w.want, w.material, m.attrs.uv ? w.uvs : null)
	);
	appendToView(om, added);
	return { walls: added.length };
}

/**
 * INSET: each connected piece shrinks toward its own centre by fraction `amount` (clamped 0..0.95)
 * in space and in uv, and a ring quad joins every border side to its inset copy.
 * @param {OpMesh} om @param {number[]} tris @param {number} amount
 */
export function insetRegion(om, tris, amount) {
	const t = Math.min(Math.max(amount, 0), 0.95);
	let rings = 0;
	for (const piece of triangleComponents(om, tris)) rings += insetPiece(om, piece, t);
	return { rings };
}

/** @param {OpMesh} om @param {number[]} piece @param {number} t */
function insetPiece(om, piece, t) {
	const m = om.mesh;
	const faces = isolateTriangles(om, piece);
	// the soup's centroids: every triangle corner counts (a shared vertex counts once per triangle)
	const c = [0, 0, 0];
	let n = 0;
	let u = 0;
	let w = 0;
	let nu = 0;
	const hasUv = !!m.attrs.uv;
	for (const tri of piece)
		for (let k = 0; k < 3; k++) {
			const corner = cornerOf(om, tri, k);
			const p = pos(om, m.cVert[corner]);
			c[0] += p[0];
			c[1] += p[1];
			c[2] += p[2];
			n++;
			if (hasUv) {
				const uv = uvOf(om, corner);
				u += uv[0];
				w += uv[1];
				nu++;
			}
		}
	const centroid = [c[0] / (n || 1), c[1] / (n || 1), c[2] / (n || 1)];
	const uvc = nu ? [u / nu, w / nu] : [0, 0];
	/** @param {number[]} q @returns {[number, number]} */
	const lerpUv = (q) => [q[0] + (uvc[0] - q[0]) * t, q[1] + (uvc[1] - q[1]) * t];
	const border = borderOf(om, piece, faces);
	const rings = border.map((b) => {
		const uvA = uvOf(om, b.ca);
		const uvB = uvOf(om, b.cb);
		return { b, want: triangleNormal(om, b.t), uvs: [uvA, uvB, lerpUv(uvB), lerpUv(uvA)], material: m.fMat[b.f] };
	});
	const borderVerts = new Set(border.flatMap((b) => [b.va, b.vb]));
	const dup = detachRegion(
		om,
		faces,
		borderVerts,
		(v) => {
			const p = pos(om, v);
			return [p[0] + (centroid[0] - p[0]) * t, p[1] + (centroid[1] - p[1]) * t, p[2] + (centroid[2] - p[2]) * t];
		},
		hasUv ? (_f, corner) => lerpUv(uvOf(om, corner)) : undefined
	);
	const added = rings.map((r) =>
		pushQuad(om, [r.b.va, r.b.vb, /** @type {number} */ (dup.get(r.b.vb)), /** @type {number} */ (dup.get(r.b.va))], r.want, r.material, hasUv ? r.uvs : null)
	);
	appendToView(om, added);
	return added.length;
}

/**
 * MOVE (push / pull) the region by `normal * dist`, WELDED the soup's way: every vertex whose
 * position key equals a region vertex's moves too, so the faces around it stretch (nothing
 * detaches, no face is added). Matching by KEY rather than by connectivity is the soup's rule and
 * it matters after an op that created coincident points (an inset ring meeting an unconnected
 * vertex of the same key): those move as well, as they did. @param {OpMesh} om @param {number[]} tris
 * @param {number[]} normal @param {number} dist
 */
export function moveRegion(om, tris, normal, dist) {
	const m = om.mesh;
	/** @type {Set<string>} */
	const keys = new Set();
	// the region's key box: a vertex outside it cannot share a key, so only the few inside build a string
	let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
	for (const t of tris)
		for (let k = 0; k < 3; k++) {
			const p = pos(om, m.cVert[cornerOf(om, t, k)]);
			const kx = Math.round(p[0] * 1e4), ky = Math.round(p[1] * 1e4), kz = Math.round(p[2] * 1e4);
			keys.add(`${kx},${ky},${kz}`);
			if (kx < x0) x0 = kx;
			if (kx > x1) x1 = kx;
			if (ky < y0) y0 = ky;
			if (ky > y1) y1 = ky;
			if (kz < z0) z0 = kz;
			if (kz > z1) z1 = kz;
		}
	const ox = normal[0] * dist;
	const oy = normal[1] * dist;
	const oz = normal[2] * dist;
	/** @type {number[]} */
	const moved = [];
	const vp = m.vPos;
	for (let v = 0; v < m.vTop; v++) {
		if (!m.hasVertex(v)) continue;
		const kx = Math.round(vp[v * 3] * 1e4), ky = Math.round(vp[v * 3 + 1] * 1e4), kz = Math.round(vp[v * 3 + 2] * 1e4);
		if (kx < x0 || kx > x1 || ky < y0 || ky > y1 || kz < z0 || kz > z1) continue;
		if (keys.has(`${kx},${ky},${kz}`)) moved.push(v);
	}
	for (const v of moved) m.setPosition(v, vp[v * 3] + ox, vp[v * 3 + 1] + oy, vp[v * 3 + 2] + oz);
	return { moved: moved.length };
}

/**
 * EXTRUDE INDIVIDUAL: each connected piece along its own averaged normal (read before any piece
 * moves; pieces share no vertex, so no earlier piece touches a later one).
 * @param {OpMesh} om @param {number[]} tris @param {number} dist
 */
export function extrudeIndividual(om, tris, dist) {
	const pieces = triangleComponents(om, tris).map((piece) => ({ piece, normal: averagedNormal(om, piece) }));
	let walls = 0;
	for (const { piece, normal } of pieces) walls += extrudeRegion(om, piece, normal, dist).walls;
	return { walls };
}

/**
 * INSET, extended (the adjust engine's): `individual` insets each unit on its own (the granularity
 * units the selection was built from, else connected pieces), then `depth` pushes each piece of the
 * cap along its own averaged normal, welded so the ring stretches with it.
 * @param {OpMesh} om @param {number[]} tris @param {{ amount?: number, depth?: number, individual?: boolean, units?: number[][] | null }} [options]
 */
export function insetExtended(om, tris, options = {}) {
	const amount = options.amount ?? 0.2;
	const depth = options.depth ?? 0;
	if (options.individual) {
		const units = options.units?.length ? options.units : triangleComponents(om, tris);
		for (const unit of units) insetRegion(om, unit, amount);
	} else insetRegion(om, tris, amount);
	if (depth)
		for (const piece of triangleComponents(om, tris)) moveRegion(om, piece, averagedNormal(om, piece), depth);
}

/** does the region have a border (an open region; a closed one cannot be extruded)
 * @param {OpMesh} om @param {number[]} tris */
export function regionHasBorder(om, tris) {
	const m = om.mesh;
	const faces = new Set(tris.map((t) => om.view.tFace[t]));
	// a partly covered face has a border inside it (the triangle edge the soup counted once)
	/** @type {Map<number, number>} */
	const picked = new Map();
	for (const t of tris) picked.set(om.view.tFace[t], (picked.get(om.view.tFace[t]) ?? 0) + 1);
	for (const [f, n] of picked) if (n < m.fTriLen[f]) return true;
	return borderOf(om, tris, faces).length > 0;
}
