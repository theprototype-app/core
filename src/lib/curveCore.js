// 68 — ONE property-track keyframe model (design note: cloud plans/core/pending/keyframe-model.md).
//
// Imports nothing (the unit-layer entry rule). Everything here is a pure function of its
// arguments: normalizing a curve, evaluating it, the mutators both editors call, and the
// reduction that turns a 30 Hz recording into a few keys inside an error budget. The
// sequencer's `prop` tracks (68 Film mode) are the first user; 65 M1 and 57 reuse it.
//
// THE MODEL
//   type = 'number' | 'step' | 'vec3' | 'quat' | 'color'
//   Key  = { id, t, v, i: 'bezier'|'linear'|'constant', h: 'auto'|'autoClamped'|'aligned'|'free'|'vector',
//            in?: [dt, ...dv], out?: [dt, ...dv], src?: 'rec'|'user' }
//   · `i` shapes the segment that FOLLOWS the key (the Blender convention).
//   · Handles are ABSOLUTE (seconds, value units) and relative to their key, as Blender stores
//     them: `out` = [dt >= 0, dv...], `in` = [dt <= 0, dv...]. One dv per component, so a vec3
//     handle is [dt, dx, dy, dz]. Each handle's dt is clamped to its segment so time stays
//     monotonic.
//   · `auto` / `autoClamped` / `vector` handles are RECOMPUTED from the neighbours in
//     normalizeCurve — a pure, deterministic step, so every peer derives the same values from
//     the same keys. `free` / `aligned` handles are stored; a missing one is filled with the
//     autoClamped value.
//   · `quat` keys interpolate by slerp (or hold); sign continuity is enforced on normalize
//     (q flips when dot(q_prev, q) < 0), so a recorded rotation never takes the long way round.
//   · Unknown key fields RIDE THROUGH (the hudSync rule).

export const CURVE_TYPES = /** @type {const} */ (['number', 'step', 'vec3', 'quat', 'color']);
export const INTERPS = /** @type {const} */ (['bezier', 'linear', 'constant']);
export const HANDLE_TYPES = /** @type {const} */ (['auto', 'autoClamped', 'aligned', 'free', 'vector']);

/** keys closer than this in time are the same moment (an insert REPLACES) */
export const SAME_TIME = 1e-6;

/** @param {string} type */
export function isCurveType(type) {
	return /** @type {readonly string[]} */ (CURVE_TYPES).includes(type);
}

/** Components per value. @param {string} type */
export function widthOf(type) {
	return type === 'quat' ? 4 : type === 'vec3' || type === 'color' ? 3 : 1;
}

/** Types whose segments may be bezier (scalar or per-component handles). @param {string} type */
export function canBezier(type) {
	return type === 'number' || type === 'vec3' || type === 'color';
}

/** @param {any} v @param {number} d */
function num(v, d) {
	const n = Number(v);
	return Number.isFinite(n) ? n : d;
}

/** A short random key id. */
export function newKeyId() {
	return 'k' + Math.random().toString(36).slice(2, 10);
}

// ---- values -----------------------------------------------------------------------

/** A well-formed value of `type`, or null. @param {string} type @param {any} v @returns {any} */
export function normalizeValue(type, v) {
	if (type === 'number') return Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null;
	if (type === 'step') {
		if (typeof v === 'boolean' || typeof v === 'string') return v;
		return Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null;
	}
	const w = widthOf(type);
	if (!Array.isArray(v) || v.length < w) return null;
	const out = v.slice(0, w).map(Number);
	if (!out.every(Number.isFinite)) return null;
	if (type === 'quat') {
		const len = Math.hypot(out[0], out[1], out[2], out[3]);
		if (len < 1e-9) return null;
		return out.map((c) => c / len);
	}
	return out;
}

/** Components of a value as an array (a scalar becomes [v]). @param {string} type @param {any} v @returns {number[]} */
function comps(type, v) {
	return widthOf(type) === 1 ? [Number(v)] : v;
}

/** @param {string} type @param {number[]} c */
function fromComps(type, c) {
	return widthOf(type) === 1 ? c[0] : c;
}

/** @param {number[]} a @param {number[]} b */
function dot4(a, b) {
	return a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
}

