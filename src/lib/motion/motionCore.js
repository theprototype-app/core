// 40 F15 — GENERAL-PURPOSE MOTION, the pure half (no THREE, no DOM, no stores — unit-tested).
//
// Four effect nodes share this file's math; motionNodes.js is the THREE half flowRuntime calls:
//   Follow Path (`followpath`)      — ride a smooth path (a drawn Spline, a Flow path or clicked
//                                    waypoints) at a speed, facing along it, banking into turns.
//   Orient to Velocity (`orientvelocity`) — face wherever the object is moving (after any mover:
//                                    Wander, Orbit, Bounce, a script), turning smoothly, banking.
//   Wander (`wander`)               — drift around a smooth, bounded, seeded noise target inside an
//                                    area object's box (a water volume, a room) or a box around
//                                    where it was placed.
//   Body Wave (`bodywave`)          — a travelling bend along the body (a vertex shader): a fish's
//                                    spine, a snake, a flag, a tail; its amplitude and frequency
//                                    follow the object's speed and turn rate.
// The movers (Follow Path, Wander) are pure functions of (data, shared time) — determinism is the
// netcode, exactly like Spin and Path patrol. The followers (Orient, Body Wave) read the motion
// the movers produced, so they keep a little per-peer state; what they write is a look, not a
// pose anyone else needs, and every peer converges on the same one.

/** @typedef {[number, number, number]} V3 */

export const MOTION_VERSION = 1;
/** where the forward axis of a model can point; Path patrol's convention (+Z) is the default */
export const FORWARD_AXES = ['+z', '-z', '+x', '-x'];
/** samples per control-point span when a path is densified */
export const SAMPLES_PER_SPAN = 16;
/** the most control points a path keeps (the spline tool's own cap) */
export const MAX_PATH_POINTS = 200;

/** @param {any} v @param {number} d @param {number} lo @param {number} hi */
export function clampNum(v, d, lo, hi) {
	const n = Number(v);
	if (v === null || v === undefined || v === '' || !Number.isFinite(n)) return d;
	return Math.min(hi, Math.max(lo, n));
}

/** @param {number[]} a @param {number[]} b */
const dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);

/** finite [x, y, z] points only, capped @param {any} pts @returns {V3[]} */
export function cleanPoints(pts) {
	if (!Array.isArray(pts)) return [];
	/** @type {V3[]} */
	const out = [];
	for (const p of pts) {
		const q = Array.isArray(p) ? p : Array.isArray(p?.pos) ? p.pos : null;
		if (!q || q.length < 3) continue;
		const v = /** @type {V3} */ ([+q[0], +q[1], +q[2]]);
		if (!v.every(Number.isFinite)) continue;
		// a doubled click adds nothing but a zero-length span
		if (out.length && dist(out[out.length - 1], v) < 1e-6) continue;
		out.push(v);
		if (out.length >= MAX_PATH_POINTS) break;
	}
	return out;
}

/**
 * One centripetal Catmull-Rom span (alpha 0.5 — no cusps or self-loops on uneven spacing, the
 * spline tool's own curve) between p1 and p2 at u ∈ [0, 1].
 * @param {number[]} p0 @param {number[]} p1 @param {number[]} p2 @param {number[]} p3 @param {number} u
 * @returns {V3}
 */
export function catmullRom(p0, p1, p2, p3, u) {
	const knot = (/** @type {number[]} */ a, /** @type {number[]} */ b) => Math.max(1e-4, Math.sqrt(dist(a, b)));
	const t0 = 0;
	const t1 = t0 + knot(p0, p1);
	const t2 = t1 + knot(p1, p2);
	const t3 = t2 + knot(p2, p3);
	const t = t1 + (t2 - t1) * u;
	/** @type {V3} */
	const out = [0, 0, 0];
	for (let i = 0; i < 3; i++) {
		const a1 = ((t1 - t) / (t1 - t0)) * p0[i] + ((t - t0) / (t1 - t0)) * p1[i];
		const a2 = ((t2 - t) / (t2 - t1)) * p1[i] + ((t - t1) / (t2 - t1)) * p2[i];
		const a3 = ((t3 - t) / (t3 - t2)) * p2[i] + ((t - t2) / (t3 - t2)) * p3[i];
		const b1 = ((t2 - t) / (t2 - t0)) * a1 + ((t - t0) / (t2 - t0)) * a2;
		const b2 = ((t3 - t) / (t3 - t1)) * a2 + ((t - t1) / (t3 - t1)) * a3;
		out[i] = ((t2 - t) / (t2 - t1)) * b1 + ((t - t1) / (t2 - t1)) * b2;
	}
	return out;
}

