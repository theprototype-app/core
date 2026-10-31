// 47 T1 — TERRAIN PAINT, the pure half (imports NOTHING; unit-tested in tests/unit).
//
// A painted terrain carries ONE RGBA splat map: texel (i, j) holds the four layer
// WEIGHTS as bytes that always sum to exactly 255 (r = layer 0 … a = layer 3). The map
// covers the terrain's local XZ bounds — u = (x - minX) / sizeX, v = (z - minZ) / sizeZ,
// texel row j = floor(v * res) — so the shader and the brush agree without ever reading
// the geometry's own `uv` attribute (a meshgeo commit rebuilds the geometry from bare
// positions and drops it).
//
// Stored on the object as `userData.terrainSplat = {v: 1, res, data: <base64 RGBA>}` so
// every carrier that already moves userData (toJSON, GLTF extras, a joiner's object
// sync, duplicate, prefab, .tpscene) carries it without a line of its own. The LAYERS
// (colour, texture hash, tiling) are a SEPARATE small block, `userData.terrainLayers`,
// so an Inspector nudge never re-sends the bytes.

export const SPLAT_VERSION = 1;
/** texels per side: 128² × 4 = 64 KB raw (the sculpt preview of a 48-segment tile is
 *  166 KB, so a full-map preview sits well inside the stream budget sculpt already pays) */
export const SPLAT_RES = 128;
export const LAYER_COUNT = 4;
export const TILING_MIN = 0.1;
export const TILING_MAX = 200;

/** The four default layers. Layer 0 with NO colour and NO texture is "the material": the
 * terrain's own colour × map (so painting a fresh terrain changes only where you paint,
 * and the Material section keeps driving the base). Then dirt, rock, sand. Tiling =
 * repeats across the tile. */
export const DEFAULT_LAYERS = Object.freeze([
	Object.freeze({ color: '', texture: '', tiling: 8 }),
	Object.freeze({ color: '#8a6a45', texture: '', tiling: 8 }),
	Object.freeze({ color: '#808080', texture: '', tiling: 8 }),
	Object.freeze({ color: '#d8c690', texture: '', tiling: 8 })
]);

/** A fresh map: every texel 100 % layer 0. @param {number} [res] */
export function createSplat(res = SPLAT_RES) {
	const bytes = new Uint8Array(res * res * 4);
	for (let i = 0; i < bytes.length; i += 4) bytes[i] = 255;
	return bytes;
}

/**
 * One brush application in SPLAT space (u, v in 0..1; radius in u units — the caller
 * divides metres by the tile size). Pulls `layer` toward 100 % with a smoothstep falloff;
 * the other three shrink proportionally, so the four bytes keep summing to 255 exactly
 * (rounding error is absorbed by the painted channel).
 * @param {Uint8Array} bytes @param {number} res
 * @param {number} u @param {number} v @param {number} radius
 * @param {number} layer 0..3 @param {number} strength 0..1 @param {number} [dt] seconds
 * @returns {{x0:number, y0:number, x1:number, y1:number} | null} the dirty texel rect (inclusive), null = nothing changed
 */
