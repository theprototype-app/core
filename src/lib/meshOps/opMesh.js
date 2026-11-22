// Roadmap 99 K4: the operator seam. An operator runs on an OP MESH — the session's kernel plus the
// two facts the editor needs from it that the kernel alone does not keep:
//
// - `view`: the OUTPUT TRIANGLE ORDER (what toArrays emits: source order, then new triangles by
//   order key). Output triangle t is the editor's triangle t (workingTris[t], the selection's
//   indices). Each entry names its face and the triangle's LOCAL corners, which survive a reface
//   (a face rebuilt with new vertices keeps its corner order and triangulation).
// - `logical`: face ID -> the editor's stored face (the `__topo` partition). The kernel turns each
//   stored face into one n-gon when it can; a face with a seam inside stays triangles, and an
//   operator may split a face it only partly covers (isolateTriangles). Both keep their stored
//   face through `logical`, so the committed partition is the one the soup operators composed.
//
// Pure (no three.js, no stores): node tests, a Worker and the page run the same code.

import { NONE } from '../meshKernel/kernel.js';
import { fromArrays, toArrays } from '../meshKernel/arrays.js';

/** the editor's weld: faceEdit's keyOf (Math.round(x * 1e4) per axis), so an operator sees exactly the
 * vertices the soup operators treated as one */
export const OP_WELD = { key: 1e4 };

/**
 * @typedef {import('../meshKernel/kernel.js').MeshKernel} MeshKernel
 * @typedef {{ tFace: Int32Array, tLoc: Int32Array, count: number }} TriView
 * @typedef {{ mesh: MeshKernel, logical: number[], baseGroup: number, nextGroup: number, view: TriView }} OpMesh
 * @typedef {{ cornerVertex: Int32Array, triFace: Int32Array }} IdChannels
 */

/**
 * The output triangle order (toArrays' rule, kept in step with it by a unit test).
 * @param {MeshKernel} mesh @returns {TriView}
 */
export function buildView(mesh) {
	const faceList = mesh.faceIds({ degenerate: true });
	let total = 0;
	for (const f of faceList) {
		mesh.ensureTriangulation(f);
		total += mesh.fTriLen[f];
	}
	const recF = new Int32Array(total);
	const recT = new Int32Array(total);
	let at = 0;
	let sorted = true;
	let last = -Infinity;
	for (const f of faceList) {
		const first = mesh.fTriFirst[f];
		for (let t = 0; t < mesh.fTriLen[f]; t++) {
			recF[at] = f;
			recT[at] = first + t;
			const o = mesh.tOrder[first + t];
			if (o < last) sorted = false;
			last = o;
			at++;
		}
	}
	let perm = null;
	if (!sorted) {
		const p = Array.from({ length: total }, (_, i) => i);
		p.sort((a, b) => mesh.tOrder[recT[a]] - mesh.tOrder[recT[b]] || a - b);
		perm = p;
	}
	const tFace = new Int32Array(total);
	const tLoc = new Int32Array(total * 3);
	for (let i = 0; i < total; i++) {
		const r = perm ? perm[i] : i;
		tFace[i] = recF[r];
		const rec = recT[r] * 3;
		tLoc[i * 3] = mesh.tLocal[rec];
		tLoc[i * 3 + 1] = mesh.tLocal[rec + 1];
		tLoc[i * 3 + 2] = mesh.tLocal[rec + 2];
	}
	return { tFace, tLoc, count: total };
}

/**
 * An op mesh from plain arrays (a geometry's, or a triangle soup's).
 * @param {{
 *   positions: ArrayLike<number>, index?: ArrayLike<number> | null, uv?: ArrayLike<number> | null,
 *   groups?: { start: number, count: number, materialIndex?: number }[] | null,
 *   partition?: number[][] | null, ids?: { cornerVertex?: ArrayLike<number> | null, triFace?: ArrayLike<number> | null } | null
 * }} src `partition` = the editor's faces over the source triangles; `ids` = the vertex (and face)
 *   IDs to keep — a history state's channels, or the session kernel's vertex map (skips the weld)
 * @returns {OpMesh}
 */
