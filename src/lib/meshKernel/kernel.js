// Roadmap 99 K1: the headless mesh kernel.
//
// A face-vertex mesh with full adjacency, stored in flat typed arrays (owner fork 2a: fast to copy
// to a Worker and to peers). Pure JS: no three.js, no stores, no DOM, so it runs in node, in a
// Worker and in the page alike.
//
// The model is BMesh's, flattened:
// - VERTEX: a position (Float64) and one incident edge (`vEdge`, the head of its DISK cycle).
// - EDGE: two vertices, the next edge around each end (`eDisk`, the disk cycle of that end) and one
//   corner that walks it (`eCorner`, the head of its RADIAL cycle: every face side on this edge).
// - FACE: an n-gon, a contiguous block of CORNERS (`fFirst`, `fLen`) plus a material slot.
// - CORNER (a face-vertex, BMesh's "loop"): its vertex, the edge to the next corner, its face, the
//   next corner on the same edge (`cRadial`), and the per-corner attributes (uv, normal, colour...).
//
// IDs ARE SLOTS and are never reused until `compact()`: a vertex / edge / face keeps its number
// through every edit that does not delete it, so a selection stored as IDs survives a move, a split,
// a bevel. `compact()` is the one call that renumbers, and it returns the old -> new maps.
//
// Triangles are OUTPUT only. Each face keeps a triangulation cache in LOCAL corner indices with an
// ORDER key per triangle. An imported mesh keeps its source triangles (and their order) until an
// edit changes that face's topology, so geometry -> kernel -> geometry is lossless; a moved vertex
// keeps its faces' diagonals (no flips mid-grab); a face whose corners change is re-triangulated
// (ear clipping) at output time.

import { triangulatePolygon } from './triangulate.js';
import { SpatialHash } from './spatialHash.js';

export const NONE = -1;
const ALIVE = 1;
/** a face whose corners repeat CONSECUTIVELY (a zero-length side): kept for output, never linked */
const DEGENERATE = 2;
/** a face whose triangulation cache is stale */
const DIRTY = 4;

/** vertex IDs live in 26 bits for the import's pair keys (67 M vertices) */
export const MAX_VERTICES = 1 << 26;

/**
 * @typedef {{ size: number, data: Float32Array<ArrayBuffer> }} CornerAttribute
 * @typedef {{ material?: number, attrs?: Record<string, ArrayLike<number>>, triangles?: ArrayLike<number>|null, orders?: ArrayLike<number>|null, id?: number }} FaceOptions
 */

// The grow helpers resize to EXACTLY `need`: every table's arrays are sized from ONE capacity
// (k values per element), so a floor or doubling per array would let a gating array outgrow its
// k-per-element siblings and the writes past their end would be silently dropped.
/** @param {Int32Array<ArrayBuffer>} arr @param {number} need @returns {Int32Array<ArrayBuffer>} */
function growI32(arr, need) {
	if (need <= arr.length) return arr;
	const out = new Int32Array(need).fill(NONE);
	out.set(arr);
	return out;
}
/** @param {Uint8Array<ArrayBuffer>} arr @param {number} need @returns {Uint8Array<ArrayBuffer>} */
function growU8(arr, need) {
	if (need <= arr.length) return arr;
	const out = new Uint8Array(need);
	out.set(arr);
	return out;
}
/** @param {Float64Array<ArrayBuffer>} arr @param {number} need @returns {Float64Array<ArrayBuffer>} */
function growF64(arr, need) {
	if (need <= arr.length) return arr;
	const out = new Float64Array(need);
	out.set(arr);
	return out;
}
/** @param {Float32Array<ArrayBuffer>} arr @param {number} need @returns {Float32Array<ArrayBuffer>} */
function growF32(arr, need) {
	if (need <= arr.length) return arr;
	const out = new Float32Array(need);
	out.set(arr);
	return out;
}

/** The typed-array fields, in one list: transfer, byte counting and compaction walk it. */
const FIELDS = /** @type {const} */ ([
	'vPos',
	'vEdge',
	'vFlag',
	'eVert',
	'eDisk',
	'eCorner',
	'eFlag',
	'cVert',
	'cEdge',
	'cFace',
	'cRadial',
	'fFirst',
	'fLen',
	'fMat',
	'fFlag',
	'fTriFirst',
	'fTriLen',
	'tLocal',
	'tOrder'
]);
const COUNTERS = /** @type {const} */ ([
	'vTop',
	'eTop',
	'cTop',
	'fTop',
	'tTop',
	'numVerts',
	'numEdges',
	'numFaces',
	'numDegenerate',
	'nextOrder',
	'hasMaterials'
]);

export class MeshKernel {
	/** @param {{ vertices?: number, faces?: number, corners?: number, attributes?: Record<string, number> }} [capacity] */
	constructor(capacity = {}) {
		const nv = Math.max(capacity.vertices ?? 64, 1);
		const nf = Math.max(capacity.faces ?? 64, 1);
		const nc = Math.max(capacity.corners ?? nf * 4, 3);
		const ne = nv + nf + 8;
		/** positions, 3 per vertex slot */ this.vPos = new Float64Array(nv * 3);
		/** head of the vertex's disk cycle */ this.vEdge = new Int32Array(nv).fill(NONE);
		/** ALIVE */ this.vFlag = new Uint8Array(nv);
		/** the two vertices, 2 per edge */ this.eVert = new Int32Array(ne * 2).fill(NONE);
		/** next edge around end 0 / end 1 */ this.eDisk = new Int32Array(ne * 2).fill(NONE);
		/** head of the radial cycle */ this.eCorner = new Int32Array(ne).fill(NONE);
		this.eFlag = new Uint8Array(ne);
		this.cVert = new Int32Array(nc).fill(NONE);
		this.cEdge = new Int32Array(nc).fill(NONE);
		this.cFace = new Int32Array(nc).fill(NONE);
		this.cRadial = new Int32Array(nc).fill(NONE);
		this.fFirst = new Int32Array(nf).fill(NONE);
		this.fLen = new Int32Array(nf);
		this.fMat = new Int32Array(nf);
		this.fFlag = new Uint8Array(nf);
		/** triangulation cache: first triangle record and count per face */
		this.fTriFirst = new Int32Array(nf).fill(NONE);
		this.fTriLen = new Int32Array(nf);
		/** triangle records: 3 LOCAL corner indices each, and an output order key */
		this.tLocal = new Int32Array(nf * 3).fill(NONE);
		this.tOrder = new Float64Array(nf);
		this.vTop = 0;
		this.eTop = 0;
		this.cTop = 0;
		this.fTop = 0;
		this.tTop = 0;
		this.numVerts = 0;
		this.numEdges = 0;
		this.numFaces = 0;
		this.numDegenerate = 0;
		/** the next free triangle order key (imports start it after the source triangle count) */
		this.nextOrder = 0;
		/** 1 when the source had material groups (output writes groups), else 0 */
		this.hasMaterials = 0;
		/** @type {Record<string, CornerAttribute>} */
		this.attrs = {};
		for (const [name, size] of Object.entries(capacity.attributes ?? {})) this.addCornerAttribute(name, size);
	}

	// ---- attributes ---------------------------------------------------------------------------

	/** Declare a per-corner attribute (uv = 2, normal = 3, color = 3 or 4...). Existing corners get 0.
	 * @param {string} name @param {number} size */
	addCornerAttribute(name, size) {
		if (name === 'position') throw new Error('position is per vertex, not per corner');
		if (this.attrs[name]) return this.attrs[name];
		const attr = { size, data: new Float32Array(Math.max(this.cVert.length, 1) * size) };
		this.attrs[name] = attr;
		return attr;
	}

	/** @returns {string[]} */
	attributeNames() {
		return Object.keys(this.attrs);
	}

	// ---- capacity -----------------------------------------------------------------------------

