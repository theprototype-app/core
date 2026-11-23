// 105-noise (roadmap 105 T4a) — GENERATED NOISE AS PIXELS, a LEAF that imports nothing (it runs in
// `noise.worker.js` and under vitest with no canvas). Four kinds — Perlin (gradient), Simplex, Worley (cells) and
// Value — each summed over fBm octaves, shaped (contrast, invert), coloured through two colours or a gradient,
// optionally turned into a tangent-space NORMAL map (height -> normal), and blended over an existing raster
// (replace / multiply / overlay / add, with an opacity).
//
// TILEABLE is the default and is EXACT, not approximate: octave o has `scale * 2^o` cells across the image and the
// lattice indices wrap at that period, so the value at u = 1 IS the value at u = 0 (same lattice corners, same
// fractions) and a texture repeats with no seam. Simplex cannot wrap that way (its lattice is skewed), so a tileable
// Simplex is 4-D simplex noise sampled on a torus (u and v each walk a circle whose circumference is the period).
// Not tileable = the plain 2-D noises with no wrap, and a fractional scale is allowed.
//
// DETERMINISTIC: integer hashes, no Math.random, so the same options give the same bytes (the unit layer checks it).
// Peers never recompute this: the result is an ordinary image and travels as one.

/** @typedef {{width: number, height: number, data: Uint8ClampedArray}} Raster */
/**
 * @typedef {{kind: 'perlin' | 'simplex' | 'worley' | 'value', scale: number, octaves: number, roughness: number,
 *   seed: number, contrast: number, invert: boolean, tileable: boolean, colors: string[],
 *   blend: 'replace' | 'multiply' | 'overlay' | 'add', opacity: number, output: 'color' | 'normal', strength: number}} NoiseOptions
 */

export const NOISE_KINDS = Object.freeze(['perlin', 'simplex', 'worley', 'value']);
export const NOISE_BLENDS = Object.freeze(['replace', 'multiply', 'overlay', 'add']);
export const NOISE_OUTPUTS = Object.freeze(['color', 'normal']);
/** the most colours a gradient takes (two = the two-colour case) */
export const MAX_NOISE_COLORS = 5;
/** [min, max] of every number option */
export const NOISE_LIMITS = Object.freeze({
	scale: [1, 64],
	octaves: [1, 8],
	roughness: [0, 1],
	seed: [0, 999999],
	contrast: [-100, 100],
	opacity: [0, 1],
	strength: [0, 10]
});

/** @type {Readonly<NoiseOptions>} */
export const NOISE_DEFAULTS = Object.freeze({
	kind: 'perlin',
	scale: 4,
	octaves: 4,
	roughness: 0.5,
	seed: 1,
	contrast: 0,
	invert: false,
	tileable: true,
	colors: Object.freeze(['#000000', '#ffffff']),
	blend: 'replace',
	opacity: 1,
	output: 'color',
	strength: 1
});

/** @param {number} v @param {number} lo @param {number} hi */
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

/** '#rgb' or '#rrggbb' (any case) to '#rrggbb', else null @param {any} c */
export function hexColor(c) {
	if (typeof c !== 'string') return null;
	const m = c.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
	if (!m) return null;
	const h = m[1].length === 3 ? [...m[1]].map((x) => x + x).join('') : m[1];
	return '#' + h.toLowerCase();
}

/**
 * Every option made legal: unknown kinds / blends fall back to the default, numbers are clamped, a tileable scale
 * is a whole number (a period must be a whole number of cells), colours are 2..5 valid hex values.
 * @param {any} [o] @returns {NoiseOptions}
 */
