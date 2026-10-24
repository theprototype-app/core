// Roadmap 66 S4b — import_file's pure half (imports only the two pure 56 cores; the unit layer covers it).
//
// An agent on the user's own machine renders something with a local tool (Pixling, ImageMagick, a
// Blender --background script) and hands the FILE to the session. What may come in, decided from the
// BYTES, never the name: PNG, WebP (images), JSON (a spec, a sheet's frame data, any config) and
// `.tpanim` (57's clip file: a GLB whose root extras say `theprototype.kind = 'clip'`, or a VRM
// Animation). Anything else is refused with the reason and the tool to use instead.
//
// THE RULES, each one testable here:
//   · TYPE BY SNIFFING — a `.png` that is a JPEG is a JPEG (refused); a JSON is UTF-8 text that parses
//     to an object or array; a plain GLB is a model (import_model), not a clip
//   · CAPS — 16 MB per image, 2 MB per JSON (the spec rides beside the sheet), 25 MB per clip (the
//     Explorer's own import cap); a chunked upload is capped by the same numbers BEFORE it is assembled
//   · METADATA STRIPPED — images go through 56's `stripMetadata` (EXIF / XMP / text chunks), the
//     chat-image rule: a file someone else's machine made may carry where and who it was made by
//   · ROLE — editors and admins import; a viewer's agent is refused with the words to relay

import { sniffType, stripMetadata, metadataOf } from '../chat/attachCore.js';
import { inspectGlb, MAX_IMPORT_BYTES } from './importModelCore.js';

export const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
export const MAX_JSON_BYTES = 2 * 1024 * 1024;
export const MAX_CLIP_BYTES = MAX_IMPORT_BYTES;
/** the default Explorer folder an import lands in */
export const DEFAULT_FOLDER = 'Generated';
/** a placed card's texture: longest side and largest data URL kept as-is (it rides the wire, every save and
 * the undo snapshot, whose cap is 5 MB); a bigger image is downscaled for the card, the Explorer file stays whole */
export const CARD_TEXTURE_MAX = 2048;
export const CARD_TEXTURE_BYTES = 3 * 1024 * 1024;
/** chunked uploads: the most parts, and how long an unfinished one is kept (ms) */
export const MAX_CHUNKS = 64;
export const CHUNK_TTL_MS = 5 * 60 * 1000;

/** @type {Record<string, {mime: string, ext: string, max: number}>} */
const KINDS = {
	png: { mime: 'image/png', ext: '.png', max: MAX_IMAGE_BYTES },
	webp: { mime: 'image/webp', ext: '.webp', max: MAX_IMAGE_BYTES },
	json: { mime: 'application/json', ext: '.json', max: MAX_JSON_BYTES },
	tpanim: { mime: 'model/gltf-binary', ext: '.tpanim', max: MAX_CLIP_BYTES }
};

/** the biggest a file of ANY accepted kind may be (what a chunked upload is held to before it is sniffed) */
export const MAX_FILE_BYTES = Math.max(...Object.values(KINDS).map((k) => k.max));

const ACCEPTS = 'PNG, WebP, JSON or .tpanim';

/** @param {number} n */
const mb = (n) => (n / 1048576).toFixed(n < 1048576 ? 2 : 1) + ' MB';

/**
 * What the bytes ARE. `{kind, mime, ext, max}` for an accepted file, else `{error}` naming what it is
 * and what to do. The name plays no part.
 * @param {Uint8Array} b
 * @returns {{kind: string, mime: string, ext: string, max: number, json?: any} | {error: string}}
 */
export function sniffFile(b) {
	if (!b || !b.length) return { error: 'the file is empty' };
	const image = sniffType(b);
	if (image === 'image/png') return { kind: 'png', ...KINDS.png };
	if (image === 'image/webp') return { kind: 'webp', ...KINDS.webp };
	if (image) return { error: 'the file is ' + image.replace('image/', '').toUpperCase() + ' — import_file takes ' + ACCEPTS + ' (convert the image to PNG first)' };
	if (b.length >= 12 && b[0] === 0x67 && b[1] === 0x6c && b[2] === 0x54 && b[3] === 0x46) {
		const glb = inspectGlb(b);
		if (!glb.ok) return { error: String(glb.error) };
		if (isClipJson(glb.json)) return { kind: 'tpanim', ...KINDS.tpanim };
		return { error: 'the file is a GLB model, not a .tpanim clip — use import_model for models' };
	}
	const json = parseJsonBytes(b);
	if (json.ok) return { kind: 'json', ...KINDS.json, json: json.value };
	return { error: 'not a file import_file takes (' + ACCEPTS + ')' + (json.reason ? ': ' + json.reason : '') };
}

