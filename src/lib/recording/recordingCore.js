// 36-share (B13) — the recorder's PURE half (imports nothing): the options and their clamps, the
// camera paths (turntable orbit, flythrough through the saved camera views), the output size and
// crop, the bitrate, the container. recorder.js is the browser half (canvas, MediaRecorder,
// Explorer); everything here is a number in, a number out, so a unit suite pins it.

/** @typedef {[number, number, number]} Vec3 */

/** output sizes. `viewport` = whatever the canvas is (even dimensions, long side ≤ 3840) */
export const RESOLUTIONS = Object.freeze([
	{ id: 'viewport', label: 'Viewport size', w: 0, h: 0 },
	{ id: '720p', label: '1280 × 720 (HD)', w: 1280, h: 720 },
	{ id: '1080p', label: '1920 × 1080 (Full HD)', w: 1920, h: 1080 },
	{ id: 'square', label: '1080 × 1080 (square)', w: 1080, h: 1080 },
	{ id: 'vertical', label: '1080 × 1920 (vertical)', w: 1080, h: 1920 }
]);
export const FPS_CHOICES = Object.freeze([24, 30, 60]);
/** bits per pixel per frame — × w × h × fps = the encoder's target bitrate */
export const QUALITY_BPP = Object.freeze({ low: 0.05, medium: 0.1, high: 0.2 });
export const MIN_DURATION = 1;
export const MAX_DURATION = 60;
const MIN_BITRATE = 500_000;
const MAX_BITRATE = 25_000_000;

/** @typedef {{mode: 'turntable'|'flythrough', target: 'selection'|'scene', resolution: string, fps: number,
 *   duration: number, quality: 'low'|'medium'|'high', revolutions: number, direction: 'cw'|'ccw',
 *   frame: boolean, hideHelpers: boolean}} RecordingPrefs */

/** @type {RecordingPrefs} */
export const DEFAULT_RECORDING_PREFS = Object.freeze({
	mode: 'turntable',
	target: 'selection',
	resolution: '720p',
	fps: 30,
	duration: 8,
	quality: 'medium',
	revolutions: 1,
	direction: 'ccw',
	frame: true,
	hideHelpers: true
});

/** Typed, clamped prefs from whatever was stored (unknown keys dropped). @param {any} raw @returns {RecordingPrefs} */
export function coerceRecordingPrefs(raw) {
	const r = raw && typeof raw === 'object' ? raw : {};
	const d = DEFAULT_RECORDING_PREFS;
	/** @param {any} v @param {boolean} def */
	const bool = (v, def) => (typeof v === 'boolean' ? v : def);
	const num = Number(r.duration);
	const revs = Number(r.revolutions);
	return {
		mode: r.mode === 'flythrough' ? 'flythrough' : 'turntable',
		target: r.target === 'scene' ? 'scene' : 'selection',
		resolution: RESOLUTIONS.some((x) => x.id === r.resolution) ? r.resolution : d.resolution,
		fps: FPS_CHOICES.includes(Number(r.fps)) ? Number(r.fps) : d.fps,
		duration: Number.isFinite(num) ? Math.min(MAX_DURATION, Math.max(MIN_DURATION, Math.round(num * 10) / 10)) : d.duration,
		quality: r.quality in QUALITY_BPP ? r.quality : d.quality,
		revolutions: Number.isFinite(revs) ? Math.min(4, Math.max(0.25, Math.round(revs * 4) / 4)) : d.revolutions,
		direction: r.direction === 'cw' ? 'cw' : 'ccw',
		frame: bool(r.frame, d.frame),
		hideHelpers: bool(r.hideHelpers, d.hideHelpers)
	};
}

/** @param {number} n round to an even integer ≥ 2 (video encoders want even dimensions) */
const even = (n) => Math.max(2, Math.round(n / 2) * 2);

/**
 * The output frame size for a resolution choice and the canvas' drawing-buffer size.
 * @param {string} resolution @param {{w: number, h: number}} canvas @returns {{w: number, h: number}}
 */
export function outputSize(resolution, canvas) {
	const choice = RESOLUTIONS.find((x) => x.id === resolution);
	if (choice && choice.w) return { w: choice.w, h: choice.h };
	const w = Math.max(2, canvas.w || 1280);
	const h = Math.max(2, canvas.h || 720);
	const scale = Math.min(1, 3840 / Math.max(w, h));
	return { w: even(w * scale), h: even(h * scale) };
}

/**
 * The source rect that fills a `dw × dh` frame from a `sw × sh` canvas without stretching (centre
 * crop — "cover").
 * @param {number} sw @param {number} sh @param {number} dw @param {number} dh
 * @returns {{sx: number, sy: number, sw: number, sh: number}}
 */
export function coverRect(sw, sh, dw, dh) {
	const src = sw / sh;
	const dst = dw / dh;
	if (src > dst) {
		const w = sh * dst;
		return { sx: (sw - w) / 2, sy: 0, sw: w, sh };
	}
	const h = sw / dst;
	return { sx: 0, sy: (sh - h) / 2, sw, sh: h };
}

