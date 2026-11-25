// @ts-check
// Roadmap 99 K8 (lane 99-newops): BISECT on the kernel — cut a face set (default: every face) with a plane.
// 1. each vertex gets its signed distance to the plane; within `eps` it counts as ON the plane (no sliver);
// 2. every edge of the set whose ends lie strictly on opposite sides is split where it crosses (splitEdge: each
//    face on the edge gains the corner, attributes lerped per face — the knife's rule; an unpicked neighbour on a
//    split edge gains it too, so no T-junction);
// 3. every face of the set with corners strictly on both sides is split between its on-plane corners (a concave
//    n-gon that crosses the plane more than twice is split pair by pair along the cut line);
// 4. options: `clear: 'inner' | 'outer'` removes the faces of the set on the negative (inner) / positive (outer)
//    side; `fill` closes each open loop of the cut with one n-gon facing away from the kept side (uv: the plane's
//    own projection, in the loop's bounding square; material: the first neighbour's).
// IDs: every vertex and face keeps its ID unless cleared; a crossing is a new vertex, a split-off half a new face.
// Pure: no three.js, no stores.

import { NONE } from './kernel.js';

/** @typedef {import('./kernel.js').MeshKernel} MeshKernel */
/**
 * @typedef {{ point: ArrayLike<number>, normal: ArrayLike<number> }} Plane
 * @typedef {{ faces?: Iterable<number> | null, clear?: 'inner' | 'outer' | null, fill?: boolean, eps?: number }} BisectOptions
 * @typedef {{ cutVertices: number[], cutEdges: number[], newFaces: number[], removed: number[], filled: number[],
 *   inner: number[], outer: number[] }} BisectResult
 * `inner` / `outer` = the surviving faces of the set on each side after the cut (the new pieces included).
 */

/**
 * @param {MeshKernel} mesh @param {Plane} plane @param {BisectOptions} [options]
 * @returns {BisectResult}
 */