export function normalizeNoise(o = {}) {
	const src = o && typeof o === 'object' ? o : {};
	const D = NOISE_DEFAULTS;
	/** @param {keyof typeof NOISE_LIMITS} key */
	const num = (key) => {
		const v = Number(src[key]);
		return Number.isFinite(v) ? clamp(v, NOISE_LIMITS[key][0], NOISE_LIMITS[key][1]) : /** @type {number} */ (D[key]);
	};
	const tileable = src.tileable === undefined ? D.tileable : !!src.tileable;
	let colors = Array.isArray(src.colors) ? src.colors.map(hexColor).filter((c) => c !== null) : [];
	if (colors.length < 2) colors = [...D.colors];
	return {
		kind: NOISE_KINDS.includes(src.kind) ? src.kind : D.kind,
		scale: tileable ? Math.max(1, Math.round(num('scale'))) : num('scale'),
		octaves: Math.round(num('octaves')),
		roughness: num('roughness'),
		seed: Math.round(num('seed')),
		contrast: num('contrast'),
		invert: !!src.invert,
		tileable,
		colors: /** @type {string[]} */ (colors.slice(0, MAX_NOISE_COLORS)),
		blend: NOISE_BLENDS.includes(src.blend) ? src.blend : D.blend,
		opacity: num('opacity'),
		output: NOISE_OUTPUTS.includes(src.output) ? src.output : D.output,
		strength: num('strength')
	};
}

// ---- hashes and lattices -----------------------------------------------------------------

/** a 32-bit hash of a lattice point and a seed, the same on every machine @param {number} x @param {number} y @param {number} s */
function hash2(x, y, s) {
	let n = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(s, 2147483647)) | 0;
	n = Math.imul(n ^ (n >>> 13), 1274126177);
	return (n ^ (n >>> 16)) >>> 0;
}
/** @param {number} x @param {number} y @param {number} z @param {number} w @param {number} s */
function hash4(x, y, z, w, s) {
	let n = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(z, 1103515245) + Math.imul(w, -2048144777) + Math.imul(s, 2147483647)) | 0;
	n = Math.imul(n ^ (n >>> 13), 1274126177);
	n = Math.imul(n ^ (n >>> 15), 668265263);
	return (n ^ (n >>> 16)) >>> 0;
}
/** wrap a lattice index into 0..P-1; P = 0 = no wrap @param {number} i @param {number} P */
const wrap = (i, P) => (P > 0 ? ((i % P) + P) % P : i);
/** @param {number} t */
const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);

// 8 unit gradients for Perlin; 8 Gustavson ones (length 1 or sqrt 2) for 2-D simplex
const G8X = [1, -1, 0, 0, Math.SQRT1_2, -Math.SQRT1_2, Math.SQRT1_2, -Math.SQRT1_2];
const G8Y = [0, 0, 1, -1, Math.SQRT1_2, Math.SQRT1_2, -Math.SQRT1_2, -Math.SQRT1_2];
const GS2X = [1, -1, 1, -1, 1, -1, 0, 0];
const GS2Y = [1, 1, -1, -1, 0, 0, 1, -1];

/** gradient (Perlin) noise, about -0.71..0.71 @param {number} x @param {number} y @param {number} P @param {number} s */
function perlin(x, y, P, s) {
	const x0 = Math.floor(x);
	const y0 = Math.floor(y);
	const fx = x - x0;
	const fy = y - y0;
	const xa = wrap(x0, P);
	const xb = wrap(x0 + 1, P);
	const ya = wrap(y0, P);
	const yb = wrap(y0 + 1, P);
	let h = hash2(xa, ya, s) & 7;
	const n00 = G8X[h] * fx + G8Y[h] * fy;
	h = hash2(xb, ya, s) & 7;
	const n10 = G8X[h] * (fx - 1) + G8Y[h] * fy;
	h = hash2(xa, yb, s) & 7;
	const n01 = G8X[h] * fx + G8Y[h] * (fy - 1);
	h = hash2(xb, yb, s) & 7;
	const n11 = G8X[h] * (fx - 1) + G8Y[h] * (fy - 1);
	const u = fade(fx);
	const v = fade(fy);
	const a = n00 + (n10 - n00) * u;
	const b = n01 + (n11 - n01) * u;
	return a + (b - a) * v;
}

/** value noise, 0..1 @param {number} x @param {number} y @param {number} P @param {number} s */
function valueNoise(x, y, P, s) {
	const x0 = Math.floor(x);
	const y0 = Math.floor(y);
	const u = fade(x - x0);
	const v = fade(y - y0);
	const xa = wrap(x0, P);
	const xb = wrap(x0 + 1, P);
	const ya = wrap(y0, P);
	const yb = wrap(y0 + 1, P);
	const k = 1 / 4294967295;
	const a = hash2(xa, ya, s) * k;
	const b = hash2(xb, ya, s) * k;
	const c = hash2(xa, yb, s) * k;
	const d = hash2(xb, yb, s) * k;
	const top = a + (b - a) * u;
	const bot = c + (d - c) * u;
	return top + (bot - top) * v;
}