	/** @param {number} n */
	_ensureVerts(n) {
		if (n <= this.vEdge.length) return;
		const cap = Math.max(n, this.vEdge.length * 2, 16);
		this.vPos = growF64(this.vPos, cap * 3);
		this.vEdge = growI32(this.vEdge, cap);
		this.vFlag = growU8(this.vFlag, cap);
	}
	/** @param {number} n */
	_ensureEdges(n) {
		if (n <= this.eCorner.length) return;
		const cap = Math.max(n, this.eCorner.length * 2, 16);
		this.eVert = growI32(this.eVert, cap * 2);
		this.eDisk = growI32(this.eDisk, cap * 2);
		this.eCorner = growI32(this.eCorner, cap);
		this.eFlag = growU8(this.eFlag, cap);
	}
	/** @param {number} n */
	_ensureCorners(n) {
		if (n <= this.cVert.length) return;
		const cap = Math.max(n, this.cVert.length * 2, 16);
		this.cVert = growI32(this.cVert, cap);
		this.cEdge = growI32(this.cEdge, cap);
		this.cFace = growI32(this.cFace, cap);
		this.cRadial = growI32(this.cRadial, cap);
		for (const attr of Object.values(this.attrs)) attr.data = growF32(attr.data, cap * attr.size);
	}
	/** @param {number} n */
	_ensureFaces(n) {
		if (n <= this.fFirst.length) return;
		const cap = Math.max(n, this.fFirst.length * 2, 16);
		this.fFirst = growI32(this.fFirst, cap);
		this.fLen = growI32(this.fLen, cap);
		this.fMat = growI32(this.fMat, cap);
		this.fFlag = growU8(this.fFlag, cap);
		this.fTriFirst = growI32(this.fTriFirst, cap);
		this.fTriLen = growI32(this.fTriLen, cap);
	}
	/** @param {number} n */
	_ensureTris(n) {
		if (n <= this.tOrder.length) return;
		const cap = Math.max(n, this.tOrder.length * 2, 16);
		this.tLocal = growI32(this.tLocal, cap * 3);
		this.tOrder = growF64(this.tOrder, cap);
	}

	// ---- liveness -----------------------------------------------------------------------------

	/** @param {number} v */
	hasVertex(v) {
		return v >= 0 && v < this.vTop && (this.vFlag[v] & ALIVE) !== 0;
	}
	/** @param {number} e */
	hasEdge(e) {
		return e >= 0 && e < this.eTop && (this.eFlag[e] & ALIVE) !== 0;
	}
	/** @param {number} f */
	hasFace(f) {
		return f >= 0 && f < this.fTop && (this.fFlag[f] & ALIVE) !== 0;
	}
	/** a face kept for output only (a zero-length side): no edges, no adjacency @param {number} f */
	isDegenerate(f) {
		return this.hasFace(f) && (this.fFlag[f] & DEGENERATE) !== 0;
	}

	/** alive vertex IDs, ascending @returns {Int32Array} */
	vertexIds() {
		const out = new Int32Array(this.numVerts);
		let at = 0;
		for (let v = 0; v < this.vTop; v++) if (this.vFlag[v] & ALIVE) out[at++] = v;
		return out;
	}
	/** alive edge IDs, ascending @returns {Int32Array} */
	edgeIds() {
		const out = new Int32Array(this.numEdges);
		let at = 0;
		for (let e = 0; e < this.eTop; e++) if (this.eFlag[e] & ALIVE) out[at++] = e;
		return out;
	}
	/** alive face IDs, ascending; degenerate faces only with `{ degenerate: true }`
	 * @param {{ degenerate?: boolean }} [options] @returns {Int32Array} */
	faceIds(options = {}) {
		const withDegenerate = options.degenerate === true;
		const out = new Int32Array(this.numFaces - (withDegenerate ? 0 : this.numDegenerate));
		let at = 0;
		for (let f = 0; f < this.fTop; f++) {
			const flag = this.fFlag[f];
			if (!(flag & ALIVE)) continue;
			if (flag & DEGENERATE && !withDegenerate) continue;
			out[at++] = f;
		}
		return out;
	}

	// ---- vertices -----------------------------------------------------------------------------

	/** @param {number} x @param {number} y @param {number} z @returns {number} the new vertex ID */
	addVertex(x, y, z) {
		const v = this.vTop;
		if (v >= MAX_VERTICES) throw new Error('mesh kernel: vertex limit');
		this._ensureVerts(v + 1);
		this.vTop = v + 1;
		this.vPos[v * 3] = x;
		this.vPos[v * 3 + 1] = y;
		this.vPos[v * 3 + 2] = z;
		this.vEdge[v] = NONE;
		this.vFlag[v] = ALIVE;
		this.numVerts++;
		return v;
	}

	/** @param {number} v @param {number} x @param {number} y @param {number} z */
	setPosition(v, x, y, z) {
		this.vPos[v * 3] = x;
		this.vPos[v * 3 + 1] = y;
		this.vPos[v * 3 + 2] = z;
	}

	/** @param {number} v @param {number[]|Float64Array} [out] @returns {number[]|Float64Array} */
	position(v, out = [0, 0, 0]) {
		out[0] = this.vPos[v * 3];
		out[1] = this.vPos[v * 3 + 1];
		out[2] = this.vPos[v * 3 + 2];
		return out;
	}

	// ---- edges (disk cycles) ------------------------------------------------------------------

	/** the other end of edge `e` from `v` @param {number} e @param {number} v */
	otherVertex(e, v) {
		const a = this.eVert[e * 2];
		return a === v ? this.eVert[e * 2 + 1] : a;
	}
	/** @param {number} e @returns {[number, number]} */
	edgeVertices(e) {
		return [this.eVert[e * 2], this.eVert[e * 2 + 1]];
	}
	/** @param {number} e @param {number} v */
	_diskSlot(e, v) {
		return this.eVert[e * 2] === v ? e * 2 : e * 2 + 1;
	}
	/** next edge around `v` after `e` @param {number} e @param {number} v */
	diskNext(e, v) {
		return this.eDisk[this._diskSlot(e, v)];
	}
	/** @param {number} e @param {number} v */
	_diskInsert(e, v) {
		this.eDisk[this._diskSlot(e, v)] = this.vEdge[v];
		this.vEdge[v] = e;
	}
	/** @param {number} e @param {number} v */
	_diskRemove(e, v) {
		const next = this.diskNext(e, v);
		if (this.vEdge[v] === e) {
			this.vEdge[v] = next;
		} else {
			let p = this.vEdge[v];
			let guard = this.eTop + 1;
			while (p !== NONE && guard-- > 0) {
				const pn = this.diskNext(p, v);
				if (pn === e) {
					this.eDisk[this._diskSlot(p, v)] = next;
					break;
				}
				p = pn;
			}
		}
		this.eDisk[this._diskSlot(e, v)] = NONE;
	}

	/** The edge joining `a` and `b`, or NONE. Walks a's disk: no hash table, degree-sized.
	 * @param {number} a @param {number} b */
	findEdge(a, b) {
		const eVert = this.eVert;
		const eDisk = this.eDisk;
		let e = this.vEdge[a];
		while (e !== NONE) {
			const s = eVert[e * 2] === a ? 0 : 1;
			if (eVert[e * 2 + 1 - s] === b) return e;
			e = eDisk[e * 2 + s];
		}
		return NONE;
	}

	/** @param {number} a @param {number} b @returns {number} */
	_newEdge(a, b) {
		const e = this.eTop;
		this._ensureEdges(e + 1);
		this.eTop = e + 1;
		this.eVert[e * 2] = a;
		this.eVert[e * 2 + 1] = b;
		this.eDisk[e * 2] = NONE;
		this.eDisk[e * 2 + 1] = NONE;
		this.eCorner[e] = NONE;
		this.eFlag[e] = ALIVE;
		this._diskInsert(e, a);
		this._diskInsert(e, b);
		this.numEdges++;
		return e;
	}

	/** A wire edge (no face), or the existing edge between a and b. @param {number} a @param {number} b */
	addEdge(a, b) {
		if (a === b) throw new Error('mesh kernel: an edge needs two vertices');
		if (!this.hasVertex(a) || !this.hasVertex(b)) throw new Error('mesh kernel: edge on a dead vertex');
		const e = this.findEdge(a, b);
		return e !== NONE ? e : this._newEdge(a, b);
	}

