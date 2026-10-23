// 59 T1/T2/T7 — small, lossless edits to a GLB's own bytes. A LEAF: no three, no stores (the
// container itself is gltfOptimize/glbPost's reader/writer).
//
// An animated import replicates, saves and undoes as its ORIGINAL file bytes (golden rule 6), so
// anything a replace or an "Edit in Blender" round trip has to add to such a model must go INTO
// the bytes — a field beside them would be one more thing every save format, the wire, the undo
// entry and the late-joiner reply had to learn to carry. Three edits, each a JSON-chunk rewrite
// plus (for clips) an append to the BIN chunk; nothing that is already in the file is re-encoded:
//   · `extras.theprototype = {uuid, name}` on the scene and its root nodes (T7b: a re-exported
//     file dropped anywhere finds its object again — Blender keeps both as Custom Properties);
//   · a transform premultiplied onto the scene's root nodes (T7c: the 100× / Z-up fixes);
//   · animations appended (T1/F2: a clip the old model had, kept on the new one by bone name).

import { asBytes, isGlb, unpackGlb, packGlb } from './gltfOptimize/glbPost.js';

const FLOAT = 5126;

export { isGlb };

/** GLB in, `{json, bin}` out — glbPost's reader, refusing anything that is not a GLB
 * @param {ArrayBuffer | ArrayBufferView} input */
function readGlb(input) {
	if (!isGlb(input)) throw new Error('not a GLB');
	return unpackGlb(input);
}

/** @param {any} json @param {Uint8Array | null} bin @returns {ArrayBuffer} */
function writeGlb(json, bin) {
	return /** @type {ArrayBuffer} */ (packGlb(json, bin).buffer);
}

/** the scene a loader shows (glTF's `scene`, else the first) @param {any} json */
function sceneOf(json) {
	const scenes = Array.isArray(json?.scenes) ? json.scenes : [];
	return scenes[Number.isInteger(json?.scene) ? json.scene : 0] ?? null;
}

/** @param {any} value @returns {{uuid: string, name: string} | null} */
function tpStamp(value) {
	const tp = value?.extras?.theprototype;
	return tp && typeof tp.uuid === 'string' && tp.uuid ? { uuid: tp.uuid, name: typeof tp.name === 'string' ? tp.name : '' } : null;
}

/**
 * T7b: the object a file was exported FROM — `extras.theprototype` on the scene, else on one of
 * its root nodes (an exporter that drops scene extras usually keeps the node's). Reads a GLB or
 * a .gltf JSON text; null for anything else or no stamp. Never throws.
 * @param {ArrayBuffer | ArrayBufferView} input @returns {{uuid: string, name: string} | null}
 */
export function readTpExtras(input) {
	try {
		const u8 = asBytes(input);
		/** @type {any} */
		let json;
		if (isGlb(u8)) json = readGlb(u8).json;
		else {
			// a .gltf is JSON text — only look when it plainly starts like one
			const head = new TextDecoder().decode(u8.subarray(0, Math.min(64, u8.byteLength))).trimStart();
			if (!head.startsWith('{')) return null;
			json = JSON.parse(new TextDecoder().decode(u8));
		}
		const scene = sceneOf(json);
		const fromScene = tpStamp(scene);
		if (fromScene) return fromScene;
		for (const index of scene?.nodes ?? []) {
			const hit = tpStamp(json.nodes?.[index]);
			if (hit) return hit;
		}
		return null;
	} catch {
		return null;
	}
}

/**
 * T7b: stamp `extras.theprototype = {uuid, name}` on the scene and on every scene root node.
 * Other extras on those are kept. GLB in, GLB out; the BIN chunk is untouched.
 * @param {ArrayBuffer | ArrayBufferView} input @param {{uuid: string, name?: string}} stamp
 * @returns {ArrayBuffer}
 */
export function stampTpExtras(input, stamp) {
	const { json, bin } = readGlb(input);
	const value = { uuid: String(stamp.uuid), name: String(stamp.name ?? '') };
	if (!Array.isArray(json.scenes) || !json.scenes.length) json.scenes = [{ nodes: [] }];
	const scene = sceneOf(json) ?? json.scenes[0];
	scene.extras = { ...(scene.extras ?? {}), theprototype: value };
	for (const index of scene.nodes ?? []) {
		const node = json.nodes?.[index];
		if (node) node.extras = { ...(node.extras ?? {}), theprototype: value };
	}
	return writeGlb(json, bin);
}

