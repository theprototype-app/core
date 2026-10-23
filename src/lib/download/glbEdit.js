// 57 M9 / M6 — EDIT A GLB WITHOUT RE-EXPORTING IT. A rig's bytes are the truth (CLAUDE.md rule 6:
// three's GLTFExporter is lossy on rigs, and it drops a VRM's extensions), so a download that adds
// clips, strips clips or rewrites skin weights edits the file's own JSON + BIN chunks: everything
// not touched stays byte-for-byte what the user imported (materials, extensions, extras, names).
//
// A LEAF (imports nothing; unit-tested in node).

const MAGIC = 0x46546c67; // 'glTF'
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;

/** is this a binary glTF? @param {ArrayBuffer | Uint8Array} bytes */
export function isGlb(bytes) {
	const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	return (
		u.byteLength >= 20 &&
		new DataView(u.buffer, u.byteOffset, u.byteLength).getUint32(0, true) === MAGIC
	);
}

/**
 * @typedef {{json: any, bin: Uint8Array}} GlbDoc `bin` grows as accessors are appended
 */

/** @param {ArrayBuffer | Uint8Array} bytes @returns {GlbDoc} */
export function readGlb(bytes) {
	const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	const dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
	if (dv.getUint32(0, true) !== MAGIC) throw new Error('not a GLB');
	let at = 12;
	/** @type {any} */
	let json = null;
	let bin = new Uint8Array(0);
	while (at + 8 <= u.byteLength) {
		const len = dv.getUint32(at, true);
		const type = dv.getUint32(at + 4, true);
		const body = u.subarray(at + 8, at + 8 + len);
		if (type === JSON_CHUNK) json = JSON.parse(new TextDecoder().decode(body));
		else if (type === BIN_CHUNK) bin = body.slice();
		at += 8 + len;
	}
	if (!json) throw new Error('GLB has no JSON chunk');
	return { json, bin };
}

/** @param {GlbDoc} doc @returns {Uint8Array} */
export function writeGlb(doc) {
	const json = doc.json;
	if (doc.bin.byteLength) {
		json.buffers = json.buffers?.length ? json.buffers : [{}];
		json.buffers[0] = { ...json.buffers[0], byteLength: doc.bin.byteLength };
		delete json.buffers[0].uri;
	}
	let j = new TextEncoder().encode(JSON.stringify(json));
	const jpad = (4 - (j.byteLength % 4)) % 4;
	const bpad = (4 - (doc.bin.byteLength % 4)) % 4;
	const binLen = doc.bin.byteLength ? doc.bin.byteLength + bpad : 0;
	const total = 12 + 8 + j.byteLength + jpad + (binLen ? 8 + binLen : 0);
	const out = new Uint8Array(total);
	const dv = new DataView(out.buffer);
	dv.setUint32(0, MAGIC, true);
	dv.setUint32(4, 2, true);
	dv.setUint32(8, total, true);
	dv.setUint32(12, j.byteLength + jpad, true);
	dv.setUint32(16, JSON_CHUNK, true);
	out.set(j, 20);
	out.fill(0x20, 20 + j.byteLength, 20 + j.byteLength + jpad);
	if (binLen) {
		const at = 20 + j.byteLength + jpad;
		dv.setUint32(at, binLen, true);
		dv.setUint32(at + 4, BIN_CHUNK, true);
		out.set(doc.bin, at + 8);
	}
	return out;
}

const COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

/**
 * Append a float accessor (its own bufferView in the BIN chunk, 4-byte aligned).
 * @param {GlbDoc} doc @param {Float32Array} data @param {'SCALAR'|'VEC2'|'VEC3'|'VEC4'|'MAT4'} type
 * @param {{minmax?: boolean}} [opts] `minmax` (required for animation input times) @returns {number}
 */
export function appendFloatAccessor(doc, data, type, opts = {}) {
	const json = doc.json;
	const pad = (4 - (doc.bin.byteLength % 4)) % 4;
	const offset = doc.bin.byteLength + pad;
	const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
	const next = new Uint8Array(offset + bytes.byteLength);
	next.set(doc.bin, 0);
	next.set(bytes, offset);
	doc.bin = next;
	json.buffers = json.buffers?.length ? json.buffers : [{ byteLength: 0 }];
	json.bufferViews = json.bufferViews ?? [];
	json.accessors = json.accessors ?? [];
	json.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.byteLength });
	const n = COMPONENTS[type];
	/** @type {any} */
	const acc = {
		bufferView: json.bufferViews.length - 1,
		componentType: 5126,
		count: data.length / n,
		type
	};
	if (opts.minmax) {
		const min = new Array(n).fill(Infinity);
		const max = new Array(n).fill(-Infinity);
		for (let i = 0; i < data.length; i++) {
			const c = i % n;
			if (data[i] < min[c]) min[c] = data[i];
			if (data[i] > max[c]) max[c] = data[i];
		}
		acc.min = min;
		acc.max = max;
	}
	json.accessors.push(acc);
	return json.accessors.length - 1;
}