	/** @param {number} e */
	_killEdge(e) {
		const a = this.eVert[e * 2];
		const b = this.eVert[e * 2 + 1];
		this._diskRemove(e, a);
		this._diskRemove(e, b);
		this.eFlag[e] = 0;
		this.eCorner[e] = NONE;
		this.numEdges--;
	}

	/** edges around a vertex @param {number} v @returns {number[]} */
	vertexEdges(v) {
		/** @type {number[]} */
		const out = [];
		let e = this.vEdge[v];
		let guard = this.eTop + 1;
		while (e !== NONE && guard-- > 0) {
			out.push(e);
			e = this.diskNext(e, v);
		}
		return out;
	}

	/** neighbouring vertices (one per edge) @param {number} v @returns {number[]} */
	vertexNeighbors(v) {
		return this.vertexEdges(v).map((e) => this.otherVertex(e, v));
	}

	// ---- radial cycles ------------------------------------------------------------------------

	/** @param {number} e @param {number} c */
	_radialAdd(e, c) {
		this.cRadial[c] = this.eCorner[e];
		this.eCorner[e] = c;
	}
	/** @param {number} e @param {number} c */
	_radialRemove(e, c) {
		if (this.eCorner[e] === c) {
			this.eCorner[e] = this.cRadial[c];
		} else {
			let p = this.eCorner[e];
			let guard = this.cTop + 1;
			while (p !== NONE && guard-- > 0) {
				if (this.cRadial[p] === c) {
					this.cRadial[p] = this.cRadial[c];
					break;
				}
				p = this.cRadial[p];
			}
		}
		this.cRadial[c] = NONE;
	}

	/** corners on an edge (one per face side) @param {number} e @returns {number[]} */
	edgeCorners(e) {
		/** @type {number[]} */
		const out = [];
		let c = this.eCorner[e];
		let guard = this.cTop + 1;
		while (c !== NONE && guard-- > 0) {
			out.push(c);
			c = this.cRadial[c];
		}
		return out;
	}

	/** faces on an edge, each once @param {number} e @returns {number[]} */
	edgeFaces(e) {
		/** @type {number[]} */
		const out = [];
		for (const c of this.edgeCorners(e)) {
			const f = this.cFace[c];
			if (!out.includes(f)) out.push(f);
		}
		return out;
	}

	/** how many face sides use the edge (0 wire, 1 boundary, 2 manifold, >2 non-manifold) @param {number} e */
	edgeValence(e) {
		let n = 0;
		let c = this.eCorner[e];
		while (c !== NONE) {
			n++;
			c = this.cRadial[c];
		}
		return n;
	}

	// ---- corners and faces ----------------------------------------------------------------------

	/** next corner in the face @param {number} c */
	cornerNext(c) {
		const f = this.cFace[c];
		const first = this.fFirst[f];
		return c + 1 < first + this.fLen[f] ? c + 1 : first;
	}
	/** previous corner in the face @param {number} c */
	cornerPrev(c) {
		const f = this.cFace[c];
		const first = this.fFirst[f];
		return c > first ? c - 1 : first + this.fLen[f] - 1;
	}

	/** corners at a vertex (each corner once: found through its OUTGOING edge) @param {number} v @returns {number[]} */
	vertexCorners(v) {
		/** @type {number[]} */
		const out = [];
		for (const e of this.vertexEdges(v))
			for (const c of this.edgeCorners(e)) if (this.cVert[c] === v) out.push(c);
		return out;
	}

	/** faces around a vertex, each once @param {number} v @returns {number[]} */
	vertexFaces(v) {
		/** @type {number[]} */
		const out = [];
		for (const c of this.vertexCorners(v)) {
			const f = this.cFace[c];
			if (!out.includes(f)) out.push(f);
		}
		return out;
	}

	/** @param {number} f @returns {number[]} */
	faceVertices(f) {
		const first = this.fFirst[f];
		return Array.from(this.cVert.subarray(first, first + this.fLen[f]));
	}
	/** @param {number} f @returns {number[]} */
	faceEdges(f) {
		const first = this.fFirst[f];
		return Array.from(this.cEdge.subarray(first, first + this.fLen[f]));
	}
	/** global corner indices of a face (they move when the face is rebuilt; corner indices are not IDs)
	 * @param {number} f @returns {number[]} */
	faceCorners(f) {
		const first = this.fFirst[f];
		/** @type {number[]} */
		const out = [];
		for (let i = 0; i < this.fLen[f]; i++) out.push(first + i);
		return out;
	}
	/** @param {number} f */
	faceSize(f) {
		return this.fLen[f];
	}
	/** @param {number} f */
	faceMaterial(f) {
		return this.fMat[f];
	}
	/** @param {number} f @param {number} slot */
	setFaceMaterial(f, slot) {
		this.fMat[f] = slot;
		if (slot !== 0) this.hasMaterials = 1;
	}

	/** faces sharing an edge with `f` @param {number} f @returns {number[]} */
	faceNeighbors(f) {
		/** @type {number[]} */
		const out = [];
		if (this.fFlag[f] & DEGENERATE) return out;
		for (const e of this.faceEdges(f))
			for (const g of this.edgeFaces(e)) if (g !== f && !out.includes(g)) out.push(g);
		return out;
	}

	/** Newell normal (unit; zero for a degenerate face) @param {number} f @param {number[]} [out] */
	faceNormal(f, out = [0, 0, 0]) {
		const first = this.fFirst[f];
		const n = this.fLen[f];
		const p = this.vPos;
		let nx = 0;
		let ny = 0;
		let nz = 0;
		for (let i = 0; i < n; i++) {
			const a = this.cVert[first + i] * 3;
			const b = this.cVert[first + ((i + 1) % n)] * 3;
			nx += (p[a + 1] - p[b + 1]) * (p[a + 2] + p[b + 2]);
			ny += (p[a + 2] - p[b + 2]) * (p[a] + p[b]);
			nz += (p[a] - p[b]) * (p[a + 1] + p[b + 1]);
		}
		const len = Math.hypot(nx, ny, nz);
		out[0] = len ? nx / len : 0;
		out[1] = len ? ny / len : 0;
		out[2] = len ? nz / len : 0;
		return out;
	}

	/** corner-average centre @param {number} f @param {number[]} [out] */
	faceCenter(f, out = [0, 0, 0]) {
		const first = this.fFirst[f];
		const n = this.fLen[f];
		let x = 0;
		let y = 0;
		let z = 0;
		for (let i = 0; i < n; i++) {
			const v = this.cVert[first + i] * 3;
			x += this.vPos[v];
			y += this.vPos[v + 1];
			z += this.vPos[v + 2];
		}
		out[0] = x / n;
		out[1] = y / n;
		out[2] = z / n;
		return out;
	}

	/** read a corner attribute @param {number} c @param {string} name @param {number[]} [out] */
	cornerAttribute(c, name, out = []) {
		const attr = this.attrs[name];
		if (!attr) return out;
		for (let k = 0; k < attr.size; k++) out[k] = attr.data[c * attr.size + k];
		return out;
	}
	/** @param {number} c @param {string} name @param {ArrayLike<number>} value */
	setCornerAttribute(c, name, value) {
		const attr = this.attrs[name] ?? this.addCornerAttribute(name, value.length);
		for (let k = 0; k < attr.size; k++) attr.data[c * attr.size + k] = value[k] ?? 0;
	}

	// ---- building faces -----------------------------------------------------------------------

	/** @param {number} n @returns {number} the first corner of a fresh block */
	_allocCorners(n) {
		const base = this.cTop;
		this._ensureCorners(base + n);
		this.cTop = base + n;
		return base;
	}

