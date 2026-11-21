// Roadmap 99 K1: plain arrays <-> kernel. The lossless core of every adapter (no three.js here:
// a Worker can import this file as it is).
//
// IMPORT welds corners into vertices (exact numeric equality by default, so nothing moves), turns
// each stored face of the partition into one n-gon when it is a clean disk, and keeps every source
// triangle as that face's triangulation with its source index as the ORDER key. OUTPUT walks the
// faces and re-emits those triangles in that order. So geometry -> kernel -> geometry returns the
// same triangles, in the same order, with the same corner values — the round-trip contract the
// scene tests hold every mesh to.

import { MeshKernel, NONE } from './kernel.js';

/**
 * @typedef {{ array: ArrayLike<number>, itemSize: number }} PlainAttribute
 * @typedef {{ start: number, count: number, materialIndex?: number }} Group
 * @typedef {{
 *   positions: ArrayLike<number>,
 *   index?: ArrayLike<number>|null,
 *   attributes?: Record<string, PlainAttribute>,
 *   groups?: Group[]|null,
 *   faces?: number[][]|null,
 *   cornerVertex?: ArrayLike<number>|null,
 *   triFace?: ArrayLike<number>|null
 * }} MeshArrays
 * @typedef {{ weld?: number|false }} ImportOptions
 * @typedef {{ triangles: number, faces: number, ngons: number, degenerate: number, fallbackFaces: number, partition: 'used'|'absent'|'invalid'|'ids', vertices: number }} ImportReport
 */

const f64 = new Float64Array(1);
const u32 = new Uint32Array(f64.buffer);
/** @param {number} x */
function bitsHash(x) {
	f64[0] = x + 0; // -0 -> 0: numerically equal, one key
	return Math.imul(u32[0] ^ Math.imul(u32[1], 0x9e3779b1), 0x85ebca6b);
}

/**
 * Exact weld: source vertex -> the first source vertex with the SAME position (numeric equality,
 * so -0 meets 0). Open addressing on the float bits.
 * @param {ArrayLike<number>} p @param {number} n @returns {Int32Array}
 */
function exactWeld(p, n) {
	let size = 1;
	while (size < n * 2) size <<= 1;
	const mask = size - 1;
	const table = new Int32Array(size).fill(-1);
	const rep = new Int32Array(n);
	for (let i = 0; i < n; i++) {
		const x = p[i * 3];
		const y = p[i * 3 + 1];
		const z = p[i * 3 + 2];
		let h = (bitsHash(x) ^ Math.imul(bitsHash(y), 0x27d4eb2f) ^ Math.imul(bitsHash(z), 0x165667b1)) & mask;
		for (;;) {
			const j = table[h];
			if (j < 0) {
				table[h] = i;
				rep[i] = i;
				break;
			}
			if (p[j * 3] === x && p[j * 3 + 1] === y && p[j * 3 + 2] === z) {
				rep[i] = j;
				break;
			}
			h = (h + 1) & mask;
		}
	}
	return rep;
}


/**
 * Is `faces` a partition of `triCount` triangles (each exactly once)? Mirrors meshTopology's
 * facesValidFor without importing it (this file stays dependency-free for Workers).
 * @param {any} faces @param {number} triCount
 */
function isPartition(faces, triCount) {
	if (!Array.isArray(faces) || !faces.length) return false;
	const seen = new Uint8Array(triCount);
	let total = 0;
	for (const face of faces) {
		if (!Array.isArray(face) || !face.length) return false;
		for (const t of face) {
			if (!Number.isInteger(t) || t < 0 || t >= triCount || seen[t]) return false;
			seen[t] = 1;
			total++;
		}
	}
	return total === triCount;
}

/**
 * The boundary loop of a set of triangles when they form one clean disk with no interior vertex
 * (the only shape an n-gon can stand for), else null.
 * @param {Int32Array} vt vertex per corner @param {number[]} tris
 * @returns {number[]|null}
 */