/**
 * A path ready to walk: the control points densified (smooth) or kept as a polyline, with the
 * cumulative arc length per sample. A closed path's last sample IS its first.
 * @param {any} points @param {{closed?: boolean, smooth?: boolean, samples?: number}} [opts]
 * @returns {{pts: V3[], cum: number[], total: number, closed: boolean} | null}
 */
export function buildPath(points, opts = {}) {
	const ctrl = cleanPoints(points);
	if (ctrl.length < 2) return null;
	const closed = !!opts.closed && ctrl.length >= 3;
	const smooth = opts.smooth !== false && ctrl.length >= 3;
	const per = Math.max(1, Math.min(64, Math.round(opts.samples ?? SAMPLES_PER_SPAN)));
	const n = ctrl.length;
	/** @type {V3[]} */
	let pts;
	if (!smooth) pts = closed ? [...ctrl, ctrl[0]] : ctrl.slice();
	else {
		const at = (/** @type {number} */ i) => {
			if (closed) return ctrl[((i % n) + n) % n];
			if (i < 0) return mirror(ctrl[0], ctrl[1]);
			if (i >= n) return mirror(ctrl[n - 1], ctrl[n - 2]);
			return ctrl[i];
		};
		pts = [];
		const spans = closed ? n : n - 1;
		for (let s = 0; s < spans; s++) {
			for (let k = 0; k < per; k++) pts.push(catmullRom(at(s - 1), at(s), at(s + 1), at(s + 2), k / per));
		}
		pts.push(closed ? ctrl[0] : ctrl[n - 1]);
	}
	const cum = [0];
	for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + dist(pts[i - 1], pts[i]));
	const total = cum[cum.length - 1];
	if (!(total > 1e-6)) return null;
	return { pts, cum, total, closed };
}

/** the phantom point beyond an open end (keeps the end tangent straight) @param {V3} end @param {V3} prev @returns {V3} */
function mirror(end, prev) {
	return [2 * end[0] - prev[0], 2 * end[1] - prev[1], 2 * end[2] - prev[2]];
}

/**
 * Position and unit tangent at arc length s (clamped to the path).
 * @param {{pts: V3[], cum: number[], total: number}} path @param {number} s
 * @returns {{p: V3, t: V3}}
 */