// ---- 4x4 column-major helpers (glTF's own layout), no three ---------------------------------

/** @param {number[]} a @param {number[]} b @returns {number[]} a·b */
function mul(a, b) {
	const out = new Array(16).fill(0);
	for (let c = 0; c < 4; c++)
		for (let r = 0; r < 4; r++) {
			let s = 0;
			for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
			out[c * 4 + r] = s;
		}
	return out;
}

/** compose T·R·S @param {number[]} t @param {number[]} q xyzw @param {number[]} s */
export function composeTRS(t, q, s) {
	const [x, y, z, w] = q;
	const x2 = x + x, y2 = y + y, z2 = z + z;
	const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2;
	const wx = w * x2, wy = w * y2, wz = w * z2;
	return [
		(1 - (yy + zz)) * s[0], (xy + wz) * s[0], (xz - wy) * s[0], 0,
		(xy - wz) * s[1], (1 - (xx + zz)) * s[1], (yz + wx) * s[1], 0,
		(xz + wy) * s[2], (yz - wx) * s[2], (1 - (xx + yy)) * s[2], 0,
		t[0], t[1], t[2], 1
	];
}

/**
 * Decompose an affine matrix with no shear into T, R (xyzw) and S — what a uniform scale and a
 * rotation premultiplied onto a TRS node always give back.
 * @param {number[]} m @returns {{t: number[], q: number[], s: number[]}}
 */
export function decomposeTRS(m) {
	let sx = Math.hypot(m[0], m[1], m[2]);
	const sy = Math.hypot(m[4], m[5], m[6]);
	const sz = Math.hypot(m[8], m[9], m[10]);
	// a mirrored basis keeps its handedness in the scale, like three's decompose
	const det =
		m[0] * (m[5] * m[10] - m[6] * m[9]) - m[4] * (m[1] * m[10] - m[2] * m[9]) + m[8] * (m[1] * m[6] - m[2] * m[5]);
	if (det < 0) sx = -sx;
	const r00 = m[0] / sx, r10 = m[1] / sx, r20 = m[2] / sx;
	const r01 = m[4] / sy, r11 = m[5] / sy, r21 = m[6] / sy;
	const r02 = m[8] / sz, r12 = m[9] / sz, r22 = m[10] / sz;
	const trace = r00 + r11 + r22;
	/** @type {number[]} */
	let q;
	if (trace > 0) {
		const s = 0.5 / Math.sqrt(trace + 1);
		q = [(r21 - r12) * s, (r02 - r20) * s, (r10 - r01) * s, 0.25 / s];
	} else if (r00 > r11 && r00 > r22) {
		const s = 2 * Math.sqrt(1 + r00 - r11 - r22);
		q = [0.25 * s, (r01 + r10) / s, (r02 + r20) / s, (r21 - r12) / s];
	} else if (r11 > r22) {
		const s = 2 * Math.sqrt(1 + r11 - r00 - r22);
		q = [(r01 + r10) / s, 0.25 * s, (r12 + r21) / s, (r02 - r20) / s];
	} else {
		const s = 2 * Math.sqrt(1 + r22 - r00 - r11);
		q = [(r02 + r20) / s, (r12 + r21) / s, 0.25 * s, (r10 - r01) / s];
	}
	const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
	return { t: [m[12], m[13], m[14]], q: q.map((v) => v / n), s: [sx, sy, sz] };
}

/** a node's local matrix, whichever way it was written @param {any} node */
function nodeMatrix(node) {
	if (Array.isArray(node.matrix) && node.matrix.length === 16) return node.matrix.slice();
	return composeTRS(node.translation ?? [0, 0, 0], node.rotation ?? [0, 0, 0, 1], node.scale ?? [1, 1, 1]);
}

/**
 * T7c: premultiply `matrix` (column-major, 16 numbers) onto every scene ROOT node, so the whole
 * model turns/scales about the file's origin. A node written as TRS stays TRS (the fixes are a
 * uniform scale and a rotation, so no shear appears); a `matrix` node stays a matrix.
 * @param {ArrayBuffer | ArrayBufferView} input @param {number[]} matrix @returns {ArrayBuffer}
 */
