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
