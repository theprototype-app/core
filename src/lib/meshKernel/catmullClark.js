// @ts-check
// Roadmap 99 K8 (lane 99-newops): Catmull-Clark subdivision ON THE KERNEL — the one implementation behind the
// editor's Subdivide (smooth) and the agent's create_shape / edit_mesh `subdivide` (worldToolsCore.catmullClark
// is an adapter over this file).
//
// One level on a face set S (default: every live face), in place:
// - a FACE POINT per face of S: the corner average (position and every corner attribute);
// - an EDGE POINT per edge of S: the average of its ends and its two face points when both faces are in S and
//   the edge is manifold, else its midpoint (an open border, the border of the picked region, a non-manifold
//   edge). Attributes are the midpoint of the face's two corners (splitEdge's per-face lerp): a texture does
//   not slide, and a UV seam stays a seam (each face keeps its own corner values);
// - a VERTEX POINT per vertex of S: (F + 2R + (n - 3) v) / n (F = the mean of its face points, R = the mean of
//   its edge midpoints, n = its face count); on an open border the crease rule (6 v + its two border
//   neighbours) / 8, so a border keeps its shape ("sharp where a boundary is"); a vertex that touches a face
//   OUTSIDE S stays where it is, so the unpicked neighbours do not move. Corner attributes stay.
// - every face of S becomes one quad per corner, wound like it: (corner, edge point to next, face point,
//   edge point from previous). The first quad keeps the face's ID and every quad its material slot. An
//   unpicked neighbour on a split edge gains the edge point as a corner (no T-junction: it becomes an n-gon).
//
// IDs: every vertex keeps its ID (moved to its vertex point); an edge keeps its ID for the half at its first
// vertex (splitEdge); edge and face points are new vertices. Pure: no three.js, no stores.

import { NONE } from './kernel.js';

/** @typedef {import('./kernel.js').MeshKernel} MeshKernel */

/**
 * @typedef {{
 *   faces: number[],
 *   children: number[][],
 *   facePoint: number[],
 *   edgePoint: Map<number, number>,
 *   sourceEdges: number[]
 * }} CatmullClarkStep
 * `faces` = every new quad in parent order then corner order; `children[i]` = the quads of the i-th source face
 * (corner order, the first one keeps its ID); `facePoint[i]` = its face point vertex; `edgePoint` = source edge
 * -> edge point vertex; `sourceEdges` = the split edges in first-seen order (face order, corner order).
 */

/**
 * One Catmull-Clark level on `faces` (default every live face) of `mesh`, in place.
 * @param {MeshKernel} mesh @param {Iterable<number> | null} [faces]
 * @returns {CatmullClarkStep}
 */
