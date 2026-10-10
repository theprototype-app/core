// 40-image (roadmap 40 F13) — THE IMAGE EDITOR'S PIXEL MATHS, as a LEAF that imports
// nothing. Every operation takes and returns a plain `{width, height, data}` raster
// (`data` = RGBA bytes, row-major, the ImageData layout) and never mutates its input, so
// the editor's undo stack can hold the previous raster as-is and vitest can drive the
// whole thing with no canvas and no browser.
//
// WHY NOT `ctx.filter` / `drawImage` for the work: the canvas pipeline is fast but it is
// not the SAME pipeline everywhere (Safari's canvas `filter` support arrived late, and
// resampling quality is a per-browser choice), and the editor's promise is that what you
// saw is what Save writes. Doing the arithmetic here makes the preview and the saved file
// one function call apart, on every engine. The canvas is only used to DECODE and ENCODE.

/** @typedef {{width: number, height: number, data: Uint8ClampedArray}} Raster */
/** @typedef {{x: number, y: number, w: number, h: number}} Rect */
/** @typedef {{brightness: number, contrast: number, saturation: number}} Adjust */

/** the neutral adjustment — every slider at 0 */
export const IDENTITY_ADJUST = Object.freeze({ brightness: 0, contrast: 0, saturation: 0 });

/** the largest side the editor will produce (a resize past this is clamped) */
export const MAX_SIDE = 8192;

/** @param {number} width @param {number} height @param {Uint8ClampedArray} [data] @returns {Raster} */
export function makeRaster(width, height, data) {
	const w = Math.max(1, Math.round(width));
	const h = Math.max(1, Math.round(height));
	return { width: w, height: h, data: data ?? new Uint8ClampedArray(w * h * 4) };
}

/** @param {number} v @param {number} lo @param {number} hi */
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

/**
 * A crop rectangle made legal for an image of this size: whole pixels, at least 1x1,
 * entirely inside. A rect dragged backwards (negative w/h) is normalised first, so a
 * drag from bottom-right to top-left crops the same box as the other way round.
 * @param {Rect} rect @param {number} width @param {number} height @returns {Rect}
 */