export function samplePath(path, s) {
	const { pts, cum, total } = path;
	const x = Math.min(total, Math.max(0, s));
	// binary search the span
	let lo = 0;
	let hi = cum.length - 1;
	while (hi - lo > 1) {
		const mid = (lo + hi) >> 1;
		if (cum[mid] <= x) lo = mid;
		else hi = mid;
	}
	const a = pts[lo];
	const b = pts[hi];
	const len = cum[hi] - cum[lo];
	const u = len > 0 ? (x - cum[lo]) / len : 0;
	/** @type {V3} */
	const p = [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
	const l = len || 1;
	/** @type {V3} */
	const t = [(b[0] - a[0]) / l, (b[1] - a[1]) / l, (b[2] - a[2]) / l];
	return { p, t };
}

/**
 * Where along the path at `time`: s (arc length) and dir (+1 forward / -1 on a ping-pong's way
 * back). `offset` (0..1) shifts the start along the path, so several riders of one path spread
 * out; a negative speed rides it backwards.
 * @param {number} time @param {number} speed m/s @param {number} total @param {string} mode
 * 'loop' | 'pingpong' | 'once' @param {number} [offset]
 */
export function pathDistance(time, speed, total, mode, offset = 0) {
	const t = Math.max(0, time);
	const start = (((offset % 1) + 1) % 1) * total;
	const run = speed * t;
	if (mode === 'once') {
		const s = Math.min(total, Math.max(0, start + run));
		return { s, dir: speed < 0 ? -1 : 1 };
	}
	if (mode === 'pingpong') {
		const period = 2 * total;
		const c = (((start + run) % period) + period) % period;
		const back = c > total;
		const s = back ? period - c : c;
		const forward = speed >= 0 ? !back : back;
		return { s, dir: forward ? 1 : -1 };
	}
	const s = (((start + run) % total) + total) % total;
	return { s, dir: speed < 0 ? -1 : 1 };
}

/**
 * Signed horizontal curvature (1/m) at s: positive = the path turns LEFT (counter-clockwise seen
 * from above, +Y up). Measured over ±h of arc so a densified polyline's corners do not alias.
 * @param {{pts: V3[], cum: number[], total: number, closed: boolean}} path @param {number} s @param {number} [h]
 */
export function curvatureAt(path, s, h = 0.15) {
	const span = Math.min(h, path.total / 4);
	const wrap = (/** @type {number} */ x) => (path.closed ? ((x % path.total) + path.total) % path.total : x);
	const a = samplePath(path, wrap(s - span)).t;
	const b = samplePath(path, wrap(s + span)).t;
	const ya = Math.atan2(a[0], a[2]);
	const yb = Math.atan2(b[0], b[2]);
	return wrapAngle(yb - ya) / (2 * span);
}

/** an angle into (-π, π] @param {number} a */
export function wrapAngle(a) {
	let x = a % (Math.PI * 2);
	if (x > Math.PI) x -= Math.PI * 2;
	if (x <= -Math.PI) x += Math.PI * 2;
	return x;
}

/**
 * The roll (radians) a mover leans INTO a turn: a coordinated turn's lean, shaped so the user
 * sets it with two numbers — `bank` (0..1, how much) and `maxBank` (degrees, the ceiling).
 * yawRate in rad/s (positive = turning left); the result is positive when the mover's top leans
 * to its left. tanh keeps it smooth and bounded: 1 rad/s of turn ≈ 76 % of the ceiling.
 * @param {number} yawRate @param {number} bank @param {number} maxBankDeg
 */
export function bankRoll(yawRate, bank, maxBankDeg) {
	const b = Math.min(1, Math.max(0, bank));
	const max = (Math.min(85, Math.max(0, maxBankDeg)) * Math.PI) / 180;
	return b * max * Math.tanh(yawRate);
}

// ---- Wander: smooth bounded noise -------------------------------------------------------------

/** a 32-bit hash of a string or number → [0, 1) @param {any} seed */
export function hash01(seed) {
	const s = String(seed ?? '');
	let h = 2166136261;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	h ^= h >>> 13;
	h = Math.imul(h, 0x5bd1e995);
	h ^= h >>> 15;
	return (h >>> 0) / 4294967296;
}

// three octaves at incommensurate rates (golden-ratio steps): smooth (C∞), never periodic in
// practice, bounded by construction — the sum of the weights is the divisor
const OCT = [
	{ f: 1, w: 1 },
	{ f: 1.618034, w: 0.5 },
	{ f: 2.618034, w: 0.25 }
];
const OCT_SUM = OCT.reduce((a, o) => a + o.w, 0);

/**
 * Smooth noise in [-1, 1] on one channel at time t. `seed` picks the phases (and slightly the
 * rates), so two wanderers with different seeds never move in step.
 * @param {number} t @param {number} seed01 a [0, 1) seed @param {number} channel 0, 1, 2
 */
export function smoothNoise(t, seed01, channel) {
	let v = 0;
	for (let i = 0; i < OCT.length; i++) {
		const k = hash01(seed01 * 1000 + channel * 31 + i * 7);
		const rate = OCT[i].f * (0.85 + 0.3 * k);
		v += OCT[i].w * Math.sin(t * rate + k * Math.PI * 2);
	}
	return v / OCT_SUM;
}

/** d/dt of smoothNoise (for an analytic velocity) @param {number} t @param {number} seed01 @param {number} channel */
export function smoothNoiseRate(t, seed01, channel) {
	let v = 0;
	for (let i = 0; i < OCT.length; i++) {
		const k = hash01(seed01 * 1000 + channel * 31 + i * 7);
		const rate = OCT[i].f * (0.85 + 0.3 * k);
		v += OCT[i].w * rate * Math.cos(t * rate + k * Math.PI * 2);
	}
	return v / OCT_SUM;
}

/**
 * The wander target at time t inside a box (centre + half extents, any frame): each axis is its
 * own noise channel, scaled to the half extent. `speed` is how fast the noise is walked (1 = the
 * base octave turns about once every 6 s); `seed01` makes riders of one node differ.
 * @param {number} t @param {V3} center @param {V3} half @param {number} speed @param {number} seed01
 * @returns {{p: V3, v: V3}} position and its time derivative (m/s)
 */
export function wanderAt(t, center, half, speed, seed01) {
	const tt = Math.max(0, t) * speed;
	/** @type {V3} */
	const p = [0, 0, 0];
	/** @type {V3} */
	const v = [0, 0, 0];
	for (let c = 0; c < 3; c++) {
		p[c] = center[c] + half[c] * smoothNoise(tt, seed01, c);
		v[c] = half[c] * speed * smoothNoiseRate(tt, seed01, c);
	}
	return { p, v };
}

// ---- Body Wave: the travelling bend ------------------------------------------------------------

export const BODY_WAVE_DEFAULTS = Object.freeze({
	forward: '+z',
	side: 'x',
	amplitude: 0.08, // of the body length, at the tail
	wavelength: 1, // body lengths per wave
	frequency: 1.5, // Hz at rest
	stiffness: 0.3, // the front fraction that does not bend (a fish's head)
	falloff: 2, // envelope power (2 = the tail swings most)
	speedGain: 1, // extra Hz per m/s (a fast swimmer beats faster)
	ampGain: 0.5, // extra amplitude (fraction) per m/s
	turnBend: 0.5, // bend into a turn: fraction of body length per rad/s of turn
	reverse: false // the wave travels tail → head instead (a flag rippling toward its pole)
});

/**
 * The envelope at u (0 = the front/head, 1 = the tail): nothing ahead of `stiffness`, rising to
 * 1 at the tail as a power curve. Pure, so the shader and the tests agree.
 * @param {number} u @param {number} stiffness @param {number} falloff
 */
export function waveEnvelope(u, stiffness, falloff) {
	const s = Math.min(0.95, Math.max(0, stiffness));
	const x = Math.min(1, Math.max(0, (u - s) / (1 - s)));
	return Math.pow(x, Math.max(0.25, falloff));
}

/**
 * The live wave numbers for a speed (m/s) and turn rate (rad/s, + = left): frequency and
 * amplitude grow with speed (clamped to sane ceilings), the static bend follows the turn.
 * @param {any} data node data @param {number} speed @param {number} yawRate
 */
export function waveDrive(data, speed, yawRate) {
	const d = BODY_WAVE_DEFAULTS;
	const v = Math.max(0, Math.min(10, speed || 0));
	const frequency = clampNum(data.frequency, d.frequency, 0, 10) + clampNum(data.speedGain, d.speedGain, 0, 10) * v;
	const amplitude = clampNum(data.amplitude, d.amplitude, 0, 0.5) * (1 + clampNum(data.ampGain, d.ampGain, 0, 5) * v);
	const bend = clampNum(data.turnBend, d.turnBend, 0, 2) * Math.max(-2, Math.min(2, yawRate || 0));
	return { frequency: Math.min(20, frequency), amplitude: Math.min(0.6, amplitude), bend: Math.max(-0.6, Math.min(0.6, bend)) };
}

/**
 * The sideways offset (fraction of body length) at u for an accumulated phase (cycles). The
 * shader runs this exact formula; the tests pin it.
 * @param {number} u @param {number} phase cycles @param {{amplitude: number, bend: number}} drive
 * @param {{wavelength: number, stiffness: number, falloff: number, reverse?: boolean}} shape
 */
export function waveOffset(u, phase, drive, shape) {
	const env = waveEnvelope(u, shape.stiffness, shape.falloff);
	const k = 1 / Math.max(0.05, shape.wavelength);
	const dir = shape.reverse ? -1 : 1;
	// head → tail: the crest moves toward larger u as the phase grows
	const wave = Math.sin(Math.PI * 2 * (u * k - dir * phase));
	// a turn bends the body like a bow: no lean at the head, most at the tail (u²)
	return drive.amplitude * env * wave + drive.bend * u * u;
}

/** the unit vector of a forward-axis name @param {string} name @returns {V3} */
export function forwardVector(name) {
	switch (name) {
		case '-z':
			return [0, 0, -1];
		case '+x':
			return [1, 0, 0];
		case '-x':
			return [-1, 0, 0];
		default:
			return [0, 0, 1];
	}
}

/**
 * The Euler Y (radians) that turns a model whose nose is `forward` so it faces +Z — the
 * correction every mover applies after building a +Z-forward frame.
 * @param {string} forward
 */
export function forwardYaw(forward) {
	switch (forward) {
		case '-z':
			return Math.PI;
		case '+x':
			return -Math.PI / 2;
		case '-x':
			return Math.PI / 2;
		default:
			return 0;
	}
}

/**
 * Exponential smoothing factor for a rate (1/s) over dt — frame-rate independent.
 * @param {number} rate @param {number} dt
 */
export function damp(rate, dt) {
	if (!(rate > 0)) return 1;
	return 1 - Math.exp(-rate * Math.max(0, dt));
}

// ---- 78 F4: the Path object's SCHEDULE --------------------------------------------------------
//
// Where a walker on a Path object is at shared time t, with per-point waits, per-span speed /
// ease / gaps, and the four walk modes. `buildSchedule` turns the path into ONE CYCLE of
// segments (wait at a point · move along a span), and `scheduleAt` is a binary search into it:
// a PURE function of (path, t) — the same numbers give the same pose on every peer, with no
// message, exactly like Spin and Follow Path (determinism IS the netcode). Random mode is pure
// too: its "random" next points are a seeded hash, laid out once into a fixed cycle of
// RANDOM_HOPS hops that ends back at the start, so the cycle repeats seamlessly.

/** hops in one random-mode cycle (long enough that nobody sees it repeat) */
export const RANDOM_HOPS = 64;
/** the most arrival events one scheduleEvents call reports (a long pause never floods) */
export const MAX_EVENTS_PER_CALL = 64;

/** @param {number} u @param {string | undefined} ease */
export function easeProgress(u, ease) {
	const x = Math.min(1, Math.max(0, u));
	switch (ease) {
		case 'in':
			return x * x;
		case 'out':
			return 1 - (1 - x) * (1 - x);
		case 'inout':
			return x < 0.5 ? 2 * x * x : 1 - 2 * (1 - x) * (1 - x);
		default:
			return x;
	}
}

/**
 * @typedef {{pos: number[], wait?: number, speed?: number, ease?: string, gap?: boolean, event?: string, facing?: number}} SchedPoint
 * @typedef {{kind: 'wait', t0: number, t1: number, point: number, pass?: boolean}
 *   | {kind: 'move', t0: number, t1: number, span: number, dir: 1 | -1, from: number, to: number, ease: string, jump: boolean, pass?: boolean}} Segment
 * @typedef {{segs: Segment[], period: number, mode: string, spans: {pts: V3[], cum: number[], total: number}[], points: SchedPoint[], closed: boolean}} Schedule
 */

/** the samples of span k (from point k to k+1, wrapping when closed) @param {V3[]} ctrl @param {number} k @param {boolean} closed @param {boolean} smooth @param {number} per */
function spanSamples(ctrl, k, closed, smooth, per) {
	const n = ctrl.length;
	const a = ctrl[k];
	const b = ctrl[(k + 1) % n];
	/** @type {V3[]} */
	let pts;
	if (!smooth || n < 3) pts = [a, b];
	else {
		const at = (/** @type {number} */ i) => {
			if (closed) return ctrl[((i % n) + n) % n];
			if (i < 0) return mirror(ctrl[0], ctrl[1]);
			if (i >= n) return mirror(ctrl[n - 1], ctrl[n - 2]);
			return ctrl[i];
		};
		pts = [];
		for (let s = 0; s < per; s++) pts.push(catmullRom(at(k - 1), at(k), at(k + 1), at(k + 2), s / per));
		pts.push(b);
	}
	const cum = [0];
	for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + dist(pts[i - 1], pts[i]));
	return { pts, cum, total: cum[cum.length - 1] };
}