export function opMeshFromArrays(src) {
	/** @type {Record<string, { array: ArrayLike<number>, itemSize: number }>} */
	const attributes = {};
	if (src.uv) attributes.uv = { array: src.uv, itemSize: 2 };
	const arrays = {
		positions: src.positions,
		index: src.index ?? null,
		attributes,
		groups: src.groups?.length ? src.groups : null,
		faces: src.partition ?? null,
		cornerVertex: src.ids?.cornerVertex ?? null,
		triFace: src.ids?.triFace ?? null
	};
	let { mesh } = fromArrays(arrays, { weld: OP_WELD });
	let view = buildView(mesh);
	let logical = logicalOf(mesh, view, src.partition ?? null);
	if (!logical && arrays.triFace) {
		// the supplied face IDs disagree with the partition (a stale channel): keep the vertex IDs only
		({ mesh } = fromArrays({ ...arrays, triFace: null }, { weld: OP_WELD }));
		view = buildView(mesh);
		logical = logicalOf(mesh, view, src.partition ?? null);
	}
	const groups = /** @type {number[]} */ (logical);
	let top = 0;
	for (const g of groups) if (g !== undefined && g >= top) top = g + 1;
	return { mesh, logical: groups, baseGroup: top, nextGroup: top, view };
}

/**
 * face ID -> stored face index (or its own singleton group when there is no partition); null when a
 * kernel face spans two stored faces.
 * @param {MeshKernel} mesh @param {TriView} view @param {number[][] | null} partition
 * @returns {number[] | null}
 */
function logicalOf(mesh, view, partition) {
	/** @type {number[]} */
	const logical = new Array(mesh.fTop);
	if (!partition) {
		let next = 0;
		for (let t = 0; t < view.count; t++) {
			const f = view.tFace[t];
			if (logical[f] === undefined) logical[f] = next++;
		}
		return logical;
	}
	const faceOfTri = new Int32Array(view.count).fill(-1);
	partition.forEach((face, i) => {
		for (const t of face) if (t >= 0 && t < view.count) faceOfTri[t] = i;
	});
	for (let t = 0; t < view.count; t++) {
		const f = view.tFace[t];
		const g = faceOfTri[t];
		if (logical[f] === undefined) logical[f] = g;
		else if (logical[f] !== g) return null;
	}
	return logical;
}

/** a fresh logical group for a face an operator created @param {OpMesh} om @param {number} f */
export function newGroup(om, f) {
	om.logical[f] = om.nextGroup++;
}

/** the ID channels of the op mesh as it stands (the output order) @param {OpMesh} om @returns {IdChannels} */
export function idChannels(om) {
	const { mesh, view } = om;
	const cornerVertex = new Int32Array(view.count * 3);
	const triFace = new Int32Array(view.count);
	for (let t = 0; t < view.count; t++) {
		const f = view.tFace[t];
		triFace[t] = f;
		const first = mesh.fFirst[f];
		for (let k = 0; k < 3; k++) cornerVertex[t * 3 + k] = mesh.cVert[first + view.tLoc[t * 3 + k]];
	}
	return { cornerVertex, triFace };
}

/** absolute corner of output triangle t, local slot k @param {OpMesh} om @param {number} t @param {number} k */
export function cornerOf(om, t, k) {
	return om.mesh.fFirst[om.view.tFace[t]] + om.view.tLoc[t * 3 + k];
}

/**
 * Make every face the triangles `tris` touch FULLY covered by them: a face only partly covered is
 * split into its triangles (same corners, corner order, order keys; the first keeps the face ID)
 * and every piece keeps the face's logical group, so the stored partition is unchanged.
 * @param {OpMesh} om @param {number[]} tris output triangle indices
 * @returns {Set<number>} the faces of `tris` afterwards
 */