function diskLoop(vt, tris) {
	/** @type {Map<number, number>} directed edge key -> count */
	const directed = new Map();
	const K = 67108864; // 2^26, the kernel's vertex ID width
	for (const t of tris) {
		for (let k = 0; k < 3; k++) {
			const a = vt[t * 3 + k];
			const b = vt[t * 3 + ((k + 1) % 3)];
			if (a === b) return null;
			const key = a * K + b;
			if (directed.has(key)) return null; // two triangles walk one side the same way
			directed.set(key, 1);
		}
	}
	/** @type {Map<number, number>} vertex -> next on the boundary */
	const next = new Map();
	for (const key of directed.keys()) {
		const a = Math.floor(key / K);
		const b = key - a * K;
		if (directed.has(b * K + a)) continue; // interior edge
		if (next.has(a)) return null; // the boundary touches itself
		next.set(a, b);
	}
	if (next.size < 3) return null;
	const start = /** @type {number} */ (next.keys().next().value);
	/** @type {number[]} */
	const loop = [];
	let v = start;
	for (let guard = 0; guard <= next.size; guard++) {
		loop.push(v);
		const n = next.get(v);
		if (n === undefined) return null;
		v = n;
		if (v === start) break;
	}
	if (v !== start || loop.length !== next.size) return null; // two loops (a hole) or an open walk
	if (tris.length !== loop.length - 2) return null; // an interior vertex, or a folded disk
	return loop;
}

/**
 * Build a kernel from plain arrays.
 * @param {MeshArrays} src @param {ImportOptions} [options]
 * @returns {{ mesh: MeshKernel, report: ImportReport }}
 */
