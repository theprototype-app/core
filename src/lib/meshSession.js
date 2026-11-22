// Roadmap 99 K3: the edit session's kernel half — LAZY (editSession.js imports it the first time
// a session opens, so the kernel never reaches the boot chunk).
//
// - `buildSessionKernel(geometry)`: the kernel of the edited mesh, built OFF the main thread
//   (meshSession.worker.js) with the editor's weld (1e-4), so entering edit mode costs what it
//   did before K3. `buildSessionKernelSync` is the same build in-thread (node tests, no Worker).
// - `selectionToIds` / `idsToSelection`: the selection as element IDs — faces as face IDs,
//   vertices as vertex IDs, edges as vertex-ID PAIRS (edge IDs are re-derived, a pair is not) —
//   through the kernel's ID maps (`triFace`: output triangle -> face; `cornerVertex`: corner ->
//   vertex). The import keeps the source triangle order, so output triangle i IS geometry
//   triangle i, and a map built on the entry geometry reads the live selection directly.
//
// K3 STORES the selection as IDs beside the index-based stash; the index stash stays the one restore
// reads (K4 ported the operators onto the session's op mesh: faceEdit heldOpMesh / sessionKernelCommit).

import { fromArrays, toArrays, geometryArrays } from './meshKernel/index.js';
import { MAX_SNAPSHOT } from './meshBudget';

/** the editor's weld — faceEdit's keyOf (Math.round(x * 1e4) per axis; K1 QUESTIONS #1). 99 K4: by KEY, not by
 * distance, so the session kernel's vertices are exactly the ones the operators weld (meshOps OP_WELD) and an
 * operator can rebuild from this kernel's vertex map without welding again */
export const SESSION_WELD = { key: 1e4 };

/** a mesh above this many triangles gets no session kernel: the commit ceiling (MAX_SNAPSHOT
 * floats, 9 per triangle) — an edit beyond it can never commit, so its IDs would serve nothing */
export const KERNEL_MAX_TRIS = Math.floor(MAX_SNAPSHOT / 9);

/**
 * Build the open session's kernel and keep it on the session — only while the session and the
 * geometry it was built from are still current.
 * The session comes in as an argument: importing the editSessionState leaf from this lazy chunk
 * made the bundler split the leaf into a boot chunk of its own.
 * @param {any} session editSessionState's `session` @param {string} uuid @param {any} geometry
 * @param {(entry: any, geometry: any) => boolean} changed editSession's geometryChanged
 * @returns {Promise<any>} the ID maps, or null
 */
export async function startSessionKernel(session, uuid, geometry, changed) {
	const position = geometry.attributes.position;
	if ((geometry.index ? geometry.index.count : position.count) / 3 > KERNEL_MAX_TRIS) return null;
	const entry = session.entry;
	const built = await buildSessionKernel(geometry);
	if (
		!built ||
		session.uuid !== uuid ||
		session.entry !== entry ||
		changed(entry, session.object?.geometry)
	)
		return null;
	session.kernel = built.packed;
	session.kernelMaps = {
		triFace: built.triFace,
		cornerVertex: built.cornerVertex,
		ms: built.ms,
		geometry
	};
	return session.kernelMaps;
}

/**
 * A stashed selection as IDs on the session (`session.selection`); the caller checked the maps
 * are current. @param {any} session
 * @param {{ tris?: number[], handles?: number[][], edgeKeys?: string[] }} selection
 * @param {(x: number, y: number, z: number) => string} [keyOf]
 */
export function storeSelectionIds(session, selection, keyOf) {
	const maps = session.kernelMaps;
	const ids = selectionToIds(maps, maps.geometry, selection, keyOf);
	if (selection.tris) session.selection.faces = ids.faces;
	if (selection.handles) session.selection.verts = ids.verts;
	if (selection.edgeKeys) session.selection.edges = ids.edges;
}

/**
 * The kernel + ID maps of a geometry, in this thread.
 * @param {any} geometry @returns {{ packed: any, triFace: Int32Array, cornerVertex: Int32Array, ms: number }}
 */
export function buildSessionKernelSync(geometry) {
	const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
	const { arrays } = geometryArrays(geometry);
	const { mesh } = fromArrays(arrays, { weld: SESSION_WELD });
	const out = toArrays(mesh);
	const ms = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
	return { packed: mesh.toTransfer(), triFace: out.triFace, cornerVertex: out.cornerVertex, ms };
}

/** @type {Worker | null} */
let worker = null;
let nextId = 1;
/** @type {Map<number, (v: any) => void>} */
const waiting = new Map();

/** the worker, made on first use (a test may replace it) */
let makeWorker = () =>
	new Worker(new URL('./meshSession.worker.js', import.meta.url), { type: 'module' });

/**
 * The kernel + ID maps of a geometry, built in the session worker. Resolves null when there is no
 * Worker (node, SSR) or the build failed — a session without a kernel behaves as before K3.
 * @param {any} geometry @returns {Promise<{ packed: any, triFace: Int32Array, cornerVertex: Int32Array, ms: number } | null>}
 */
