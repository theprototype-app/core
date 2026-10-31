// 57 M1: the GLB container for `.tpanim`, by hand. A LEAF (no three, no DOM) so the format is
// unit-tested in node and WRITES THE SAME BYTES on every machine — GLTFExporter needs a FileReader
// and a scene graph, and orders its output by what it walked.
//
// Scope is exactly what a clip file holds: one binary buffer of float accessors (animation
// inputs/outputs). The reader is wider, because any glTF tool may have written the file it is
// handed (a .vrma from VRoid, a Blender .glb): interleaved views, normalized integer rotations,
// and sparse accessors are read; images and meshes are ignored.

const MAGIC = 0x46546c67; // 'glTF'
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

/** @type {Record<string, number>} */
export const COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

/**
 * Builds the binary chunk + its bufferViews/accessors while a writer adds arrays.
 * Identical arrays (a shared key-time row) are stored ONCE.
 */
export class GlbBuilder {
	constructor() {
		/** @type {Uint8Array[]} */
		this.parts = [];
		this.length = 0;
		/** @type {any[]} */
		this.bufferViews = [];
		/** @type {any[]} */
		this.accessors = [];
		/** @type {Map<string, number>} */
		this.dedupe = new Map();
	}

	/**
	 * Add a float accessor; returns its index.
	 * @param {Float32Array | number[]} data @param {'SCALAR'|'VEC3'|'VEC4'} type @param {boolean} [minMax]
	 */
	addFloats(data, type, minMax = false) {
		const arr = data instanceof Float32Array ? data : Float32Array.from(data);
		const key = type + ':' + minMax + ':' + fingerprint(arr);
		const hit = this.dedupe.get(key);
		if (hit !== undefined && sameFloats(this.accessorData(hit), arr)) return hit;
		const bytes = new Uint8Array(arr.buffer.slice(arr.byteOffset, arr.byteOffset + arr.byteLength));
		const view = this.bufferViews.length;
		this.bufferViews.push({ buffer: 0, byteOffset: this.length, byteLength: bytes.byteLength });
		this.parts.push(bytes);
		this.length += bytes.byteLength;
		const pad = (4 - (this.length % 4)) % 4;
		if (pad) {
			this.parts.push(new Uint8Array(pad));
			this.length += pad;
		}
		const n = COMPONENTS[type];
		/** @type {any} */
		const acc = { bufferView: view, componentType: 5126, count: arr.length / n, type };
		if (minMax) {
			const min = new Array(n).fill(Infinity);
			const max = new Array(n).fill(-Infinity);
			for (let i = 0; i < arr.length; i++) {
				const c = i % n;
				if (arr[i] < min[c]) min[c] = arr[i];
				if (arr[i] > max[c]) max[c] = arr[i];
			}
			acc.min = min.map(fround);
			acc.max = max.map(fround);
		}
		const index = this.accessors.length;
		this.accessors.push(acc);
		/** @type {any} */ (acc).__data = arr;
		this.dedupe.set(key, index);
		return index;
	}

	/** @param {number} index @returns {Float32Array} */
	accessorData(index) {
		return /** @type {any} */ (this.accessors[index]).__data;
	}

	/**
	 * The finished GLB. `json` gets buffers/bufferViews/accessors filled in.
	 * @param {any} json @returns {ArrayBuffer}
	 */
	finish(json) {
		const out = { ...json };
		if (this.length) {
			out.buffers = [{ byteLength: this.length }];
			out.bufferViews = this.bufferViews;
			out.accessors = this.accessors.map((a) => {
				const { __data, ...rest } = /** @type {any} */ (a);
				return rest;
			});
		}
		return packGlb(out, this.length ? concat(this.parts, this.length) : null);
	}
}

/** @param {number} v */
function fround(v) {
	return Math.fround(v);
}

/** a cheap content key; collisions are settled by sameFloats @param {Float32Array} a */
function fingerprint(a) {
	let h = 2166136261 >>> 0;
	const u = new Uint32Array(a.buffer, a.byteOffset, a.length);
	for (let i = 0; i < u.length; i++) {
		h ^= u[i];
		h = Math.imul(h, 16777619) >>> 0;
	}
	return a.length + '-' + h.toString(16);
}

/** @param {Float32Array} a @param {Float32Array} b */
function sameFloats(a, b) {
	if (!a || a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i] && !(Number.isNaN(a[i]) && Number.isNaN(b[i]))) return false;
	return true;
}

/** @param {Uint8Array[]} parts @param {number} length */
function concat(parts, length) {
	const out = new Uint8Array(length);
	let o = 0;
	for (const p of parts) {
		out.set(p, o);
		o += p.byteLength;
	}
	return out;
}

/**
 * JSON + optional BIN -> a GLB (both chunks 4-byte aligned: JSON padded with spaces, BIN with 0).
 * @param {any} json @param {Uint8Array | null} bin @returns {ArrayBuffer}
 */