/** Worley (cellular) F1: the distance to the nearest feature point, one per cell, 0..1 (clamped)
 * @param {number} x @param {number} y @param {number} P @param {number} s */
function worley(x, y, P, s) {
	const xi = Math.floor(x);
	const yi = Math.floor(y);
	let best = 4;
	for (let dy = -1; dy <= 1; dy++) {
		for (let dx = -1; dx <= 1; dx++) {
			const cx = xi + dx;
			const cy = yi + dy;
			const h = hash2(wrap(cx, P), wrap(cy, P), s);
			const px = cx + (h & 0xffff) / 65536 - x;
			const py = cy + (h >>> 16) / 65536 - y;
			const d = px * px + py * py;
			if (d < best) best = d;
		}
	}
	return Math.min(1, Math.sqrt(best));
}

const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;
/** 2-D simplex noise, about -1..1 (Gustavson, gradients by hash) @param {number} x @param {number} y @param {number} s */
function simplex2(x, y, s) {
	const t = (x + y) * F2;
	const i = Math.floor(x + t);
	const j = Math.floor(y + t);
	const t0 = (i + j) * G2;
	const x0 = x - (i - t0);
	const y0 = y - (j - t0);
	const i1 = x0 > y0 ? 1 : 0;
	const j1 = 1 - i1;
	const x1 = x0 - i1 + G2;
	const y1 = y0 - j1 + G2;
	const x2 = x0 - 1 + 2 * G2;
	const y2 = y0 - 1 + 2 * G2;
	let n = 0;
	let c = 0.5 - x0 * x0 - y0 * y0;
	if (c > 0) {
		const g = hash2(i, j, s) & 7;
		c *= c;
		n += c * c * (GS2X[g] * x0 + GS2Y[g] * y0);
	}
	c = 0.5 - x1 * x1 - y1 * y1;
	if (c > 0) {
		const g = hash2(i + i1, j + j1, s) & 7;
		c *= c;
		n += c * c * (GS2X[g] * x1 + GS2Y[g] * y1);
	}
	c = 0.5 - x2 * x2 - y2 * y2;
	if (c > 0) {
		const g = hash2(i + 1, j + 1, s) & 7;
		c *= c;
		n += c * c * (GS2X[g] * x2 + GS2Y[g] * y2);
	}
	return 70 * n;
}

// the 32 gradients of 4-D simplex noise: every vector with one zero and three of +-1
/** @type {number[][]} */
const GRAD4 = [];
for (let zero = 0; zero < 4; zero++)
	for (let m = 0; m < 8; m++) {
		const g = [0, 0, 0, 0];
		let bit = 0;
		for (let k = 0; k < 4; k++) {
			if (k === zero) continue;
			g[k] = (m >> bit++) & 1 ? -1 : 1;
		}
		GRAD4.push(g);
	}
const F4 = (Math.sqrt(5) - 1) / 4;
const G4 = (5 - Math.sqrt(5)) / 20;

/** 4-D simplex noise, about -1..1 (Gustavson's rank ordering, gradients by hash)
 * @param {number} x @param {number} y @param {number} z @param {number} w @param {number} s */