export function bisect(mesh, plane, options = {}) {
	const nl = Math.hypot(plane.normal[0], plane.normal[1], plane.normal[2]) || 1;
	const N = [plane.normal[0] / nl, plane.normal[1] / nl, plane.normal[2] / nl];
	const off = N[0] * plane.point[0] + N[1] * plane.point[1] + N[2] * plane.point[2];
	const eps = options.eps ?? 1e-6;
	const P = () => mesh.vPos;
	/** @param {number} v */
	const sd = (v) => {
		const p = P();
		return N[0] * p[v * 3] + N[1] * p[v * 3 + 1] + N[2] * p[v * 3 + 2] - off;
	};
	/** side per vertex: -1, 0 (on the plane), 1 — grown as crossings are added */
	let side = new Int8Array(mesh.vTop + 16);
	const sideOf = (/** @type {number} */ v) => {
		if (v >= side.length) {
			const s = new Int8Array(Math.max(v + 1, side.length * 2));
			s.set(side);
			side = s;
		}
		return side[v];
	};
	const setSide = (/** @type {number} */ v, /** @type {number} */ s) => {
		sideOf(v);
		side[v] = s;
	};

	/** @type {number[]} */
	let S = [];
	const inS = new Set();
	for (const f of options.faces ?? mesh.faceIds()) {
		if (!mesh.hasFace(f) || mesh.isDegenerate(f) || inS.has(f)) continue;
		inS.add(f);
		S.push(f);
	}
	/** @type {BisectResult} */
	const res = { cutVertices: [], cutEdges: [], newFaces: [], removed: [], filled: [], inner: [], outer: [] };
	if (!S.length) return res;

	// 1. sides
	const E = [];
	const eSeen = new Set();
	for (const f of S)
		for (const c of mesh.faceCorners(f)) {
			const v = mesh.cVert[c];
			const d = sd(v);
			setSide(v, d > eps ? 1 : d < -eps ? -1 : 0);
			const e = mesh.cEdge[c];
			if (e !== NONE && !eSeen.has(e)) {
				eSeen.add(e);
				E.push(e);
			}
		}

	// 2. split the crossing edges
	const onPlane = new Set();
	for (const f of S) for (const v of mesh.faceVertices(f)) if (side[v] === 0) onPlane.add(v);
	for (const e of E) {
		const a = mesh.eVert[e * 2];
		const b = mesh.eVert[e * 2 + 1];
		if (side[a] * side[b] >= 0) continue;
		const da = sd(a);
		const db = sd(b);
		const { vertex } = mesh.splitEdge(e, da / (da - db));
		setSide(vertex, 0);
		onPlane.add(vertex);
		res.cutVertices.push(vertex);
	}

	// 3. split the faces that now hold corners on both sides: the corners where the boundary CROSSES the plane
	//    (its sides before and after differ), sorted along the cut line, pair up even-odd (a simple polygon's
	//    inside is between the 1st and 2nd crossing, the 3rd and 4th ...)
	const dir = [0, 0, 0];
	/** @type {number[]} */
	const pieces = [];
	for (const f of S) {
		const verts = mesh.faceVertices(f);
		const n = verts.length;
		let neg = false;
		let pos = false;
		for (const v of verts) {
			if (side[v] < 0) neg = true;
			else if (side[v] > 0) pos = true;
		}
		if (!(neg && pos)) continue;
		/** @type {number[]} */
		const cross = [];
		for (let i = 0; i < n; i++) {
			if (side[verts[i]] !== 0) continue;
			let before = 0;
			for (let k = 1; k < n && !before; k++) before = side[verts[(i - k + n) % n]];
			let after = 0;
			for (let k = 1; k < n && !after; k++) after = side[verts[(i + k) % n]];
			if (before * after < 0) cross.push(verts[i]);
		}
		if (cross.length < 2) continue;
		const fn = mesh.faceNormal(f);
		dir[0] = N[1] * fn[2] - N[2] * fn[1];
		dir[1] = N[2] * fn[0] - N[0] * fn[2];
		dir[2] = N[0] * fn[1] - N[1] * fn[0];
		const p = P();
		const t = (/** @type {number} */ v) => dir[0] * p[v * 3] + dir[1] * p[v * 3 + 1] + dir[2] * p[v * 3 + 2];
		cross.sort((x, y) => t(x) - t(y) || x - y);
		/** the faces this face has become so far */
		const parts = [f];
		for (let i = 0; i + 1 < cross.length; i += 2) {
			const va = cross[i];
			const vb = cross[i + 1];
			if (mesh.findEdge(va, vb) !== NONE) continue;
			for (const g of parts) {
				const gv = mesh.faceVertices(g);
				const ia = gv.indexOf(va);
				const ib = gv.indexOf(vb);
				if (ia < 0 || ib < 0) continue;
				const m = gv.length;
				if ((ia + 1) % m === ib || (ib + 1) % m === ia) break;
				const { face, edge } = mesh.splitFace(g, va, vb);
				parts.push(face);
				pieces.push(face);
				res.newFaces.push(face);
				res.cutEdges.push(edge);
				break;
			}
		}
	}
	S = S.concat(pieces);
	for (const g of pieces) inS.add(g);
	// existing edges lying in the plane between two cut sides count as cut edges too
	for (const f of S)
		for (const e of mesh.faceEdges(f)) {
			const a = mesh.eVert[e * 2];
			const b = mesh.eVert[e * 2 + 1];
			if (side[a] === 0 && side[b] === 0 && !res.cutEdges.includes(e)) {
				const fs = mesh.edgeFaces(e);
				const sides = new Set(fs.map((g) => faceSide(mesh, g, side)));
				if (sides.has(1) && sides.has(-1)) res.cutEdges.push(e);
			}
		}

	// 4. classify, clear, fill
	for (const f of S) {
		const s = faceSide(mesh, f, side);
		if (s < 0) res.inner.push(f);
		else if (s > 0) res.outer.push(f);
	}
	if (options.clear === 'inner' || options.clear === 'outer') {
		const gone = options.clear === 'inner' ? res.inner : res.outer;
		/** @type {Set<number>} */
		const corners = new Set();
		for (const f of gone) {
			for (const v of mesh.faceVertices(f)) corners.add(v);
			mesh.removeFace(f);
			res.removed.push(f);
		}
		// the cleared side's vertices that no edge holds any more go with it
		for (const v of corners) if (mesh.hasVertex(v) && mesh.vEdge[v] === NONE) mesh.removeVertex(v);
		if (options.clear === 'inner') res.inner = [];
		else res.outer = [];
		if (options.fill) res.filled = fillCut(mesh, side, onPlane, N, options.clear === 'inner' ? -1 : 1);
	}
	res.cutEdges = res.cutEdges.filter((e) => mesh.hasEdge(e));
	return res;
}