export function paintSplatAt(bytes, res, u, v, radius, layer, strength, dt = 0.016) {
	if (!(radius > 0) || !(layer >= 0 && layer < LAYER_COUNT)) return null;
	const ch = layer | 0;
	const cx = u * res;
	const cy = v * res;
	const rTex = radius * res;
	const x0 = Math.max(0, Math.floor(cx - rTex));
	const x1 = Math.min(res - 1, Math.ceil(cx + rTex));
	const y0 = Math.max(0, Math.floor(cy - rTex));
	const y1 = Math.min(res - 1, Math.ceil(cy + rTex));
	if (x0 > x1 || y0 > y1) return null;
	// a full-strength second of brushing paints a texel at the centre solid
	const rate = Math.max(0, Math.min(1, strength)) * dt * 6;
	let dirty = null;
	for (let j = y0; j <= y1; j++) {
		for (let i = x0; i <= x1; i++) {
			const d = Math.hypot(i + 0.5 - cx, j + 0.5 - cy) / rTex;
			if (d > 1) continue;
			const t = 1 - d;
			const a = Math.min(1, rate * t * t * (3 - 2 * t));
			if (a <= 0) continue;
			const o = (j * res + i) * 4;
			if (bytes[o + ch] === 255) continue;
			let others = 0;
			let changed = false;
			for (let c = 0; c < 4; c++) {
				if (c === ch) continue;
				const next = Math.round(bytes[o + c] * (1 - a));
				if (next !== bytes[o + c]) changed = true;
				bytes[o + c] = next;
				others += next;
			}
			// a tiny `a` can round every other channel back to itself; force progress so a
			// slow brush still lands (a whole stroke of no-ops reads as a dead tool)
			if (!changed) {
				for (let c = 0; c < 4; c++) {
					if (c !== ch && bytes[o + c] > 0) {
						bytes[o + c] -= 1;
						others -= 1;
						changed = true;
						break;
					}
				}
			}
			bytes[o + ch] = 255 - others;
			if (!dirty) dirty = { x0: i, y0: j, x1: i, y1: j };
			else {
				if (i < dirty.x0) dirty.x0 = i;
				if (i > dirty.x1) dirty.x1 = i;
				if (j < dirty.y0) dirty.y0 = j;
				if (j > dirty.y1) dirty.y1 = j;
			}
		}
	}
	return dirty;
}

/** Share of `layer` across the whole map, 0..1 (tests, the Inspector's coverage line).
 * @param {Uint8Array} bytes @param {number} layer */
export function layerCoverage(bytes, layer) {
	let sum = 0;
	for (let i = layer; i < bytes.length; i += 4) sum += bytes[i];
	return bytes.length ? sum / ((bytes.length / 4) * 255) : 0;
}

// ---- base64 (btoa/atob exist in every browser and in Node ≥ 16) --------------------

/** @param {Uint8Array} bytes */
export function bytesToBase64(bytes) {
	let out = '';
	const CHUNK = 0x8000;
	for (let i = 0; i < bytes.length; i += CHUNK)
		out += String.fromCharCode.apply(null, /** @type {any} */ (bytes.subarray(i, i + CHUNK)));
	return btoa(out);
}

/** @param {string} b64 @returns {Uint8Array | null} */
export function base64ToBytes(b64) {
	if (typeof b64 !== 'string') return null;
	try {
		const bin = atob(b64);
		const bytes = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
		return bytes;
	} catch {
		return null;
	}
}

/**
 * The stored block → its bytes, or null when it is absent or malformed (a wrong length
 * is refused whole: a short map would sample garbage past its end).
 * @param {any} block @returns {{res: number, bytes: Uint8Array} | null}
 */
export function decodeSplatBlock(block) {
	if (!block || typeof block !== 'object') return null;
	const res = Number(block.res);
	if (!Number.isInteger(res) || res < 2 || res > 1024) return null;
	const bytes = base64ToBytes(block.data);
	if (!bytes || bytes.length !== res * res * 4) return null;
	return { res, bytes };
}

/** @param {Uint8Array} bytes @param {number} res */
export function encodeSplatBlock(bytes, res) {
	return { v: SPLAT_VERSION, res, data: bytesToBase64(bytes) };
}

/** Wire bytes (an ArrayBuffer or a typed view) → a Uint8Array of the right length, else null.
 * @param {any} raw @param {number} res */
export function wireSplatBytes(raw, res) {
	if (!Number.isInteger(res) || res < 2 || res > 1024) return null;
	let bytes = null;
	if (raw instanceof ArrayBuffer) bytes = new Uint8Array(raw);
	else if (ArrayBuffer.isView(raw)) bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
	if (!bytes || bytes.length !== res * res * 4) return null;
	return new Uint8Array(bytes); // own copy: the wire buffer is not ours to keep
}

