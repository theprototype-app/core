// 102 M8 — the EDITING and EXPORT half of the one curve model (curveCore.js is the model and its
// evaluation). Kept apart so the boot chunk, which needs curveCore to play sequences, does not carry
// the editor's presets, clipboard and export maps: this module is reached only by the lazy curve view
// (CurveGraph.svelte), `.tpanim` (format.js) and the unit tests. Pure, imports only curveCore.

import {
	normalizeCurve,
	normalizeValue,
	sampleCurve,
	keyIndexAt,
	lerpValue,
	valueError,
	canBezier,
	widthOf,
	newKeyId,
	SAME_TIME
} from './curveCore.js';

/** Components of a value as an array (a scalar becomes [v]). @param {string} type @param {any} v @returns {number[]} */
function comps(type, v) {
	return widthOf(type) === 1 ? [Number(v)] : v;
}

/** @param {string} type @param {number[]} c */
function fromComps(type, c) {
	return widthOf(type) === 1 ? c[0] : c;
}

/** A deep-enough copy (arrays are the only nested values). @param {any} v */
function copyValue(v) {
	return Array.isArray(v) ? v.slice() : v;
}

// ---- 102 M8: key modes, presets, value entry, copy / paste ------------------------------

/**
 * The modes people pick (the brief's auto / linear / stepped / free / broken), mapped onto the
 * model: `i` shapes the segment after the key, `h` the key's handles. `free` = both handles
 * stored and dragged apart ("broken"); `aligned` keeps them on one line.
 */
export const KEY_MODES = /** @type {const} */ ({
	auto: { i: 'bezier', h: 'autoClamped', label: 'Auto (no overshoot)' },
	autoOver: { i: 'bezier', h: 'auto', label: 'Auto (smooth through)' },
	aligned: { i: 'bezier', h: 'aligned', label: 'Aligned handles' },
	free: { i: 'bezier', h: 'free', label: 'Broken handles' },
	linear: { i: 'linear', h: 'vector', label: 'Linear' },
	stepped: { i: 'constant', h: 'autoClamped', label: 'Stepped' }
});

/** The mode a key shows as. @param {any} k */
export function keyModeOf(k) {
	if (k?.i === 'constant') return 'stepped';
	if (k?.i === 'linear') return 'linear';
	if (k?.h === 'auto') return 'autoOver';
	if (k?.h === 'aligned') return 'aligned';
	if (k?.h === 'free') return 'free';
	return 'auto';
}

/** Set the mode of keys by id. @param {string} type @param {any[]} keys @param {string[]} ids @param {string} mode */
export function setKeyMode(type, keys, ids, mode) {
	const m = /** @type {any} */ (KEY_MODES)[mode];
	if (!m) return keys;
	const pick = new Set(ids);
	return normalizeCurve(
		type,
		keys.map((k) => {
			if (!pick.has(k.id)) return k;
			const next = { ...k, i: m.i, h: m.h, src: 'user' };
			// a computed mode drops stored handles; aligned / free keep what the key shows now
			if (m.h !== 'free' && m.h !== 'aligned') {
				delete next.in;
				delete next.out;
			}
			return next;
		})
	);
}

/**
 * Ease presets for the segment that FOLLOWS a key. Bezier presets are CSS cubic-beziers mapped
 * the fromLegacyKeys way (out = [x1·dt, y1·dv], next key's in = [(x2−1)·dt, (y2−1)·dv]);
 * `bounce` inserts keys (one bezier segment cannot bounce).
 */
export const EASE_PRESETS = /** @type {const} */ ({
	linear: { label: 'Linear' },
	stepped: { label: 'Stepped' },
	auto: { label: 'Smooth (auto)' },
	easeIn: { label: 'Ease in', bezier: [0.42, 0, 1, 1] },
	easeOut: { label: 'Ease out', bezier: [0, 0, 0.58, 1] },
	easeInOut: { label: 'Ease in and out', bezier: [0.42, 0, 0.58, 1] },
	overshoot: { label: 'Overshoot', bezier: [0.34, 1.56, 0.64, 1] },
	anticipate: { label: 'Anticipate', bezier: [0.36, 0, 0.66, -0.56] },
	bounce: { label: 'Bounce' }
});

