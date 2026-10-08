// @ts-ignore - no bundled three type declarations (project-wide)
import * as THREE from 'three';
import { writable, get } from 'svelte/store';
import { idbGet, idbPut } from './idb';

// 39 P4 — HOW BIG A PACK ITEM IS, BEFORE IT IS LOADED. The drag-to-place ghost shows a
// not-yet-loaded item as its bounding box with W × D × H in metres, so the size has to be
// known without the file. Three sources, best first:
//   1. the pack's own row (`size: [w, h, d]`, `box`, `tris`, `bytes`, `animated`) — written
//      by the packs repo's build tool (`kit-build dims`) for every shipped item;
//   2. what this device measured the first time the file loaded (an old / imported pack, a
//      Khronos row), kept in ONE IndexedDB record so it survives a reload;
//   3. nothing: a neutral 1 m box with a "size unknown" label.
//
// `size` is [x, y, z] = width, height, depth in metres (after the pack's own scale — the GLB
// as shipped). PACKS.md's manifest example used to put the BYTE count in `size`; a NUMBER
// there is still read as bytes, so an old manifest keeps working.
//
// A LEAF: three, svelte/store and idb. Nothing here travels — a measurement is a fact about
// a file, and every peer measures its own copy.

/**
 * @typedef {{size: number[], box: number[], tris: number | null, bytes: number | null,
 *   animated: boolean, known: boolean, source: 'row' | 'measured' | 'unknown'}} Dims
 */

/** a 1 m block standing on the origin — the unknown-size ghost (the placeholders' DEFAULT_BOX) */
export const UNKNOWN_BOX = [-0.5, 0, -0.5, 0.5, 1, 0.5];

const KEY = 'pack:dims-v1';
/** url -> measured dims, loaded once @type {Map<string, Dims> | null} */
let memo = null;
/** @type {Promise<void> | null} */
let loading = null;
/** bumps when a measurement lands, so a ghost waiting on an unknown size can swap */
export const dimsRevision = writable(0);

/** @param {any} v */
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
/** @param {number} v */
const mm = (v) => Math.round(v * 1000) / 1000;

/** A box from a size alone: the pack pivot rule (bottom-centre) @param {number[]} size */
export function boxFromSize(size) {
	const [w, h, d] = size;
	return [mm(-w / 2), 0, mm(-d / 2), mm(w / 2), mm(h), mm(d / 2)];
}

/** @param {number[]} box */
export function sizeOfBox(box) {
	return [mm(box[3] - box[0]), mm(box[4] - box[1]), mm(box[5] - box[2])];
}

/** @param {any} v @returns {number[] | null} */
function sizeArray(v) {
	return Array.isArray(v) && v.length === 3 && v.every(finite) && v.every((/** @type {number} */ n) => n >= 0) ? v.map(Number) : null;
}
/** @param {any} v @returns {number[] | null} */
function boxArray(v) {
	if (!Array.isArray(v) || v.length !== 6 || !v.every(finite)) return null;
	if (v[3] < v[0] || v[4] < v[1] || v[5] < v[2]) return null;
	return v.map(Number);
}

/**
 * The dims a pack row / manifest item DECLARES, or null when it declares none.
 * @param {any} row @returns {Dims | null}
 */
export function dimsFromRow(row) {
	if (!row || typeof row !== 'object') return null;
	const box = boxArray(row.box);
	const size = sizeArray(row.size) ?? (box ? sizeOfBox(box) : null);
	if (!size) return null;
	// a numeric `size` is the OLD manifest's byte count (PACKS.md before 39)
	const bytes = finite(row.bytes) ? row.bytes : finite(row.size) ? row.size : null;
	return {
		size,
		box: box ?? boxFromSize(size),
		tris: finite(row.tris) ? Math.round(row.tris) : null,
		bytes,
		animated: row.animated === true || !!row.behavior,
		known: true,
		source: 'row'
	};
}

/** The unknown-size answer. @returns {Dims} */
export function unknownDims() {
	return { size: sizeOfBox(UNKNOWN_BOX), box: UNKNOWN_BOX.slice(), tris: null, bytes: null, animated: false, known: false, source: 'unknown' };
}

/**
 * Measure a parsed model: its bounds in its ROOT's own frame and the triangles it draws.
 * @param {any} root @param {{bytes?: number | null, animated?: boolean}} [extra] @returns {Dims | null}
 */
