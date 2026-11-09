// 78 F4 — THE PATH OBJECT, the pure record half (imports NOTHING: splineTube, motionCore, the
// runtime, the AI tools and vitest all read it).
//
// A Path object is a SPLINE OBJECT whose record carries a `path` block: the ONE curve object
// (roadmap 78 "The ONE curve object") — 64's pen paths, 65's motion along a path, 68's dolly
// and 61's Patrol read this record, never a second list of points. Everything a spline record
// already is stays true (`{points: [{pos, radius}], closed, color, ...}` on `userData.spline`,
// the `splineedit` wire, the `spline` undo kind, the spline editor's handles); the Path adds:
//
//   record.path = {version, mode, speed, smooth, showInPlay, preview, seed}
//   point       += {wait, speed, ease, gap, event, facing}   (each OPTIONAL, absent = default)
//
// Per-point fields split in two by what they describe:
//   - the POINT itself: `wait` (seconds standing there), `event` (a name fired on arrival),
//     `facing` (degrees of yaw to hold while waiting; absent = keep the arrival heading);
//   - the SPAN that LEAVES it (point k owns span k -> k+1): `speed` (m/s, absent = the path's),
//     `ease` (linear | in | out | inout over that span), `gap` (the span is a JUMP — no
//     travel time, the walker is simply at the next point).
// A plain spline (no `path` block) normalizes byte-identically to what it always did: the
// extras are written ONLY when the block is present and only when they differ from the default.

export const PATH_VERSION = 1;
export const PATH_MODES = /** @type {const} */ (['loop', 'pingpong', 'once', 'random']);
export const PATH_EASES = /** @type {const} */ (['linear', 'in', 'out', 'inout']);
export const MAX_WAIT = 3600;
export const MIN_SPEED = 0.01;
export const MAX_SPEED = 50;
export const MAX_EVENT_LENGTH = 40;
/** the radius a Path's line is drawn at (thin: it is a guide, not scenery) */
export const PATH_LINE_RADIUS = 0.03;
export const PATH_COLOR = '#f5b301';

export const PATH_DEFAULTS = Object.freeze({
	version: PATH_VERSION,
	mode: /** @type {'loop'|'pingpong'|'once'|'random'} */ ('loop'),
	speed: 1.5,
	smooth: true,
	showInPlay: false,
	preview: true,
	seed: 0
});

/** @param {any} v @param {number} d @param {number} lo @param {number} hi */
function clampNum(v, d, lo, hi) {
	const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
	return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
}

/**
 * THE boundary for a record's `path` block. Unknown fields are dropped (the block is small and
 * owned here); a missing block stays missing (a plain spline).
 * @param {any} raw
 * @returns {{version: number, mode: 'loop'|'pingpong'|'once'|'random', speed: number, smooth: boolean, showInPlay: boolean, preview: boolean, seed: number}}
 */
export function normalizePathBlock(raw) {
	const r = raw && typeof raw === 'object' ? raw : {};
	const d = PATH_DEFAULTS;
	return {
		version: PATH_VERSION,
		mode: PATH_MODES.includes(r.mode) ? r.mode : d.mode,
		speed: clampNum(r.speed, d.speed, MIN_SPEED, MAX_SPEED),
		smooth: r.smooth !== false,
		showInPlay: r.showInPlay === true,
		preview: r.preview !== false,
		seed: Math.round(clampNum(r.seed, 0, 0, 1e9))
	};
}

/**
 * The extras of one Path point, normalized; only non-default keys are returned so a record
 * stays small (it rides toJSON, GLTF extras and every `splineedit`).
 * @param {any} p @returns {{wait?: number, speed?: number, ease?: string, gap?: boolean, event?: string, facing?: number}}
 */
