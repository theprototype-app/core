// Roadmap 99 K1: kernel <-> the EXISTING wire shapes, with no new message and no new format.
//
// - The CSR face packing (`meshTopology.packFaces` / `unpackFaces`: `faceCounts` + `faceTris` as
//   Int32 raw bytes) IS the kernel's face list, expressed over output triangles.
// - The `meshgeo` snapshot (positions + groups + uvs + colors + faceCounts + faceTris, what
//   broadcastMeshGeo sends and applyMeshGeo applies) round-trips through `toMeshGeo` /
//   `fromMeshGeo`, so a K2 commit service can speak today's protocol unchanged.
// - Optional ID channels (`ids`): the vertex ID per output corner and the face ID per output
//   triangle, as Int32 raw bytes. With them a receiver rebuilds the SAME vertex and face IDs
//   (no welding), which is what selection-as-IDs across peers needs. Absent = an ordinary
//   meshgeo, and the receiver numbers its own.

import { packFaces, unpackFaces, facesValidFor } from '../meshTopology.js';
import { fromArrays, toArrays } from './arrays.js';

/** @param {any} data @returns {Int32Array|null} */
function ints(data) {
	if (data == null) return null;
	if (data instanceof ArrayBuffer) return new Int32Array(data);
	if (ArrayBuffer.isView(data)) {
		const view = /** @type {any} */ (data);
		return new Int32Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
	}
	return Array.isArray(data) ? Int32Array.from(data) : null;
}
/** @param {any} data @returns {ArrayLike<number>|null} */
function floats(data) {
	if (data == null) return null;
	if (data instanceof ArrayBuffer) return new Float32Array(data);
	if (ArrayBuffer.isView(data)) {
		const view = /** @type {any} */ (data);
		if (view instanceof Float32Array || view instanceof Float64Array) return view;
		return new Float32Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
	}
	return Array.isArray(data) ? data : null;
}

/** The kernel's faces as the CSR wire fields, over its output triangles.
 * @param {import('./kernel.js').MeshKernel} mesh */
export function kernelToFaceWire(mesh) {
	return packFaces(toArrays(mesh).faces);
}

/** The CSR wire fields as a partition, or null when they do not describe `triCount` triangles.
 * @param {any} faceCounts @param {any} faceTris @param {number} triCount @returns {number[][]|null} */
export function faceWireToPartition(faceCounts, faceTris, triCount) {
	if (faceCounts == null || faceTris == null) return null;
	const faces = unpackFaces(faceCounts, faceTris);
	return facesValidFor(faces, triCount) ? faces : null;
}

/**
 * The kernel as a `meshgeo` payload: the same fields, the same null-when-trivial rules as
 * faceEdit (`groups` null without materials, `uvs` null without a uv attribute, `colors` null
 * without colour), plus `ids` when asked.
 * @param {import('./kernel.js').MeshKernel} mesh @param {{ ids?: boolean }} [options]
 */
export function toMeshGeo(mesh, options = {}) {
	const out = toArrays(mesh);
	const packed = out.faces.some((face) => face.length > 1) ? packFaces(out.faces) : null;
	/** @type {any} */
	const msg = {
		positions: out.positions,
		groups: out.groups && out.groups.some((g) => (g.materialIndex ?? 0) > 0) ? out.groups : null,
		uvs: out.attributes.uv?.array ?? null,
		colors: out.attributes.color?.itemSize === 3 ? out.attributes.color.array : null,
		...(packed ?? {})
	};
	if (options.ids) msg.ids = { cornerVertex: out.cornerVertex.buffer, triFace: out.triFace.buffer };
	return msg;
}

/**
 * A `meshgeo` payload as a kernel. With `ids` the vertex / face IDs are the sender's; without,
 * corners weld by exact position (`weld` to change that) and faces come from the CSR partition.
 * @param {{ positions: any, groups?: any, uvs?: any, colors?: any, faceCounts?: any, faceTris?: any, ids?: { cornerVertex?: any, triFace?: any } }} msg
 * @param {import('./arrays.js').ImportOptions} [options]
 */
export function fromMeshGeo(msg, options = {}) {
	const positions = floats(msg.positions) ?? [];
	const triCount = Math.floor(positions.length / 9);
	/** @type {Record<string, { array: ArrayLike<number>, itemSize: number }>} */
	const attributes = {};
	const uvs = floats(msg.uvs);
	if (uvs && uvs.length === triCount * 6) attributes.uv = { array: uvs, itemSize: 2 };
	const colors = floats(msg.colors);
	if (colors && colors.length === triCount * 9) attributes.color = { array: colors, itemSize: 3 };
	return fromArrays(
		{
			positions,
			attributes,
			groups: Array.isArray(msg.groups) ? msg.groups : null,
			faces: faceWireToPartition(msg.faceCounts, msg.faceTris, triCount),
			cornerVertex: ints(msg.ids?.cornerVertex),
			triFace: ints(msg.ids?.triFace)
		},
		options
	);
}