/**
 * One cycle of a Path's walk. `points` are WORLD positions with the Path point fields; `opts`
 * carries the path block (mode, default speed, smooth, seed) and `closed`.
 * @param {any[]} points @param {{closed?: boolean, smooth?: boolean, mode?: string, speed?: number, seed?: number, samples?: number}} [opts]
 * @returns {Schedule | null}
 */
export function buildSchedule(points, opts = {}) {
	if (!Array.isArray(points)) return null;
	/** @type {SchedPoint[]} */
	const pts = [];
	for (const p of points.slice(0, MAX_PATH_POINTS)) {
		const q = Array.isArray(p) ? p : p?.pos;
		if (!Array.isArray(q) || q.length < 3) continue;
		const pos = [+q[0], +q[1], +q[2]];
		if (!pos.every(Number.isFinite)) continue;
		pts.push({ ...(Array.isArray(p) ? {} : p), pos });
	}
	const n = pts.length;
	if (n < 2) return null;
	const closed = !!opts.closed && n >= 3;
	const smooth = opts.smooth !== false;
	const per = Math.max(1, Math.min(64, Math.round(opts.samples ?? SAMPLES_PER_SPAN)));
	const mode = ['loop', 'pingpong', 'once', 'random'].includes(/** @type {string} */ (opts.mode)) ? /** @type {string} */ (opts.mode) : 'loop';
	const baseSpeed = clampNum(opts.speed, 1.5, 0.01, 50);
	const ctrl = /** @type {V3[]} */ (pts.map((p) => p.pos));
	const nSpans = closed ? n : n - 1;
	const spans = [];
	for (let k = 0; k < nSpans; k++) spans.push(spanSamples(ctrl, k, closed, smooth, per));

	/** @type {Segment[]} */
	const segs = [];
	let t = 0;
	const wait = (/** @type {number} */ i, pass = false) => {
		const w = pass ? 0 : clampNum(pts[i].wait, 0, 0, 3600);
		if (w > 0) {
			segs.push({ kind: 'wait', t0: t, t1: t + w, point: i });
			t += w;
		}
	};
	/** travel span k in direction dir (+1: k -> k+1) @param {number} k @param {1 | -1} dir @param {boolean} [pass] */
	const move = (k, dir, pass = false) => {
		const owner = pts[k];
		const len = spans[k].total;
		const jump = owner.gap === true;
		const speed = clampNum(owner.speed, baseSpeed, 0.01, 50);
		const d = jump ? 0 : len / speed;
		const from = dir > 0 ? k : (k + 1) % n;
		const to = dir > 0 ? (k + 1) % n : k;
		segs.push({ kind: 'move', t0: t, t1: t + d, span: k, dir, from, to, ease: owner.ease ?? 'linear', jump, ...(pass ? { pass: true } : {}) });
		t += d;
	};

	if (mode === 'random') {
		// hop to a seeded-random other point, the short way round (open: the only way), passing
		// the points between without stopping; the last hop returns to 0 so the cycle repeats
		let at = 0;
		const seed = clampNum(opts.seed, 0, 0, 1e9);
		for (let h = 0; h < RANDOM_HOPS; h++) {
			let target;
			if (h === RANDOM_HOPS - 1) target = 0;
			else {
				target = Math.floor(hash01('path:' + seed + ':' + h) * (n - 1));
				if (target >= at) target++;
			}
			if (target === at) continue;
			wait(at);
			let dir = /** @type {1 | -1} */ (target > at ? 1 : -1);
			let steps = Math.abs(target - at);
			if (closed) {
				const fwd = (((target - at) % n) + n) % n;
				dir = fwd <= n - fwd ? 1 : -1;
				steps = dir > 0 ? fwd : n - fwd;
			}
			for (let s = 0; s < steps; s++) {
				const k = dir > 0 ? at : (((at - 1) % n) + n) % n;
				move(k, dir, s < steps - 1);
				at = dir > 0 ? (at + 1) % n : (((at - 1) % n) + n) % n;
			}
		}
	} else {
		for (let k = 0; k < nSpans; k++) {
			wait(k);
			move(k, 1);
		}
		if (mode === 'pingpong') {
			const end = closed ? 0 : n - 1;
			wait(end);
			for (let k = nSpans - 1; k >= 0; k--) {
				if (k < nSpans - 1) wait((k + 1) % n);
				move(k, -1);
			}
		} else if (mode === 'once') {
			if (!closed) wait(n - 1);
		} else if (!closed) {
			// loop on an OPEN path: stand at the end, then start again from the first point
			wait(n - 1);
			segs.push({ kind: 'move', t0: t, t1: t, span: nSpans - 1, dir: 1, from: n - 1, to: 0, ease: 'linear', jump: true, pass: false });
		}
	}
	return { segs, period: t, mode, spans, points: pts, closed };
}