/** a glTF JSON chunk that is a clip: our `.tpanim` extras, or a VRM Animation @param {any} json */
function isClipJson(json) {
	const tp = json?.extras?.theprototype;
	if (tp && tp.kind === 'clip') return true;
	return Array.isArray(json?.extensionsUsed) && json.extensionsUsed.includes('VRMC_vrm_animation') && Array.isArray(json.animations) && json.animations.length > 0;
}

/**
 * UTF-8 bytes that parse to a JSON object or array (a bare number / string is not a file anyone means).
 * @param {Uint8Array} b @returns {{ok: true, value: any} | {ok: false, reason?: string}}
 */
export function parseJsonBytes(b) {
	let text;
	try {
		text = new TextDecoder('utf-8', { fatal: true }).decode(b);
	} catch {
		return { ok: false };
	}
	if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
	const first = text.trimStart()[0];
	if (first !== '{' && first !== '[') return { ok: false };
	try {
		return { ok: true, value: JSON.parse(text) };
	} catch (e) {
		return { ok: false, reason: 'it looks like JSON but does not parse (' + String(/** @type {any} */ (e)?.message ?? e).slice(0, 80) + ')' };
	}
}

/**
 * The size rule for a sniffed file. null = fine, else the refusal.
 * @param {{kind: string, max: number}} type @param {number} bytes
 */
export function sizeRefusal(type, bytes) {
	if (bytes <= type.max) return null;
	const what = type.kind === 'json' ? 'a JSON file' : type.kind === 'tpanim' ? 'a clip' : 'an image';
	return 'the file is ' + mb(bytes) + ' — the limit for ' + what + ' is ' + mb(type.max);
}

/**
 * The bytes as they may enter the session: images without their metadata, everything else as sent.
 * Also says what was removed (for the result, so the agent knows why the hash differs from its file).
 * @param {Uint8Array} b @param {{kind: string, mime: string}} type
 * @returns {{bytes: Uint8Array, stripped: string[]}}
 */
export function cleanBytes(b, type) {
	if (type.kind !== 'png' && type.kind !== 'webp') return { bytes: b, stripped: [] };
	const before = metadataOf(b);
	const out = stripMetadata(b, type.mime);
	const stripped = /** @type {string[]} */ ([]);
	// the strip only ever REMOVES chunks, so an unchanged length is an unchanged file: hand back the original
	if (out.length === b.length) return { bytes: b, stripped };
	{
		if (before.gps) stripped.push('gps');
		if (before.exif) stripped.push('exif');
		if (before.xmp) stripped.push('xmp');
		if (before.text) stripped.push('text');
		if (!stripped.length) stripped.push('metadata');
	}
	return { bytes: out, stripped };
}