/** Spherical interpolation of two unit quaternions [x,y,z,w]. @param {number[]} a @param {number[]} b @param {number} s */
export function slerp(a, b, s) {
	let d = dot4(a, b);
	let bx = b[0], by = b[1], bz = b[2], bw = b[3];
	if (d < 0) {
		d = -d;
		bx = -bx; by = -by; bz = -bz; bw = -bw;
	}
	let ka, kb;
	if (d > 0.9995) {
		ka = 1 - s;
		kb = s;
	} else {
		const th = Math.acos(Math.min(1, d));
		const sn = Math.sin(th);
		ka = Math.sin((1 - s) * th) / sn;
		kb = Math.sin(s * th) / sn;
	}
	const q = [a[0] * ka + bx * kb, a[1] * ka + by * kb, a[2] * ka + bz * kb, a[3] * ka + bw * kb];
	const len = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
	return q.map((c) => c / len);
}

/** The angle between two orientations, DEGREES. @param {number[]} a @param {number[]} b */
export function quatAngleDeg(a, b) {
	const d = Math.min(1, Math.abs(dot4(a, b)));
	return (2 * Math.acos(d) * 180) / Math.PI;
}

/**
 * The distance between two values in the type's own units — what an error budget measures
 * (a vec3 = 3D distance, a quat = degrees, a colour = RGB distance, a step = 0/1).
 * @param {string} type @param {any} a @param {any} b
 */