export function clampRect(rect, width, height) {
	let { x, y, w, h } = rect;
	if (w < 0) (x += w), (w = -w);
	if (h < 0) (y += h), (h = -h);
	const x0 = clamp(Math.round(x), 0, width - 1);
	const y0 = clamp(Math.round(y), 0, height - 1);
	const x1 = clamp(Math.round(x + w), x0 + 1, width);
	const y1 = clamp(Math.round(y + h), y0 + 1, height);
	return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * The largest rect of aspect `ratio` (w/h) centred in a `width` x `height` image — what an
 * aspect preset starts from. A ratio <= 0 (Free) returns the whole image.
 * @param {number} width @param {number} height @param {number} ratio @returns {Rect}
 */
export function aspectRect(width, height, ratio) {
	if (!(ratio > 0)) return { x: 0, y: 0, w: width, h: height };
	let w = width;
	let h = Math.round(w / ratio);
	if (h > height) {
		h = height;
		w = Math.round(h * ratio);
	}
	w = Math.max(1, Math.min(w, width));
	h = Math.max(1, Math.min(h, height));
	return { x: Math.floor((width - w) / 2), y: Math.floor((height - h) / 2), w, h };
}

/** @param {Raster} img @param {Rect} rect @returns {Raster} */
export function cropRaster(img, rect) {
	const r = clampRect(rect, img.width, img.height);
	const out = makeRaster(r.w, r.h);
	for (let row = 0; row < r.h; row++) {
		const from = ((r.y + row) * img.width + r.x) * 4;
		out.data.set(img.data.subarray(from, from + r.w * 4), row * r.w * 4);
	}
	return out;
}

/**
 * Rotate by quarter turns. +1 = 90 degrees CLOCKWISE as you look at the picture (the
 * button every image editor puts on the right), -1 counter-clockwise; any integer works
 * and 4 is the identity.
 * @param {Raster} img @param {number} quarterTurns @returns {Raster}
 */
export function rotateRaster(img, quarterTurns) {
	const q = ((Math.round(quarterTurns) % 4) + 4) % 4;
	if (q === 0) return makeRaster(img.width, img.height, img.data.slice());
	const { width: W, height: H } = img;
	const out = q === 2 ? makeRaster(W, H) : makeRaster(H, W);
	const OW = out.width;
	const src = new Uint32Array(img.data.buffer, img.data.byteOffset, W * H);
	const dst = new Uint32Array(out.data.buffer);
	for (let y = 0; y < H; y++) {
		for (let x = 0; x < W; x++) {
			let nx, ny;
			if (q === 1) (nx = H - 1 - y), (ny = x);
			else if (q === 2) (nx = W - 1 - x), (ny = H - 1 - y);
			else (nx = y), (ny = W - 1 - x);
			dst[ny * OW + nx] = src[y * W + x];
		}
	}
	return out;
}

/** Mirror. `'h'` swaps left and right, `'v'` top and bottom.
 * @param {Raster} img @param {'h' | 'v'} axis @returns {Raster} */
export function flipRaster(img, axis) {
	const { width: W, height: H } = img;
	const out = makeRaster(W, H);
	const src = new Uint32Array(img.data.buffer, img.data.byteOffset, W * H);
	const dst = new Uint32Array(out.data.buffer);
	for (let y = 0; y < H; y++) {
		for (let x = 0; x < W; x++) {
			const nx = axis === 'h' ? W - 1 - x : x;
			const ny = axis === 'v' ? H - 1 - y : y;
			dst[ny * W + nx] = src[y * W + x];
		}
	}
	return out;
}

/**
 * Per-axis resampling weights: for every destination index, the source indices it reads
 * and how much of each. SHRINKING averages the source span the destination pixel covers
 * (an area filter — what keeps a 4x reduction from aliasing into noise); GROWING
 * interpolates linearly between the two nearest source centres.
 * @param {number} src @param {number} dst @returns {{idx: Int32Array, w: Float32Array, start: Int32Array}}
 */
function axisWeights(src, dst) {
	const scale = src / dst;
	/** @type {number[]} */ const idx = [];
	/** @type {number[]} */ const w = [];
	const start = new Int32Array(dst + 1);
	for (let d = 0; d < dst; d++) {
		start[d] = idx.length;
		if (scale > 1) {
			const a = d * scale;
			const b = a + scale;
			for (let s = Math.floor(a); s < Math.ceil(b) && s < src; s++) {
				const cover = Math.min(b, s + 1) - Math.max(a, s);
				if (cover > 0) idx.push(s), w.push(cover / scale);
			}
		} else {
			const centre = (d + 0.5) * scale - 0.5;
			const s0 = clamp(Math.floor(centre), 0, src - 1);
			const s1 = Math.min(s0 + 1, src - 1);
			const t = clamp(centre - s0, 0, 1);
			if (s1 === s0) idx.push(s0), w.push(1);
			else idx.push(s0, s1), w.push(1 - t, t);
		}
	}
	start[dst] = idx.length;
	return { idx: Int32Array.from(idx), w: Float32Array.from(w), start };
}

/**
 * Resample to `width` x `height` (each clamped to 1..MAX_SIDE). Separable: rows first
 * into a float buffer, then columns. Colour is weighted by ALPHA, so a transparent pixel
 * cannot bleed its (meaningless) colour into the edge of an opaque neighbour — the dark
 * halo every naive resize of a cut-out PNG grows.
 * @param {Raster} img @param {number} width @param {number} height @returns {Raster}
 */
export function resizeRaster(img, width, height) {
	const W = clamp(Math.round(width), 1, MAX_SIDE);
	const H = clamp(Math.round(height), 1, MAX_SIDE);
	if (W === img.width && H === img.height) return makeRaster(W, H, img.data.slice());
	const sw = img.width;
	const sh = img.height;
	const xs = axisWeights(sw, W);
	const ys = axisWeights(sh, H);
	// premultiplied float rows: [r*a, g*a, b*a, a]
	const mid = new Float32Array(W * sh * 4);
	const s = img.data;
	for (let y = 0; y < sh; y++) {
		const row = y * sw * 4;
		for (let x = 0; x < W; x++) {
			let r = 0, g = 0, b = 0, a = 0;
			for (let k = xs.start[x]; k < xs.start[x + 1]; k++) {
				const p = row + xs.idx[k] * 4;
				const wa = xs.w[k] * s[p + 3];
				r += s[p] * wa;
				g += s[p + 1] * wa;
				b += s[p + 2] * wa;
				a += wa;
			}
			const o = (y * W + x) * 4;
			mid[o] = r;
			mid[o + 1] = g;
			mid[o + 2] = b;
			mid[o + 3] = a;
		}
	}
	const out = makeRaster(W, H);
	const d = out.data;
	for (let y = 0; y < H; y++) {
		for (let x = 0; x < W; x++) {
			let r = 0, g = 0, b = 0, a = 0;
			for (let k = ys.start[y]; k < ys.start[y + 1]; k++) {
				const p = (ys.idx[k] * W + x) * 4;
				const wk = ys.w[k];
				r += mid[p] * wk;
				g += mid[p + 1] * wk;
				b += mid[p + 2] * wk;
				a += mid[p + 3] * wk;
			}
			const o = (y * W + x) * 4;
			if (a > 0) {
				d[o] = r / a;
				d[o + 1] = g / a;
				d[o + 2] = b / a;
			}
			d[o + 3] = a;
		}
	}
	return out;
}

/** Is this adjustment a no-op? @param {Partial<Adjust> | null | undefined} adj */
export function isIdentityAdjust(adj) {
	return !adj || (!adj.brightness && !adj.contrast && !adj.saturation);
}

/**
 * Brightness / contrast / saturation, each -100..100 with 0 = unchanged. The order is the
 * one every photo tool uses — brightness shifts, contrast stretches about mid-grey, then
 * saturation pulls toward or away from the pixel's own luma (Rec. 709 weights) — and the
 * three are folded into ONE 256-entry table per stage where they can be, so a 4K image is
 * one pass. Alpha is never touched.
 * @param {Raster} img @param {Partial<Adjust>} adj @returns {Raster}
 */
export function adjustRaster(img, adj) {
	const brightness = clamp(Number(adj?.brightness) || 0, -100, 100);
	const contrast = clamp(Number(adj?.contrast) || 0, -100, 100);
	const saturation = clamp(Number(adj?.saturation) || 0, -100, 100);
	const out = makeRaster(img.width, img.height, img.data.slice());
	if (!brightness && !contrast && !saturation) return out;
	// the per-channel tone curve: brightness then contrast
	const shift = brightness * 2.55;
	const c = contrast * 2.55;
	const factor = (259 * (c + 255)) / (255 * (259 - c));
	const lut = new Float32Array(256);
	for (let v = 0; v < 256; v++) lut[v] = factor * (v + shift - 128) + 128;
	const sat = 1 + saturation / 100;
	const d = out.data;
	for (let i = 0; i < d.length; i += 4) {
		let r = lut[d[i]];
		let g = lut[d[i + 1]];
		let b = lut[d[i + 2]];
		if (saturation) {
			const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
			r = l + (r - l) * sat;
			g = l + (g - l) * sat;
			b = l + (b - l) * sat;
		}
		d[i] = r; // Uint8ClampedArray rounds and clamps
		d[i + 1] = g;
		d[i + 2] = b;
	}
	return out;
}

/**
 * Fit `width` x `height` inside `maxW` x `maxH` keeping the aspect, never enlarging.
 * @param {number} width @param {number} height @param {number} maxW @param {number} maxH
 * @returns {{width: number, height: number, scale: number}}
 */
export function fitSize(width, height, maxW, maxH) {
	const scale = Math.min(1, maxW / width, maxH / height);
	return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), scale };
}