	/**
	 * Lay a face's corners out as a fresh block and link them. `attrs[name]` holds `n * size`
	 * values in corner order (missing = zeros).
	 * @param {number} f @param {ArrayLike<number>} verts @param {Record<string, ArrayLike<number>>|null} attrs
	 */
	_attachFace(f, verts, attrs) {
		const n = verts.length;
		const base = this._allocCorners(n);
		this.fFirst[f] = base;
		this.fLen[f] = n;
		let degenerate = false;
		for (let i = 0; i < n; i++) {
			const c = base + i;
			this.cVert[c] = verts[i];
			this.cFace[c] = f;
			this.cRadial[c] = NONE;
			this.cEdge[c] = NONE;
			if (verts[i] === verts[(i + 1) % n]) degenerate = true;
		}
		for (const [name, attr] of Object.entries(this.attrs)) {
			const src = attrs?.[name];
			const size = attr.size;
			const data = attr.data;
			if (src) for (let k = 0; k < n * size; k++) data[base * size + k] = src[k];
			else data.fill(0, base * size, (base + n) * size);
		}
		if (degenerate) {
			if (!(this.fFlag[f] & DEGENERATE)) this.numDegenerate++;
			this.fFlag[f] |= DEGENERATE;
			return;
		}
		if (this.fFlag[f] & DEGENERATE) this.numDegenerate--;
		this.fFlag[f] &= ~DEGENERATE;
		for (let i = 0; i < n; i++) {
			const c = base + i;
			const a = verts[i];
			const b = verts[(i + 1) % n];
			let e = this.findEdge(a, b);
			if (e === NONE) e = this._newEdge(a, b);
			this.cEdge[c] = e;
			this._radialAdd(e, c);
		}
	}

	/** Unlink a face's corners from their edges (the edges stay, possibly as wire edges).
	 * @param {number} f @returns {number[]} the edges it was on */
	_detachFace(f) {
		const first = this.fFirst[f];
		const n = this.fLen[f];
		/** @type {number[]} */
		const edges = [];
		for (let i = 0; i < n; i++) {
			const c = first + i;
			const e = this.cEdge[c];
			if (e !== NONE) {
				this._radialRemove(e, c);
				edges.push(e);
			}
			this.cFace[c] = NONE;
			this.cEdge[c] = NONE;
		}
		return edges;
	}

	/** the face's corner attributes, copied out in corner order @param {number} f */
	_faceAttrs(f) {
		const first = this.fFirst[f];
		const n = this.fLen[f];
		/** @type {Record<string, Float32Array>} */
		const out = {};
		for (const [name, attr] of Object.entries(this.attrs))
			out[name] = attr.data.slice(first * attr.size, (first + n) * attr.size);
		return out;
	}

	/** @param {number} f */
	_dropTriangulation(f) {
		this.fTriFirst[f] = NONE;
		this.fTriLen[f] = 0;
		this.fFlag[f] |= DIRTY;
	}

	/**
	 * Store a triangulation for a face: `local` = 3 corner indices per triangle (0..n-1), `orders`
	 * one output order key each (fresh keys when omitted).
	 * @param {number} f @param {ArrayLike<number>} local @param {ArrayLike<number>|null} [orders]
	 */
	setTriangulation(f, local, orders = null) {
		const count = local.length / 3;
		const first = this.tTop;
		this._ensureTris(first + count);
		this.tTop = first + count;
		for (let k = 0; k < count * 3; k++) this.tLocal[first * 3 + k] = local[k];
		for (let t = 0; t < count; t++) {
			const order = orders ? orders[t] : this.nextOrder++;
			this.tOrder[first + t] = order;
			if (orders && order >= this.nextOrder) this.nextOrder = Math.floor(order) + 1;
		}
		this.fTriFirst[f] = first;
		this.fTriLen[f] = count;
		this.fFlag[f] &= ~DIRTY;
	}

	/** @param {number} [id] @returns {number} */
	_claimFace(id) {
		let f = id ?? this.fTop;
		if (id !== undefined) {
			if (id < this.fTop && this.fFlag[id] & ALIVE) throw new Error('mesh kernel: face ID in use');
			f = id;
		}
		this._ensureFaces(f + 1);
		if (f >= this.fTop) {
			for (let g = this.fTop; g < f; g++) this.fFlag[g] = 0;
			this.fTop = f + 1;
		}
		this.fFlag[f] = ALIVE;
		this.fTriFirst[f] = NONE;
		this.fTriLen[f] = 0;
		this.numFaces++;
		return f;
	}

	/**
	 * Add an n-gon over existing vertices (in winding order). Corner attributes in `options.attrs`
	 * (n * size values each), a material slot, and optionally the triangulation to keep
	 * (`triangles` = local corner triples, `orders` = their output order keys).
	 * @param {ArrayLike<number>} verts @param {FaceOptions} [options] @returns {number} the face ID
	 */
	addFace(verts, options = {}) {
		const n = verts.length;
		if (n < 3) throw new Error('mesh kernel: a face needs 3 corners');
		for (let i = 0; i < n; i++)
			if (!this.hasVertex(verts[i])) throw new Error('mesh kernel: face on a dead vertex');
		const f = this._claimFace(options.id);
		this.fMat[f] = options.material ?? 0;
		if (this.fMat[f] !== 0) this.hasMaterials = 1;
		this._attachFace(f, verts, options.attrs ?? null);
		if (options.triangles) this.setTriangulation(f, options.triangles, options.orders ?? null);
		else this.fFlag[f] |= DIRTY;
		return f;
	}

	/**
	 * Remove a face. Its edges that no other face uses go too, unless `keepEdges`.
	 * @param {number} f @param {{ keepEdges?: boolean }} [options]
	 */
	removeFace(f, options = {}) {
		if (!this.hasFace(f)) return;
		const edges = this._detachFace(f);
		if (this.fFlag[f] & DEGENERATE) this.numDegenerate--;
		this.fFlag[f] = 0;
		this.fTriLen[f] = 0;
		this.fTriFirst[f] = NONE;
		this.numFaces--;
		if (options.keepEdges) return;
		for (const e of edges) if (this.eFlag[e] & ALIVE && this.eCorner[e] === NONE) this._killEdge(e);
	}

	/** Remove an edge and every face on it (their other edges go when nothing else uses them).
	 * @param {number} e */
	removeEdge(e) {
		if (!this.hasEdge(e)) return;
		for (const f of this.edgeFaces(e)) this.removeFace(f);
		if (this.eFlag[e] & ALIVE) this._killEdge(e);
	}

	/** degenerate faces using `v` (they are not linked, so this scans; they are rare) @param {number} v */
	_degenerateFacesAt(v) {
		/** @type {number[]} */
		const out = [];
		if (!this.numDegenerate) return out;
		for (let f = 0; f < this.fTop; f++) {
			if ((this.fFlag[f] & (ALIVE | DEGENERATE)) !== (ALIVE | DEGENERATE)) continue;
			const first = this.fFirst[f];
			for (let i = 0; i < this.fLen[f]; i++)
				if (this.cVert[first + i] === v) {
					out.push(f);
					break;
				}
		}
		return out;
	}

	/** Remove a vertex with its edges and faces. @param {number} v */
	removeVertex(v) {
		if (!this.hasVertex(v)) return;
		for (const e of this.vertexEdges(v)) this.removeEdge(e);
		for (const f of this._degenerateFacesAt(v)) this.removeFace(f);
		this.vFlag[v] = 0;
		this.vEdge[v] = NONE;
		this.numVerts--;
	}

	/**
	 * Rebuild a face with a new corner list, keeping its ID and material. A face that ends up with
	 * fewer than 3 corners is removed (returns false).
	 * @param {number} f @param {number[]} verts @param {Record<string, ArrayLike<number>>} attrs
	 * @param {{ triangles?: ArrayLike<number>|null, orders?: ArrayLike<number>|null }} [tri]
	 */
	_reface(f, verts, attrs, tri = {}) {
		const edges = this._detachFace(f);
		if (verts.length < 3) {
			if (this.fFlag[f] & DEGENERATE) this.numDegenerate--;
			this.fFlag[f] = 0;
			this.fTriLen[f] = 0;
			this.numFaces--;
			for (const e of edges) if (this.eFlag[e] & ALIVE && this.eCorner[e] === NONE) this._killEdge(e);
			return false;
		}
		this._attachFace(f, verts, attrs);
		if (tri.triangles) this.setTriangulation(f, tri.triangles, tri.orders ?? null);
		else this._dropTriangulation(f);
		for (const e of edges) if (this.eFlag[e] & ALIVE && this.eCorner[e] === NONE) this._killEdge(e);
		return true;
	}

	// ---- Euler-style edits (the K4 building blocks) -------------------------------------------