export function isolateTriangles(om, tris) {
	const { mesh, view } = om;
	/** @type {Map<number, number>} face -> picked triangles on it */
	const picked = new Map();
	for (const t of tris) picked.set(view.tFace[t], (picked.get(view.tFace[t]) ?? 0) + 1);
	/** @type {number[]} */
	const partial = [];
	for (const [f, n] of picked) if (n < mesh.fTriLen[f]) partial.push(f);
	if (partial.length) {
		const partialSet = new Set(partial);
		/** @type {Map<number, number[]>} face -> its output triangles */
		const trisOf = new Map();
		for (let t = 0; t < view.count; t++) {
			const f = view.tFace[t];
			if (!partialSet.has(f)) continue;
			let list = trisOf.get(f);
			if (!list) trisOf.set(f, (list = []));
			list.push(t);
		}
		for (const f of partial) explodeFace(om, f, trisOf.get(f) ?? []);
	}
	/** @type {Set<number>} */
	const faces = new Set();
	for (const t of tris) faces.add(view.tFace[t]);
	return faces;
}

/**
 * Split every face of several triangles that `tris` touch into one face per triangle (corners, corner
 * order, order keys and logical group kept; the first piece keeps the face ID), so a partition finer than
 * the faces can be stored. @param {OpMesh} om @param {number[]} tris output triangle indices
 */
export function explodeFaces(om, tris) {
	const { mesh, view } = om;
	/** @type {Set<number>} */
	const faces = new Set();
	for (const t of tris) if (mesh.fTriLen[view.tFace[t]] > 1) faces.add(view.tFace[t]);
	if (!faces.size) return;
	/** @type {Map<number, number[]>} */
	const trisOf = new Map();
	for (let t = 0; t < view.count; t++) {
		const f = view.tFace[t];
		if (!faces.has(f)) continue;
		let list = trisOf.get(f);
		if (!list) trisOf.set(f, (list = []));
		list.push(t);
	}
	for (const f of faces) explodeFace(om, f, trisOf.get(f) ?? []);
}

/** @param {OpMesh} om @param {number} f @param {number[]} outTris the face's output triangles */
function explodeFace(om, f, outTris) {
	const { mesh, view } = om;
	const verts = mesh.faceVertices(f);
	const first = mesh.fFirst[f];
	const material = mesh.fMat[f];
	const group = om.logical[f];
	/** @type {Record<string, { size: number, data: Float32Array }>} */
	const attrs = {};
	for (const [name, attr] of Object.entries(mesh.attrs))
		attrs[name] = { size: attr.size, data: attr.data.slice(first * attr.size, (first + verts.length) * attr.size) };
	/** @type {{ t: number, loc: number[], order: number }[]} */
	const pieces = [];
	for (const t of outTris) {
		const loc = [view.tLoc[t * 3], view.tLoc[t * 3 + 1], view.tLoc[t * 3 + 2]];
		pieces.push({ t, loc, order: triangleOrder(mesh, f, loc) });
	}
	mesh.removeFace(f, { keepEdges: true });
	pieces.forEach((piece, i) => {
		/** @type {Record<string, number[]>} */
		const pieceAttrs = {};
		for (const [name, { size, data }] of Object.entries(attrs)) {
			pieceAttrs[name] = [];
			for (const l of piece.loc) for (let k = 0; k < size; k++) pieceAttrs[name].push(data[l * size + k]);
		}
		const g = mesh.addFace(
			piece.loc.map((l) => verts[l]),
			{ id: i === 0 ? f : undefined, material, attrs: pieceAttrs, triangles: [0, 1, 2], orders: [piece.order] }
		);
		om.logical[g] = group;
		view.tFace[piece.t] = g;
		view.tLoc[piece.t * 3] = 0;
		view.tLoc[piece.t * 3 + 1] = 1;
		view.tLoc[piece.t * 3 + 2] = 2;
	});
}

/** the order key of the face's triangle with these local corners @param {MeshKernel} mesh @param {number} f @param {number[]} loc */
function triangleOrder(mesh, f, loc) {
	const first = mesh.fTriFirst[f];
	for (let r = first; r < first + mesh.fTriLen[f]; r++)
		if (mesh.tLocal[r * 3] === loc[0] && mesh.tLocal[r * 3 + 1] === loc[1] && mesh.tLocal[r * 3 + 2] === loc[2])
			return mesh.tOrder[r];
	return mesh.nextOrder++;
}