export function normalizePathPointExtras(p) {
	/** @type {any} */
	const out = {};
	if (!p || typeof p !== 'object') return out;
	const wait = clampNum(p.wait, 0, 0, MAX_WAIT);
	if (wait > 0) out.wait = wait;
	if (p.speed !== undefined && p.speed !== null && p.speed !== '') {
		const s = clampNum(p.speed, NaN, MIN_SPEED, MAX_SPEED);
		if (Number.isFinite(s)) out.speed = s;
	}
	if (PATH_EASES.includes(p.ease) && p.ease !== 'linear') out.ease = p.ease;
	if (p.gap === true) out.gap = true;
	if (typeof p.event === 'string') {
		const e = p.event.trim().slice(0, MAX_EVENT_LENGTH);
		if (e) out.event = e;
	}
	if (p.facing !== undefined && p.facing !== null && p.facing !== '') {
		const f = clampNum(p.facing, NaN, -360, 360);
		if (Number.isFinite(f)) out.facing = f;
	}
	return out;
}

/** is this spline record a Path (has the block)? @param {any} spline */
export function isPathRecord(spline) {
	return !!spline && typeof spline === 'object' && !!spline.path && typeof spline.path === 'object';
}

/** is this object a Path object? @param {any} object */
export function isPathObject(object) {
	const s = object?.userData?.spline;
	return !!s?.points?.length && isPathRecord(s);
}

/** a deep, plain copy (records never alias) @param {any} rec */
const copy = (rec) => JSON.parse(JSON.stringify(rec));

/**
 * A fresh Path record: three points in a gentle line on the ground around the object's origin.
 * @param {any} [patch] record fields to override (points, path block fields)
 */
export function newPathRecord(patch = {}) {
	const pts = Array.isArray(patch.points) && patch.points.length >= 2
		? patch.points
		: [{ pos: [-2, 0, 0] }, { pos: [0, 0, 1] }, { pos: [2, 0, 0] }];
	return {
		points: pts.map((/** @type {any} */ p) => ({
			...normalizePathPointExtras(p),
			pos: Array.isArray(p) ? [+p[0] || 0, +p[1] || 0, +p[2] || 0] : [+p.pos?.[0] || 0, +p.pos?.[1] || 0, +p.pos?.[2] || 0],
			radius: PATH_LINE_RADIUS
		})),
		color: typeof patch.color === 'string' ? patch.color : PATH_COLOR,
		closed: !!patch.closed,
		radialSegments: 6,
		segmentsPerSpan: 12,
		path: normalizePathBlock({ ...(patch.path ?? {}), ...pick(patch, ['mode', 'speed', 'smooth', 'showInPlay', 'preview', 'seed']) })
	};
}

/** @param {any} o @param {string[]} keys */
function pick(o, keys) {
	/** @type {any} */
	const out = {};
	for (const k of keys) if (o && o[k] !== undefined) out[k] = o[k];
	return out;
}

/** the span fields a point owns (they describe the span LEAVING it) */
const SPAN_KEYS = ['speed', 'ease', 'gap'];
/** the fields of the point itself */
const POINT_KEYS = ['wait', 'event', 'facing'];

/**
 * Reverse the walking direction: points in the other order, every point keeps its own fields
 * (wait / event / facing) and every SPAN keeps its own (speed / ease / gap) — which means the
 * span fields move to the span's other end. Returns a NEW record.
 * @param {any} rec
 */
export function reversePath(rec) {
	const out = copy(rec);
	const src = rec.points;
	const n = src.length;
	out.points = src.map((/** @type {any} */ _p, /** @type {number} */ j) => {
		const old = src[n - 1 - j];
		/** @type {any} */
		const p = { pos: [...old.pos], radius: old.radius };
		for (const k of POINT_KEYS) if (old[k] !== undefined) p[k] = old[k];
		return p;
	});
	// old span k (k -> k+1) is new span (n-2-k) mod n
	const spans = rec.closed ? n : n - 1;
	for (let k = 0; k < spans; k++) {
		const owner = (((n - 2 - k) % n) + n) % n;
		for (const key of SPAN_KEYS) if (src[k][key] !== undefined) out.points[owner][key] = src[k][key];
	}
	return out;
}