	/**
	 * Split an edge at `t` (0 = its first vertex). Every face on it gains the new corner, with its
	 * attributes interpolated per face. The edge keeps its ID for the half at its FIRST vertex; the
	 * other half is a new edge.
	 * @param {number} e @param {number} [t] @returns {{ vertex: number, edge: number }}
	 */
	splitEdge(e, t = 0.5) {
		if (!this.hasEdge(e)) throw new Error('mesh kernel: split of a dead edge');
		const a = this.eVert[e * 2];
		const b = this.eVert[e * 2 + 1];
		const pa = this.position(a);
		const pb = this.position(b);
		const m = this.addVertex(
			pa[0] + (pb[0] - pa[0]) * t,
			pa[1] + (pb[1] - pa[1]) * t,
			pa[2] + (pb[2] - pa[2]) * t
		);
		const faces = this.edgeFaces(e);
		/** @type {{ f: number, verts: number[], attrs: Record<string, number[]> }[]} */
		const rebuilt = [];
		for (const f of faces) {
			const first = this.fFirst[f];
			const n = this.fLen[f];
			const old = this._faceAttrs(f);
			/** @type {number[]} */
			const verts = [];
			/** @type {Record<string, number[]>} */
			const attrs = {};
			for (const name of Object.keys(this.attrs)) attrs[name] = [];
			for (let i = 0; i < n; i++) {
				const c = first + i;
				verts.push(this.cVert[c]);
				for (const [name, attr] of Object.entries(this.attrs))
					for (let k = 0; k < attr.size; k++) attrs[name].push(old[name][i * attr.size + k]);
				if (this.cEdge[c] !== e) continue;
				// this side walks a -> b (param t) or b -> a (param 1 - t)
				const s = this.cVert[c] === a ? t : 1 - t;
				const j = (i + 1) % n;
				verts.push(m);
				for (const [name, attr] of Object.entries(this.attrs))
					for (let k = 0; k < attr.size; k++) {
						const x = old[name][i * attr.size + k];
						const y = old[name][j * attr.size + k];
						attrs[name].push(x + (y - x) * s);
					}
			}
			this._detachFace(f);
			rebuilt.push({ f, verts, attrs });
		}
		// e keeps a..m, the new edge is m..b
		this._diskRemove(e, b);
		this.eVert[e * 2 + 1] = m;
		this._diskInsert(e, m);
		const fresh = this._newEdge(m, b);
		for (const { f, verts, attrs } of rebuilt) {
			this._attachFace(f, verts, attrs);
			this._dropTriangulation(f);
		}
		return { vertex: m, edge: fresh };
	}

	/**
	 * Split a face along a new edge between two of its vertices that are not neighbours. `f` keeps
	 * the corners from `va` round to `vb`; the new face gets `vb` round to `va`.
	 * @param {number} f @param {number} va @param {number} vb @returns {{ face: number, edge: number }}
	 */
	splitFace(f, va, vb) {
		if (!this.hasFace(f) || this.fFlag[f] & DEGENERATE) throw new Error('mesh kernel: split of a dead face');
		const verts = this.faceVertices(f);
		const n = verts.length;
		const ia = verts.indexOf(va);
		const ib = verts.indexOf(vb);
		if (ia < 0 || ib < 0 || ia === ib) throw new Error('mesh kernel: split needs two corners of the face');
		if ((ia + 1) % n === ib || (ib + 1) % n === ia) throw new Error('mesh kernel: split corners are neighbours');
		const old = this._faceAttrs(f);
		/** @param {number} from @param {number} to */
		const run = (from, to) => {
			/** @type {number[]} */
			const idx = [];
			for (let i = from; ; i = (i + 1) % n) {
				idx.push(i);
				if (i === to) break;
			}
			return idx;
		};
		/** @param {number[]} idx */
		const pick = (idx) => {
			/** @type {Record<string, number[]>} */
			const attrs = {};
			for (const [name, attr] of Object.entries(this.attrs)) {
				attrs[name] = [];
				for (const i of idx) for (let k = 0; k < attr.size; k++) attrs[name].push(old[name][i * attr.size + k]);
			}
			return { verts: idx.map((i) => verts[i]), attrs };
		};
		const one = pick(run(ia, ib));
		const two = pick(run(ib, ia));
		// both halves attach BEFORE any edge is judged faceless: f's old sides now belong to g too
		const edges = this._detachFace(f);
		this._attachFace(f, one.verts, one.attrs);
		this._dropTriangulation(f);
		const g = this.addFace(two.verts, { material: this.fMat[f], attrs: two.attrs });
		for (const e of edges) if (this.eFlag[e] & ALIVE && this.eCorner[e] === NONE) this._killEdge(e);
		return { face: g, edge: this.findEdge(va, vb) };
	}

	/**
	 * Join the two faces on a manifold edge into one n-gon (the edge goes). The lower face ID
	 * survives. Both faces' triangulations are KEPT (re-indexed), so dissolving the inner edges of
	 * an imported quad changes nothing at output. Refuses (returns NONE) when the edge is not
	 * between two distinct, consistently wound faces, when the corner attributes differ across the
	 * edge (a seam), or when the result would repeat a vertex.
	 * @param {number} e @returns {number}
	 */
	dissolveEdge(e) {
		if (!this.hasEdge(e)) return NONE;
		const corners = this.edgeCorners(e);
		if (corners.length !== 2) return NONE;
		const [c1, c2] = corners;
		const f1 = this.cFace[c1];
		const f2 = this.cFace[c2];
		if (f1 === f2 || this.cVert[c1] === this.cVert[c2]) return NONE;
		if (this.fMat[f1] !== this.fMat[f2]) return NONE;
		// seams: the corners at each end must carry equal attributes in both faces
		const c1n = this.cornerNext(c1);
		const c2n = this.cornerNext(c2);
		for (const attr of Object.values(this.attrs)) {
			const s = attr.size;
			for (let k = 0; k < s; k++) {
				if (attr.data[c1 * s + k] !== attr.data[c2n * s + k]) return NONE;
				if (attr.data[c1n * s + k] !== attr.data[c2 * s + k]) return NONE;
			}
		}
		const n1 = this.fLen[f1];
		const n2 = this.fLen[f2];
		const i1 = c1 - this.fFirst[f1];
		const i2 = c2 - this.fFirst[f2];
		// new loop: f1 from its corner after the edge (b) round to the edge's start (a), then f2 from
		// its corner two after its edge corner (past a) round to the corner before its edge corner
		/** @type {{ face: number, local: number }[]} */
		const loop = [];
		for (let k = 1; k <= n1; k++) loop.push({ face: f1, local: (i1 + k) % n1 });
		for (let k = 2; k < n2; k++) loop.push({ face: f2, local: (i2 + k) % n2 });
		const verts = loop.map(({ face, local }) => this.cVert[this.fFirst[face] + local]);
		if (new Set(verts).size !== verts.length) return NONE;
		// old local -> new local, per face (the shared ends map through f1)
		const map1 = new Int32Array(n1).fill(NONE);
		const map2 = new Int32Array(n2).fill(NONE);
		loop.forEach(({ face, local }, at) => ((face === f1 ? map1 : map2)[local] = at));
		map2[i2] = map1[(i1 + 1) % n1]; // f2's edge corner sits on b
		map2[(i2 + 1) % n2] = map1[i1]; // ...and its next corner on a
		/** @type {Record<string, number[]>} */
		const attrs = {};
		for (const [name, attr] of Object.entries(this.attrs)) {
			attrs[name] = [];
			for (const { face, local } of loop) {
				const c = this.fFirst[face] + local;
				for (let k = 0; k < attr.size; k++) attrs[name].push(attr.data[c * attr.size + k]);
			}
		}
		const keep = Math.min(f1, f2);
		const drop = keep === f1 ? f2 : f1;
		this.ensureTriangulation(f1);
		this.ensureTriangulation(f2);
		/** @type {number[]} */
		const tris = [];
		/** @type {number[]} */
		const orders = [];
		for (const [face, map] of /** @type {[number, Int32Array][]} */ ([
			[f1, map1],
			[f2, map2]
		])) {
			const first = this.fTriFirst[face];
			for (let t = 0; t < this.fTriLen[face]; t++) {
				for (let k = 0; k < 3; k++) tris.push(map[this.tLocal[(first + t) * 3 + k]]);
				orders.push(this.tOrder[first + t]);
			}
		}
		this.removeFace(drop, { keepEdges: true });
		this._reface(keep, verts, attrs, { triangles: tris, orders });
		if (this.eFlag[e] & ALIVE && this.eCorner[e] === NONE) this._killEdge(e);
		return keep;
	}