/** easeOutBounce's touch-downs and peaks as (fraction of time, fraction of value) */
const BOUNCE_POINTS = [
	[1 / 2.75, 1, 'touch'],
	[1.5 / 2.75, 0.75, 'peak'],
	[2 / 2.75, 1, 'touch'],
	[2.25 / 2.75, 0.9375, 'peak'],
	[2.5 / 2.75, 1, 'touch'],
	[2.625 / 2.75, 0.984375, 'peak']
];

/**
 * Apply an ease preset to the segment after each selected key (a key with no next key is left
 * alone). Quat and step curves take only linear / stepped (they have no bezier segments).
 * @param {string} type @param {any[]} keys normalized @param {string[]} ids @param {string} preset
 * @returns {any[]} normalized keys
 */
export function applyPreset(type, keys, ids, preset) {
	const p = /** @type {any} */ (EASE_PRESETS)[preset];
	if (!p) return keys;
	const pick = new Set(ids);
	if (preset === 'linear' || preset === 'stepped' || !canBezier(type)) {
		if (preset !== 'linear' && preset !== 'stepped') return keys;
		const i = preset === 'linear' ? 'linear' : 'constant';
		return normalizeCurve(type, keys.map((k) => (pick.has(k.id) ? { ...k, i, src: 'user' } : k)));
	}
	const w = widthOf(type);
	const next = keys.map((k) => ({ ...k, in: k.in?.slice(), out: k.out?.slice() }));
	/** @type {any[]} */
	const extra = [];
	for (let n = 0; n < next.length - 1; n++) {
		const a = next[n];
		if (!pick.has(a.id)) continue;
		const b = next[n + 1];
		const dt = b.t - a.t;
		const va = comps(type, a.v);
		const vb = comps(type, b.v);
		a.src = 'user';
		if (preset === 'auto') {
			a.i = 'bezier';
			a.h = 'autoClamped';
			delete a.in;
			delete a.out;
			continue;
		}
		if (preset === 'bounce') {
			a.i = 'bezier';
			delete a.out; // re-derived against the first touch-down
			for (const [ft, fv, kind] of BOUNCE_POINTS) {
				const v = va.map((c, j) => c + (vb[j] - c) * /** @type {number} */ (fv));
				extra.push({
					id: newKeyId(),
					t: a.t + dt * /** @type {number} */ (ft),
					v: fromComps(type, v),
					i: 'bezier',
					h: kind === 'peak' ? 'autoClamped' : 'vector',
					src: 'user'
				});
			}
			continue;
		}
		const [x1, y1, x2, y2] = p.bezier;
		a.i = 'bezier';
		a.h = a.h === 'aligned' ? 'aligned' : 'free';
		a.out = [x1 * dt, ...va.map((c, j) => y1 * (vb[j] - c))];
		if (!a.in) a.in = [0, ...new Array(w).fill(0)];
		// the next key keeps its own out-handle as it shows now; only its in-handle changes
		b.h = 'free';
		b.in = [(x2 - 1) * dt, ...va.map((c, j) => (y2 - 1) * (vb[j] - c))];
	}
	return normalizeCurve(type, [...next, ...extra]);
}

/**
 * Set the time and / or value of keys (value entry). A time that lands on another key's moment
 * replaces that key (insertKey's rule).
 * @param {string} type @param {any[]} keys @param {string[]} ids @param {{t?: number, v?: any}} patch
 */
export function setKeys(type, keys, ids, patch) {
	const pick = new Set(ids);
	const v = patch.v === undefined ? undefined : normalizeValue(type, patch.v);
	const t = patch.t === undefined ? undefined : Number(patch.t);
	let list = keys.map((k) => {
		if (!pick.has(k.id)) return k;
		const next = { ...k, src: 'user' };
		if (v !== undefined && v !== null) next.v = copyValue(v);
		if (t !== undefined && Number.isFinite(t)) next.t = Math.max(0, t);
		return next;
	});
	// one key per moment: an edited key wins over an untouched one at the same time
	list = list.filter((k) => pick.has(k.id) || !list.some((o) => o !== k && pick.has(o.id) && Math.abs(o.t - k.t) <= SAME_TIME));
	return normalizeCurve(type, list);
}

