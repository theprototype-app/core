// Roadmap 55 A5 — THE ARITHMETIC OF AN AGENT'S SCREENSHOT. Imports nothing (the unit layer's rule):
// where the temporary camera stands for each view, how big the picture is, and how a LINEAR float
// frame becomes sRGB bytes.
//
// Why the pixel half exists at all: the screenshot renders into an OFFSCREEN render target, so no
// person's canvas or camera is ever touched — and three applies its output colour space and tone
// mapping only when it draws to the canvas (`currentRenderTarget === null`). The target therefore
// holds LINEAR light, and the conversion the canvas would have done is done here.

import { SCREENSHOT_VIEWS, SCREENSHOT_MAX_SIZE, SCREENSHOT_DEFAULT_SIZE } from './contract.js';

/** Smallest side a request may ask for. */
export const SCREENSHOT_MIN_SIZE = 64;

/** @param {any} view @returns {'current'|'top'|'front'|'iso'|'focus'} */
export function normalizeView(view) {
	const v = String(view ?? '').toLowerCase();
	return /** @type {any} */ (SCREENSHOT_VIEWS.includes(/** @type {any} */ (v)) ? v : 'iso');
}

/** @param {any} size @returns {number} the longest side, clamped */
export function clampSize(size) {
	const n = Math.round(Number(size));
	if (!Number.isFinite(n) || n <= 0) return SCREENSHOT_DEFAULT_SIZE;
	return Math.max(SCREENSHOT_MIN_SIZE, Math.min(SCREENSHOT_MAX_SIZE, n));
}

/**
 * Output size for a longest side and an aspect (w/h).
 * @param {number} size @param {number} aspect
 * @returns {{w: number, h: number}}
 */
export function frameSize(size, aspect) {
	const a = Number.isFinite(aspect) && aspect > 0 ? Math.max(0.25, Math.min(4, aspect)) : 16 / 9;
	return a >= 1 ? { w: size, h: Math.max(1, Math.round(size / a)) } : { w: Math.max(1, Math.round(size * a)), h: size };
}

/** @param {number[]} v */
function norm(v) {
	const l = Math.hypot(v[0], v[1], v[2]) || 1;
	return [v[0] / l, v[1] / l, v[2] / l];
}

/** Direction FROM the subject TO the camera, per view (Y up; the front looks down -Z). */
export const VIEW_DIRS = /** @type {Record<string, number[]>} */ ({
	top: [0, 1, 0],
	front: [0, 0, 1],
	iso: norm([1, 0.8, 1]),
	focus: norm([1, 0.8, 1])
});

/**
 * Where the temporary camera stands to frame a sphere (center, radius) from a view. A perspective
 * camera fits the sphere when it stands radius / sin(fov/2) away along the view direction — the
 * NARROWER of the two fovs decides, so a tall frame does not crop a wide scene.
 * @param {'top'|'front'|'iso'|'focus'} view
 * @param {{center: number[], radius: number}} bounds
 * @param {number} fovDeg vertical field of view
 * @param {number} aspect w/h
 * @param {number} [margin] 1 = the sphere touches the frame
 * @returns {{position: number[], target: number[], up: number[], near: number, far: number}}
 */
export function viewPose(view, bounds, fovDeg, aspect, margin = 1.15) {
	const r = Math.max(0.05, Number(bounds.radius) || 0);
	const c = bounds.center.map((x) => Number(x) || 0);
	const vFov = ((Math.max(5, Math.min(120, fovDeg || 50)) * Math.PI) / 180) / 2;
	const hFov = Math.atan(Math.tan(vFov) * (aspect > 0 ? aspect : 1));
	const half = Math.min(vFov, hFov);
	const dist = (r * margin) / Math.sin(half);
	const dir = VIEW_DIRS[view] ?? VIEW_DIRS.iso;
	const position = [c[0] + dir[0] * dist, c[1] + dir[1] * dist, c[2] + dir[2] * dist];
	// looking straight down, "up" on the picture is -Z (north), never the degenerate +Y
	const up = view === 'top' ? [0, 0, -1] : [0, 1, 0];
	return { position, target: c, up, near: Math.max(0.01, dist - r * 4), far: dist + r * 4 };
}