/**
 * Split at point `index`. An OPEN path becomes two (the split point is in both); a CLOSED one
 * opens there (one record starting and ending at that point). Returns null when refused (an end
 * point of an open path, or a piece with fewer than two points).
 * @param {any} rec @param {number} index @returns {any[] | null}
 */
export function splitPath(rec, index) {
	const n = rec.points.length;
	if (!Number.isInteger(index) || index < 0 || index >= n) return null;
	if (rec.closed) {
		const out = copy(rec);
		const rotated = [...rec.points.slice(index), ...rec.points.slice(0, index)].map(copy);
		// the closing span (last -> first) becomes the walk back to the split point
		rotated.push({ ...copy(rec.points[index]) });
		for (const key of SPAN_KEYS) delete rotated[rotated.length - 1][key];
		out.points = rotated;
		out.closed = false;
		return [out];
	}
	if (index === 0 || index === n - 1) return null;
	const a = copy(rec);
	const b = copy(rec);
	a.points = rec.points.slice(0, index + 1).map(copy);
	// the last point of A owns no span now
	for (const key of SPAN_KEYS) delete a.points[a.points.length - 1][key];
	b.points = rec.points.slice(index).map(copy);
	return [a, b];
}

/**
 * Join B onto the end of A (both records' points in ONE frame — the caller converts). When A's
 * last point and B's first coincide (≤ `weld` m) they become one point (A's span fields stay
 * off it: B's first point owns the span that continues). The result takes A's path block.
 * @param {any} a @param {any} b @param {number} [weld]
 */
export function joinPaths(a, b, weld = 1e-3) {
	const out = copy(a);
	out.closed = false;
	const tail = out.points[out.points.length - 1];
	const head = b.points[0];
	const d = Math.hypot(tail.pos[0] - head.pos[0], tail.pos[1] - head.pos[1], tail.pos[2] - head.pos[2]);
	const rest = b.points.map(copy);
	if (d <= weld) {
		const first = rest.shift();
		// the welded point: A's wait / event / facing win, B's span fields continue the walk
		for (const key of SPAN_KEYS) {
			if (first[key] !== undefined) tail[key] = first[key];
			else delete tail[key];
		}
	}
	out.points.push(...rest);
	return out;
}

/**
 * The record a legacy Path patrol node's clicked waypoints become: WORLD points re-seated
 * around their centroid (the object's origin), a LINEAR path (the old patrol walked straight
 * lines), closed for `loop` (the old loop closed the polyline) and ping-pong otherwise. Pose
 * for pose identical to the old node at every shared time (tests/unit/pathCore.test.js).
 * @param {any} data the old node's data `{points, speed, mode}`
 * @returns {{record: any, center: number[]} | null}
 */
export function recordFromPatrol(data) {
	const raw = Array.isArray(data?.points) ? data.points : [];
	const pts = raw.filter((/** @type {any} */ p) => Array.isArray(p) && p.length >= 3 && p.slice(0, 3).every((/** @type {any} */ v) => Number.isFinite(+v)));
	if (pts.length < 2) return null;
	const center = [0, 1, 2].map((a) => pts.reduce((/** @type {number} */ s, /** @type {any} */ p) => s + +p[a], 0) / pts.length);
	const loop = (data.mode ?? 'loop') === 'loop';
	// a 2-point "loop" closes into A -> B -> A, which IS a ping-pong (a closed spline needs 3)
	const closed = loop && pts.length > 2;
	const record = newPathRecord({
		points: pts.map((/** @type {any} */ p) => ({ pos: [+p[0] - center[0], +p[1] - center[1], +p[2] - center[2]] })),
		closed,
		mode: closed ? 'loop' : 'pingpong',
		speed: clampNum(data.speed, 1, MIN_SPEED, MAX_SPEED),
		smooth: false
	});
	return { record, center };
}