/**
 * Copy keys: times relative to the first copied key, handles and modes kept, ids dropped.
 * @param {string} type @param {any[]} keys @param {string[]} ids
 * @returns {{type: string, keys: any[]}|null}
 */
export function copyKeys(type, keys, ids) {
	const pick = new Set(ids);
	const sel = keys.filter((k) => pick.has(k.id));
	if (!sel.length) return null;
	const t0 = sel[0].t;
	return {
		type,
		keys: sel.map((k) => {
			const { id: _id, ...rest } = k;
			return { ...rest, t: k.t - t0, v: copyValue(k.v), in: k.in?.slice(), out: k.out?.slice() };
		})
	};
}

/**
 * Paste copied keys at time `at` (keys already at those moments are replaced). A clip of
 * another width is refused (returns the keys unchanged): a number pastes onto any number
 * curve, a vec3 onto a vec3. `period` (e.g. 2π for a radian Euler axis) shifts the block by
 * whole turns so its first key lands nearest the curve's value at `at` — the no-flip guard.
 * @param {string} type @param {any[]} keys @param {{type: string, keys: any[]}|null} clip @param {number} at
 * @param {{period?: number}} [opts]
 * @returns {{keys: any[], ids: string[]}}
 */
export function pasteKeys(type, keys, clip, at, opts = {}) {
	if (!clip?.keys?.length || widthOf(clip.type) !== widthOf(type) || (clip.type === 'quat') !== (type === 'quat'))
		return { keys, ids: [] };
	let shift = 0;
	if (opts.period && widthOf(type) === 1 && keys.length) {
		const here = sampleCurve(type, keys, at);
		shift = unwrapNear(Number(clip.keys[0].v), Number(here), opts.period) - Number(clip.keys[0].v);
	}
	const fresh = clip.keys.map((k) => ({
		...k,
		id: newKeyId(),
		t: Math.max(0, at + k.t),
		v: shift ? Number(k.v) + shift : copyValue(k.v),
		src: 'user'
	}));
	const times = fresh.map((k) => k.t);
	const kept = keys.filter((k) => !times.some((t) => Math.abs(t - k.t) <= SAME_TIME));
	return { keys: normalizeCurve(type, [...kept, ...fresh]), ids: fresh.map((k) => k.id) };
}

/**
 * The value v + n·period (whole turns) closest to `ref` — an angle unwrapped next to its
 * neighbour, so 179° then −179° reads as 181° (a 2° step, not a −358° spin back).
 * @param {number} v @param {number} ref @param {number} period
 */
export function unwrapNear(v, ref, period) {
	if (!(period > 0) || !Number.isFinite(v) || !Number.isFinite(ref)) return v;
	return v + Math.round((ref - v) / period) * period;
}

/**
 * Unwrap a run of angle samples (radians by default) so no step between neighbours is more
 * than half a turn — the read-out a quaternion track shows as Euler, and the guard for keys
 * that came from a wrapped source (atan2 / setFromQuaternion).
 * @param {number[]} values @param {number} [period]
 */
export function unwrapSeries(values, period = 2 * Math.PI) {
	const out = values.slice();
	for (let n = 1; n < out.length; n++) out[n] = unwrapNear(out[n], out[n - 1], period);
	return out;
}

/** The value bounds of a curve's keys AND handles (for "frame all"). @param {string} type @param {any[]} keys @param {number} [comp] */
export function valueBounds(type, keys, comp = 0) {
	let lo = Infinity;
	let hi = -Infinity;
	for (const k of keys) {
		const v = comps(type, k.v)[comp];
		if (!Number.isFinite(v)) continue;
		lo = Math.min(lo, v);
		hi = Math.max(hi, v);
		for (const h of [k.in, k.out])
			if (h && Number.isFinite(h[1 + comp])) {
				lo = Math.min(lo, v + h[1 + comp]);
				hi = Math.max(hi, v + h[1 + comp]);
			}
	}
	return Number.isFinite(lo) ? { lo, hi } : null;
}