/** three's PropertyBinding.sanitizeNodeName, so a GLB node name matches the name three gave it @param {string} n */
export function sanitizeNodeName(n) {
	return String(n ?? '')
		.replace(/\s/g, '_')
		.replace(/[\[\]\.:\/]/g, '');
}

/**
 * A map from the node names three uses (sanitized) to node indices. GLTFLoader also suffixes a
 * duplicate name (`name_1`), which this mirrors.
 * @param {any} json @returns {Map<string, number>}
 */
export function nodeIndexByName(json) {
	/** @type {Map<string, number>} */
	const out = new Map();
	/** @type {Map<string, number>} */
	const used = new Map();
	(json.nodes ?? []).forEach((/** @type {any} */ n, /** @type {number} */ i) => {
		const base = sanitizeNodeName(n.name ?? '');
		if (!base) return;
		const k = used.get(base) ?? 0;
		used.set(base, k + 1);
		const name = k ? base + '_' + k : base;
		if (!out.has(name)) out.set(name, i);
		if (!out.has(n.name)) out.set(n.name, i);
	});
	return out;
}

/**
 * @typedef {{node: string, path: 'rotation'|'translation'|'scale', times: Float32Array, values: Float32Array, step?: boolean}} ClipChannel
 * @typedef {{name: string, channels: ClipChannel[], extras?: any}} PlainClip
 */

/**
 * Append clips as glTF animations; channels naming a node the file does not have are dropped
 * (and counted).
 * @param {GlbDoc} doc @param {PlainClip[]} clips @returns {{added: number, dropped: number}}
 */
export function appendAnimations(doc, clips) {
	const json = doc.json;
	const byName = nodeIndexByName(json);
	json.animations = json.animations ?? [];
	let dropped = 0;
	let added = 0;
	for (const clip of clips) {
		/** @type {any[]} */
		const samplers = [];
		/** @type {any[]} */
		const channels = [];
		for (const ch of clip.channels) {
			const node = byName.get(ch.node) ?? byName.get(sanitizeNodeName(ch.node));
			if (node === undefined || !ch.times.length) {
				dropped++;
				continue;
			}
			const input = appendFloatAccessor(doc, ch.times, 'SCALAR', { minmax: true });
			const output = appendFloatAccessor(doc, ch.values, ch.path === 'rotation' ? 'VEC4' : 'VEC3');
			samplers.push({ input, output, interpolation: ch.step ? 'STEP' : 'LINEAR' });
			channels.push({ sampler: samplers.length - 1, target: { node, path: ch.path } });
		}
		if (!channels.length) continue;
		/** @type {any} */
		const anim = { name: clip.name, samplers, channels };
		if (clip.extras) anim.extras = clip.extras;
		json.animations.push(anim);
		added++;
	}
	return { added, dropped };
}

/**
 * Keep only the named embedded animations (`keep` = null removes none, [] removes all). The
 * accessors they used stay in the BIN (unreferenced) — the file stays valid, the rest untouched.
 * @param {GlbDoc} doc @param {string[] | null} keep @returns {number} how many were removed
 */
export function keepAnimations(doc, keep) {
	const list = doc.json.animations ?? [];
	if (!keep) return 0;
	const set = new Set(keep);
	const next = list.filter((/** @type {any} */ a, /** @type {number} */ i) =>
		set.has(a.name ?? 'animation_' + i)
	);
	const removed = list.length - next.length;
	if (next.length) doc.json.animations = next;
	else delete doc.json.animations;
	return removed;
}

/** the names three gives the embedded animations (GLTFLoader: `name` or `animation_<i>`) @param {any} json */
export function animationNames(json) {
	return (json.animations ?? []).map(
		(/** @type {any} */ a, /** @type {number} */ i) => a.name ?? 'animation_' + i
	);
}