export function catmullClarkStep(mesh, faces = null) {
	/** @type {number[]} */
	const S = [];
	const inS = new Uint8Array(mesh.fTop);
	for (const f of faces ?? mesh.faceIds()) {
		if (!mesh.hasFace(f) || mesh.isDegenerate(f) || inS[f]) continue;
		inS[f] = 1;
		S.push(f);
	}
	const empty = { faces: [], children: [], facePoint: [], edgePoint: new Map(), sourceEdges: [] };
	if (!S.length) return empty;
	const P = mesh.vPos;

	// face points (positions); attributes are read per face when it is rebuilt
	const fpx = new Float64Array(S.length * 3);
	/** @type {Map<number, number>} face -> index in S */
	const slot = new Map();
	S.forEach((f, i) => {
		slot.set(f, i);
		const first = mesh.fFirst[f];
		const n = mesh.fLen[f];
		let x = 0;
		let y = 0;
		let z = 0;
		for (let k = 0; k < n; k++) {
			const v = mesh.cVert[first + k] * 3;
			x += P[v];
			y += P[v + 1];
			z += P[v + 2];
		}
		fpx[i * 3] = x / n;
		fpx[i * 3 + 1] = y / n;
		fpx[i * 3 + 2] = z / n;
	});

	// the edges and vertices of S, in first-seen order
	/** @type {number[]} */
	const E = [];
	const eSeen = new Uint8Array(mesh.eTop);
	/** @type {number[]} */
	const V = [];
	const vSeen = new Uint8Array(mesh.vTop);
	for (const f of S) {
		const first = mesh.fFirst[f];
		for (let k = 0; k < mesh.fLen[f]; k++) {
			const c = first + k;
			const e = mesh.cEdge[c];
			if (e !== NONE && !eSeen[e]) {
				eSeen[e] = 1;
				E.push(e);
			}
			const v = mesh.cVert[c];
			if (!vSeen[v]) {
				vSeen[v] = 1;
				V.push(v);
			}
		}
	}

	// edge points
	const epx = new Float64Array(E.length * 3);
	E.forEach((e, i) => {
		const a = mesh.eVert[e * 2] * 3;
		const b = mesh.eVert[e * 2 + 1] * 3;
		const fs = mesh.edgeFaces(e);
		if (fs.length === 2 && inS[fs[0]] && inS[fs[1]] && fs[0] !== fs[1]) {
			const p = /** @type {number} */ (slot.get(fs[0])) * 3;
			const q = /** @type {number} */ (slot.get(fs[1])) * 3;
			for (let k = 0; k < 3; k++) epx[i * 3 + k] = (P[a + k] + P[b + k] + fpx[p + k] + fpx[q + k]) / 4;
		} else for (let k = 0; k < 3; k++) epx[i * 3 + k] = (P[a + k] + P[b + k]) / 2;
	});

	// vertex points (from the ORIGINAL positions: applied after the rebuild)
	const vpx = new Float64Array(V.length * 3);
	V.forEach((v, i) => {
		const o = v * 3;
		const vf = mesh.vertexFaces(v);
		let pinned = false;
		for (const f of vf) if (!inS[f]) pinned = true;
		if (!pinned) {
			const edges = mesh.vertexEdges(v).filter((e) => mesh.eCorner[e] !== NONE);
			const border = edges.filter((e) => mesh.edgeValence(e) === 1);
			if (border.length >= 2) {
				const n0 = mesh.otherVertex(border[0], v) * 3;
				const n1 = mesh.otherVertex(border[1], v) * 3;
				for (let k = 0; k < 3; k++) vpx[i * 3 + k] = (6 * P[o + k] + P[n0 + k] + P[n1 + k]) / 8;
				return;
			}
			const n = vf.length;
			if (n && edges.length) {
				for (let k = 0; k < 3; k++) {
					let F = 0;
					for (const f of vf) F += fpx[/** @type {number} */ (slot.get(f)) * 3 + k];
					F /= n;
					let R = 0;
					for (const e of edges) R += (P[mesh.eVert[e * 2] * 3 + k] + P[mesh.eVert[e * 2 + 1] * 3 + k]) / 2;
					R /= edges.length;
					vpx[i * 3 + k] = (F + 2 * R + (n - 3) * P[o + k]) / n;
				}
				return;
			}
		}
		vpx[i * 3] = P[o];
		vpx[i * 3 + 1] = P[o + 1];
		vpx[i * 3 + 2] = P[o + 2];
	});

	// split every edge of S at its middle (every face on it gains the corner, attributes lerped per face)
	/** @type {Map<number, number>} */
	const edgePoint = new Map();
	const isEdgePoint = new Set();
	E.forEach((e, i) => {
		const { vertex } = mesh.splitEdge(e, 0.5);
		mesh.setPosition(vertex, epx[i * 3], epx[i * 3 + 1], epx[i * 3 + 2]);
		edgePoint.set(e, vertex);
		isEdgePoint.add(vertex);
	});

	// each face of S (now 2n corners, original and edge points alternating) -> n quads round its face point
	const names = Object.keys(mesh.attrs);
	/** @type {number[]} */
	const out = [];
	/** @type {number[][]} */
	const children = [];
	/** @type {number[]} */
	const facePoint = [];
	S.forEach((f, i) => {
		const verts = mesh.faceVertices(f);
		const old = mesh._faceAttrs(f);
		const material = mesh.fMat[f];
		const m = verts.length;
		// start at an original corner
		let s = 0;
		while (s < m && isEdgePoint.has(verts[s])) s++;
		const at = (/** @type {number} */ j) => (s + j + m) % m;
		const n = m / 2;
		const fv = mesh.addVertex(fpx[i * 3], fpx[i * 3 + 1], fpx[i * 3 + 2]);
		facePoint.push(fv);
		/** @type {Record<string, number[]>} the face point's attribute: the mean of the ORIGINAL corners */
		const centre = {};
		for (const name of names) {
			const size = mesh.attrs[name].size;
			const sum = new Array(size).fill(0);
			for (let j = 0; j < n; j++) for (let k = 0; k < size; k++) sum[k] += old[name][at(2 * j) * size + k];
			centre[name] = sum.map((x) => x / n);
		}
		mesh.removeFace(f, { keepEdges: true });
		/** @type {number[]} */
		const kids = [];
		for (let j = 0; j < n; j++) {
			const corners = [at(2 * j), at(2 * j + 1), -1, at(2 * j - 1)];
			/** @type {Record<string, number[]>} */
			const attrs = {};
			for (const name of names) {
				const size = mesh.attrs[name].size;
				const list = [];
				for (const c of corners)
					for (let k = 0; k < size; k++) list.push(c < 0 ? centre[name][k] : old[name][c * size + k]);
				attrs[name] = list;
			}
			const g = mesh.addFace(
				corners.map((c) => (c < 0 ? fv : verts[c])),
				{ id: j === 0 ? f : undefined, material, attrs }
			);
			kids.push(g);
			out.push(g);
		}
		children.push(kids);
	});

	V.forEach((v, i) => mesh.setPosition(v, vpx[i * 3], vpx[i * 3 + 1], vpx[i * 3 + 2]));
	return { faces: out, children, facePoint, edgePoint, sourceEdges: E };
}