function simplex4(x, y, z, w, s) {
	const t = (x + y + z + w) * F4;
	const i = Math.floor(x + t);
	const j = Math.floor(y + t);
	const k = Math.floor(z + t);
	const l = Math.floor(w + t);
	const t0 = (i + j + k + l) * G4;
	const x0 = x - (i - t0);
	const y0 = y - (j - t0);
	const z0 = z - (k - t0);
	const w0 = w - (l - t0);
	// rank each coordinate: the order the simplex's corners are visited in
	let rx = 0, ry = 0, rz = 0, rw = 0;
	if (x0 > y0) rx++; else ry++;
	if (x0 > z0) rx++; else rz++;
	if (x0 > w0) rx++; else rw++;
	if (y0 > z0) ry++; else rz++;
	if (y0 > w0) ry++; else rw++;
	if (z0 > w0) rz++; else rw++;
	let n = 0;
	for (let c = 0; c < 5; c++) {
		// corner c: offset 1 on every axis whose rank is >= 4 - c (corner 0 = none, corner 4 = all)
		const lim = 4 - c;
		const oi = c === 0 ? 0 : rx >= lim ? 1 : 0;
		const oj = c === 0 ? 0 : ry >= lim ? 1 : 0;
		const ok = c === 0 ? 0 : rz >= lim ? 1 : 0;
		const ol = c === 0 ? 0 : rw >= lim ? 1 : 0;
		const dx = x0 - oi + c * G4;
		const dy = y0 - oj + c * G4;
		const dz = z0 - ok + c * G4;
		const dw = w0 - ol + c * G4;
		let q = 0.6 - dx * dx - dy * dy - dz * dz - dw * dw;
		if (q <= 0) continue;
		const g = GRAD4[hash4(i + oi, j + oj, k + ok, l + ol, s) & 31];
		q *= q;
		n += q * q * (g[0] * dx + g[1] * dy + g[2] * dz + g[3] * dw);
	}
	return 27 * n;
}

const TAU = Math.PI * 2;

/**
 * One octave at (u, v) in 0..1 image space with `f` cells across, mapped to 0..1.
 * @param {string} kind @param {number} u @param {number} v @param {number} f @param {boolean} tile @param {number} s
 */
function octave(kind, u, v, f, tile, s) {
	const x = u * f;
	const y = v * f;
	const P = tile ? f : 0;
	switch (kind) {
		case 'value':
			return valueNoise(x, y, P, s);
		case 'worley':
			return worley(x, y, P, s);
		case 'simplex': {
			if (!tile) return 0.5 + 0.5 * simplex2(x, y, s);
			// a torus: u and v each walk a circle of circumference f, so features keep their size and wrap exactly
			const r = f / TAU;
			const a = u * TAU;
			const b = v * TAU;
			return 0.5 + 0.5 * simplex4(r * Math.cos(a), r * Math.sin(a), r * Math.cos(b), r * Math.sin(b), s);
		}
		default:
			return 0.5 + perlin(x, y, P, s) * Math.SQRT1_2;
	}
}

/**
 * The shaped height at one point, 0..1: fBm over the octaves, then contrast and invert. Exported for the seam test.
 * @param {number} u @param {number} v @param {NoiseOptions} o
 */
export function sampleNoise(u, v, o) {
	let sum = 0;
	let norm = 0;
	let amp = 1;
	let f = o.scale;
	for (let oct = 0; oct < o.octaves; oct++) {
		sum += amp * octave(o.kind, u, v, f, o.tileable, o.seed + oct * 101);
		norm += amp;
		amp *= o.roughness;
		f *= 2;
	}
	return shape(norm > 0 ? sum / norm : 0, o);
}

/** contrast about mid-grey (-100..100), then invert @param {number} h @param {NoiseOptions} o */
function shape(h, o) {
	const c = o.contrast / 100;
	if (c) {
		const k = c > 0 ? 1 / (1 - c * 0.98) : 1 + c;
		h = (h - 0.5) * k + 0.5;
	}
	h = h < 0 ? 0 : h > 1 ? 1 : h;
	return o.invert ? 1 - h : h;
}

/**
 * The height field, row-major, 0..1. Pixel (x, y) samples u = x / width, so the period is exactly the image.
 * Octave-major with the kind chosen once per octave and every per-column / per-row term (the coordinate, the torus's
 * cos and sin) computed once: the same arithmetic as `sampleNoise`, in the same order, so the two agree bit for bit.
 * `rows` = which image rows, in order (default all): a band of a bigger fill, for the worker pool.
 * @param {number} width @param {number} height @param {NoiseOptions} o @param {number[] | null} [rows] @returns {Float32Array}
 */