	/**
	 * Merge vertex `drop` into `keep`: every face on `drop` uses `keep` instead, sides that collapse
	 * to nothing go, faces left with fewer than 3 corners go. `drop`'s edges move onto `keep`
	 * (keeping their IDs) unless `keep` already has that edge, which then wins.
	 * @param {number} keep @param {number} drop
	 */
	mergeVertices(keep, drop) {
		if (keep === drop || !this.hasVertex(keep) || !this.hasVertex(drop)) return;
		/** @type {Set<number>} */
		const faceSet = new Set(this.vertexFaces(drop));
		for (const f of this._degenerateFacesAt(drop)) faceSet.add(f);
		/** @type {{ f: number, verts: number[], attrs: Record<string, number[]>, keepTris: boolean, tris: number[], orders: number[] }[]} */
		const plans = [];
		for (const f of faceSet) {
			const first = this.fFirst[f];
			const n = this.fLen[f];
			const old = this._faceAttrs(f);
			const raw = this.faceVertices(f).map((v) => (v === drop ? keep : v));
			// drop consecutive repeats (and a wrap-around repeat)
			/** @type {number[]} */
			const keepIdx = [];
			for (let i = 0; i < n; i++) if (raw[i] !== raw[(i + n - 1) % n] || n === 1) keepIdx.push(i);
			if (keepIdx.length === 0) keepIdx.push(0);
			/** @type {Record<string, number[]>} */
			const attrs = {};
			for (const [name, attr] of Object.entries(this.attrs)) {
				attrs[name] = [];
				for (const i of keepIdx) for (let k = 0; k < attr.size; k++) attrs[name].push(old[name][i * attr.size + k]);
			}
			const same = keepIdx.length === n;
			/** @type {number[]} */
			const tris = [];
			/** @type {number[]} */
			const orders = [];
			if (same && this.fTriLen[f] > 0 && !(this.fFlag[f] & DIRTY)) {
				const tf = this.fTriFirst[f];
				for (let t = 0; t < this.fTriLen[f]; t++) {
					for (let k = 0; k < 3; k++) tris.push(this.tLocal[(tf + t) * 3 + k]);
					orders.push(this.tOrder[tf + t]);
				}
			}
			plans.push({ f, verts: keepIdx.map((i) => raw[i]), attrs, keepTris: tris.length > 0, tris, orders });
			void first;
		}
		for (const { f } of plans) this._detachFace(f);
		for (const e of this.vertexEdges(drop)) {
			const x = this.otherVertex(e, drop);
			if (x === keep || this.findEdge(keep, x) !== NONE) {
				// collapses, or keep already has it: this edge is now faceless (we detached) and goes
				if (this.eCorner[e] === NONE) this._killEdge(e);
				continue;
			}
			this._diskRemove(e, drop);
			this.eVert[this._diskSlot(e, drop)] = keep;
			this._diskInsert(e, keep);
		}
		this.vFlag[drop] = 0;
		this.vEdge[drop] = NONE;
		this.numVerts--;
		for (const plan of plans) {
			const ok = this._refaceDetached(plan.f, plan.verts, plan.attrs);
			if (ok && plan.keepTris) this.setTriangulation(plan.f, plan.tris, plan.orders);
		}
	}

	/** _reface for a face already detached @param {number} f @param {number[]} verts @param {Record<string, ArrayLike<number>>} attrs */
	_refaceDetached(f, verts, attrs) {
		if (verts.length < 3) {
			if (this.fFlag[f] & DEGENERATE) this.numDegenerate--;
			this.fFlag[f] = 0;
			this.fTriLen[f] = 0;
			this.numFaces--;
			return false;
		}
		this._attachFace(f, verts, attrs);
		this._dropTriangulation(f);
		return true;
	}

	/** Collapse an edge to one vertex at `t` (its first vertex survives). @param {number} e @param {number} [t] */
	collapseEdge(e, t = 0.5) {
		if (!this.hasEdge(e)) return NONE;
		const a = this.eVert[e * 2];
		const b = this.eVert[e * 2 + 1];
		const pa = this.position(a);
		const pb = this.position(b);
		this.setPosition(a, pa[0] + (pb[0] - pa[0]) * t, pa[1] + (pb[1] - pa[1]) * t, pa[2] + (pb[2] - pa[2]) * t);
		this.mergeVertices(a, b);
		// edges left with no face after the collapse (the collapsed edge itself is gone already)
		return a;
	}

	/**
	 * Merge vertices closer than `eps` (through the spatial hash, so pairs across a cell wall merge
	 * too). Each cluster keeps its LOWEST vertex ID and that vertex's position. Returns how many
	 * vertices went. Positions change by up to `eps` (chained clusters can span more).
	 * @param {number} eps @returns {number}
	 */
	weldByDistance(eps) {
		if (!(eps >= 0)) return 0;
		const hash = new SpatialHash(this.vPos, {
			cellSize: Math.max(eps, 1e-9) * 2,
			count: this.vTop,
			include: (v) => (this.vFlag[v] & ALIVE) !== 0
		});
		const rep = hash.clusters(eps);
		let merged = 0;
		for (let v = 0; v < this.vTop; v++) {
			if (rep[v] < 0 || rep[v] === v || !(this.vFlag[v] & ALIVE)) continue;
			this.mergeVertices(rep[v], v);
			merged++;
		}
		return merged;
	}

	/** a spatial hash over the live vertices (rebuild after moves) @param {number} cellSize */
	spatialHash(cellSize) {
		return new SpatialHash(this.vPos, {
			cellSize,
			count: this.vTop,
			include: (v) => (this.vFlag[v] & ALIVE) !== 0
		});
	}

	/** Reverse a face's winding; its triangulation is mirrored, not recomputed. @param {number} f */
	flipFace(f) {
		if (!this.hasFace(f)) return;
		const n = this.fLen[f];
		const old = this._faceAttrs(f);
		const verts = this.faceVertices(f).reverse();
		/** @type {Record<string, number[]>} */
		const attrs = {};
		for (const [name, attr] of Object.entries(this.attrs)) {
			attrs[name] = [];
			for (let i = n - 1; i >= 0; i--) for (let k = 0; k < attr.size; k++) attrs[name].push(old[name][i * attr.size + k]);
		}
		this.ensureTriangulation(f);
		const tf = this.fTriFirst[f];
		/** @type {number[]} */
		const tris = [];
		/** @type {number[]} */
		const orders = [];
		for (let t = 0; t < this.fTriLen[f]; t++) {
			const a = this.tLocal[(tf + t) * 3];
			const b = this.tLocal[(tf + t) * 3 + 1];
			const c = this.tLocal[(tf + t) * 3 + 2];
			tris.push(n - 1 - a, n - 1 - c, n - 1 - b);
			orders.push(this.tOrder[tf + t]);
		}
		this._reface(f, verts, attrs, { triangles: tris, orders });
	}

	// ---- triangulation (output) ---------------------------------------------------------------

	/** Make sure a face has a triangulation cache (ear clipping on its current corners). @param {number} f */
	ensureTriangulation(f) {
		if (this.fTriLen[f] > 0 && !(this.fFlag[f] & DIRTY)) return;
		const n = this.fLen[f];
		const first = this.fFirst[f];
		const coords = new Float64Array(n * 3);
		for (let i = 0; i < n; i++) {
			const v = this.cVert[first + i] * 3;
			coords[i * 3] = this.vPos[v];
			coords[i * 3 + 1] = this.vPos[v + 1];
			coords[i * 3 + 2] = this.vPos[v + 2];
		}
		this.setTriangulation(f, triangulatePolygon(coords, n));
	}

