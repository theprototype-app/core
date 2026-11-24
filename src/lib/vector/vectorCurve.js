// 64-vector row 2: ONE CURVE — the bridge between a vector shape's bezier subpaths and 78's Path object
// (the spline record `{points: [{pos, radius}], closed, path}` that motion, patrol, the dolly and the
// array tool read). Decision (b) in STATUS / QUESTIONS-64-vector Q1: a pen path keeps its own bezier
// record (handles, holes, fills, corner radius do not fit a Catmull-Rom point list), and these two
// pure converters carry a curve across in either direction. The ONE bezier handle editor stays
// vectorEdit.js; splineEdit stays the point / radius editor of 3D curves. Imports only the path leaf.
//
//   vector -> Path: a subpath made only of lines becomes its corners on a LINEAR Path (smooth off:
//     exact); a curved one is flattened inside a tolerance chosen so the Path keeps <= MAX_CURVE_POINTS
//     points, on a smooth Path (Catmull-Rom through dense samples stays within the tolerance).
//   Path -> vector: each Catmull-Rom span becomes one cubic (the uniform conversion, handles =
//     (P[i+1] - P[i-1]) / 6 — exact for uniform Catmull-Rom, within a few % of three's centripetal on
//     ordinary spacing); a linear Path becomes corners. The 3D points are laid on their best plane
//     (Newell normal for a loop, the widest spread otherwise), so the shape has its own 2D frame.
import { flattenSubpath, node } from './vectorPath.js';

/** the most points a 78 Path holds (splineTube MAX_POINTS) */
export const MAX_CURVE_POINTS = 200;

/** @param {import('./vectorPath.js').VSubpath} sub */
const straight = (sub) => sub.nodes.every((n) => n.ix === 0 && n.iy === 0 && n.ox === 0 && n.oy === 0);

/**
 * A subpath as Path points in the shape's own 2D frame.
 * @param {import('./vectorPath.js').VSubpath} sub
 * @returns {{points: number[][], closed: boolean, smooth: boolean} | null}
 */
export function subpathToCurvePoints(sub, maxPoints = MAX_CURVE_POINTS) {
	if (!sub?.nodes?.length || sub.nodes.length < 2) return null;
	const closed = !!sub.closed && sub.nodes.length > 2;
	if (straight(sub)) {
		if (sub.nodes.length > maxPoints) return null;
		return { points: sub.nodes.map((n) => [n.x, n.y]), closed, smooth: false };
	}
	let tolerance = 0.01;
	for (let i = 0; i < 24; i++) {
		const pts = flattenSubpath({ ...sub, closed }, tolerance);
		if (pts.length <= maxPoints && pts.length >= 2) return { points: pts, closed, smooth: true };
		tolerance *= 1.6;
	}
	return null;
}

/** @param {number[]} a @param {number[]} b */
const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
/** @param {number[]} a @param {number[]} b */
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
/** @param {number[]} a @param {number[]} b */
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
/** @param {number[]} a */
const unit3 = (a) => {
	const l = Math.hypot(a[0], a[1], a[2]);
	return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : null;
};

/**
 * The plane a run of 3D points lies on: origin (centroid), in-plane axes x / y and normal z (right-handed).
 * A flat horizontal set gets z = +Y (a map on the floor, read from above); an open, straight-ish set uses
 * its widest direction as x. @param {number[][]} pts @returns {{origin: number[], x: number[], y: number[], z: number[]}}
 */
export function planeFrame(pts) {
	const n = pts.length || 1;
	const origin = [0, 1, 2].map((k) => pts.reduce((s, p) => s + p[k], 0) / n);
	// Newell's normal: robust for a loop, still meaningful for a bent open line
	let nx = 0,
		ny = 0,
		nz = 0;
	for (let i = 0; i < pts.length; i++) {
		const a = pts[i];
		const b = pts[(i + 1) % pts.length];
		nx += (a[1] - b[1]) * (a[2] + b[2]);
		ny += (a[2] - b[2]) * (a[0] + b[0]);
		nz += (a[0] - b[0]) * (a[1] + b[1]);
	}
	// the widest direction (first to farthest point) is the x axis candidate
	let far = pts[0] ?? origin;
	let best = -1;
	for (const p of pts) {
		const d = dot3(sub3(p, pts[0]), sub3(p, pts[0]));
		if (d > best) ((best = d), (far = p));
	}
	let x = unit3(sub3(far, pts[0] ?? origin)) ?? [1, 0, 0];
	let z = unit3([nx, ny, nz]);
	if (!z || Math.abs(dot3(z, x)) > 0.5) {
		// collinear (or no area): any plane holding the line; prefer the one containing world up
		z = unit3(cross3(x, [0, 1, 0])) ?? unit3(cross3(x, [0, 0, 1])) ?? [0, 0, 1];
	}
	// a horizontal set reads from above (+Y normal)
	if (Math.abs(z[1]) > 0.999 && z[1] < 0) z = [-z[0], -z[1], -z[2]];
	// x exactly in the plane, y completes a right-handed frame
	x = unit3(sub3(x, z.map((c) => c * dot3(x, z)))) ?? [1, 0, 0];
	const y = cross3(z, x);
	return { origin, x, y, z };
}

/**
 * 78 Path points (3D, any frame) -> one bezier subpath in a plane frame of its own.
 * @param {number[][]} pts @param {{closed?: boolean, smooth?: boolean}} [opts]
 * @returns {{sub: import('./vectorPath.js').VSubpath, frame: ReturnType<typeof planeFrame>} | null}
 */
export function curvePointsToSubpath(pts, opts = {}) {
	if (!Array.isArray(pts) || pts.length < 2) return null;
	const frame = planeFrame(pts);
	const flat = pts.map((p) => {
		const d = sub3(p, frame.origin);
		return [dot3(d, frame.x), dot3(d, frame.y)];
	});
	const closed = !!opts.closed && flat.length > 2;
	const smooth = opts.smooth !== false;
	const n = flat.length;
	const at = (/** @type {number} */ i) => (closed ? flat[(i + n) % n] : flat[Math.max(0, Math.min(n - 1, i))]);
	const nodes = flat.map((p, i) => {
		if (!smooth) return node(p[0], p[1]);
		const prev = at(i - 1);
		const next = at(i + 1);
		const tx = (next[0] - prev[0]) / 6;
		const ty = (next[1] - prev[1]) / 6;
		// an open end has one neighbour: its handle on the far side stays put
		const first = !closed && i === 0;
		const last = !closed && i === n - 1;
		return node(p[0], p[1], first ? 0 : -tx, first ? 0 : -ty, last ? 0 : tx, last ? 0 : ty, !first && !last);
	});
	return { sub: { closed, nodes }, frame };
}