/**
 * `levels` Catmull-Clark levels on `faces` (default every face): each level runs on the quads the previous one
 * made. @param {MeshKernel} mesh @param {number} levels @param {Iterable<number> | null} [faces]
 * @returns {{ faces: number[] }} the quads of the last level
 */
export function catmullClark(mesh, levels, faces = null) {
	let cur = faces ? [...faces] : null;
	for (let l = 0; l < levels; l++) cur = catmullClarkStep(mesh, cur).faces;
	return { faces: cur ?? [] };
}

/** vertices / faces after `levels` levels on a mesh of v vertices, c corners and f faces (closed: an upper bound
 * for an open one is close) @param {number} v @param {number} c @param {number} f @param {number} levels */
export function catmullClarkSize(v, c, f, levels) {
	for (let l = 0; l < levels; l++) {
		const e = Math.ceil(c / 2);
		v = v + e + f;
		f = c;
		c = f * 4;
	}
	return { vertices: v, faces: f };
}

/**
 * @typedef {{ vertices: number[][], faces: number[][], uvs?: number[][], colors?: number[][], faceMaterials?: number[] }} PolyArrays
 * the agent's polygon mesh: per-vertex positions (and uvs / colours), faces as vertex index lists
 */

/**
 * Catmull-Clark on the agent's polygon arrays, through the kernel (85b G9's create_shape / edit_mesh `subdivide`).
 * The output keeps G9's order: face points (face order), edge points (first seen walking the faces), then the
 * vertex points of every vertex a face uses (index order; an unused vertex is dropped); each face gives one quad
 * per corner (corner, edge point to next, face point, edge point from previous). Per-vertex uvs / colours ride
 * as corner attributes, so they come out the SAME averages the positions use for face and edge points and stay
 * at the old vertices. @param {PolyArrays} poly @param {number} levels @param {typeof import('./kernel.js').MeshKernel} Kernel
 * @returns {PolyArrays}
 */
export function catmullClarkArrays(poly, levels, Kernel) {
	let cur = poly;
	for (let l = 0; l < levels; l++) cur = ccArraysOnce(cur, Kernel);
	return cur;
}

/** @param {PolyArrays} m @param {typeof import('./kernel.js').MeshKernel} Kernel @returns {PolyArrays} */
function ccArraysOnce(m, Kernel) {
	/** @type {('uvs' | 'colors')[]} */
	const carried = /** @type {('uvs' | 'colors')[]} */ (['uvs', 'colors']).filter((k) => Array.isArray(m[k]));
	/** @type {Record<string, number>} */
	const sizes = {};
	for (const k of carried) sizes[k] = /** @type {number[][]} */ (m[k])[0]?.length ?? (k === 'uvs' ? 2 : 3);
	const mesh = new Kernel({ attributes: sizes });
	for (const p of m.vertices) mesh.addVertex(p[0], p[1], p[2]);
	m.faces.forEach((f, fi) => {
		/** @type {Record<string, number[]>} */
		const attrs = {};
		for (const k of carried) attrs[k] = f.flatMap((v) => /** @type {number[][]} */ (m[k])[v]);
		mesh.addFace(f, { material: m.faceMaterials?.[fi] ?? 0, attrs });
	});
	const step = catmullClarkStep(mesh, m.faces.map((_, i) => i));
	/** kernel vertex -> output index */
	const outIndex = new Map();
	let next = 0;
	for (const v of step.facePoint) outIndex.set(v, next++);
	for (const e of step.sourceEdges) outIndex.set(/** @type {number} */ (step.edgePoint.get(e)), next++);
	const used = new Uint8Array(m.vertices.length);
	for (const f of m.faces) for (const v of f) used[v] = 1;
	for (let v = 0; v < m.vertices.length; v++) if (used[v]) outIndex.set(v, next++);
	/** @type {number[][]} */
	const vertices = new Array(next);
	for (const [v, i] of outIndex) {
		const p = mesh.position(v);
		vertices[i] = [p[0], p[1], p[2]];
	}
	/** @type {Record<string, number[][]>} */
	const rows = {};
	for (const k of carried) rows[k] = new Array(next);
	/** @type {number[][]} */
	const faces = [];
	for (const f of step.faces) {
		const first = mesh.fFirst[f];
		/** @type {number[]} */
		const quad = [];
		for (let k = 0; k < mesh.fLen[f]; k++) {
			const c = first + k;
			const i = outIndex.get(mesh.cVert[c]);
			quad.push(i);
			for (const name of carried) rows[name][i] = mesh.cornerAttribute(c, name);
		}
		faces.push(quad);
	}
	/** @type {PolyArrays} */
	const res = { vertices, faces };
	for (const k of carried) res[k] = rows[k];
	if (m.faceMaterials) res.faceMaterials = step.faces.map((f) => mesh.fMat[f]);
	return res;
}
