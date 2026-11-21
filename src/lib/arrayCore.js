// @ts-ignore - no bundled three type declarations (project-wide)
import * as THREE from 'three';

// 102b-arrange row 1 — THE ARRAY RECORD and the pose of every copy. A LEAF over three (the runtime,
// the Inspector, "Make real objects" and the agent tool all reach it; it records nothing).
//
// An array is a record on an ordinary object: `userData.array`. The object itself is copy 0 and
// stays a normal object; copies 1..n-1 are drawn by every peer from the record (arrayRuntime.js,
// instanced at the scene root — golden rules 5 and 8), so a save, a sync and an undo carry ONE small
// record however many copies it makes. An older build skips the field and shows the one object.
//
// Every pose is in the object's PARENT frame, relative to the object's own local pose, so moving,
// turning or scaling the object moves the whole array with it.

/** copies in one array, the object itself included (one InstancedMesh per source mesh draws them) */
export const ARRAY_MAX = 500;
export const ARRAY_MODES = /** @type {const} */ (['line', 'grid', 'circle', 'path']);

/** @typedef {{v: 1, mode: 'line'|'grid'|'circle'|'path', count: number, step: number[], grid: number[],
 *   gridStep: number[], radius: number, arc: number, faceOut: boolean, path: string, spacing: number,
 *   follow: boolean, rotStep: number[], scaleStep: number}} ArrayRecord
 *  step: line offset between neighbours (m); grid: columns/rows/layers on x/y/z; gridStep: grid spacing;
 *  radius/arc (degrees, 360 = a full ring)/faceOut: the circle (centre `radius` m on -X of the object, about
 *  the parent's Y); path: the uuid of a Path (or any object text can follow); spacing: m along the path
 *  (0 = spread evenly over its length); follow: copies turn with the path; rotStep: degrees per copy
 *  (x, y, z, in each copy's own frame); scaleStep: size change per copy (0.1 = each 10 % bigger). */

/** @type {ArrayRecord} */
export const ARRAY_DEFAULTS = Object.freeze({
	v: 1,
	mode: 'line',
	count: 5,
	step: [2, 0, 0],
	grid: [3, 1, 3],
	gridStep: [2, 2, 2],
	radius: 3,
	arc: 360,
	faceOut: true,
	path: '',
	spacing: 0,
	follow: true,
	rotStep: [0, 0, 0],
	scaleStep: 0
});

/** @param {any} v @param {number} lo @param {number} hi @param {number} d */
const num = (v, lo, hi, d) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
/** @param {any} v @param {number} lo @param {number} hi @param {number} d */
const int = (v, lo, hi, d) => Math.round(num(v, lo, hi, d));
/** @param {any} v @param {number} lo @param {number} hi @param {number[]} d */
const vec = (v, lo, hi, d) => (Array.isArray(v) && v.length === 3 ? v.map((n, i) => num(n, lo, hi, d[i])) : [...d]);

/**
 * Clean a record from anywhere (a save, a peer, the agent, the Inspector). Unknown keys are dropped;
 * null for anything that is not an object or names an unknown mode.
 * @param {any} raw @returns {ArrayRecord | null}
 */
export function normalizeArray(raw) {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
	const d = ARRAY_DEFAULTS;
	const mode = ARRAY_MODES.includes(raw.mode) ? raw.mode : raw.mode === undefined ? d.mode : null;
	if (!mode) return null;
	const grid = vec(raw.grid, 1, 50, d.grid).map((n) => Math.round(n));
	// the grid's product is the copy count: shrink the deepest axis first until it fits
	for (let axis = 2; axis >= 0 && grid[0] * grid[1] * grid[2] > ARRAY_MAX; axis--) {
		const others = grid.reduce((p, n, i) => (i === axis ? p : p * n), 1);
		grid[axis] = Math.max(1, Math.floor(ARRAY_MAX / others));
	}
	return {
		v: 1,
		mode,
		count: int(raw.count, 2, ARRAY_MAX, d.count),
		step: vec(raw.step, -1000, 1000, d.step),
		grid,
		gridStep: vec(raw.gridStep, -1000, 1000, d.gridStep),
		radius: num(raw.radius, 0, 1000, d.radius),
		arc: num(raw.arc, 1, 360, d.arc),
		faceOut: typeof raw.faceOut === 'boolean' ? raw.faceOut : d.faceOut,
		path: typeof raw.path === 'string' && raw.path.length <= 64 ? raw.path : '',
		spacing: num(raw.spacing, 0, 1000, d.spacing),
		follow: typeof raw.follow === 'boolean' ? raw.follow : d.follow,
		rotStep: vec(raw.rotStep, -360, 360, d.rotStep),
		scaleStep: num(raw.scaleStep, -0.9, 10, d.scaleStep)
	};
}

/** how many objects the array shows, the original included @param {ArrayRecord} rec */
export function arrayTotal(rec) {
	return rec.mode === 'grid' ? rec.grid[0] * rec.grid[1] * rec.grid[2] : rec.count;
}

/** a short line for the Inspector, toasts and the agent ("5 in a line") @param {ArrayRecord} rec */
export function arraySummary(rec) {
	const n = arrayTotal(rec);
	if (rec.mode === 'grid') return `${rec.grid.join(' x ')} grid (${n})`;
	if (rec.mode === 'circle') return `${n} in a ${rec.arc >= 360 ? 'circle' : 'arc'}`;
	if (rec.mode === 'path') return `${n} along a path`;
	return `${n} in a line`;
}