/**
 * A bounding box as a sphere; an empty box is a small default patch at the origin.
 * @param {{min: number[], max: number[]} | null} box
 */
export function boundsOf(box) {
	if (!box || !box.min.every(Number.isFinite) || !box.max.every(Number.isFinite) || box.min.some((v, i) => v > box.max[i]))
		return { center: [0, 0.5, 0], radius: 4, empty: true };
	const center = box.min.map((v, i) => (v + box.max[i]) / 2);
	const radius = Math.hypot(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]) / 2;
	return { center, radius: Math.max(0.25, radius), empty: false };
}

/** linear [0,1] -> sRGB [0,1] @param {number} c */
export function linearToSrgb(c) {
	const x = c <= 0 ? 0 : c >= 1 ? 1 : c;
	return x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
}

/** three's ACESFilmicToneMapping (the fitted RRT+ODT), per channel triple, exposure applied @param {number[]} rgb @param {number} exposure */
export function acesFilmic(rgb, exposure = 1) {
	// three's version scales by exposure / 0.6 and works in the ACES AP1 space
	const e = exposure / 0.6;
	const r = rgb[0] * e;
	const g = rgb[1] * e;
	const b = rgb[2] * e;
	// sRGB -> AP1 (ACESInputMat), column-major as three writes it
	const ir = 0.59719 * r + 0.35458 * g + 0.04823 * b;
	const ig = 0.076 * r + 0.90834 * g + 0.01566 * b;
	const ib = 0.0284 * r + 0.13383 * g + 0.83777 * b;
	/** @param {number} v */
	const rrt = (v) => (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.432951) + 0.238081);
	const tr = rrt(ir);
	const tg = rrt(ig);
	const tb = rrt(ib);
	// AP1 -> sRGB (ACESOutputMat)
	return [
		1.60475 * tr - 0.53108 * tg - 0.07367 * tb,
		-0.10208 * tr + 1.10813 * tg - 0.00605 * tb,
		-0.00327 * tr - 0.07276 * tg + 1.07602 * tb
	];
}

/**
 * A linear RGBA frame read back from a render target (BOTTOM row first, as WebGL reads) to
 * top-down sRGB bytes, applying the tone mapping the canvas would have.
 * @param {ArrayLike<number>} src RGBA, floats in linear light (or bytes when `bytes` is true)
 * @param {number} w @param {number} h
 * @param {{toneMapping?: 'none'|'linear'|'aces', exposure?: number, bytes?: boolean}} [opts]
 * @returns {Uint8ClampedArray}
 */
export function linearFrameToSrgb(src, w, h, opts = {}) {
	const out = new Uint8ClampedArray(w * h * 4);
	const exposure = Number.isFinite(opts.exposure) ? /** @type {number} */ (opts.exposure) : 1;
	const scale = opts.bytes ? 1 / 255 : 1;
	const tm = opts.toneMapping ?? 'none';
	/** byte inputs: one table instead of a pow per channel @type {Uint8ClampedArray|null} */
	let lut = null;
	if (opts.bytes && tm === 'none') {
		lut = new Uint8ClampedArray(256);
		for (let i = 0; i < 256; i++) lut[i] = Math.round(linearToSrgb(i / 255) * 255);
	}
	const rgb = [0, 0, 0];
	for (let y = 0; y < h; y++) {
		const from = (h - 1 - y) * w * 4;
		const to = y * w * 4;
		for (let x = 0; x < w; x++) {
			const i = from + x * 4;
			const o = to + x * 4;
			if (lut) {
				out[o] = lut[src[i]];
				out[o + 1] = lut[src[i + 1]];
				out[o + 2] = lut[src[i + 2]];
			} else {
				rgb[0] = src[i] * scale;
				rgb[1] = src[i + 1] * scale;
				rgb[2] = src[i + 2] * scale;
				const m = tm === 'aces' ? acesFilmic(rgb, exposure) : tm === 'linear' ? [rgb[0] * exposure, rgb[1] * exposure, rgb[2] * exposure] : rgb;
				out[o] = Math.round(linearToSrgb(m[0]) * 255);
				out[o + 1] = Math.round(linearToSrgb(m[1]) * 255);
				out[o + 2] = Math.round(linearToSrgb(m[2]) * 255);
			}
			out[o + 3] = 255;
		}
	}
	return out;
}