// ---- 102 M8: export — glTF CUBICSPLINE where it is exact, sampled keys otherwise -----------

/** handle dt equal to segment/3 within this fraction of the segment */
const THIRD_EPS = 1e-6;

/**
 * The curve as glTF CUBICSPLINE (Hermite) when that is EXACT — every segment bezier with both
 * handle times at a third of the segment (then x(u) is linear in u and the bezier IS a Hermite
 * with m = 3·dv/dt), or linear (m = dv/dt) — else null (the caller resamples). glTF's layout:
 * per key [inTangent, value, outTangent], each `widthOf(type)` wide, tangents in units / second.
 * @param {string} type @param {any[]} keys normalized
 * @returns {{times: number[], values: number[]}|null}
 */
export function toCubicSpline(type, keys) {
	if (!canBezier(type) || keys.length < 2) return null;
	const w = widthOf(type);
	/** @type {number[][]} */
	const inT = keys.map(() => new Array(w).fill(0));
	/** @type {number[][]} */
	const outT = keys.map(() => new Array(w).fill(0));
	for (let n = 0; n < keys.length - 1; n++) {
		const a = keys[n];
		const b = keys[n + 1];
		const span = b.t - a.t;
		if (span <= SAME_TIME) return null;
		const va = comps(type, a.v);
		const vb = comps(type, b.v);
		if (a.i === 'constant') return null;
		if (a.i === 'linear') {
			for (let c = 0; c < w; c++) outT[n][c] = inT[n + 1][c] = (vb[c] - va[c]) / span;
			continue;
		}
		const ao = a.out;
		const bi = b.in;
		if (!ao || !bi) return null;
		if (Math.abs(ao[0] - span / 3) > THIRD_EPS * Math.max(1, span) || Math.abs(bi[0] + span / 3) > THIRD_EPS * Math.max(1, span))
			return null;
		for (let c = 0; c < w; c++) {
			outT[n][c] = (3 * (ao[1 + c] ?? 0)) / span;
			inT[n + 1][c] = (-3 * (bi[1 + c] ?? 0)) / span;
		}
	}
	const values = [];
	for (let n = 0; n < keys.length; n++) values.push(...inT[n], ...comps(type, keys[n].v), ...outT[n]);
	return { times: keys.map((k) => k.t), values };
}

/**
 * ONE glTF CUBICSPLINE segment (the spec's Hermite) into `out`: keys `lo` -> `lo + 1`, `td` seconds
 * apart, at fraction `s`. `values` holds [inTangent, value, outTangent] per key, `w` wide, tangents in
 * units / second. sampleCubicSpline and the `.tpanim` interpolant both call this.
 * @param {ArrayLike<number>} values @param {number} w @param {number} lo @param {number} td @param {number} s
 * @param {{[i: number]: number}} out @param {number} [at] write offset in `out`
 * @returns {any} `out`
 */
export function hermiteInto(values, w, lo, td, s, out, at = 0) {
	const s2 = s * s;
	const s3 = s2 * s;
	const p0 = lo * 3 * w + w;
	const m0 = lo * 3 * w + 2 * w;
	const p1 = (lo + 1) * 3 * w + w;
	const m1 = (lo + 1) * 3 * w;
	const h00 = 2 * s3 - 3 * s2 + 1;
	const h10 = td * (s3 - 2 * s2 + s);
	const h01 = -2 * s3 + 3 * s2;
	const h11 = td * (s3 - s2);
	for (let c = 0; c < w; c++) out[at + c] = h00 * values[p0 + c] + h10 * values[m0 + c] + h01 * values[p1 + c] + h11 * values[m1 + c];
	return out;
}

/**
 * Evaluate glTF CUBICSPLINE data at `time` — the reader's side of toCubicSpline, and what a
 * `.tpanim` CUBICSPLINE track plays with (hold before the first key and after the last).
 * @param {ArrayLike<number>} times @param {ArrayLike<number>} values [in, v, out] per key @param {number} w @param {number} time
 * @returns {number[]}
 */