export function fromArrays(src, options = {}) {
	const positions = src.positions;
	const index = src.index ?? null;
	const srcCount = Math.floor(positions.length / 3);
	const triCount = Math.floor((index ? index.length : srcCount) / 3);
	const cornerCount = triCount * 3;
	/** source vertex of each corner */
	const sc = new Int32Array(cornerCount);
	for (let c = 0; c < cornerCount; c++) sc[c] = index ? index[c] : c;

	const attrs = Object.entries(src.attributes ?? {}).filter(([name]) => name !== 'position');
	/** @type {Record<string, number>} */
	const sizes = {};
	for (const [name, attr] of attrs) sizes[name] = attr.itemSize;
	const mesh = new MeshKernel({
		vertices: Math.max(srcCount, 1),
		faces: Math.max(triCount, 1),
		corners: Math.max(cornerCount, 3),
		attributes: sizes
	});

	// ---- vertices -----------------------------------------------------------------------------
	const vt = new Int32Array(cornerCount); // kernel vertex per corner
	if (src.cornerVertex) {
		// IDs supplied (a kernel's own output coming back): no welding, the IDs ARE the topology
		const ids = src.cornerVertex;
		let max = -1;
		for (let c = 0; c < cornerCount; c++) if (ids[c] > max) max = ids[c];
		mesh._ensureVerts(max + 1);
		mesh.vTop = max + 1;
		for (let c = 0; c < cornerCount; c++) {
			const v = ids[c];
			vt[c] = v;
			if (mesh.vFlag[v]) continue;
			const s = sc[c];
			mesh.vPos[v * 3] = positions[s * 3];
			mesh.vPos[v * 3 + 1] = positions[s * 3 + 1];
			mesh.vPos[v * 3 + 2] = positions[s * 3 + 2];
			mesh.vFlag[v] = 1;
			mesh.numVerts++;
		}
	} else {
		const weld = options.weld ?? 0;
		/** @type {Int32Array|null} */
		let rep = null;
		if (weld === 0) rep = exactWeld(positions, srcCount);
		else if (typeof weld === 'number' && weld > 0) rep = epsilonWeld(positions, srcCount, weld);
		const kernelOf = new Int32Array(srcCount).fill(NONE);
		for (let c = 0; c < cornerCount; c++) {
			// weld:false on a soup still shares a vertex between corners naming one source index
			const s = rep ? rep[sc[c]] : sc[c];
			let v = kernelOf[s];
			if (v === NONE) {
				v = mesh.addVertex(positions[s * 3], positions[s * 3 + 1], positions[s * 3 + 2]);
				kernelOf[s] = v;
			}
			vt[c] = v;
		}
	}

	// ---- materials ----------------------------------------------------------------------------
	const groups = src.groups ?? null;
	const mat = new Int32Array(triCount);
	if (groups && groups.length) {
		// three draws only what a group covers: an uncovered triangle keeps slot -1 (not drawn)
		mat.fill(-1);
		for (const g of groups) {
			const start = Math.max(g.start | 0, 0);
			const end = Math.min(start + (g.count | 0), cornerCount);
			for (let c = start; c < end; c++) if (c % 3 === 0) mat[c / 3] = g.materialIndex || 0;
		}
		mesh.hasMaterials = 1;
	}

	// ---- faces ----------------------------------------------------------------------------------
	/** @type {ImportReport} */
	const report = {
		triangles: triCount,
		faces: 0,
		ngons: 0,
		degenerate: 0,
		fallbackFaces: 0,
		partition: 'absent',
		vertices: 0
	};
	const attrData = attrs.map(([name, attr]) => ({
		src: attr.array,
		size: attr.itemSize,
		dst: mesh.attrs[name]
	}));
	const verts3 = new Int32Array(3);
	const TRI = new Int32Array([0, 1, 2]);
	const order1 = new Float64Array(1);
	/** @param {number} t @param {number} [id] */
	const addTriangle = (t, id) => {
		const f = mesh._claimFace(id);
		mesh.fMat[f] = mat[t];
		verts3[0] = vt[t * 3];
		verts3[1] = vt[t * 3 + 1];
		verts3[2] = vt[t * 3 + 2];
		mesh._attachFace(f, verts3, null);
		const base = mesh.fFirst[f];
		for (const { src: a, size, dst } of attrData) {
			const d = dst.data;
			for (let k = 0; k < 3; k++) {
				const s = sc[t * 3 + k];
				for (let j = 0; j < size; j++) d[(base + k) * size + j] = a[s * size + j];
			}
		}
		order1[0] = t;
		mesh.setTriangulation(f, TRI, order1);
		return f;
	};
	/** @param {number[]} tris @param {number} [id] */
	const addGroup = (tris, id) => {
		if (tris.length === 1) return addTriangle(tris[0], id);
		const m = mat[tris[0]];
		const loop = tris.every((t) => mat[t] === m) ? diskLoop(vt, tris) : null;
		/** corner of each loop vertex, attributes checked equal across the group */
		let ok = loop !== null;
		/** @type {Map<number, number>} */
		const localOf = new Map();
		/** @type {number[]} */
		const firstCorner = [];
		if (ok && loop) {
			loop.forEach((v, i) => localOf.set(v, i));
			for (const t of tris)
				for (let k = 0; k < 3 && ok; k++) {
					const c = t * 3 + k;
					const i = /** @type {number} */ (localOf.get(vt[c]));
					if (firstCorner[i] === undefined) {
						firstCorner[i] = c;
						continue;
					}
					const s0 = sc[firstCorner[i]];
					const s1 = sc[c];
					for (const { src: a, size } of attrData)
						for (let j = 0; j < size; j++)
							if (a[s0 * size + j] !== a[s1 * size + j]) {
								ok = false; // a seam inside the face: an n-gon corner has one value
								break;
							}
				}
		}
		if (!ok || !loop) {
			report.fallbackFaces++;
			const first = addTriangle(tris[0], id);
			for (let i = 1; i < tris.length; i++) addTriangle(tris[i]);
			return first;
		}
		const f = mesh._claimFace(id);
		mesh.fMat[f] = m;
		mesh._attachFace(f, loop, null);
		const base = mesh.fFirst[f];
		for (const { src: a, size, dst } of attrData)
			for (let i = 0; i < loop.length; i++) {
				const s = sc[firstCorner[i]];
				for (let j = 0; j < size; j++) dst.data[(base + i) * size + j] = a[s * size + j];
			}
		const local = new Int32Array(tris.length * 3);
		const orders = new Float64Array(tris.length);
		tris.forEach((t, n) => {
			for (let k = 0; k < 3; k++) local[n * 3 + k] = /** @type {number} */ (localOf.get(vt[t * 3 + k]));
			orders[n] = t;
		});
		mesh.setTriangulation(f, local, orders);
		report.ngons++;
		return f;
	};

	if (src.triFace) {
		report.partition = 'ids';
		/** @type {Map<number, number[]>} */
		const byFace = new Map();
		for (let t = 0; t < triCount; t++) {
			const id = src.triFace[t];
			let list = byFace.get(id);
			if (!list) byFace.set(id, (list = []));
			list.push(t);
		}
		// claim the supplied IDs first so a fallback triangle cannot take one
		const ids = [...byFace.keys()].sort((a, b) => a - b);
		mesh._ensureFaces((ids[ids.length - 1] ?? 0) + 1);
		for (const id of ids) addGroup(/** @type {number[]} */ (byFace.get(id)), id);
	} else if (src.faces && isPartition(src.faces, triCount)) {
		report.partition = 'used';
		for (const face of src.faces) addGroup(face);
	} else {
		if (src.faces) report.partition = 'invalid';
		for (let t = 0; t < triCount; t++) addTriangle(t);
	}
	mesh.nextOrder = Math.max(mesh.nextOrder, triCount);
	report.faces = mesh.numFaces - mesh.numDegenerate;
	report.degenerate = mesh.numDegenerate;
	report.vertices = mesh.numVerts;
	return { mesh, report };
}

/**
 * Epsilon weld over source vertices: a uniform grid with neighbour-cell checks, union-find to
 * the lowest index (positions move to that representative).
 * @param {ArrayLike<number>} p @param {number} n @param {number} eps @returns {Int32Array}
 */