/** the segment index live at cycle-local time x (the LAST one whose t0 <= x and t1 > x) @param {Segment[]} segs @param {number} x */
function segmentAt(segs, x) {
	let lo = 0;
	let hi = segs.length - 1;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (segs[mid].t0 <= x) lo = mid;
		else hi = mid - 1;
	}
	// zero-length segments (jumps) never own time: step past them
	while (lo < segs.length - 1 && segs[lo].t1 <= x) lo++;
	return lo;
}

/** the travel direction at the END of move segment i (its arrival heading) @param {Schedule} sched @param {any} seg */
function arrivalTangent(sched, seg) {
	const path = sched.spans[seg.span];
	const s = seg.dir > 0 ? path.total : 0;
	const tan = samplePath(path, s).t;
	return /** @type {V3} */ (tan.map((v) => v * seg.dir));
}

/**
 * Where the walker is at `time`. `start` is the shared moment the walk began (a trigger's stamp
 * for a once-walk; 0 for the clock-anchored loops), `offset` seconds shift a walker along it.
 * @param {Schedule} sched @param {number} time @param {{start?: number, offset?: number}} [o]
 * @returns {{p: V3, t: V3, yaw: number, kind: 'wait'|'move', point: number, next: number, progress: number, cycle: number, local: number}}
 */