export function noiseHeightField(width, height, o, rows = null) {
	const list = rows ?? Array.from({ length: height }, (_, y) => y);
	const sum = new Float64Array(width * list.length);
	const colU = new Float64Array(width);
	for (let px = 0; px < width; px++) colU[px] = px / width;
	const xs = new Float64Array(width);
	const ca = new Float64Array(width);
	const sa = new Float64Array(width);
	let norm = 0;
	let amp = 1;
	let f = o.scale;
	for (let oct = 0; oct < o.octaves; oct++) {
		const s = o.seed + oct * 101;
		const P = o.tileable ? f : 0;
		const torus = o.kind === 'simplex' && o.tileable;
		const r = f / TAU;
		for (let px = 0; px < width; px++) {
			xs[px] = colU[px] * f;
			if (torus) {
				const a = colU[px] * TAU;
				ca[px] = r * Math.cos(a);
				sa[px] = r * Math.sin(a);
			}
		}
		let i = 0;
		for (const py of list) {
			const v = py / height;
			const y = v * f;
			if (o.kind === 'value') for (let px = 0; px < width; px++) sum[i++] += amp * valueNoise(xs[px], y, P, s);
			else if (o.kind === 'worley') for (let px = 0; px < width; px++) sum[i++] += amp * worley(xs[px], y, P, s);
			else if (torus) {
				const b = v * TAU;
				const cb = r * Math.cos(b);
				const sb = r * Math.sin(b);
				for (let px = 0; px < width; px++) sum[i++] += amp * (0.5 + 0.5 * simplex4(ca[px], sa[px], cb, sb, s));
			} else if (o.kind === 'simplex') for (let px = 0; px < width; px++) sum[i++] += amp * (0.5 + 0.5 * simplex2(xs[px], y, s));
			else for (let px = 0; px < width; px++) sum[i++] += amp * (0.5 + perlin(xs[px], y, P, s) * Math.SQRT1_2);
		}
		norm += amp;
		amp *= o.roughness;
		f *= 2;
	}
	const out = new Float32Array(sum.length);
	for (let i = 0; i < out.length; i++) out[i] = shape(norm > 0 ? sum[i] / norm : 0, o);
	return out;
}

/** 256 RGB entries along evenly spaced colour stops @param {string[]} colors @returns {Uint8Array} */
export function gradientLut(colors) {
	const stops = colors.map((c) => {
		const h = hexColor(c) ?? '#000000';
		return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
	});
	const lut = new Uint8Array(256 * 3);
	const segs = stops.length - 1;
	for (let i = 0; i < 256; i++) {
		const t = (i / 255) * segs;
		const k = Math.min(Math.floor(t), segs - 1);
		const f = t - k;
		for (let ch = 0; ch < 3; ch++) lut[i * 3 + ch] = Math.round(stops[k][ch] + (stops[k + 1][ch] - stops[k][ch]) * f);
	}
	return lut;
}

/**
 * A height field as a tangent-space normal map (three.js / OpenGL convention: green = up the texture). Central
 * differences in UV units, so the strength reads the same at any resolution; edges wrap when tileable.
 * `h` holds the band's rows plus one row above and one below (`rows` = their image row numbers, already wrapped or
 * clamped), so a band of a bigger fill is exactly the matching rows of the whole.
 * @param {Float32Array} h @param {number[]} rows @param {number} width @param {number} H the whole image's height
 * @param {number} strength @param {boolean} tile
 * @param {Uint8Array} out RGB, width * (rows.length - 2) * 3
 */
function heightToNormal(h, rows, width, H, strength, tile, out) {
	const k = strength / 32;
	const height = rows.length - 2;
	for (let y = 0; y < height; y++) {
		const above = y * width;
		const self = (y + 1) * width;
		const below = (y + 2) * width;
		const spanY = tile ? 2 : rows[y + 2] - rows[y] || 1;
		for (let x = 0; x < width; x++) {
			const xl = tile ? (x - 1 + width) % width : Math.max(x - 1, 0);
			const xr = tile ? (x + 1) % width : Math.min(x + 1, width - 1);
			const spanX = tile ? 2 : xr - xl || 1;
			const dhdu = ((h[self + xr] - h[self + xl]) * width) / spanX;
			// image y runs down, texture v runs up (flipY): -dh/dv = +dh/dy
			const dhdy = ((h[below + x] - h[above + x]) * H) / spanY;
			let nx = -dhdu * k;
			let ny = dhdy * k;
			const len = Math.hypot(nx, ny, 1);
			nx /= len;
			ny /= len;
			const nz = 1 / len;
			const o = (y * width + x) * 3;
			out[o] = Math.round((nx * 0.5 + 0.5) * 255);
			out[o + 1] = Math.round((ny * 0.5 + 0.5) * 255);
			out[o + 2] = Math.round((nz * 0.5 + 0.5) * 255);
		}
	}
}