// ---- layers --------------------------------------------------------------------------

const HEX = /^#[0-9a-f]{6}$/i;
const HASH = /^[0-9a-zA-Z_-]{1,128}$/;

/** Is layer 0 still "the material" (no colour, no texture)? @param {{color: string, texture: string}} layer0 */
export function baseIsMaterial(layer0) {
	return !layer0.color && !layer0.texture;
}

/** Exactly four layers, every field clamped/defaulted. @param {any} layers */
export function normalizeLayers(layers) {
	const list = Array.isArray(layers) ? layers : [];
	return DEFAULT_LAYERS.map((def, i) => {
		const l = list[i] && typeof list[i] === 'object' ? list[i] : {};
		const tiling = Number(l.tiling);
		return {
			// only layer 0 may be colourless (= the material); a bad colour falls back
			color: typeof l.color === 'string' && (HEX.test(l.color) || (i === 0 && l.color === '')) ? l.color.toLowerCase() : def.color,
			texture: typeof l.texture === 'string' && HASH.test(l.texture) ? l.texture : '',
			tiling: Number.isFinite(tiling) ? Math.min(TILING_MAX, Math.max(TILING_MIN, tiling)) : def.tiling
		};
	});
}

// ---- 51 E4: per-terrain splat resolution --------------------------------------------------

/** The resolutions the Inspector offers. 512² × 4 = 1 MB raw is the ceiling: a stroke streams
 * the whole map as a preview (~5/s), and 1024² would be 4 MB per preview. */
export const SPLAT_RES_CHOICES = Object.freeze([64, 128, 256, 512]);

/**
 * Resample a splat map to another resolution: each new texel samples the old map
 * bilinearly at its centre (texel centres line up, so a 128 → 256 → 128 round trip lands
 * back within a byte or two), then the four weights are re-normalised to sum to exactly 255
 * — the invariant every reader relies on.
 * @param {Uint8Array} bytes @param {number} res @param {number} next
 * @returns {Uint8Array}
 */
export function resampleSplat(bytes, res, next) {
	if (next === res) return bytes.slice();
	const out = new Uint8Array(next * next * 4);
	const at = (/** @type {number} */ i, /** @type {number} */ j, /** @type {number} */ c) =>
		bytes[(Math.min(res - 1, Math.max(0, j)) * res + Math.min(res - 1, Math.max(0, i))) * 4 + c];
	const w = [0, 0, 0, 0];
	for (let j = 0; j < next; j++) {
		const fy = ((j + 0.5) / next) * res - 0.5;
		const j0 = Math.floor(fy);
		const ty = fy - j0;
		for (let i = 0; i < next; i++) {
			const fx = ((i + 0.5) / next) * res - 0.5;
			const i0 = Math.floor(fx);
			const tx = fx - i0;
			let sum = 0;
			for (let c = 0; c < 4; c++) {
				const top = at(i0, j0, c) * (1 - tx) + at(i0 + 1, j0, c) * tx;
				const bot = at(i0, j0 + 1, c) * (1 - tx) + at(i0 + 1, j0 + 1, c) * tx;
				w[c] = top * (1 - ty) + bot * ty;
				sum += w[c];
			}
			const o = (j * next + i) * 4;
			if (!(sum > 0)) {
				out[o] = 255;
				continue;
			}
			// round three channels, give the remainder to the largest so the sum is exact
			let big = 0;
			for (let c = 1; c < 4; c++) if (w[c] > w[big]) big = c;
			let acc = 0;
			for (let c = 0; c < 4; c++) {
				if (c === big) continue;
				out[o + c] = Math.round((w[c] / sum) * 255);
				acc += out[o + c];
			}
			out[o + big] = 255 - acc;
		}
	}
	return out;
}