/**
 * A polyline measured once: cumulative lengths, for points and tangents at a distance.
 * @param {number[][]} points @param {boolean} closed
 */
export function measurePolyline(points, closed) {
	const pts = points.filter((p) => Array.isArray(p) && p.length >= 3 && p.every((n) => Number.isFinite(n))).map((p) => [p[0], p[1], p[2]]);
	if (closed && pts.length > 2) pts.push(pts[0]);
	/** @type {number[]} */
	const cum = [0];
	for (let i = 1; i < pts.length; i++) {
		const a = pts[i - 1];
		const b = pts[i];
		cum.push(cum[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]));
	}
	return { pts, cum, length: cum[cum.length - 1] ?? 0, closed: closed && pts.length > 3 };
}

/**
 * Point + unit tangent at distance `s` along a measured polyline (clamped to its ends).
 * @param {ReturnType<typeof measurePolyline>} line @param {number} s
 * @returns {{point: number[], tangent: number[]}}
 */
export function pointAt(line, s) {
	const { pts, cum, length } = line;
	if (pts.length < 2 || length <= 0) return { point: pts[0] ?? [0, 0, 0], tangent: [1, 0, 0] };
	const at = Math.min(length, Math.max(0, s));
	let i = 1;
	while (i < cum.length - 1 && cum[i] < at) i++;
	// skip zero-length segments so the tangent is never NaN
	while (i < cum.length - 1 && cum[i] - cum[i - 1] < 1e-9) i++;
	const a = pts[i - 1];
	const b = pts[i];
	const seg = cum[i] - cum[i - 1];
	const t = seg > 1e-9 ? (at - cum[i - 1]) / seg : 0;
	const tangent = seg > 1e-9 ? [(b[0] - a[0]) / seg, (b[1] - a[1]) / seg, (b[2] - a[2]) / seg] : [1, 0, 0];
	return { point: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t], tangent };
}

const _q = new THREE.Quaternion();
const _qStep = new THREE.Quaternion();
const _e = new THREE.Euler();
const _t0 = new THREE.Vector3();
const _t1 = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const DEG = Math.PI / 180;

/**
 * The poses of copies 1..n-1 in the object's PARENT frame. `base` is the object's local pose;
 * `path` is the followed polyline already in that parent frame (path mode only; absent or too
 * short = no copies, the Inspector says "Pick a path").
 * @param {ArrayRecord} rec
 * @param {{position: number[], quaternion: number[], scale: number[]}} base
 * @param {{points: number[][], closed: boolean} | null} [path]
 * @returns {{position: number[], quaternion: number[], scale: number[]}[]}
 */
export function arrayCopyPoses(rec, base, path = null) {
	const n = arrayTotal(rec);
	const [px, py, pz] = base.position;
	const baseQ = new THREE.Quaternion().fromArray(base.quaternion);
	/** @type {{position: number[], quaternion: number[], scale: number[]}[]} */
	const out = [];
	let line = null;
	let start = null;
	if (rec.mode === 'path') {
		line = path ? measurePolyline(path.points, !!path.closed) : null;
		if (!line || line.length <= 1e-6) return out;
		start = pointAt(line, 0);
		_t0.fromArray(start.tangent);
	}
	for (let i = 1; i < n; i++) {
		let pos = [px, py, pz];
		_q.copy(baseQ);
		if (rec.mode === 'line') {
			pos = [px + rec.step[0] * i, py + rec.step[1] * i, pz + rec.step[2] * i];
		} else if (rec.mode === 'grid') {
			const [nx, ny] = rec.grid;
			const ix = i % nx;
			const iy = Math.floor(i / nx) % ny;
			const iz = Math.floor(i / (nx * ny));
			pos = [px + rec.gridStep[0] * ix, py + rec.gridStep[1] * iy, pz + rec.gridStep[2] * iz];
		} else if (rec.mode === 'circle') {
			const theta = rec.arc >= 360 ? (i * 2 * Math.PI) / n : (i * rec.arc * DEG) / (n - 1);
			// the centre sits `radius` on -X of the object, so the object itself is at angle 0
			const cx = px - rec.radius;
			pos = [cx + rec.radius * Math.cos(theta), py, pz - rec.radius * Math.sin(theta)];
			if (rec.faceOut) _q.premultiply(_qStep.setFromAxisAngle(_up, theta));
		} else if (line && start) {
			const s = rec.spacing > 0 ? rec.spacing * i : line.closed ? (line.length * i) / n : (line.length * i) / (n - 1);
			if (s > line.length + 1e-6) {
				if (!line.closed) break; // an open path ends: no copy hangs past it
			}
			const at = pointAt(line, line.closed ? s % line.length : s);
			pos = [px + at.point[0] - start.point[0], py + at.point[1] - start.point[1], pz + at.point[2] - start.point[2]];
			if (rec.follow) _q.premultiply(_qStep.setFromUnitVectors(_t0, _t1.fromArray(at.tangent)));
		}
		if (rec.rotStep[0] || rec.rotStep[1] || rec.rotStep[2]) {
			_e.set(rec.rotStep[0] * DEG * i, rec.rotStep[1] * DEG * i, rec.rotStep[2] * DEG * i);
			_q.multiply(_qStep.setFromEuler(_e));
		}
		const f = Math.max(0.01, 1 + rec.scaleStep * i);
		out.push({ position: pos, quaternion: _q.toArray(), scale: base.scale.map((s) => s * f) });
	}
	return out;
}