export function scheduleAt(sched, time, o = {}) {
	const segs = sched.segs;
	const start = Number.isFinite(o.start) ? /** @type {number} */ (o.start) : 0;
	let local = time - start + (Number.isFinite(o.offset) ? /** @type {number} */ (o.offset) : 0);
	let cycle = 0;
	const P = sched.period;
	const once = sched.mode === 'once';
	if (!segs.length || !(P > 0)) {
		// nothing takes time (every span a gap, no waits): stand at the first point
		const p0 = /** @type {V3} */ ([...sched.points[0].pos]);
		return { p: p0, t: [0, 0, 1], yaw: 0, kind: 'wait', point: 0, next: 0, progress: 0, cycle: 0, local: 0 };
	}
	if (once) local = Math.min(P, Math.max(0, local));
	else {
		cycle = Math.floor(local / P);
		local -= cycle * P;
	}
	// once, at (or past) the end: stand at the last arrival
	const atEnd = once && local >= P;
	const i = atEnd ? segs.length - 1 : segmentAt(segs, local);
	const seg = segs[i];
	/** @type {V3} */
	let p;
	/** @type {V3} */
	let tan;
	let progress = 0;
	if (seg.kind === 'move' && !atEnd) {
		const path = sched.spans[seg.span];
		const d = seg.t1 - seg.t0;
		const u = d > 0 ? easeProgress((local - seg.t0) / d, seg.ease) : 1;
		progress = u;
		const s = seg.dir > 0 ? u * path.total : (1 - u) * path.total;
		const here = samplePath(path, s);
		p = here.p;
		tan = /** @type {V3} */ (here.t.map((v) => v * seg.dir));
	} else {
		const pointIdx = seg.kind === 'wait' ? seg.point : seg.to;
		p = /** @type {V3} */ ([...sched.points[pointIdx].pos]);
		progress = seg.kind === 'wait' && seg.t1 > seg.t0 ? (local - seg.t0) / (seg.t1 - seg.t0) : 1;
		tan = standingTangent(sched, seg.kind === 'move' ? i + 1 : i);
	}
	const standing = seg.kind === 'wait' || atEnd;
	const pointIdx = seg.kind === 'wait' ? seg.point : atEnd ? seg.kind === 'move' ? seg.to : seg.point : seg.from;
	const facing = standing ? sched.points[pointIdx]?.facing : undefined;
	const yaw = typeof facing === 'number' ? (facing * Math.PI) / 180 : Math.atan2(tan[0], tan[2]);
	const next = seg.kind === 'move' ? seg.to : nextStopAfter(segs, i, pointIdx);
	return { p, t: tan, yaw, kind: standing ? 'wait' : 'move', point: pointIdx, next, progress, cycle, local };
}

