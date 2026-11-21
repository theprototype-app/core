// Roadmap 99 K2: the ONE mesh commit shape and the ONE `meshgeo` sender.
//
// Every mesh edit ends the same way: snapshot -> apply -> broadcast -> record. The apply half
// needs faceEdit's live session (it owns the edited object and its overlays), so the function
// that runs the four steps is `commitMesh` in faceEdit.js. This module is its pure half:
//
// - `meshGeoMessage` / `sendMeshGeo`: the wire message. Byte-for-byte what the five senders
//   built by hand before K2 (faceEdit's broadcastMeshGeo, the meshgeo history replay,
//   uvEditor's broadcastUvGeo, terrainSculpt's index conversion and its stroke preview): raw
//   Float32 BYTES (binarypack recurses per element and blows the call stack on a big plain
//   array), optional fields only when present, the same key order. No new message, no new field.
// - `compactMeshState`: what history KEEPS for one side of a `meshgeo` entry. Typed arrays
//   (positions / uvs / colours Float32, the face partition packed as meshTopology's CSR Int32
//   pair, the kernel's optional ID channels Int32), so `meshBudget.entryBytes` counts the bytes
//   that are really held. Before K2 history kept plain number arrays: 8 bytes per number in V8,
//   counted as 4, so the 256 MB budget held about twice that.
// The kernel's side (`toMeshGeo` -> a commit state) is `meshCommitKernel.js`, kept apart so this
// module — imported by every editor — pulls no kernel code into their chunks.

import { get } from 'svelte/store';
import { peers } from '../stores/appStore';
import { packFaces } from './meshTopology.js';

/**
 * @typedef {{ faceCounts: ArrayBuffer, faceTris: ArrayBuffer }} FaceFields
 * @typedef {{ cornerVertex: ArrayBuffer | Int32Array, triFace: ArrayBuffer | Int32Array }} IdChannels
 * @typedef {{
 *   positions: ArrayLike<number>,
 *   groups?: any[] | null,
 *   uvs?: ArrayLike<number> | null,
 *   colors?: ArrayLike<number> | null,
 *   faces?: number[][] | null,
 *   faceCounts?: ArrayBuffer | ArrayBufferView,
 *   faceTris?: ArrayBuffer | ArrayBufferView,
 *   ids?: IdChannels
 * }} MeshState
 */

/**
 * The `meshgeo` wire message.
 * @param {string} uuid
 * @param {ArrayLike<number>} positions
 * @param {{ groups?: any[] | null, uvs?: ArrayLike<number> | null, colors?: ArrayLike<number> | null, faceFields?: Partial<FaceFields> | null }} [fields]
 *   `faceFields` = the CSR topology to send (absent = none); each sender decides where it comes from.
 */
export function meshGeoMessage(uuid, positions, fields = {}) {
	const { groups, uvs, colors, faceFields } = fields;
	return {
		type: 'meshgeo',
		uuid: uuid,
		positions: new Float32Array(/** @type {any} */ (positions)).buffer,
		// `groups` is a handful of small objects — safe as a plain value, and absent entirely
		// for the single-material case (an older peer simply ignores it)
		...(groups?.length ? { groups } : {}),
		...(uvs?.length ? { uvs: new Float32Array(/** @type {any} */ (uvs)).buffer } : {}),
		...(colors?.length ? { colors: new Float32Array(/** @type {any} */ (colors)).buffer } : {}),
		...(faceFields ?? {})
	};
}

/**
 * Send one `meshgeo` to every peer (a no-op offline). THE sender: nothing else builds the message.
 * @param {string} uuid @param {ArrayLike<number>} positions
 * @param {Parameters<typeof meshGeoMessage>[2]} [fields]
 * @returns {boolean} whether a peer connection took it
 */
export function sendMeshGeo(uuid, positions, fields) {
	/** @type {any} */
	const peer = get(peers);
	if (!peer) return false;
	peer.send(meshGeoMessage(uuid, positions, fields));
	return true;
}

/** @param {any} data @returns {Float32Array} */
function f32(data) {
	if (data instanceof Float32Array) return data;
	if (data instanceof ArrayBuffer) return new Float32Array(data);
	return Float32Array.from(/** @type {ArrayLike<number>} */ (data));
}
/** @param {any} data @returns {Int32Array} */
function i32(data) {
	if (data instanceof Int32Array) return data;
	if (data instanceof ArrayBuffer) return new Int32Array(data.slice(0));
	if (ArrayBuffer.isView(data)) {
		const view = /** @type {any} */ (data);
		return new Int32Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
	}
	return Int32Array.from(/** @type {ArrayLike<number>} */ (data));
}

/** The bytes of exactly this view (a view may sit inside a larger buffer).
 * @param {ArrayBufferView} view @returns {ArrayBuffer} */
function exactBuffer(view) {
	const buffer = /** @type {ArrayBuffer} */ (view.buffer);
	if (view.byteOffset === 0 && view.byteLength === buffer.byteLength) return buffer;
	return buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
}

/** @param {any} value */
function isNumbers(value) {
	return Array.isArray(value) || (ArrayBuffer.isView(value) && !(value instanceof DataView));
}

/**
 * One side of a `meshgeo` history entry as history keeps it. Values are unchanged (every apply
 * already goes through Float32: a Float32 copy of a double is the number that would have been
 * applied), so a replay applies and sends exactly what it did before K2.
 * - a bare positions array (sculpt strokes, vertex drags, VR grabs) stays bare, as Float32;
 * - an object keeps its fields; `faces` becomes the packed `faceCounts` + `faceTris` pair (the
 *   replay packs `faces` itself, so the bytes it sends are the same), an empty partition stays absent;
 * - `ids` (the kernel's vertex-per-corner / face-per-triangle channels) are kept as Int32.
 * Idempotent; null / non-geometry values pass through.
 * @param {any} state @returns {any}
 */
export function compactMeshState(state) {
	if (state == null || typeof state !== 'object') return state;
	if (isNumbers(state)) return f32(state);
	if (!isNumbers(state.positions)) return state;
	/** @type {any} */
	const out = { ...state, positions: f32(state.positions) };
	if (isNumbers(state.uvs)) out.uvs = f32(state.uvs);
	if (isNumbers(state.colors)) out.colors = f32(state.colors);
	if ('faces' in state) {
		delete out.faces;
		const packed = Array.isArray(state.faces) && state.faces.length ? packFaces(state.faces) : null;
		if (packed) {
			out.faceCounts = new Int32Array(packed.faceCounts);
			out.faceTris = new Int32Array(packed.faceTris);
		}
	} else if (state.faceCounts != null && state.faceTris != null) {
		out.faceCounts = i32(state.faceCounts);
		out.faceTris = i32(state.faceTris);
	}
	if (state.ids?.cornerVertex != null && state.ids?.triFace != null)
		out.ids = { cornerVertex: i32(state.ids.cornerVertex), triFace: i32(state.ids.triFace) };
	return out;
}

/**
 * The CSR topology a state carries, as the wire fields (`faces` packed, or the stored pair), or null.
 * @param {any} state @returns {FaceFields | null}
 */
export function stateFaceFields(state) {
	if (!state || typeof state !== 'object' || isNumbers(state)) return null;
	if (Array.isArray(state.faces)) return packFaces(state.faces);
	if (state.faceCounts != null && state.faceTris != null) {
		const counts = i32(state.faceCounts);
		if (!counts.length) return null;
		return { faceCounts: exactBuffer(counts), faceTris: exactBuffer(i32(state.faceTris)) };
	}
	return null;
}