export function buildSessionKernel(geometry) {
	if (typeof Worker === 'undefined') return Promise.resolve(null);
	let arrays;
	try {
		arrays = geometryArrays(geometry).arrays;
	} catch {
		return Promise.resolve(null);
	}
	if (!worker) {
		try {
			worker = makeWorker();
		} catch {
			return Promise.resolve(null);
		}
		worker.onmessage = (event) => {
			const done = waiting.get(event.data?.id);
			if (!done) return;
			waiting.delete(event.data.id);
			done(event.data.error ? null : event.data);
		};
		worker.onerror = () => {
			for (const done of waiting.values()) done(null);
			waiting.clear();
		};
	}
	const id = nextId++;
	const w = worker;
	return new Promise((resolve) => {
		waiting.set(id, resolve);
		w.postMessage({ id, arrays, weld: SESSION_WELD });
	});
}

/** @param {any} geometry corner -> attribute index @returns {(c: number) => number} */
function cornerAttr(geometry) {
	const index = geometry.index;
	return index ? (c) => index.getX(c) : (c) => c;
}

/**
 * The selection as element IDs.
 * @param {{ triFace: Int32Array, cornerVertex: Int32Array }} maps
 * @param {any} geometry the geometry the maps were built from
 * @param {{ tris?: number[], handles?: number[][], edgeKeys?: string[] }} selection
 *   `tris` = selected triangle indices (face mode), `handles` = the attribute indices of each
 *   selected vertex handle (vertex mode), `edgeKeys` = selected edges as the editor stores them
 *   ('ka|kb', two welded position keys)
 * @param {(x: number, y: number, z: number) => string} [keyOf] the editor's position key (edges)
 * @returns {{ faces: number[], verts: number[], edges: [number, number][] }}
 */
export function selectionToIds(maps, geometry, selection, keyOf) {
	const { triFace, cornerVertex } = maps;
	/** @type {Set<number>} */
	const faces = new Set();
	for (const t of selection.tris ?? []) if (t >= 0 && t < triFace.length) faces.add(triFace[t]);
	const attrOf = cornerAttr(geometry);
	/** @type {Map<number, number>} attribute index -> vertex id */
	const vertexOfAttr = new Map();
	for (let c = 0; c < cornerVertex.length; c++) vertexOfAttr.set(attrOf(c), cornerVertex[c]);
	/** @type {Set<number>} */
	const verts = new Set();
	for (const handle of selection.handles ?? [])
		for (const a of handle) {
			const v = vertexOfAttr.get(a);
			if (v !== undefined) verts.add(v);
		}
	/** @type {[number, number][]} */
	const edges = [];
	if (selection.edgeKeys?.length && keyOf) {
		const position = geometry.attributes.position;
		/** @type {Map<string, number>} */
		const vertexOfKey = new Map();
		for (const [a, v] of vertexOfAttr) {
			const k = keyOf(position.getX(a), position.getY(a), position.getZ(a));
			if (!vertexOfKey.has(k)) vertexOfKey.set(k, v);
		}
		for (const key of selection.edgeKeys) {
			const [ka, kb] = key.split('|');
			const a = vertexOfKey.get(ka);
			const b = vertexOfKey.get(kb);
			if (a !== undefined && b !== undefined) edges.push(a < b ? [a, b] : [b, a]);
		}
	}
	return {
		faces: [...faces].sort((a, b) => a - b),
		verts: [...verts].sort((a, b) => a - b),
		edges
	};
}

/**
 * Element IDs back to the selection's indices on the geometry the maps were built from.
 * @param {{ triFace: Int32Array, cornerVertex: Int32Array }} maps @param {any} geometry
 * @param {{ faces: number[], verts: number[], edges: [number, number][] }} ids
 * @returns {{ tris: number[], attrs: number[], edgeAttrs: [number, number][] }} triangles of the
 *   faces, every attribute index of the vertices, one attribute index per edge end
 */
export function idsToSelection(maps, geometry, ids) {
	const { triFace, cornerVertex } = maps;
	const faceSet = new Set(ids.faces);
	const tris = [];
	for (let t = 0; t < triFace.length; t++) if (faceSet.has(triFace[t])) tris.push(t);
	const vertSet = new Set(ids.verts);
	const attrOf = cornerAttr(geometry);
	/** @type {Set<number>} */
	const attrs = new Set();
	/** @type {Map<number, number>} vertex id -> one attribute index */
	const firstAttr = new Map();
	for (let c = 0; c < cornerVertex.length; c++) {
		const v = cornerVertex[c];
		const a = attrOf(c);
		if (vertSet.has(v)) attrs.add(a);
		if (!firstAttr.has(v)) firstAttr.set(v, a);
	}
	/** @type {[number, number][]} */
	const edgeAttrs = [];
	for (const [a, b] of ids.edges) {
		const pa = firstAttr.get(a);
		const pb = firstAttr.get(b);
		if (pa !== undefined && pb !== undefined) edgeAttrs.push([pa, pb]);
	}
	return { tris, attrs: [...attrs].sort((x, y) => x - y), edgeAttrs };
}

/** test seam: replace the worker factory @param {() => Worker} make */
export function setSessionWorkerFactoryForTest(make) {
	worker?.terminate?.();
	worker = null;
	makeWorker = make;
}