/**
 * THE OPERATION: noise of these options at width x height, blended over `base` when given. With no base the result
 * is the noise itself, opaque. Alpha: replace pulls it toward opaque by the opacity, the other modes keep the base's.
 * A normal map output is opaque colour data; its blend still applies (replace is the one that makes sense, the panel
 * says so).
 * BANDS: with `y0` / `y1` the result is only rows y0..y1-1 of the width x height image (and `base`, if given, is
 * that band) — the worker pool splits a big fill this way, and a band is byte-identical to the same rows of the
 * whole. Without them, `base` fixes the size.
 * @param {Partial<NoiseOptions>} options
 * @param {{width: number, height: number, base?: Raster | null, y0?: number, y1?: number}} size
 * @returns {Raster}
 */
export function noiseRaster(options, size) {
	const o = normalizeNoise(options);
	const base = size.base ?? null;
	const banded = size.y0 !== undefined || size.y1 !== undefined;
	const width = Math.max(1, Math.round(base && !banded ? base.width : size.width));
	const height = Math.max(1, Math.round(base && !banded ? base.height : size.height));
	const y0 = banded ? clamp(Math.round(size.y0 ?? 0), 0, height) : 0;
	const y1 = banded ? clamp(Math.round(size.y1 ?? height), y0, height) : height;
	const bandH = y1 - y0;
	const n = width * bandH;
	const rgb = new Uint8Array(n * 3);
	if (o.output === 'normal') {
		/** @type {number[]} */
		const rows = [];
		for (let r = y0 - 1; r <= y1; r++) rows.push(o.tileable ? wrap(r, height) : clamp(r, 0, height - 1));
		heightToNormal(noiseHeightField(width, height, o, rows), rows, width, height, o.strength, o.tileable, rgb);
	} else {
		const rows = Array.from({ length: bandH }, (_, i) => y0 + i);
		const h = noiseHeightField(width, height, o, rows);
		const lut = gradientLut(o.colors);
		for (let i = 0; i < n; i++) {
			const idx = Math.round(h[i] * 255) * 3;
			rgb[i * 3] = lut[idx];
			rgb[i * 3 + 1] = lut[idx + 1];
			rgb[i * 3 + 2] = lut[idx + 2];
		}
	}
	const data = new Uint8ClampedArray(n * 4);
	if (!base) {
		for (let i = 0; i < n; i++) {
			data[i * 4] = rgb[i * 3];
			data[i * 4 + 1] = rgb[i * 3 + 1];
			data[i * 4 + 2] = rgb[i * 3 + 2];
			data[i * 4 + 3] = 255;
		}
		return { width, height: bandH, data };
	}
	blendInto(base.data, rgb, data, o.blend, o.opacity);
	return { width, height: bandH, data };
}

/**
 * Blend noise colours `rgb` over `src` RGBA into `dst` RGBA. Exported for the unit layer.
 * @param {Uint8ClampedArray} src @param {Uint8Array} rgb @param {Uint8ClampedArray} dst
 * @param {NoiseOptions['blend']} mode @param {number} opacity
 */
export function blendInto(src, rgb, dst, mode, opacity) {
	const n = rgb.length / 3;
	const a = clamp(opacity, 0, 1);
	for (let i = 0; i < n; i++) {
		const p = i * 4;
		const q = i * 3;
		for (let ch = 0; ch < 3; ch++) {
			const b = src[p + ch];
			const s = rgb[q + ch];
			let m;
			if (mode === 'multiply') m = (b * s) / 255;
			else if (mode === 'overlay') m = b < 128 ? (2 * b * s) / 255 : 255 - (2 * (255 - b) * (255 - s)) / 255;
			else if (mode === 'add') m = b + s > 255 ? 255 : b + s;
			else m = s;
			dst[p + ch] = b + (m - b) * a; // Uint8ClampedArray rounds
		}
		const ba = src[p + 3];
		dst[p + 3] = mode === 'replace' ? ba + (255 - ba) * a : ba;
	}
}