export function valueError(type, a, b) {
	if (type === 'quat') return quatAngleDeg(a, b);
	if (type === 'step') return a === b ? 0 : 1;
	if (widthOf(type) === 1) return Math.abs(a - b);
	return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** Straight interpolation between two values (lerp / slerp / hold). @param {string} type @param {any} a @param {any} b @param {number} s */
export function lerpValue(type, a, b, s) {
	if (type === 'step') return a;
	if (type === 'quat') return slerp(a, b, s);
	if (widthOf(type) === 1) return a + (b - a) * s;
	return a.map((/** @type {number} */ c, /** @type {number} */ k) => c + (b[k] - c) * s);
}

/** A deep-enough copy (arrays are the only nested values). @param {any} v */
function copyValue(v) {
	return Array.isArray(v) ? v.slice() : v;
}

// ---- keys + curves ------------------------------------------------------------------

/** @param {any} h @param {number} w @param {boolean} isIn @returns {number[]|undefined} */
function normalizeHandle(h, w, isIn) {
	if (!Array.isArray(h) || h.length < 1 + w) return undefined;
	const out = h.slice(0, 1 + w).map(Number);
	if (!out.every(Number.isFinite)) return undefined;
	out[0] = isIn ? Math.min(0, out[0]) : Math.max(0, out[0]);
	return out;
}

/**
 * One key, well formed for `type`, or null when it carries no usable time/value.
 * @param {string} type @param {any} raw @returns {any}
 */
export function normalizeKey(type, raw) {
	if (!raw || typeof raw !== 'object') return null;
	const t = Number(raw.t);
	if (!Number.isFinite(t)) return null;
	const v = normalizeValue(type, raw.v);
	if (v === null) return null;
	const w = widthOf(type);
	const defaultI = type === 'step' ? 'constant' : type === 'quat' ? 'linear' : 'bezier';
	let i = /** @type {readonly string[]} */ (INTERPS).includes(raw.i) ? raw.i : defaultI;
	if (type === 'step') i = 'constant';
	if (type === 'quat' && i === 'bezier') i = 'linear';
	const h = /** @type {readonly string[]} */ (HANDLE_TYPES).includes(raw.h) ? raw.h : 'autoClamped';
	/** @type {any} */
	const key = { ...raw, id: typeof raw.id === 'string' && raw.id ? raw.id : newKeyId(), t: Math.max(0, t), v, i, h };
	delete key.in;
	delete key.out;
	if (canBezier(type)) {
		const hin = normalizeHandle(raw.in, w, true);
		const hout = normalizeHandle(raw.out, w, false);
		if (hin) key.in = hin;
		if (hout) key.out = hout;
	}
	if (raw.src === 'rec' || raw.src === 'user') key.src = raw.src;
	else delete key.src;
	return key;
}

/**
 * A curve's keys, well formed: valid keys only, sorted by time (ties by id, so every peer
 * orders them alike), duplicate ids dropped, quaternion signs made continuous, and every
 * computed handle (re)derived from the neighbours.
 * @param {string} type @param {any} raw @returns {any[]}
 */
export function normalizeCurve(type, raw) {
	const list = (Array.isArray(raw) ? raw : []).map((k) => normalizeKey(type, k)).filter(Boolean);
	list.sort((a, b) => a.t - b.t || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	const seen = new Set();
	const keys = [];
	for (const k of list) {
		if (seen.has(k.id)) continue;
		seen.add(k.id);
		keys.push(k);
	}
	if (type === 'quat')
		for (let n = 1; n < keys.length; n++)
			if (dot4(keys[n - 1].v, keys[n].v) < 0) keys[n].v = keys[n].v.map((/** @type {number} */ c) => -c);
	if (canBezier(type)) computeHandles(type, keys);
	return keys;
}

/**
 * Derive the handles of auto / autoClamped / vector keys, fill a free/aligned key's missing
 * side, and clamp every handle's dt to its segment. Mutates `keys` (already sorted).
 * @param {string} type @param {any[]} keys
 */
export function computeHandles(type, keys) {
	const w = widthOf(type);
	for (let n = 0; n < keys.length; n++) {
		const k = keys[n];
		const prev = keys[n - 1];
		const next = keys[n + 1];
		const dtL = prev ? k.t - prev.t : 0;
		const dtR = next ? next.t - k.t : 0;
		const v = comps(type, k.v);
		const pv = prev ? comps(type, prev.v) : null;
		const nv = next ? comps(type, next.v) : null;
		/** @param {'auto'|'autoClamped'|'vector'} mode */
		const derived = (mode) => {
			const hin = [-dtL / 3];
			const hout = [dtR / 3];
			for (let c = 0; c < w; c++) {
				if (mode === 'vector') {
					hin.push(pv ? (pv[c] - v[c]) / 3 : 0);
					hout.push(nv ? (nv[c] - v[c]) / 3 : 0);
					continue;
				}
				let slope = 0;
				if (pv && nv && next.t - prev.t > SAME_TIME) {
					slope = (nv[c] - pv[c]) / (next.t - prev.t);
					if (mode === 'autoClamped') {
						const dl = dtL > SAME_TIME ? (v[c] - pv[c]) / dtL : 0;
						const dr = dtR > SAME_TIME ? (nv[c] - v[c]) / dtR : 0;
						// an extremum stays flat; otherwise the Fritsch–Carlson bound, so the
						// curve never overshoots a key on either side
						if (dl * dr <= 0) slope = 0;
						else slope = Math.sign(slope) * Math.min(Math.abs(slope), 3 * Math.min(Math.abs(dl), Math.abs(dr)));
					}
				}
				hin.push((-slope * dtL) / 3);
				hout.push((slope * dtR) / 3);
			}
			return { hin, hout };
		};
		if (k.h === 'auto' || k.h === 'autoClamped' || k.h === 'vector') {
			const { hin, hout } = derived(k.h);
			k.in = hin;
			k.out = hout;
		} else {
			if (!k.in || !k.out) {
				const { hin, hout } = derived('autoClamped');
				if (!k.in) k.in = hin;
				if (!k.out) k.out = hout;
			}
			// clamp the TIME of a stored handle to its segment; its value scales with it so
			// the handle keeps its direction
			if (k.in[0] < -dtL) {
				const s = dtL > 0 ? -dtL / k.in[0] : 0;
				k.in = k.in.map((/** @type {number} */ c) => c * s);
			}
			if (k.out[0] > dtR) {
				const s = dtR > 0 ? dtR / k.out[0] : 0;
				k.out = k.out.map((/** @type {number} */ c) => c * s);
			}
		}
	}
	return keys;
}

/** Index of the last key with t <= time (binary search), -1 before the first. @param {any[]} keys @param {number} time */
export function keyIndexAt(keys, time) {
	let lo = 0;
	let hi = keys.length - 1;
	if (!keys.length || time < keys[0].t) return -1;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (keys[mid].t <= time) lo = mid;
		else hi = mid - 1;
	}
	return lo;
}

/**
 * Evaluate one bezier segment between keys a and b at `time` (a.t <= time <= b.t).
 * x(u) is solved by bisection (the curve's time is monotonic because each handle's dt lies
 * inside the segment), then every component's y(u) is read at the same u.
 * @param {string} type @param {any} a @param {any} b @param {number} time
 */
function bezierAt(type, a, b, time) {
	const span = b.t - a.t;
	const va = comps(type, a.v);
	const vb = comps(type, b.v);
	if (span <= SAME_TIME) return fromComps(type, vb.slice());
	const ao = a.out ?? [span / 3, ...va.map(() => 0)];
	const bi = b.in ?? [-span / 3, ...vb.map(() => 0)];
	const x0 = a.t;
	const x1 = a.t + Math.min(span, Math.max(0, ao[0]));
	const x2 = b.t + Math.max(-span, Math.min(0, bi[0]));
	const x3 = b.t;
	const bx = (/** @type {number} */ u) => {
		const m = 1 - u;
		return m * m * m * x0 + 3 * m * m * u * x1 + 3 * m * u * u * x2 + u * u * u * x3;
	};
	let lo = 0;
	let hi = 1;
	let u = (time - a.t) / span;
	for (let it = 0; it < 48; it++) {
		const x = bx(u);
		if (Math.abs(x - time) < 1e-9) break;
		if (x < time) lo = u;
		else hi = u;
		u = (lo + hi) / 2;
	}
	const m = 1 - u;
	const out = [];
	for (let c = 0; c < va.length; c++) {
		const y1 = va[c] + (ao[1 + c] ?? 0);
		const y2 = vb[c] + (bi[1 + c] ?? 0);
		out.push(m * m * m * va[c] + 3 * m * m * u * y1 + 3 * m * u * u * y2 + u * u * u * vb[c]);
	}
	return fromComps(type, out);
}

/**
 * The curve's value at `time`: hold before the first key and after the last, otherwise the
 * segment's interpolation. Null for an empty curve. Returns a fresh array for vector types.
 * @param {string} type @param {any[]} keys @param {number} time @returns {any}
 */
export function sampleCurve(type, keys, time) {
	if (!keys?.length) return null;
	const n = keyIndexAt(keys, time);
	if (n < 0) return copyValue(keys[0].v);
	if (n >= keys.length - 1) return copyValue(keys[keys.length - 1].v);
	const a = keys[n];
	const b = keys[n + 1];
	if (a.i === 'constant' || type === 'step') return copyValue(a.v);
	const span = b.t - a.t;
	const s = span > SAME_TIME ? (time - a.t) / span : 1;
	if (a.i === 'linear' || !canBezier(type)) return lerpValue(type, a.v, b.v, s);
	return bezierAt(type, a, b, time);
}

/** First and last key time, or null. @param {any[]} keys */
export function curveRange(keys) {
	return keys?.length ? { start: keys[0].t, end: keys[keys.length - 1].t } : null;
}

// ---- the legacy Animation-window keys (17-E) ------------------------------------------

/**
 * Convert the Animation window's scalar keys `{t, v, ease?: [x1,y1,x2,y2]}` (a CSS
 * cubic-bezier NORMALIZED to the segment that follows the key) into curve keys that
 * evaluate IDENTICALLY: a.out = [x1·dt, y1·dv], b.in = [(x2−1)·dt, (y2−1)·dv], both free.
 * A key without an ease is linear; a stepped channel becomes a `step` curve.
 * @param {any[]} keys @param {boolean} [stepped]
 */
export function fromLegacyKeys(keys, stepped = false) {
	const sorted = (Array.isArray(keys) ? keys : [])
		.filter((k) => k && Number.isFinite(Number(k.t)) && Number.isFinite(Number(k.v)))
		.map((k) => ({ t: Number(k.t), v: Number(k.v), ease: k.ease }))
		.sort((a, b) => a.t - b.t);
	const type = stepped ? 'step' : 'number';
	/** @type {any[]} */
	const out = sorted.map((k) => ({ id: newKeyId(), t: k.t, v: k.v, i: stepped ? 'constant' : 'linear', h: 'autoClamped' }));
	if (!stepped)
		for (let n = 0; n < sorted.length - 1; n++) {
			const e = sorted[n].ease;
			if (!Array.isArray(e) || e.length !== 4) continue;
			const dt = sorted[n + 1].t - sorted[n].t;
			const dv = sorted[n + 1].v - sorted[n].v;
			const [x1, y1, x2, y2] = e.map(Number);
			out[n].i = 'bezier';
			out[n].h = 'free';
			out[n].out = [Math.min(1, Math.max(0, x1)) * dt, y1 * dv];
			out[n + 1].h = 'free';
			out[n + 1].in = [(Math.min(1, Math.max(0, x2)) - 1) * dt, (y2 - 1) * dv];
		}
	return normalizeCurve(type, out);
}

// ---- mutators (both editors call these; each returns a NEW normalized key list) ------

/**
 * Insert a key at `t` (replacing one already at that moment, keeping its id).
 * @param {string} type @param {any[]} keys @param {number} t @param {any} v @param {any} [opts] extra key fields
 */
export function insertKey(type, keys, t, v, opts = {}) {
	const at = keys.findIndex((k) => Math.abs(k.t - t) <= SAME_TIME);
	const next = keys.map((k) => ({ ...k }));
	const key = { ...opts, t, v, id: at >= 0 ? next[at].id : opts.id || newKeyId() };
	if (at >= 0) next[at] = { ...next[at], ...key };
	else next.push(key);
	return normalizeCurve(type, next);
}

/**
 * Move keys by id: dt seconds, dv in value units (a number, or a per-component array).
 * @param {string} type @param {any[]} keys @param {string[]} ids @param {number} dt @param {number|number[]} [dv]
 */
export function moveKeys(type, keys, ids, dt, dv = 0) {
	const pick = new Set(ids);
	return normalizeCurve(
		type,
		keys.map((k) => {
			if (!pick.has(k.id)) return k;
			const moved = { ...k, t: Math.max(0, k.t + dt), src: 'user' };
			if (type === 'quat' || type === 'step') return moved;
			if (widthOf(type) === 1) moved.v = k.v + (Number(dv) || 0);
			else moved.v = k.v.map((/** @type {number} */ c, /** @type {number} */ n) => c + (Array.isArray(dv) ? Number(dv[n]) || 0 : 0));
			return moved;
		})
	);
}

/** @param {string} type @param {any[]} keys @param {string[]} ids */
export function deleteKeys(type, keys, ids) {
	const drop = new Set(ids);
	return normalizeCurve(type, keys.filter((k) => !drop.has(k.id)));
}

/** @param {string} type @param {any[]} keys @param {string[]} ids @param {string} i */
export function setInterp(type, keys, ids, i) {
	const pick = new Set(ids);
	return normalizeCurve(type, keys.map((k) => (pick.has(k.id) ? { ...k, i } : k)));
}

/**
 * Set one handle of a key. 'aligned' keeps the other handle on the same line (its length
 * kept); anything else becomes 'free'.
 * @param {string} type @param {any[]} keys @param {string} id @param {'in'|'out'} side @param {number[]} handle
 */
export function setHandle(type, keys, id, side, handle) {
	return normalizeCurve(
		type,
		keys.map((k) => {
			if (k.id !== id) return k;
			const next = { ...k, [side]: handle.slice(), src: 'user' };
			if (k.h === 'aligned') {
				const other = side === 'in' ? 'out' : 'in';
				const cur = k[other] ?? handle.map((/** @type {number} */ c) => -c);
				const len = Math.hypot(...cur);
				const dir = Math.hypot(...handle) || 1;
				next[other] = handle.map((/** @type {number} */ c) => (-c / dir) * len);
			} else next.h = 'free';
			return next;
		})
	);
}

/** @param {string} type @param {any[]} keys @param {string[]} ids @param {string} h */
export function setHandleType(type, keys, ids, h) {
	const pick = new Set(ids);
	return normalizeCurve(
		type,
		keys.map((k) => {
			if (!pick.has(k.id)) return k;
			const next = { ...k, h };
			if (h !== 'free' && h !== 'aligned') {
				delete next.in;
				delete next.out;
			}
			return next;
		})
	);
}

/** Keys inside [t0, t1] (inclusive, by time). @param {any[]} keys @param {number} t0 @param {number} t1 */
export function keysIn(keys, t0, t1) {
	return keys.filter((k) => k.t >= t0 - SAME_TIME && k.t <= t1 + SAME_TIME);
}

/**
 * Replace everything in [t0, t1] with `fresh` keys (a take, a retake, a re-reduce). The
 * keys outside the range are kept untouched.
 * @param {string} type @param {any[]} keys @param {number} t0 @param {number} t1 @param {any[]} fresh
 */
export function replaceRange(type, keys, t0, t1, fresh) {
	const kept = keys.filter((k) => k.t < t0 - SAME_TIME || k.t > t1 + SAME_TIME);
	return normalizeCurve(type, [...kept, ...fresh]);
}

/** Do any keys in [t0, t1] carry a hand edit? (Re-reduce asks before overwriting those.) @param {any[]} keys @param {number} t0 @param {number} t1 */
export function hasUserEdits(keys, t0, t1) {
	return keysIn(keys, t0, t1).some((k) => k.src === 'user');
}

/** Shift every key in [t0, ∞) by dt (a ripple). @param {string} type @param {any[]} keys @param {number} t0 @param {number} dt */
export function shiftFrom(type, keys, t0, dt) {
	return normalizeCurve(type, keys.map((k) => (k.t >= t0 - SAME_TIME ? { ...k, t: Math.max(0, k.t + dt) } : k)));
}

// ---- recording → keys -----------------------------------------------------------------

/**
 * Resample timestamped samples onto a uniform grid (rate Hz) from the first to the last
 * sample — phone frame times jitter, and the reduction measures against a uniform grid.
 * Interpolates straight (lerp / slerp / hold).
 * @param {string} type @param {{t: number, v: any}[]} samples @param {number} [rate]
 * @returns {{t: number, v: any}[]}
 */
export function resampleUniform(type, samples, rate = 30) {
	const list = samples.filter((s) => s && Number.isFinite(s.t)).slice().sort((a, b) => a.t - b.t);
	if (list.length < 2) return list.map((s) => ({ t: s.t, v: copyValue(s.v) }));
	const t0 = list[0].t;
	const t1 = list[list.length - 1].t;
	const n = Math.max(1, Math.round((t1 - t0) * rate));
	const out = [];
	let j = 0;
	for (let k = 0; k <= n; k++) {
		const t = k === n ? t1 : t0 + k / rate;
		while (j < list.length - 2 && list[j + 1].t <= t) j++;
		const a = list[j];
		const b = list[j + 1];
		const span = b.t - a.t;
		const s = span > SAME_TIME ? Math.min(1, Math.max(0, (t - a.t) / span)) : 1;
		out.push({ t, v: lerpValue(type, a.v, b.v, s) });
	}
	return out;
}

/**
 * Ramer–Douglas–Peucker over samples with the straight-interpolation test: keep the
 * samples where the path bends more than `budget` (in valueError units). Iterative.
 * `errorOf(i, a, b, s)` may be given to measure a JOINT error (a pose: position and angle
 * share key times); it returns a ratio where > 1 means over budget.
 * @param {string} type @param {{t: number, v: any}[]} samples @param {number} budget
 * @param {((i: number, a: number, b: number, s: number) => number)|null} [errorOf]
 * @returns {number[]} the kept sample indices, sorted
 */
export function rdpIndices(type, samples, budget, errorOf = null) {
	const n = samples.length;
	if (n <= 2) return samples.map((_, i) => i);
	const keep = new Uint8Array(n);
	keep[0] = 1;
	keep[n - 1] = 1;
	const stack = [[0, n - 1]];
	const err =
		errorOf ??
		((/** @type {number} */ i, /** @type {number} */ a, /** @type {number} */ b, /** @type {number} */ s) =>
			valueError(type, samples[i].v, lerpValue(type, samples[a].v, samples[b].v, s)) / Math.max(budget, 1e-12));
	while (stack.length) {
		const [a, b] = /** @type {number[]} */ (stack.pop());
		if (b - a < 2) continue;
		const span = samples[b].t - samples[a].t;
		let worst = -1;
		let worstErr = 1;
		for (let i = a + 1; i < b; i++) {
			const s = span > SAME_TIME ? (samples[i].t - samples[a].t) / span : 0;
			const e = err(i, a, b, s);
			if (e > worstErr) {
				worstErr = e;
				worst = i;
			}
		}
		if (worst >= 0) {
			keep[worst] = 1;
			stack.push([a, worst], [worst, b]);
		}
	}
	const out = [];
	for (let i = 0; i < n; i++) if (keep[i]) out.push(i);
	return out;
}

/** The largest error of a curve against samples, and where. @param {string} type @param {any[]} keys @param {{t: number, v: any}[]} samples */
export function maxError(type, keys, samples) {
	let worst = 0;
	let at = -1;
	for (let i = 0; i < samples.length; i++) {
		const e = valueError(type, samples[i].v, sampleCurve(type, keys, samples[i].t));
		if (e > worst) {
			worst = e;
			at = i;
		}
	}
	return { error: worst, index: at };
}

/**
 * Reduce samples of ONE channel to keys within `budget`.
 * (a) RDP with the straight test → linear keys, always within budget.
 * (b) for bezier-capable types, also try a coarser RDP + autoClamped tangents, then insert
 *     the worst sample until the curve is within budget again (the error-bounded fit) — and
 *     keep whichever result has FEWER keys.
 * @param {string} type @param {{t: number, v: any}[]} samples @param {number} budget
 * @param {{fit?: 'linear'|'bezier', src?: string, idPrefix?: string}} [opts]
 * @returns {any[]} normalized keys
 */
export function reduceSamples(type, samples, budget, opts = {}) {
	if (!samples.length) return [];
	const src = opts.src ?? 'rec';
	const mk = (/** @type {number} */ i, /** @type {string} */ interp, /** @type {string} */ h) => ({
		id: (opts.idPrefix ?? 'r') + Math.round(samples[i].t * 1000).toString(36) + '-' + newKeyId().slice(1, 5),
		t: samples[i].t,
		v: copyValue(samples[i].v),
		i: type === 'step' ? 'constant' : interp,
		h,
		src
	});
	const linIdx = rdpIndices(type, samples, budget);
	const linear = normalizeCurve(
		type,
		linIdx.map((i) => mk(i, 'linear', 'vector'))
	);
	if (opts.fit !== 'bezier' || !canBezier(type) || samples.length < 4) return linear;
	const idx = new Set(rdpIndices(type, samples, budget * 4));
	/** @type {any[]} */
	let fitted = [];
	for (let guard = 0; guard < samples.length; guard++) {
		fitted = normalizeCurve(type, [...idx].sort((a, b) => a - b).map((i) => mk(i, 'bezier', 'autoClamped')));
		const { error, index } = maxError(type, fitted, samples);
		if (error <= budget || index < 0 || idx.has(index)) break;
		idx.add(index);
		if (idx.size >= linear.length) break;
	}
	const ok = maxError(type, fitted, samples).error <= budget;
	return ok && fitted.length < linear.length ? fitted : linear;
}

/**
 * Reduce a recorded POSE (position + orientation) with SHARED key times: one RDP where a
 * sample is over budget when its position error exceeds `posBudget` metres OR its angle
 * exceeds `angBudget` degrees. Shared times keep trim and retake simple (design note).
 * @param {{t: number, pos: number[], quat: number[]}[]} samples
 * @param {{pos?: number, angDeg?: number}} [budget]
 * @returns {{position: any[], quaternion: any[]}}
 */
export function reducePose(samples, budget = {}) {
	const posB = Math.max(1e-6, budget.pos ?? 0.01);
	const angB = Math.max(1e-6, budget.angDeg ?? 0.5);
	const flat = samples.map((s) => ({ t: s.t, v: 0 }));
	const idx = rdpIndices('number', flat, 1, (i, a, b, s) => {
		const p = lerpValue('vec3', samples[a].pos, samples[b].pos, s);
		const q = slerp(samples[a].quat, samples[b].quat, s);
		return Math.max(valueError('vec3', samples[i].pos, p) / posB, quatAngleDeg(samples[i].quat, q) / angB);
	});
	const position = [];
	const quaternion = [];
	for (const i of idx) {
		const id = 'p' + Math.round(samples[i].t * 1000).toString(36) + '-' + newKeyId().slice(1, 5);
		position.push({ id, t: samples[i].t, v: samples[i].pos.slice(), i: 'linear', h: 'vector', src: 'rec' });
		quaternion.push({ id, t: samples[i].t, v: samples[i].quat.slice(), i: 'linear', h: 'vector', src: 'rec' });
	}
	return { position: normalizeCurve('vec3', position), quaternion: normalizeCurve('quat', quaternion) };
}