/**
 * How much the canvas' pixel ratio must grow so its cropped region holds at least the output's
 * pixels (no upscaled, soft video from a small viewport). 1 = already enough. Capped at 3 — past
 * that the GPU cost is not worth the last bit of sharpness.
 * @param {{w: number, h: number}} css the canvas' CSS size @param {number} dpr its current ratio
 * @param {{w: number, h: number}} out
 */
export function dprBoost(css, dpr, out) {
	if (!(css.w > 0 && css.h > 0 && dpr > 0)) return 1;
	const crop = coverRect(css.w, css.h, out.w, out.h);
	const need = Math.max(out.w / crop.sw, out.h / crop.sh);
	return Math.min(3 / dpr, Math.max(1, need / dpr));
}

/**
 * The encoder's target bitrate, bits/s.
 * @param {{w: number, h: number}} size @param {number} fps @param {string} quality
 */
export function bitrateFor(size, fps, quality) {
	const bpp = /** @type {any} */ (QUALITY_BPP)[quality] ?? QUALITY_BPP.medium;
	return Math.round(Math.min(MAX_BITRATE, Math.max(MIN_BITRATE, size.w * size.h * fps * bpp)));
}

/** the file the bitrate predicts, bytes @param {number} bitrate @param {number} seconds */
export function estimateBytes(bitrate, seconds) {
	return Math.round((bitrate * seconds) / 8);
}

/**
 * The first container the browser can record. webm first (what the request names, what every
 * Chromium and Firefox records); mp4 last (Safari).
 * @param {(mime: string) => boolean} isSupported @returns {{mime: string, ext: string} | null}
 */
export function pickMimeType(isSupported) {
	for (const mime of ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4']) {
		try {
			if (isSupported(mime)) return { mime, ext: mime.startsWith('video/mp4') ? 'mp4' : 'webm' };
		} catch {
			/* a browser that throws on an unknown type: try the next */
		}
	}
	return null;
}

/** `Turntable 2026-10-05 14-03-22.webm` @param {string} mode @param {Date} when @param {string} ext */
export function recordingFileName(mode, when, ext) {
	const p = (/** @type {number} */ n) => String(n).padStart(2, '0');
	const stamp = `${when.getFullYear()}-${p(when.getMonth() + 1)}-${p(when.getDate())} ${p(when.getHours())}-${p(when.getMinutes())}-${p(when.getSeconds())}`;
	return `${mode === 'flythrough' ? 'Flythrough' : 'Turntable'} ${stamp}.${ext || 'webm'}`;
}

/* ------------------------------------------------------------------ turntable ---- */

/** @typedef {{center: Vec3, distance: number, elevation: number, azimuth: number, revolutions: number, sign: number}} Orbit */

/**
 * The orbit a turntable flies: around `center`, starting where the camera looks from now (its
 * azimuth), at its elevation (clamped to 5°..75° so it neither skims the floor nor looks straight
 * down), at its distance — or, with `frame`, at the distance that fits a sphere of `radius` in the
 * narrower field of view.
 * @param {{position: Vec3, center: Vec3, radius: number, fovDeg: number, aspect: number, frame: boolean,
 *   revolutions: number, direction: 'cw'|'ccw'}} o @returns {Orbit}
 */
export function planOrbit(o) {
	const dx = o.position[0] - o.center[0];
	const dy = o.position[1] - o.center[1];
	const dz = o.position[2] - o.center[2];
	const flat = Math.hypot(dx, dz);
	const current = Math.hypot(flat, dy);
	const deg = Math.PI / 180;
	const elevation = Math.min(75 * deg, Math.max(5 * deg, Math.atan2(dy, flat || 1e-6)));
	const azimuth = flat > 1e-6 ? Math.atan2(dx, dz) : 0;
	let distance = current > 1e-3 ? current : 10;
	if (o.frame) {
		const vfov = Math.max(5, Math.min(170, o.fovDeg || 50)) * deg;
		const hfov = 2 * Math.atan(Math.tan(vfov / 2) * (o.aspect > 0 ? o.aspect : 1));
		const fov = Math.min(vfov, hfov);
		distance = Math.max(0.5, ((o.radius > 0 ? o.radius : 1) / Math.sin(fov / 2)) * 1.1);
	}
	return { center: o.center, distance, elevation, azimuth, revolutions: o.revolutions, sign: o.direction === 'cw' ? -1 : 1 };
}

/**
 * The camera at `t` ∈ [0, 1] of a turntable — constant angular speed, so a 1-revolution clip loops.
 * @param {Orbit} orbit @param {number} t @returns {{position: Vec3, target: Vec3}}
 */