/** @param {Uint8Array} b @param {number} i */
const be32 = (b, i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
/** @param {Uint8Array} b @param {number} i */
const le24 = (b, i) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
/** @param {Uint8Array} b @param {number} i @param {string} s */
const ascii = (b, i, s) => [...s].every((c, k) => b[i + k] === c.charCodeAt(0));

/**
 * An image's pixel size from its header (no decode). null when the header cannot say.
 * @param {Uint8Array} b @returns {{w: number, h: number} | null}
 */
export function imageSize(b) {
	if (!b || b.length < 30) return null;
	if (b[0] === 0x89 && ascii(b, 12, 'IHDR')) return { w: be32(b, 16), h: be32(b, 20) };
	if (ascii(b, 0, 'RIFF') && ascii(b, 8, 'WEBP')) {
		if (ascii(b, 12, 'VP8X')) return { w: le24(b, 24) + 1, h: le24(b, 27) + 1 };
		if (ascii(b, 12, 'VP8L') && b[20] === 0x2f) {
			const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
			return { w: (bits & 0x3fff) + 1, h: ((bits >>> 14) & 0x3fff) + 1 };
		}
		if (ascii(b, 12, 'VP8 ') && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a)
			return { w: (b[26] | (b[27] << 8)) & 0x3fff, h: (b[28] | (b[29] << 8)) & 0x3fff };
	}
	return null;
}

/**
 * A safe Explorer file name: the agent's `name` (or a fallback), any extension it typed replaced by
 * the one the BYTES earned, path separators and control characters gone.
 * @param {unknown} name @param {string} ext e.g. '.png' @param {string} [fallback]
 */
export function fileName(name, ext, fallback = 'generated') {
	const raw = String(name ?? '').split(/[\\/]/).pop() ?? '';
	const base =
		raw
			.replace(/(\.[a-z0-9]{1,8})+$/i, '')
			.replace(/[:*?"<>|\u0000-\u001f]+/g, ' ')
			.replace(/\s+/g, ' ')
			.trim()
			.slice(0, 80) || fallback;
	return base + ext;
}

/** the stem a file name shares with its spec (`knight.png` → `knight`) @param {string} name */
export const stemOf = (name) => String(name).replace(/\.[^.]+$/, '');

/**
 * A generator tag for the spec file name (`<stem>.<generator>.json`, roadmap 66 F2): lower-case, short,
 * `pixling` when absent.
 * @param {unknown} g
 */
export function generatorTag(g) {
	const t = String(g ?? '')
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, '')
		.slice(0, 24);
	return t || 'pixling';
}

/**
 * The spec that travels beside a sheet: an object (or a JSON string of one), ≤ 2 MB serialised. The
 * stored bytes are the agent's JSON re-serialised with 1-space indent (Pixling's own layout), so the
 * file a later browser path reads is plain, stable JSON.
 * @param {unknown} spec @returns {{ok: true, bytes: Uint8Array, value: any} | {ok: false, error: string} | null} null = no spec
 */
export function specBytes(spec) {
	if (spec == null || spec === '') return null;
	/** @type {any} */
	let value = spec;
	if (typeof spec === 'string') {
		try {
			value = JSON.parse(spec);
		} catch {
			return { ok: false, error: 'spec is not valid JSON' };
		}
	}
	if (!value || typeof value !== 'object') return { ok: false, error: 'spec must be a JSON object (the generator\'s input)' };
	const bytes = new TextEncoder().encode(JSON.stringify(value, null, 1) + '\n');
	if (bytes.length > MAX_JSON_BYTES) return { ok: false, error: 'spec is ' + mb(bytes.length) + ' — the limit is ' + mb(MAX_JSON_BYTES) };
	return { ok: true, bytes, value };
}

/**
 * The Explorer folder path an import lands in: `folder` as "A/B" (at most 4 levels, each name cleaned),
 * the default when absent.
 * @param {unknown} folder @returns {string[]}
 */
export function folderPath(folder) {
	const parts = String(folder ?? '')
		.split('/')
		.map((p) => p.replace(/[\\:*?"<>|\u0000-\u001f]+/g, ' ').trim().slice(0, 60))
		.filter(Boolean)
		.slice(0, 4);
	return parts.length ? parts : [DEFAULT_FOLDER];
}

/**
 * One frame of a sheet as texture repeat/offset (three's flipY = true, so row 0 is the TOP strip).
 * `frame = {w, h, col?, row?}` in pixels; null = the whole image. Refuses a frame that does not fit.
 * @param {any} frame @param {{w: number, h: number}} size
 * @returns {{repeat: [number, number], offset: [number, number], w: number, h: number} | {error: string} | null}
 */
export function frameWindow(frame, size) {
	if (frame == null) return null;
	const w = Math.round(Number(frame?.w));
	const h = Math.round(Number(frame?.h));
	const col = Math.round(Number(frame?.col ?? 0));
	const row = Math.round(Number(frame?.row ?? 0));
	if (!(w > 0 && h > 0) || !(col >= 0 && row >= 0)) return { error: 'frame needs w and h in pixels (and optional col / row, from 0)' };
	if ((col + 1) * w > size.w || (row + 1) * h > size.h)
		return { error: 'frame ' + col + ',' + row + ' of ' + w + '×' + h + ' px does not fit a ' + size.w + '×' + size.h + ' image' };
	return { repeat: [w / size.w, h / size.h], offset: [(col * w) / size.w, 1 - ((row + 1) * h) / size.h], w, h };
}

/**
 * The card's size in metres from the image (or frame) aspect: `height` metres tall (default 1), or
 * `width` wide when only that is given.
 * @param {{w: number, h: number}} px @param {any} args
 */
export function cardSize(px, args = {}) {
	const aspect = px.w / px.h;
	const height = Number(args.height);
	const width = Number(args.width);
	if (height > 0 && width > 0) return { width: Math.min(width, 1000), height: Math.min(height, 1000) };
	if (width > 0 && !(height > 0)) return { width: Math.min(width, 1000), height: Math.min(width / aspect, 1000) };
	const h = height > 0 ? Math.min(height, 1000) : 1;
	return { width: h * aspect, height: h };
}

/**
 * The texture filter: 'nearest' keeps pixel art crisp (no smoothing, no mipmaps), 'linear' is a photo.
 * 'auto' (the default) = nearest when a generator spec rides along or the image is small (≤ 512 px).
 * @param {unknown} filter @param {{hasSpec: boolean, size: {w: number, h: number} | null}} facts
 */
export function filterFor(filter, facts) {
	const f = String(filter ?? 'auto').toLowerCase();
	if (f === 'nearest' || f === 'pixel') return 'nearest';
	if (f === 'linear' || f === 'smooth') return 'linear';
	if (facts.hasSpec) return 'nearest';
	return facts.size && Math.max(facts.size.w, facts.size.h) <= 512 ? 'nearest' : 'linear';
}

/** 'camera' faces each viewer, 'camera-y' turns about Y only (a standing sprite), null = a fixed plane @param {unknown} v */
export function facingOf(v) {
	if (v === true || v === 'billboard' || v === 'camera') return 'camera';
	if (v === 'y' || v === 'camera-y' || v === 'upright') return 'camera-y';
	return null;
}

/** null = may import, else the refusal a viewer's agent gets @param {string | null | undefined} role */
export function importRefusal(role) {
	return role === 'viewer' ? 'view-only: this session made you a viewer, and viewers cannot import files. Ask the host for edit access.' : null;
}

/**
 * CHUNKED UPLOADS: an agent with no local-path bridge (or a file too big for one call) sends the base64
 * in parts — `chunk: {id, index, total}` — and the file is assembled when the last part lands. Pure:
 * the store is a Map the caller owns; `now` is passed in.
 *
 * @param {Map<string, any>} store @param {{id: unknown, index: unknown, total: unknown}} chunk
 * @param {string} data base64 of THIS part @param {number} now
 * @returns {{done: false, received: number, total: number} | {done: true, data: string} | {error: string}}
 */
export function addChunk(store, chunk, data, now) {
	for (const [k, v] of store) if (now - v.at > CHUNK_TTL_MS) store.delete(k);
	const id = String(chunk?.id ?? '').slice(0, 64);
	const index = Number(chunk?.index);
	const total = Number(chunk?.total);
	if (!id || !Number.isInteger(index) || !Number.isInteger(total) || total < 1 || index < 0 || index >= total)
		return { error: 'chunk needs {id, index (from 0), total}' };
	if (total > MAX_CHUNKS) return { error: 'at most ' + MAX_CHUNKS + ' chunks — send bigger parts' };
	if (typeof data !== 'string' || !data) return { error: 'each chunk carries its part of the file as data (base64)' };
	let up = store.get(id);
	if (up && up.total !== total) return { error: 'chunk ' + id + ' was started with total ' + up.total };
	if (!up) {
		up = { total, parts: new Array(total).fill(null), bytes: 0, at: now };
		store.set(id, up);
	}
	const part = data.replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
	if (up.parts[index] == null) up.bytes += Math.floor((part.length * 3) / 4);
	up.parts[index] = part;
	up.at = now;
	if (up.bytes > MAX_FILE_BYTES) {
		store.delete(id);
		return { error: 'the upload passed ' + mb(MAX_FILE_BYTES) + ' — the largest file import_file takes' };
	}
	const received = up.parts.filter((/** @type {string | null} */ p) => p != null).length;
	if (received < total) return { done: false, received, total };
	store.delete(id);
	// every part but the last must be a whole number of base64 quads, or the joined string is garbage
	for (let i = 0; i < total - 1; i++) if (up.parts[i].length % 4) return { error: 'chunk ' + i + ' is not a whole base64 block (split on a multiple of 4 characters / 3 bytes)' };
	return { done: true, data: up.parts.join('') };
}