/**
 * Rebuild face `f` over new vertices (and optionally new corner attributes), keeping its corner
 * order, triangulation and order keys — so its output triangles keep their indices and diagonals.
 * @param {MeshKernel} mesh @param {number} f @param {number[]} verts
 * @param {Record<string, ArrayLike<number>>} [attrs] corner attributes (default: the face's own)
 */
export function refaceKeep(mesh, f, verts, attrs) {
	const first = mesh.fTriFirst[f];
	const count = mesh.fTriLen[f];
	const triangles = mesh.tLocal.slice(first * 3, (first + count) * 3);
	const orders = mesh.tOrder.slice(first, first + count);
	mesh._reface(f, verts, attrs ?? mesh._faceAttrs(f), { triangles, orders });
}

/** Append the triangles of faces added since the view was built (they come last in output order,
 * by order key) — cheaper than a rebuild after an append-only operator. @param {OpMesh} om
 * @param {number[]} added the new face IDs in creation order */
export function appendToView(om, added) {
	const { mesh } = om;
	/** @type {{ f: number, r: number, order: number }[]} */
	const recs = [];
	for (const f of added) {
		mesh.ensureTriangulation(f);
		const first = mesh.fTriFirst[f];
		for (let r = first; r < first + mesh.fTriLen[f]; r++) recs.push({ f, r, order: mesh.tOrder[r] });
	}
	recs.sort((a, b) => a.order - b.order);
	const count = om.view.count + recs.length;
	const tFace = new Int32Array(count);
	const tLoc = new Int32Array(count * 3);
	tFace.set(om.view.tFace);
	tLoc.set(om.view.tLoc);
	recs.forEach((rec, i) => {
		const t = om.view.count + i;
		tFace[t] = rec.f;
		tLoc.set(mesh.tLocal.subarray(rec.r * 3, rec.r * 3 + 3), t * 3);
	});
	om.view = { tFace, tLoc, count };
}

/**
 * The stored partition of the op mesh as it stands, grouped by `logical`. Order (the soup's two rules):
 * `'appearance'` (composeFaces, every topology operator) = the faces AUTHORED since beginOp in creation
 * order, then the carried ones by their first triangle; `'stored'` (an operator that kept the partition,
 * a move) = the carried faces in their stored order. Afterwards each face's logical group IS its index in
 * the returned partition (what the commit stores), so the next operator starts from the stored order.
 * @param {OpMesh} om @param {Int32Array} triFace face per output triangle @param {'appearance' | 'stored'} [order]
 * @returns {number[][]}
 */
function partitionOf(om, triFace, order = 'appearance') {
	const n = triFace.length;
	const logical = om.logical;
	// rank every group once: authored groups by number, carried ones by first triangle (or by number)
	const top = om.nextGroup;
	const rank = new Int32Array(top).fill(-1);
	const count = new Int32Array(top);
	const group = new Int32Array(n);
	/** @type {number[]} */
	const carried = [];
	for (let t = 0; t < n; t++) {
		const g = /** @type {number} */ (logical[triFace[t]]);
		group[t] = g;
		if (count[g]++ === 0 && g < om.baseGroup) carried.push(g);
	}
	let next = 0;
	for (let g = om.baseGroup; g < top; g++) if (count[g]) rank[g] = next++;
	if (order === 'stored') carried.sort((x, y) => x - y);
	for (const g of carried) rank[g] = next++;
	/** @type {number[][]} */
	const faces = new Array(next);
	for (let g = 0; g < top; g++) if (rank[g] >= 0) faces[rank[g]] = new Array(count[g]);
	const fill = new Int32Array(next);
	for (let t = 0; t < n; t++) {
		const r = rank[group[t]];
		faces[r][fill[r]++] = t;
	}
	// renumber: group = index in the stored partition
	for (let t = 0; t < n; t++) logical[triFace[t]] = rank[group[t]];
	om.baseGroup = om.nextGroup = next;
	return faces;
}