/**
 * The heading held while standing at segment index `i`: the last arrival's in this cycle; at a
 * cycle's start, the previous cycle's last arrival (a once-walk: its first departure).
 * @param {Schedule} sched @param {number} i @returns {V3}
 */
function standingTangent(sched, i) {
	const segs = sched.segs;
	const real = (/** @type {Segment} */ s) => s.kind === 'move' && !s.jump;
	for (let j = Math.min(i, segs.length) - 1; j >= 0; j--) if (real(segs[j])) return arrivalTangent(sched, segs[j]);
	if (sched.mode === 'once') {
		const first = segs.find(real);
		return first ? departTangent(sched, first) : [0, 0, 1];
	}
	for (let j = segs.length - 1; j >= 0; j--) if (real(segs[j])) return arrivalTangent(sched, segs[j]);
	return [0, 0, 1];
}

/** the departure heading of a move (for standing before the first move of a once-walk) @param {Schedule} sched @param {any} seg */
function departTangent(sched, seg) {
	const path = sched.spans[seg.span];
	const tan = samplePath(path, seg.dir > 0 ? 0 : path.total).t;
	return /** @type {V3} */ (tan.map((v) => v * seg.dir));
}

/** @param {Segment[]} segs @param {number} i @param {number} here */
function nextStopAfter(segs, i, here) {
	for (let j = i + 1; j < segs.length; j++) {
		const s = segs[j];
		if (s.kind === 'move') return s.to;
	}
	return here;
}