export function packGlb(json, bin) {
	const text = new TextEncoder().encode(JSON.stringify(json));
	const jsonLen = Math.ceil(text.byteLength / 4) * 4;
	const binLen = bin ? Math.ceil(bin.byteLength / 4) * 4 : 0;
	const total = 12 + 8 + jsonLen + (bin ? 8 + binLen : 0);
	const buf = new ArrayBuffer(total);
	const dv = new DataView(buf);
	const u8 = new Uint8Array(buf);
	dv.setUint32(0, MAGIC, true);
	dv.setUint32(4, 2, true);
	dv.setUint32(8, total, true);
	dv.setUint32(12, jsonLen, true);
	dv.setUint32(16, CHUNK_JSON, true);
	u8.set(text, 20);
	for (let i = 20 + text.byteLength; i < 20 + jsonLen; i++) u8[i] = 0x20;
	if (bin) {
		const o = 20 + jsonLen;
		dv.setUint32(o, binLen, true);
		dv.setUint32(o + 4, CHUNK_BIN, true);
		u8.set(bin, o + 8);
	}
	return buf;
}

/** @param {ArrayBuffer | Uint8Array} bytes */
export function isGlb(bytes) {
	const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	return u8.byteLength >= 12 && new DataView(u8.buffer, u8.byteOffset, u8.byteLength).getUint32(0, true) === MAGIC;
}

/**
 * GLB -> {json, bin}. Throws on anything that is not a version-2 GLB.
 * @param {ArrayBuffer | Uint8Array} bytes @returns {{json: any, bin: Uint8Array | null}}
 */
export function unpackGlb(bytes) {
	const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
	if (u8.byteLength < 20 || dv.getUint32(0, true) !== MAGIC) throw new Error('not a GLB file');
	if (dv.getUint32(4, true) !== 2) throw new Error('unsupported glTF version ' + dv.getUint32(4, true));
	const total = Math.min(dv.getUint32(8, true), u8.byteLength);
	let o = 12;
	/** @type {any} */
	let json = null;
	/** @type {Uint8Array | null} */
	let bin = null;
	while (o + 8 <= total) {
		const len = dv.getUint32(o, true);
		const type = dv.getUint32(o + 4, true);
		const body = u8.subarray(o + 8, o + 8 + len);
		if (type === CHUNK_JSON) json = JSON.parse(new TextDecoder().decode(body));
		else if (type === CHUNK_BIN && !bin) bin = body;
		o += 8 + len;
	}
	if (!json) throw new Error('GLB has no JSON chunk');
	return { json, bin };
}

const COMPONENT_READ = {
	5120: { size: 1, get: (/** @type {DataView} */ d, /** @type {number} */ o) => d.getInt8(o), norm: (/** @type {number} */ v) => Math.max(v / 127, -1) },
	5121: { size: 1, get: (/** @type {DataView} */ d, /** @type {number} */ o) => d.getUint8(o), norm: (/** @type {number} */ v) => v / 255 },
	5122: { size: 2, get: (/** @type {DataView} */ d, /** @type {number} */ o) => d.getInt16(o, true), norm: (/** @type {number} */ v) => Math.max(v / 32767, -1) },
	5123: { size: 2, get: (/** @type {DataView} */ d, /** @type {number} */ o) => d.getUint16(o, true), norm: (/** @type {number} */ v) => v / 65535 },
	5125: { size: 4, get: (/** @type {DataView} */ d, /** @type {number} */ o) => d.getUint32(o, true), norm: (/** @type {number} */ v) => v },
	5126: { size: 4, get: (/** @type {DataView} */ d, /** @type {number} */ o) => d.getFloat32(o, true), norm: (/** @type {number} */ v) => v }
};

/**
 * One accessor as floats (normalized integers dequantized, sparse substitutions applied).
 * @param {any} json @param {Uint8Array | null} bin @param {number} index @returns {Float32Array}
 */
export function readAccessor(json, bin, index) {
	const acc = json.accessors?.[index];
	if (!acc) throw new Error('missing accessor ' + index);
	const n = COMPONENTS[acc.type];
	const comp = /** @type {any} */ (COMPONENT_READ)[acc.componentType];
	if (!n || !comp) throw new Error('unsupported accessor ' + acc.type + '/' + acc.componentType);
	const out = new Float32Array(acc.count * n);
	if (acc.bufferView !== undefined) {
		const view = json.bufferViews?.[acc.bufferView];
		if (!view || !bin) throw new Error('accessor ' + index + ' has no data');
		if ((view.buffer ?? 0) !== 0) throw new Error('external buffers are not supported');
		const stride = view.byteStride || n * comp.size;
		const base = (view.byteOffset ?? 0) + (acc.byteOffset ?? 0);
		const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
		for (let i = 0; i < acc.count; i++)
			for (let c = 0; c < n; c++) {
				const raw = comp.get(dv, base + i * stride + c * comp.size);
				out[i * n + c] = acc.normalized ? comp.norm(raw) : raw;
			}
	}
	if (acc.sparse && bin) {
		const sp = acc.sparse;
		const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
		const iv = json.bufferViews[sp.indices.bufferView];
		const vv = json.bufferViews[sp.values.bufferView];
		const ic = /** @type {any} */ (COMPONENT_READ)[sp.indices.componentType];
		const ib = (iv.byteOffset ?? 0) + (sp.indices.byteOffset ?? 0);
		const vb = (vv.byteOffset ?? 0) + (sp.values.byteOffset ?? 0);
		for (let k = 0; k < sp.count; k++) {
			const at = ic.get(dv, ib + k * ic.size);
			for (let c = 0; c < n; c++) {
				const raw = comp.get(dv, vb + (k * n + c) * comp.size);
				out[at * n + c] = acc.normalized ? comp.norm(raw) : raw;
			}
		}
	}
	return out;
}
