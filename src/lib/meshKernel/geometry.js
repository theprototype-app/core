// Roadmap 99 K1: BufferGeometry -> kernel, read by DUCK TYPE (no three.js import: a geometry's
// shape is `attributes`, `index`, `groups`, `userData`). The other direction needs three's
// classes and lives in `three.js`.
//
// What carries over: position (welded into vertices), EVERY other attribute as a per-corner
// attribute (uv, uv1, normal, color, tangent, skin data...), the index, the material groups, and
// the stored face partition `userData.__topo` (each stored face becomes one n-gon when it is a
// clean disk). What does not: morph attributes (reported in `report.dropped`), interleaving and
// integer/normalized storage (values come out as Float32; the numbers are equal).

import { fromArrays } from './arrays.js';

/**
 * Read one attribute as plain numbers, honouring interleaved and normalized storage the way
 * three's own getX does.
 * @param {any} attr @returns {{ array: ArrayLike<number>, itemSize: number }}
 */
export function plainAttribute(attr) {
	const size = attr.itemSize;
	if (!attr.isInterleavedBufferAttribute && !attr.normalized && attr.array) return { array: attr.array, itemSize: size };
	const n = attr.count;
	const out = new Float32Array(n * size);
	const get = ['getX', 'getY', 'getZ', 'getW'];
	for (let i = 0; i < n; i++) for (let k = 0; k < size; k++) out[i * size + k] = attr[get[k]](i);
	return { array: out, itemSize: size };
}

/** the stored partition on a geometry as number[][] (unvalidated; the import validates)
 * @param {any} geometry @returns {number[][]|null} */
export function storedPartition(geometry) {
	const stored = geometry?.userData?.__topo;
	if (!stored?.counts?.length || !stored?.tris?.length) return null;
	/** @type {number[][]} */
	const faces = [];
	let at = 0;
	for (const count of stored.counts) {
		if (!(count > 0) || at + count > stored.tris.length) return null;
		faces.push(Array.from(stored.tris.slice(at, at + count)));
		at += count;
	}
	return faces;
}

/**
 * A geometry as the import's plain arrays.
 * @param {any} geometry @returns {{ arrays: import('./arrays.js').MeshArrays, dropped: string[] }}
 */
export function geometryArrays(geometry) {
	const position = geometry?.attributes?.position;
	if (!position) throw new Error('mesh kernel: geometry has no position attribute');
	/** @type {Record<string, { array: ArrayLike<number>, itemSize: number }>} */
	const attributes = {};
	for (const [name, attr] of Object.entries(geometry.attributes)) {
		if (name === 'position') continue;
		attributes[name] = plainAttribute(attr);
	}
	/** @type {string[]} */
	const dropped = [];
	for (const [name, list] of Object.entries(geometry.morphAttributes ?? {}))
		if (Array.isArray(list) && list.length) dropped.push(`morph:${name}`);
	const index = geometry.index ? plainAttribute(geometry.index).array : null;
	return {
		arrays: {
			positions: plainAttribute(position).array,
			index,
			attributes,
			groups: geometry.groups?.length ? geometry.groups : null,
			faces: storedPartition(geometry)
		},
		dropped
	};
}

/**
 * BufferGeometry -> kernel. `report` says what the import did: n-gons made from the stored
 * partition, faces that fell back to triangles (a seam or a hole inside a stored face),
 * degenerate triangles kept for output, and anything dropped.
 * @param {any} geometry @param {import('./arrays.js').ImportOptions} [options]
 */
export function fromBufferGeometry(geometry, options = {}) {
	const { arrays, dropped } = geometryArrays(geometry);
	const { mesh, report } = fromArrays(arrays, options);
	return { mesh, report: { ...report, dropped } };
}