export function measureDims(root, extra = {}) {
	if (!root) return null;
	root.updateMatrixWorld(true);
	const toRoot = new THREE.Matrix4().copy(root.matrixWorld).invert();
	const m = new THREE.Matrix4();
	const box = new THREE.Box3();
	const part = new THREE.Box3();
	let tris = 0;
	root.traverse((/** @type {any} */ node) => {
		if (!node.isMesh || !node.geometry) return;
		const g = node.geometry;
		if (!g.boundingBox) g.computeBoundingBox();
		part.copy(g.boundingBox).applyMatrix4(m.multiplyMatrices(toRoot, node.matrixWorld));
		box.union(part);
		const count = g.index ? g.index.count : g.attributes?.position?.count ?? 0;
		tris += (node.isInstancedMesh ? node.count : 1) * Math.floor(count / 3);
	});
	if (box.isEmpty()) return null;
	const b = [mm(box.min.x), mm(box.min.y), mm(box.min.z), mm(box.max.x), mm(box.max.y), mm(box.max.z)];
	return {
		size: sizeOfBox(b),
		box: b,
		tris,
		bytes: finite(extra.bytes) ? /** @type {number} */ (extra.bytes) : null,
		animated: !!extra.animated,
		known: true,
		source: 'measured'
	};
}

/** Load the measured-dims record once. */
export function loadMeasuredDims() {
	if (memo) return Promise.resolve();
	if (loading) return loading;
	loading = (async () => {
		/** @type {Map<string, Dims>} */
		const map = new Map();
		try {
			const raw = await idbGet(KEY);
			if (raw && typeof raw === 'object')
				for (const [url, d] of Object.entries(raw)) {
					const dims = dimsFromRow(d);
					if (dims) map.set(url, { ...dims, source: 'measured' });
				}
		} catch {}
		memo = map;
	})();
	return loading;
}

/** What this device measured for `url`, if anything (sync; null until loaded). @param {string} url */
export function measuredDims(url) {
	return memo?.get(url) ?? null;
}

/**
 * Keep a measurement (first load of a pack file with no dims in its row).
 * @param {string} url @param {Dims} dims
 */
export async function rememberDims(url, dims) {
	if (!url || !dims?.known) return;
	await loadMeasuredDims();
	const map = /** @type {Map<string, Dims>} */ (memo);
	const prev = map.get(url);
	if (prev && prev.tris === dims.tris && prev.box.every((v, i) => v === dims.box[i])) return;
	map.set(url, { ...dims, source: 'measured' });
	dimsRevision.update((n) => n + 1);
	// a level load measures a hundred pieces in a burst — ONE write for the lot
	clearTimeout(writeTimer);
	writeTimer = setTimeout(writeMeasured, 400);
}

/** @type {any} */
let writeTimer = null;
async function writeMeasured() {
	if (!memo) return;
	/** @type {Record<string, any>} */
	const out = {};
	for (const [u, d] of memo) out[u] = { size: d.size, box: d.box, tris: d.tris, bytes: d.bytes, animated: d.animated || undefined };
	try {
		await idbPut(KEY, out);
	} catch {}
}

/**
 * The best dims for a placeable item (a normalized pack item, a library record, a prefab
 * card). Never null: an item with nothing known is the 1 m unknown box.
 * @param {any} item @returns {Dims}
 */
export function dimsOf(item) {
	if (item?.dims?.known) return item.dims;
	const declared = dimsFromRow(item?.dims ?? item);
	if (declared) return declared;
	const url = item?.glbUrl ?? item?.url;
	const measured = url ? measuredDims(url) : null;
	if (measured) return measured;
	return unknownDims();
}

/** Forget every measurement (Storage's reclaim, the suites). */
export async function clearMeasuredDims() {
	memo = new Map();
	dimsRevision.update((n) => n + 1);
	try {
		await idbPut(KEY, {});
	} catch {}
}

/** @returns {number} how many urls carry a measurement */
export function measuredCount() {
	return memo?.size ?? 0;
}

/** A W × D × H label, metres: "1.20 × 0.80 × 2.10 m" @param {number[]} size */
export function dimsLabel(size) {
	/** @param {number} v */
	const f = (v) => (v >= 10 ? v.toFixed(1) : v.toFixed(2));
	return `${f(size[0])} × ${f(size[2])} × ${f(size[1])} m`;
}

/** "12.3k tris · 1.4 MB" (either half may be absent) @param {Dims} d */
export function costLabel(d) {
	const parts = [];
	if (d.tris != null) parts.push((d.tris >= 1000 ? (d.tris / 1000).toFixed(d.tris >= 10000 ? 0 : 1) + 'k' : String(d.tris)) + ' tris');
	if (d.bytes != null) parts.push(bytesLabel(d.bytes));
	return parts.join(' · ');
}

/** @param {number} n */
export function bytesLabel(n) {
	if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
	if (n >= 1024) return Math.round(n / 1024) + ' KB';
	return n + ' B';
}

/** for get() users @returns {number} */
export function dimsRev() {
	return get(dimsRevision);
}