export function sampleCubicSpline(times, values, w, time) {
	const n = times.length;
	if (!n) return [];
	const held = (/** @type {number} */ k) => Array.from({ length: w }, (_, c) => values[k * 3 * w + w + c]);
	if (time <= times[0]) return held(0);
	if (time >= times[n - 1]) return held(n - 1);
	let lo = 0;
	let hi = n - 1;
	while (hi - lo > 1) {
		const mid = (lo + hi) >> 1;
		if (times[mid] <= time) lo = mid;
		else hi = mid;
	}
	const td = times[hi] - times[lo];
	return hermiteInto(values, w, lo, td, td > 0 ? (time - times[lo]) / td : 0, new Array(w).fill(0));
}

/**
 * Split glTF CUBICSPLINE output ([in, v, out] per key) into its three arrays, each `w` wide.
 * @param {ArrayLike<number>} v @param {number} w
 */
export function splitCubic(v, w) {
	const keys = Math.floor(v.length / (3 * w));
	const inT = new Float32Array(keys * w);
	const values = new Float32Array(keys * w);
	const outT = new Float32Array(keys * w);
	for (let k = 0; k < keys; k++)
		for (let c = 0; c < w; c++) {
			inT[k * w + c] = v[k * 3 * w + c];
			values[k * w + c] = v[k * 3 * w + w + c];
			outT[k * w + c] = v[k * 3 * w + 2 * w + c];
		}
	return { inT, values, outT };
}

/** The inverse of splitCubic. @param {ArrayLike<number>} inT @param {ArrayLike<number>} values @param {ArrayLike<number>} outT @param {number} w */
export function joinCubic(inT, values, outT, w) {
	const keys = Math.floor(values.length / w);
	const out = new Float32Array(keys * 3 * w);
	for (let k = 0; k < keys; k++)
		for (let c = 0; c < w; c++) {
			out[k * 3 * w + c] = inT[k * w + c];
			out[k * 3 * w + w + c] = values[k * w + c];
			out[k * 3 * w + 2 * w + c] = outT[k * w + c];
		}
	return out;
}

/**
 * Sample a curve at `fps` from its first key to `end` (default: its last key) — the export
 * bake when CUBICSPLINE is not exact. A segment boundary (a key) is always a sample, so a
 * stepped jump stays sharp and every key's value is exact.
 * @param {string} type @param {any[]} keys @param {number} fps @param {number} [end]
 * @returns {{times: number[], values: any[]}}
 */
export function sampleForExport(type, keys, fps, end) {
	if (!keys.length) return { times: [], values: [] };
	const rate = Math.max(1, Number(fps) || 30);
	const t0 = keys[0].t;
	const t1 = Math.max(t0, end ?? keys[keys.length - 1].t);
	const set = new Set();
	const n = Math.max(1, Math.round((t1 - t0) * rate));
	for (let k = 0; k <= n; k++) set.add(Math.min(t1, t0 + k / rate));
	for (const k of keys) if (k.t <= t1) set.add(k.t);
	const times = [...set].sort((a, b) => a - b).filter((t, i, a) => i === 0 || t - a[i - 1] > SAME_TIME);
	return { times, values: times.map((t) => sampleCurve(type, keys, t)) };
}

/**
 * The largest error of the sampled bake against the true curve, probed `sub` times per frame
 * (in valueError units): the export's error bound.
 * @param {string} type @param {any[]} keys @param {number} fps @param {number} [sub]
 */
export function exportError(type, keys, fps, sub = 8) {
	const { times, values } = sampleForExport(type, keys, fps);
	let worst = 0;
	for (let n = 0; n < times.length - 1; n++)
		for (let j = 1; j < sub; j++) {
			const s = j / sub;
			const t = times[n] + (times[n + 1] - times[n]) * s;
			const approx = keys[keyIndexAt(keys, times[n])]?.i === 'constant' || type === 'step' ? values[n] : lerpValue(type, values[n], values[n + 1], s);
			worst = Math.max(worst, valueError(type, sampleCurve(type, keys, t), approx));
		}
	return worst;
}