/** The power of two nearest `n` (ties go up) — the texture-friendly size. @param {number} n */
export function nearestPow2(n) {
	if (!(n >= 1)) return 1;
	const lo = 2 ** Math.floor(Math.log2(n));
	const hi = lo * 2;
	return n - lo < hi - n ? lo : Math.min(hi, MAX_SIDE);
}

/**
 * What a saved edit is encoded as: the file keeps its own format where a browser can
 * write it (PNG, JPEG, WebP), and anything else (GIF, BMP) becomes PNG — a GIF encoder
 * is not something a browser ships. Returns the mime type and the filename to match.
 * @param {string} name @param {string} [mime]
 * @returns {{type: string, name: string, quality?: number}}
 */
export function encodingFor(name, mime = '') {
	const base = String(name || 'image');
	const ext = (base.match(/\.([a-z0-9]+)$/i)?.[1] ?? '').toLowerCase();
	const type = String(mime || '').toLowerCase();
	if (ext === 'jpg' || ext === 'jpeg' || type === 'image/jpeg') return { type: 'image/jpeg', name: base, quality: 0.92 };
	if (ext === 'webp' || type === 'image/webp') return { type: 'image/webp', name: base, quality: 0.92 };
	if (ext === 'png' || type === 'image/png') return { type: 'image/png', name: base };
	const stem = ext ? base.slice(0, -(ext.length + 1)) : base;
	return { type: 'image/png', name: stem + '.png' };
}