/** the stored partition over the VIEW (no output pass; the adjust engine's per-scrub read)
 * @param {OpMesh} om @param {'appearance' | 'stored'} [order] */
export function opPartition(om, order) {
	return partitionOf(om, om.view.tFace, order);
}

/**
 * The op mesh as the state commitMesh records: Float32 positions / uvs (null when untextured),
 * material groups (null when every slot is 0), the ID channels and the stored partition (partitionOf).
 * @param {OpMesh} om @param {{ order?: 'appearance' | 'stored' }} [options]
 * @returns {{ positions: Float32Array, uvs: Float32Array | null, groups: any[] | null, ids: IdChannels, faces: number[][] }}
 */
export function opOutput(om, options = {}) {
	const out = toArrays(om.mesh);
	const groups = out.groups && out.groups.some((g) => (g.materialIndex ?? 0) > 0) ? out.groups : null;
	return {
		positions: out.positions,
		uvs: out.attributes.uv?.array ?? null,
		groups,
		ids: { cornerVertex: out.cornerVertex, triFace: out.triFace },
		faces: partitionOf(om, out.triFace, options.order)
	};
}

/**
 * The operator's AUTHORED faces as output triangle indices, in authoring order — the `authored` list a soup
 * operator hands composeFaces (the leading entries of the appearance partition). Renumbers like opPartition.
 * @param {OpMesh} om @returns {number[][]}
 */
export function authoredFaces(om) {
	const base = om.baseGroup;
	/** @type {Set<number>} */
	const groups = new Set();
	for (let t = 0; t < om.view.count; t++) {
		const g = /** @type {number} */ (om.logical[om.view.tFace[t]]);
		if (g >= base) groups.add(g);
	}
	return partitionOf(om, om.view.tFace, 'appearance').slice(0, groups.size);
}

/** a deep copy (the adjust engine re-runs from one) @param {OpMesh} om @returns {OpMesh} */
export function cloneOpMesh(om) {
	const Kernel = /** @type {any} */ (om.mesh.constructor);
	return {
		mesh: Kernel.fromTransfer(om.mesh.toTransfer()),
		logical: om.logical.slice(),
		baseGroup: om.baseGroup,
		nextGroup: om.nextGroup,
		view: { tFace: om.view.tFace.slice(), tLoc: om.view.tLoc.slice(), count: om.view.count }
	};
}

export { NONE };

/**
 * The op mesh as per-corner arrays in output order, positions at full (Float64) precision — what a
 * triangle-soup caller rebuilds its triangles from. @param {OpMesh} om
 * @returns {{ positions: Float64Array, uv: Float32Array | null, material: Int32Array, count: number }}
 */
export function opTriangles(om) {
	const { mesh, view } = om;
	const n = view.count;
	const positions = new Float64Array(n * 9);
	const uvAttr = mesh.attrs.uv;
	const uv = uvAttr ? new Float32Array(n * 6) : null;
	const material = new Int32Array(n);
	for (let t = 0; t < n; t++) {
		const f = view.tFace[t];
		material[t] = mesh.fMat[f];
		const first = mesh.fFirst[f];
		for (let k = 0; k < 3; k++) {
			const c = first + view.tLoc[t * 3 + k];
			const v = mesh.cVert[c];
			positions[t * 9 + k * 3] = mesh.vPos[v * 3];
			positions[t * 9 + k * 3 + 1] = mesh.vPos[v * 3 + 1];
			positions[t * 9 + k * 3 + 2] = mesh.vPos[v * 3 + 2];
			if (uv && uvAttr) {
				uv[t * 6 + k * 2] = uvAttr.data[c * 2];
				uv[t * 6 + k * 2 + 1] = uvAttr.data[c * 2 + 1];
			}
		}
	}
	return { positions, uv, material, count: n };
}

/** start an operator: what it creates from here on is AUTHORED (opOutput lists it first) @param {OpMesh} om */
export function beginOp(om) {
	om.baseGroup = om.nextGroup;
	return om;
}