	/** the face's triangles as LOCAL corner triples @param {number} f @returns {number[]} */
	faceTriangles(f) {
		this.ensureTriangulation(f);
		const first = this.fTriFirst[f];
		return Array.from(this.tLocal.subarray(first * 3, (first + this.fTriLen[f]) * 3));
	}

	/** the number of output triangles */
	triangleCount() {
		let n = 0;
		for (let f = 0; f < this.fTop; f++) {
			if (!(this.fFlag[f] & ALIVE)) continue;
			n += this.fTriLen[f] > 0 && !(this.fFlag[f] & DIRTY) ? this.fTriLen[f] : this.fLen[f] - 2;
		}
		return n;
	}

	// ---- whole-mesh queries -------------------------------------------------------------------

	/** live element counts */
	stats() {
		let corners = 0;
		for (let f = 0; f < this.fTop; f++) if (this.fFlag[f] & ALIVE) corners += this.fLen[f];
		return {
			vertices: this.numVerts,
			edges: this.numEdges,
			faces: this.numFaces - this.numDegenerate,
			degenerate: this.numDegenerate,
			corners,
			triangles: this.triangleCount()
		};
	}

	/** V - E + F over the linked mesh (degenerate faces excluded, isolated vertices included) */
	eulerCharacteristic() {
		return this.numVerts - this.numEdges + (this.numFaces - this.numDegenerate);
	}

	/**
	 * What kind of surface this is: boundary / non-manifold / wire edges, winding conflicts (a
	 * manifold edge both faces walk the same way), non-manifold vertices (faces round it do not
	 * form one fan), isolated vertices, connected components and boundary loops.
	 */
	topologyReport() {
		let boundaryEdges = 0;
		let nonManifoldEdges = 0;
		let wireEdges = 0;
		let windingConflicts = 0;
		for (let e = 0; e < this.eTop; e++) {
			if (!(this.eFlag[e] & ALIVE)) continue;
			const n = this.edgeValence(e);
			if (n === 0) wireEdges++;
			else if (n === 1) boundaryEdges++;
			else if (n > 2) nonManifoldEdges++;
			else {
				const c1 = this.eCorner[e];
				const c2 = this.cRadial[c1];
				if (this.cVert[c1] === this.cVert[c2]) windingConflicts++;
			}
		}
		let isolatedVertices = 0;
		let nonManifoldVertices = 0;
		for (let v = 0; v < this.vTop; v++) {
			if (!(this.vFlag[v] & ALIVE)) continue;
			if (this.vEdge[v] === NONE) {
				isolatedVertices++;
				continue;
			}
			if (this._fanCount(v) > 1) nonManifoldVertices++;
		}
		const components = this.faceComponents().length;
		const boundaryLoops = this.boundaryLoops().length;
		const closed = boundaryEdges === 0 && nonManifoldEdges === 0 && wireEdges === 0;
		const manifold = nonManifoldEdges === 0 && nonManifoldVertices === 0 && wireEdges === 0;
		return {
			euler: this.eulerCharacteristic(),
			boundaryEdges,
			nonManifoldEdges,
			wireEdges,
			windingConflicts,
			isolatedVertices,
			nonManifoldVertices,
			components,
			boundaryLoops,
			closed,
			manifold,
			orientable: windingConflicts === 0
		};
	}

	/** how many separate face fans meet at a vertex (1 = a manifold vertex) @param {number} v */
	_fanCount(v) {
		const faces = this.vertexFaces(v);
		if (faces.length <= 1) return faces.length;
		const parent = new Map(faces.map((f) => [f, f]));
		/** @param {number} f @returns {number} */
		const find = (f) => {
			let r = f;
			while (parent.get(r) !== r) r = /** @type {number} */ (parent.get(r));
			parent.set(f, r);
			return r;
		};
		for (const e of this.vertexEdges(v)) {
			const fs = this.edgeFaces(e);
			for (let i = 1; i < fs.length; i++) parent.set(find(fs[i]), find(fs[0]));
		}
		return new Set(faces.map(find)).size;
	}

	/** faces grouped into edge-connected components @returns {number[][]} */
	faceComponents() {
		const parent = new Int32Array(this.fTop);
		for (let f = 0; f < this.fTop; f++) parent[f] = f;
		/** @param {number} f */
		const find = (f) => {
			while (parent[f] !== f) {
				parent[f] = parent[parent[f]];
				f = parent[f];
			}
			return f;
		};
		for (let e = 0; e < this.eTop; e++) {
			if (!(this.eFlag[e] & ALIVE)) continue;
			let c = this.eCorner[e];
			if (c === NONE) continue;
			const root = find(this.cFace[c]);
			for (c = this.cRadial[c]; c !== NONE; c = this.cRadial[c]) {
				const r = find(this.cFace[c]);
				if (r !== root) parent[r] = root;
			}
		}
		/** @type {Map<number, number[]>} */
		const groups = new Map();
		for (const f of this.faceIds()) {
			const r = find(f);
			let list = groups.get(r);
			if (!list) groups.set(r, (list = []));
			list.push(f);
		}
		// a component's root may be re-rooted later in the pass; regroup by final root
		return [...groups.values()];
	}

	/** boundary loops as vertex lists (each boundary edge walked once) @returns {number[][]} */
	boundaryLoops() {
		/** @type {Map<number, number[]>} vertex -> boundary corners starting there */
		const out = new Map();
		for (let e = 0; e < this.eTop; e++) {
			if (!(this.eFlag[e] & ALIVE) || this.edgeValence(e) !== 1) continue;
			const c = this.eCorner[e];
			// the face walks a -> b, so the boundary (seen from outside the face) walks b -> a
			const from = this.cVert[this.cornerNext(c)];
			let list = out.get(from);
			if (!list) out.set(from, (list = []));
			list.push(this.cVert[c]);
		}
		/** @type {number[][]} */
		const loops = [];
		for (const [start] of out) {
			while ((out.get(start)?.length ?? 0) > 0) {
				/** @type {number[]} */
				const loop = [];
				let v = start;
				let guard = this.eTop + 1;
				while (guard-- > 0) {
					const nexts = out.get(v);
					if (!nexts?.length) break;
					loop.push(v);
					v = /** @type {number} */ (nexts.pop());
					if (v === start) break;
				}
				loops.push(loop);
			}
		}
		return loops;
	}