function epsilonWeld(p, n, eps) {
	const inv = 1 / (eps * 2);
	/** @type {Map<string, number[]>} */
	const cells = new Map();
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
	const e2 = eps * eps;
	for (let i = 0; i < n; i++) {
		const x = p[i * 3];
		const y = p[i * 3 + 1];
		const z = p[i * 3 + 2];
		const cx = Math.floor(x * inv);
		const cy = Math.floor(y * inv);
		const cz = Math.floor(z * inv);
		for (let dx = -1; dx <= 1; dx++)
			for (let dy = -1; dy <= 1; dy++)
				for (let dz = -1; dz <= 1; dz++) {
					const list = cells.get(`${cx + dx},${cy + dy},${cz + dz}`);
					if (!list) continue;
					for (const j of list) {
						const ex = p[j * 3] - x;
						const ey = p[j * 3 + 1] - y;
						const ez = p[j * 3 + 2] - z;
						if (ex * ex + ey * ey + ez * ez > e2) continue;
						const a = find(i);
						const b = find(j);
						if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
					}
				}
		const key = `${cx},${cy},${cz}`;
		let list = cells.get(key);
		if (!list) cells.set(key, (list = []));
		list.push(i);
	}
	for (let i = 0; i < n; i++) parent[i] = find(i);
	return parent;
}

/**
 * @typedef {{
 *   positions: Float32Array,
 *   attributes: Record<string, { array: Float32Array, itemSize: number }>,
 *   groups: Group[]|null,
 *   material: Int32Array,
 *   triFace: Int32Array,
 *   cornerVertex: Int32Array,
 *   faces: number[][]
 * }} OutputArrays
 */

/**
 * Triangulate for output: a non-indexed triangle list (the form the editor commits today), with
 * per-corner attributes, material groups (runs of one slot in output order; slot -1 is left out),
 * and the ID channels a receiver needs to rebuild the same topology: `cornerVertex` (vertex ID
 * per output corner), `triFace` (face ID per output triangle) and `faces` (output triangle
 * indices per face, the `__topo` partition).
 * @param {MeshKernel} mesh @returns {OutputArrays}
 */
export function toArrays(mesh) {
	const faceList = mesh.faceIds({ degenerate: true });
	let total = 0;
	for (const f of faceList) {
		mesh.ensureTriangulation(f);
		total += mesh.fTriLen[f];
	}
	// triangle records in face order, then sorted by order key when the faces interleave
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
		perm = Int32Array.from(p);
	}
	const positions = new Float32Array(total * 9);
	const cornerVertex = new Int32Array(total * 3);
	const triFace = new Int32Array(total);
	const material = new Int32Array(total);
	/** @type {Record<string, { array: Float32Array, itemSize: number }>} */
	const attributes = {};
	const names = mesh.attributeNames();
	for (const name of names) attributes[name] = { array: new Float32Array(total * 3 * mesh.attrs[name].size), itemSize: mesh.attrs[name].size };
	/** @type {Map<number, number[]>} */
	const facesOf = new Map();
	for (let i = 0; i < total; i++) {
		const r = perm ? perm[i] : i;
		const f = recF[r];
		const tr = recT[r];
		const base = mesh.fFirst[f];
		triFace[i] = f;
		material[i] = mesh.fMat[f];
		let list = facesOf.get(f);
		if (!list) facesOf.set(f, (list = []));
		list.push(i);
		for (let k = 0; k < 3; k++) {
			const c = base + mesh.tLocal[tr * 3 + k];
			const v = mesh.cVert[c];
			cornerVertex[i * 3 + k] = v;
			positions[i * 9 + k * 3] = mesh.vPos[v * 3];
			positions[i * 9 + k * 3 + 1] = mesh.vPos[v * 3 + 1];
			positions[i * 9 + k * 3 + 2] = mesh.vPos[v * 3 + 2];
			for (const name of names) {
				const size = mesh.attrs[name].size;
				const src = mesh.attrs[name].data;
				const dst = attributes[name].array;
				for (let j = 0; j < size; j++) dst[(i * 3 + k) * size + j] = src[c * size + j];
			}
		}
	}
	/** @type {Group[]|null} */
	let groups = null;
	if (mesh.hasMaterials) {
		groups = [];
		let i = 0;
		while (i < total) {
			const m = material[i];
			let j = i + 1;
			while (j < total && material[j] === m) j++;
			if (m >= 0) groups.push({ start: i * 3, count: (j - i) * 3, materialIndex: m });
			i = j;
		}
	}
	return {
		positions,
		attributes,
		groups,
		material,
		triFace,
		cornerVertex,
		faces: [...facesOf.values()]
	};
}