/** a face's side: +1 / -1 when its corners are on one side (on-plane corners do not count), 0 when flat on the plane
 * @param {MeshKernel} mesh @param {number} f @param {Int8Array} side */
function faceSide(mesh, f, side) {
	let s = 0;
	for (const v of mesh.faceVertices(f)) if (side[v]) s = side[v];
	return s;
}

/**
 * Close each loop of open on-plane border edges with one n-gon. The fill faces AWAY from the kept side: toward
 * the cleared side `away` (-1 inner, 1 outer). @param {MeshKernel} mesh @param {Int8Array} side
 * @param {Set<number>} onPlane @param {number[]} N @param {number} away @returns {number[]} the new faces
 */
function fillCut(mesh, side, onPlane, N, away) {
	/** fill winding: next[b] = a for each border corner a -> b of a remaining face */
	const next = new Map();
	/** @type {Map<number, number>} vertex -> a neighbour face's material */
	const mat = new Map();
	for (const v of onPlane) {
		if (!mesh.hasVertex(v)) continue;
		for (const e of mesh.vertexEdges(v)) {
			const a = mesh.eVert[e * 2];
			const b = mesh.eVert[e * 2 + 1];
			if (side[a] !== 0 || side[b] !== 0 || mesh.edgeValence(e) !== 1) continue;
			const c = mesh.edgeCorners(e)[0];
			const from = mesh.cVert[c];
			const to = from === a ? b : a;
			if (next.has(to) && next.get(to) !== from) next.set(to, NONE); // ambiguous (non-manifold): skip
			else next.set(to, from);
			mat.set(to, mesh.fMat[mesh.cFace[c]]);
		}
	}
	/** @type {number[]} */
	const faces = [];
	const used = new Set();
	const uvName = mesh.attrs.uv ? 'uv' : null;
	// a basis on the plane for the fill's uvs
	const ax = Math.abs(N[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
	const U = [N[1] * ax[2] - N[2] * ax[1], N[2] * ax[0] - N[0] * ax[2], N[0] * ax[1] - N[1] * ax[0]];
	const ul = Math.hypot(U[0], U[1], U[2]);
	for (let k = 0; k < 3; k++) U[k] /= ul;
	const V = [N[1] * U[2] - N[2] * U[1], N[2] * U[0] - N[0] * U[2], N[0] * U[1] - N[1] * U[0]];
	const keys = [...next.keys()].sort((x, y) => x - y);
	for (const start of keys) {
		if (used.has(start) || next.get(start) === NONE) continue;
		/** @type {number[]} */
		const loop = [];
		let v = start;
		let ok = false;
		while (!used.has(v)) {
			used.add(v);
			loop.push(v);
			const w = next.get(v);
			if (w === undefined || w === NONE) break;
			if (w === start) {
				ok = true;
				break;
			}
			v = w;
		}
		if (!ok || loop.length < 3) continue;
		/** @type {Record<string, number[]>} */
		const attrs = {};
		if (uvName) {
			const uv = loop.map((x) => {
				const p = mesh.position(x);
				return [p[0] * U[0] + p[1] * U[1] + p[2] * U[2], p[0] * V[0] + p[1] * V[1] + p[2] * V[2]];
			});
			let u0 = Infinity;
			let v0 = Infinity;
			let span = 0;
			for (const [a, b] of uv) {
				u0 = Math.min(u0, a);
				v0 = Math.min(v0, b);
			}
			for (const [a, b] of uv) span = Math.max(span, a - u0, b - v0);
			attrs.uv = uv.flatMap(([a, b]) => [(a - u0) / (span || 1), (b - v0) / (span || 1)]);
		}
		for (const name of Object.keys(mesh.attrs)) if (!attrs[name]) attrs[name] = new Array(loop.length * mesh.attrs[name].size).fill(0);
		const f = mesh.addFace(loop, { material: mat.get(loop[0]) ?? 0, attrs });
		// the loop winds against its neighbours, so it faces the cleared side; an open rim may not: flip it then
		const fn = mesh.faceNormal(f);
		if ((fn[0] * N[0] + fn[1] * N[1] + fn[2] * N[2]) * away < 0) mesh.flipFace(f);
		faces.push(f);
	}
	return faces;
}