	/**
	 * Check every adjacency invariant. Returns a list of problems (empty = consistent). This is the
	 * property tests' oracle; it is O(mesh) and not meant for hot paths.
	 * @returns {string[]}
	 */
	validate() {
		/** @type {string[]} */
		const problems = [];
		const say = (/** @type {string} */ s) => problems.length < 50 && problems.push(s);
		let verts = 0;
		let edges = 0;
		let faces = 0;
		let degenerate = 0;
		// edges: endpoints alive, distinct, listed in both disks exactly once, unique per pair
		/** @type {Map<string, number>} */
		const pairs = new Map();
		for (let e = 0; e < this.eTop; e++) {
			if (!(this.eFlag[e] & ALIVE)) continue;
			edges++;
			const a = this.eVert[e * 2];
			const b = this.eVert[e * 2 + 1];
			if (!this.hasVertex(a) || !this.hasVertex(b)) say(`edge ${e} on a dead vertex`);
			if (a === b) say(`edge ${e} is a loop`);
			const key = a < b ? `${a},${b}` : `${b},${a}`;
			if (pairs.has(key)) say(`edges ${pairs.get(key)} and ${e} join the same vertices`);
			pairs.set(key, e);
			for (const v of [a, b]) {
				const n = this.vertexEdges(v).filter((x) => x === e).length;
				if (n !== 1) say(`edge ${e} appears ${n} times in the disk of ${v}`);
			}
			for (const c of this.edgeCorners(e)) {
				if (this.cEdge[c] !== e) say(`corner ${c} in the radial of ${e} but on edge ${this.cEdge[c]}`);
				if (!this.hasFace(this.cFace[c])) say(`corner ${c} of edge ${e} has a dead face`);
			}
		}
		for (let v = 0; v < this.vTop; v++) {
			if (!(this.vFlag[v] & ALIVE)) continue;
			verts++;
			for (const e of this.vertexEdges(v)) {
				if (!this.hasEdge(e)) say(`vertex ${v} disk holds dead edge ${e}`);
				else if (this.eVert[e * 2] !== v && this.eVert[e * 2 + 1] !== v) say(`vertex ${v} disk holds foreign edge ${e}`);
			}
		}
		for (let f = 0; f < this.fTop; f++) {
			if (!(this.fFlag[f] & ALIVE)) continue;
			faces++;
			const first = this.fFirst[f];
			const n = this.fLen[f];
			if (n < 3) say(`face ${f} has ${n} corners`);
			if (this.fFlag[f] & DEGENERATE) {
				degenerate++;
				continue;
			}
			for (let i = 0; i < n; i++) {
				const c = first + i;
				if (this.cFace[c] !== f) say(`corner ${c} of face ${f} points at face ${this.cFace[c]}`);
				const a = this.cVert[c];
				const b = this.cVert[first + ((i + 1) % n)];
				if (!this.hasVertex(a)) say(`face ${f} uses dead vertex ${a}`);
				const e = this.cEdge[c];
				if (!this.hasEdge(e)) {
					say(`corner ${c} of face ${f} has no edge`);
					continue;
				}
				const ea = this.eVert[e * 2];
				const eb = this.eVert[e * 2 + 1];
				if (!((ea === a && eb === b) || (ea === b && eb === a))) say(`corner ${c} edge ${e} does not join ${a}-${b}`);
				if (!this.edgeCorners(e).includes(c)) say(`corner ${c} missing from the radial of ${e}`);
			}
			if (this.fTriLen[f] > 0 && !(this.fFlag[f] & DIRTY)) {
				const tf = this.fTriFirst[f];
				for (let k = 0; k < this.fTriLen[f] * 3; k++) {
					const l = this.tLocal[tf * 3 + k];
					if (l < 0 || l >= n) say(`face ${f} triangulation points at corner ${l} of ${n}`);
				}
			}
		}
		if (verts !== this.numVerts) say(`numVerts ${this.numVerts} but ${verts} alive`);
		if (edges !== this.numEdges) say(`numEdges ${this.numEdges} but ${edges} alive`);
		if (faces !== this.numFaces) say(`numFaces ${this.numFaces} but ${faces} alive`);
		if (degenerate !== this.numDegenerate) say(`numDegenerate ${this.numDegenerate} but ${degenerate}`);
		return problems;
	}

	// ---- compaction, transfer, size -------------------------------------------------------------

	/**
	 * Renumber densely (drops dead slots and stale corner / triangle blocks). The ONE call that
	 * changes IDs: returns old -> new maps (NONE for gone) so a caller can carry selections over.
	 * Edge IDs come out in first-use order of the compacted faces, then wire edges.
	 * @returns {{ vertices: Int32Array, edges: Int32Array, faces: Int32Array }}
	 */
	compact() {
		const vMap = new Int32Array(this.vTop).fill(NONE);
		const eMap = new Int32Array(this.eTop).fill(NONE);
		const fMap = new Int32Array(this.fTop).fill(NONE);
		/** @type {Record<string, number>} */
		const sizes = {};
		for (const [name, attr] of Object.entries(this.attrs)) sizes[name] = attr.size;
		const next = new MeshKernel({
			vertices: this.numVerts,
			faces: this.numFaces,
			corners: this.stats().corners,
			attributes: sizes
		});
		next.hasMaterials = this.hasMaterials;
		next.nextOrder = this.nextOrder;
		for (let v = 0; v < this.vTop; v++)
			if (this.vFlag[v] & ALIVE) vMap[v] = next.addVertex(this.vPos[v * 3], this.vPos[v * 3 + 1], this.vPos[v * 3 + 2]);
		for (let f = 0; f < this.fTop; f++) {
			if (!(this.fFlag[f] & ALIVE)) continue;
			const verts = this.faceVertices(f).map((v) => vMap[v]);
			const clean = this.fTriLen[f] > 0 && !(this.fFlag[f] & DIRTY);
			const tf = this.fTriFirst[f];
			fMap[f] = next.addFace(verts, {
				material: this.fMat[f],
				attrs: this._faceAttrs(f),
				triangles: clean ? this.tLocal.subarray(tf * 3, (tf + this.fTriLen[f]) * 3) : null,
				orders: clean ? this.tOrder.subarray(tf, tf + this.fTriLen[f]) : null
			});
		}
		for (let e = 0; e < this.eTop; e++) {
			if (!(this.eFlag[e] & ALIVE)) continue;
			const a = vMap[this.eVert[e * 2]];
			const b = vMap[this.eVert[e * 2 + 1]];
			eMap[e] = next.findEdge(a, b);
			if (eMap[e] === NONE) eMap[e] = next.addEdge(a, b);
		}
		for (const key of FIELDS) /** @type {any} */ (this)[key] = /** @type {any} */ (next)[key];
		for (const key of COUNTERS) /** @type {any} */ (this)[key] = /** @type {any} */ (next)[key];
		this.attrs = next.attrs;
		return { vertices: vMap, edges: eMap, faces: fMap };
	}

	/**
	 * Everything as typed arrays trimmed to the used slots: structured-clone it to a Worker (or pass
	 * `transferList()` to move the buffers), rebuild with `MeshKernel.fromTransfer`.
	 */
	toTransfer() {
		const used = {
			vPos: this.vTop * 3,
			vEdge: this.vTop,
			vFlag: this.vTop,
			eVert: this.eTop * 2,
			eDisk: this.eTop * 2,
			eCorner: this.eTop,
			eFlag: this.eTop,
			cVert: this.cTop,
			cEdge: this.cTop,
			cFace: this.cTop,
			cRadial: this.cTop,
			fFirst: this.fTop,
			fLen: this.fTop,
			fMat: this.fTop,
			fFlag: this.fTop,
			fTriFirst: this.fTop,
			fTriLen: this.fTop,
			tLocal: this.tTop * 3,
			tOrder: this.tTop
		};
		/** @type {Record<string, any>} */
		const out = { kind: 'tp-mesh-kernel', version: 1, attrs: {} };
		for (const key of FIELDS) out[key] = /** @type {any} */ (this)[key].slice(0, used[key]);
		for (const key of COUNTERS) out[key] = /** @type {any} */ (this)[key];
		for (const [name, attr] of Object.entries(this.attrs))
			out.attrs[name] = { size: attr.size, data: attr.data.slice(0, this.cTop * attr.size) };
		return out;
	}

	/** the buffers of a `toTransfer()` result, for postMessage's transfer list @param {any} packed @returns {ArrayBuffer[]} */
	static transferList(packed) {
		/** @type {ArrayBuffer[]} */
		const list = FIELDS.map((key) => packed[key].buffer);
		for (const attr of Object.values(packed.attrs ?? {})) list.push(/** @type {any} */ (attr).data.buffer);
		return list;
	}

	/** @param {any} packed @returns {MeshKernel} */
	static fromTransfer(packed) {
		if (packed?.kind !== 'tp-mesh-kernel' || packed.version !== 1) throw new Error('mesh kernel: not a kernel transfer');
		const mesh = new MeshKernel({ vertices: 1, faces: 1, corners: 3 });
		for (const key of FIELDS) /** @type {any} */ (mesh)[key] = packed[key];
		for (const key of COUNTERS) /** @type {any} */ (mesh)[key] = packed[key];
		mesh.attrs = {};
		for (const [name, attr] of Object.entries(packed.attrs ?? {}))
			mesh.attrs[name] = { size: /** @type {any} */ (attr).size, data: /** @type {any} */ (attr).data };
		// capacity == length now; the grow helpers double on the next add
		return mesh;
	}

	/** bytes held by the typed arrays (capacity) and the part in use @returns {{ allocated: number, used: number }} */
	byteSize() {
		let allocated = 0;
		for (const key of FIELDS) allocated += /** @type {any} */ (this)[key].byteLength;
		for (const attr of Object.values(this.attrs)) allocated += attr.data.byteLength;
		const packed = this.toTransfer();
		let used = 0;
		for (const key of FIELDS) used += packed[key].byteLength;
		for (const attr of Object.values(packed.attrs)) used += /** @type {any} */ (attr).data.byteLength;
		return { allocated, used };
	}
}