export function transformRootNodes(input, matrix) {
	const { json, bin } = readGlb(input);
	const scene = sceneOf(json);
	for (const index of scene?.nodes ?? []) {
		const node = json.nodes?.[index];
		if (!node) continue;
		const m = mul(matrix, nodeMatrix(node));
		if (Array.isArray(node.matrix)) node.matrix = m;
		else {
			const { t, q, s } = decomposeTRS(m);
			node.translation = t;
			node.rotation = q;
			node.scale = s;
		}
	}
	return writeGlb(json, bin);
}

/**
 * @typedef {{node: number, path: 'translation'|'rotation'|'scale'|'weights', interpolation: 'LINEAR'|'STEP'|'CUBICSPLINE',
 *   times: Float32Array, values: Float32Array}} GlbChannel
 * @typedef {{name: string, channels: GlbChannel[]}} GlbAnimation
 */

const COMPONENTS = { translation: 'VEC3', scale: 'VEC3', rotation: 'VEC4', weights: 'SCALAR' };

/**
 * T1/F2: append animations to a GLB. Each channel's keyframes go to the end of the BIN chunk as
 * two float accessors (input SCALAR with the min/max the spec requires, output VEC3/VEC4/SCALAR).
 * A file whose first buffer is an external/data URI gets a GLB buffer inserted in front (every
 * bufferView index moved up by one), since only `buffers[0]` may be the BIN chunk.
 * @param {ArrayBuffer | ArrayBufferView} input @param {GlbAnimation[]} animations
 * @returns {ArrayBuffer}
 */
export function appendAnimations(input, animations) {
	const { json, bin } = readGlb(input);
	const list = (animations ?? []).filter((a) => a?.channels?.length);
	if (!list.length) return writeGlb(json, bin);
	json.buffers = Array.isArray(json.buffers) ? json.buffers : [];
	if (json.buffers.length && json.buffers[0].uri !== undefined) {
		json.buffers.unshift({ byteLength: 0 });
		for (const view of json.bufferViews ?? []) view.buffer = (view.buffer ?? 0) + 1;
	}
	if (!json.buffers.length) json.buffers.push({ byteLength: 0 });
	json.bufferViews = Array.isArray(json.bufferViews) ? json.bufferViews : [];
	json.accessors = Array.isArray(json.accessors) ? json.accessors : [];
	json.animations = Array.isArray(json.animations) ? json.animations : [];
	/** @type {Uint8Array[]} */
	const parts = [];
	let length = bin ? bin.byteLength : 0;
	if (bin) parts.push(bin);
	/** @param {Float32Array} data @returns {number} the bufferView index */
	const addView = (data) => {
		const pad = (4 - (length % 4)) % 4;
		if (pad) {
			parts.push(new Uint8Array(pad));
			length += pad;
		}
		const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();
		json.bufferViews.push({ buffer: 0, byteOffset: length, byteLength: bytes.byteLength });
		parts.push(bytes);
		length += bytes.byteLength;
		return json.bufferViews.length - 1;
	};
	for (const animation of list) {
		/** @type {any[]} */
		const samplers = [];
		/** @type {any[]} */
		const channels = [];
		for (const channel of animation.channels) {
			const times = channel.times;
			if (!times?.length) continue;
			let min = Infinity;
			let max = -Infinity;
			for (const t of times) {
				if (t < min) min = t;
				if (t > max) max = t;
			}
			json.accessors.push({ bufferView: addView(times), componentType: FLOAT, count: times.length, type: 'SCALAR', min: [min], max: [max] });
			const inputIndex = json.accessors.length - 1;
			const type = COMPONENTS[channel.path];
			const width = type === 'VEC4' ? 4 : type === 'VEC3' ? 3 : 1;
			json.accessors.push({ bufferView: addView(channel.values), componentType: FLOAT, count: Math.floor(channel.values.length / width), type });
			samplers.push({ input: inputIndex, output: json.accessors.length - 1, interpolation: channel.interpolation });
			channels.push({ sampler: samplers.length - 1, target: { node: channel.node, path: channel.path } });
		}
		if (channels.length) json.animations.push({ name: animation.name, samplers, channels });
	}
	const merged = new Uint8Array(length);
	let at = 0;
	for (const part of parts) {
		merged.set(part, at);
		at += part.byteLength;
	}
	json.buffers[0].byteLength = length;
	return writeGlb(json, merged);
}