/**
 * The arrivals at points between two shared times (a, b] — what fires a point's `event`. Each
 * comes with the EXACT shared time it happened at, so every peer stamps the same moment. A
 * window longer than four cycles reports only the last cycle's, capped at MAX_EVENTS_PER_CALL.
 * @param {Schedule} sched @param {number} a @param {number} b @param {{start?: number, offset?: number}} [o]
 * @returns {{at: number, point: number, event: string}[]}
 */
export function scheduleEvents(sched, a, b, o = {}) {
	/** @type {{at: number, point: number, event: string}[]} */
	const out = [];
	if (!(b > a) || !sched.segs.length) return out;
	const P = sched.period;
	if (!(P > 0)) return out;
	const start = Number.isFinite(o.start) ? /** @type {number} */ (o.start) : 0;
	const shift = start - (Number.isFinite(o.offset) ? /** @type {number} */ (o.offset) : 0);
	let la = a - shift;
	const lb = b - shift;
	if (sched.mode === 'once') {
		if (lb <= 0 || la >= P) return out;
	} else if (lb - la > 4 * P) la = lb - P;
	const firstCycle = sched.mode === 'once' ? 0 : Math.floor(la / P);
	const lastCycle = sched.mode === 'once' ? 0 : Math.floor(lb / P);
	for (let c = firstCycle; c <= lastCycle && out.length < MAX_EVENTS_PER_CALL; c++) {
		for (const s of sched.segs) {
			if (s.kind !== 'move') continue;
			const at = c * P + s.t1;
			if (at <= la || at > lb) continue;
			const ev = sched.points[s.to]?.event;
			if (ev) out.push({ at: at + shift, point: s.to, event: ev });
			if (out.length >= MAX_EVENTS_PER_CALL) break;
		}
	}
	return out;
}