export function turntablePose(orbit, t) {
	const u = Math.min(1, Math.max(0, t));
	const az = orbit.azimuth + orbit.sign * 2 * Math.PI * orbit.revolutions * u;
	const c = orbit.center;
	const flat = orbit.distance * Math.cos(orbit.elevation);
	return {
		position: [c[0] + flat * Math.sin(az), c[1] + orbit.distance * Math.sin(orbit.elevation), c[2] + flat * Math.cos(az)],
		target: [c[0], c[1], c[2]]
	};
}

/* ----------------------------------------------------------------- flythrough ---- */

/** @typedef {{position: Vec3, target: Vec3, fov: number | null}} PathPoint */

/** @param {number} a @param {number} b @param {number} c @param {number} d @param {number} s */
function catmull(a, b, c, d, s) {
	const s2 = s * s;
	const s3 = s2 * s;
	return 0.5 * (2 * b + (-a + c) * s + (2 * a - 5 * b + 4 * c - d) * s2 + (-a + 3 * b - 3 * c + d) * s3);
}
/** @param {Vec3} a @param {Vec3} b */
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/**
 * A flythrough through saved camera views, in order. Segments get time in proportion to how far
 * the camera travels (position, plus half the look-at travel so a turn on the spot still takes
 * time) — a constant pace rather than a rush through the long legs. Needs two views.
 * @param {{position: number[], target: number[], lens?: {fov?: number} | null}[]} views
 * @returns {{points: PathPoint[], cumulative: number[]} | null}
 */
export function planFlythrough(views) {
	/** @type {PathPoint[]} */
	const points = [];
	for (const v of views ?? []) {
		if (!Array.isArray(v?.position) || !Array.isArray(v?.target) || v.position.length < 3 || v.target.length < 3) continue;
		const p = /** @type {Vec3} */ (v.position.slice(0, 3).map(Number));
		const t = /** @type {Vec3} */ (v.target.slice(0, 3).map(Number));
		if (![...p, ...t].every(Number.isFinite)) continue;
		const fov = typeof v.lens?.fov === 'number' && Number.isFinite(v.lens.fov) ? v.lens.fov : null;
		points.push({ position: p, target: t, fov });
	}
	if (points.length < 2) return null;
	const cumulative = [0];
	for (let i = 1; i < points.length; i++) {
		const leg = dist(points[i - 1].position, points[i].position) + 0.5 * dist(points[i - 1].target, points[i].target);
		cumulative.push(cumulative[i - 1] + Math.max(1e-3, leg));
	}
	return { points, cumulative };
}

/** ease-in-out (sine): the flythrough starts and lands gently @param {number} t */
export const easeInOut = (t) => 0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, Math.max(0, t)));

/**
 * The camera at `t` ∈ [0, 1] of a flythrough: a Catmull-Rom spline through every view's position
 * and look-at point (it passes THROUGH each saved view), the lens eased between views that have
 * one. `fov` is null when neither end of the leg stored a lens.
 * @param {{points: PathPoint[], cumulative: number[]}} path @param {number} t
 * @returns {{position: Vec3, target: Vec3, fov: number | null}}
 */
export function flythroughPose(path, t) {
	const { points, cumulative } = path;
	const total = cumulative[cumulative.length - 1];
	const at = easeInOut(t) * total;
	let i = 1;
	while (i < cumulative.length - 1 && cumulative[i] < at) i++;
	const s = Math.min(1, Math.max(0, (at - cumulative[i - 1]) / (cumulative[i] - cumulative[i - 1])));
	const p0 = points[Math.max(0, i - 2)];
	const p1 = points[i - 1];
	const p2 = points[i];
	const p3 = points[Math.min(points.length - 1, i + 1)];
	/** @param {'position'|'target'} key @returns {Vec3} */
	const spline = (key) => /** @type {Vec3} */ ([0, 1, 2].map((k) => catmull(p0[key][k], p1[key][k], p2[key][k], p3[key][k], s)));
	const fa = p1.fov ?? p2.fov;
	const fb = p2.fov ?? p1.fov;
	return { position: spline('position'), target: spline('target'), fov: fa === null || fb === null ? null : fa + (fb - fa) * s };
}

/**
 * The bounding sphere of a set of world-space boxes `{min, max}` — what a turntable orbits.
 * Null when there is nothing to frame.
 * @param {{min: number[], max: number[]}[]} boxes @returns {{center: Vec3, radius: number} | null}
 */
export function sphereOfBoxes(boxes) {
	const lo = [Infinity, Infinity, Infinity];
	const hi = [-Infinity, -Infinity, -Infinity];
	for (const b of boxes ?? []) {
		if (!b?.min || !b?.max) continue;
		for (let k = 0; k < 3; k++) {
			if (!Number.isFinite(b.min[k]) || !Number.isFinite(b.max[k])) continue;
			lo[k] = Math.min(lo[k], b.min[k]);
			hi[k] = Math.max(hi[k], b.max[k]);
		}
	}
	if (!lo.every(Number.isFinite) || !hi.every(Number.isFinite)) return null;
	/** @type {Vec3} */
	const center = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
	return { center, radius: Math.max(0.25, Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2) };
}
