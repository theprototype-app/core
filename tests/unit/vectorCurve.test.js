// @ts-nocheck — a fixture test: results are asserted non-null by the checks themselves
// 64-vector row 2 (one curve): a vector subpath <-> 78 Path points, both ways (vectorCurve.js).
import { describe, test, expect } from 'vitest';
import { subpathToCurvePoints, curvePointsToSubpath, planeFrame, outerSubpath, MAX_CURVE_POINTS } from '../../src/lib/vector/vectorCurve.js';
import { rectPath, ellipsePath, starPath, segmentControls, cubicAt } from '../../src/lib/vector/vectorPath.js';

const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

describe('vector -> Path', () => {
	test('a straight outline (rect, star) is its corners on a LINEAR Path: exact', () => {
		const [rect] = rectPath(2, 1, 0);
		const c = subpathToCurvePoints(rect);
		expect(c.smooth).toBe(false);
		expect(c.closed).toBe(true);
		expect(c.points).toEqual(rect.nodes.map((n) => [n.x, n.y]));
		const [star] = starPath(5, 1, 0.4, 0);
		expect(subpathToCurvePoints(star).points.length).toBe(10);
	});

	test('a curved outline is flattened within the 200-point cap, every sample on the curve', () => {
		const [circle] = ellipsePath(20, 20);
		const c = subpathToCurvePoints(circle);
		expect(c.smooth).toBe(true);
		expect(c.points.length).toBeLessThanOrEqual(MAX_CURVE_POINTS);
		expect(c.points.length).toBeGreaterThan(16);
		for (const [x, y] of c.points) expect(Math.abs(Math.hypot(x, y) - 10)).toBeLessThan(0.01);
		// a 20 m circle at the default tolerance would pass the cap: points were dropped (the toast says so)
		expect(c.coarser).toBe(true);
		const small = subpathToCurvePoints(ellipsePath(0.5, 0.5)[0]);
		expect(small.coarser).toBe(false);
		expect(subpathToCurvePoints(rectPath(2, 1, 0)[0]).coarser).toBe(false);
		// a rounded rect mixes both: still under the cap, still closed
		const [rr] = rectPath(4, 2, 0.5);
		const r = subpathToCurvePoints(rr);
		expect(r.closed).toBe(true);
		expect(r.points.length).toBeLessThanOrEqual(MAX_CURVE_POINTS);
	});

	test('a cap too small for the corners is refused (null), not truncated', () => {
		const [star] = starPath(32, 1, 0.4, 0);
		expect(subpathToCurvePoints(star, 10)).toBeNull();
	});
});

describe('the outer ring (ruling Q1: a shape with holes converts its outline only)', () => {
	test('the largest ring wins, whatever the order', () => {
		const [hole] = rectPath(1, 1, 0);
		const [outline] = rectPath(4, 3, 0);
		expect(outerSubpath([hole, outline])).toBe(outline);
		expect(outerSubpath([outline, hole])).toBe(outline);
		expect(outerSubpath([])).toBeNull();
	});
});

describe('Path -> vector', () => {
	test('a linear Path gives corners in its plane; the frame maps them back to the same 3D points', () => {
		const pts = [[0, 1, 0], [2, 1, 0], [2, 1, 3], [0, 1, 3]];
		const r = curvePointsToSubpath(pts, { closed: true, smooth: false });
		expect(r.sub.closed).toBe(true);
		expect(r.sub.nodes.every((n) => n.ix === 0 && n.ox === 0)).toBe(true);
		// a floor plan reads from above: the normal is +Y
		expect(near(r.frame.z[1], 1, 1e-9)).toBe(true);
		r.sub.nodes.forEach((n, i) => {
			const back = [0, 1, 2].map((k) => r.frame.origin[k] + r.frame.x[k] * n.x + r.frame.y[k] * n.y);
			back.forEach((v, k) => expect(near(v, pts[i][k], 1e-9)).toBe(true));
		});
	});

	test('a smooth Path: every span is the uniform Catmull-Rom cubic (handles = (next - prev) / 6)', () => {
		const pts = [[0, 0, 0], [1, 0.5, 0], [2, 0, 0], [3, 0.7, 0], [4, 0, 0]];
		const { sub } = curvePointsToSubpath(pts, { smooth: true });
		expect(sub.closed).toBe(false);
		// the cubic passes through every point and matches uniform Catmull-Rom at t = 0.5 of an inner span
		const P = sub.nodes.map((n) => [n.x, n.y]);
		const cr = (p0, p1, p2, p3, t) => [0, 1].map((k) => 0.5 * (2 * p1[k] + (-p0[k] + p2[k]) * t + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t * t + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t * t * t));
		const mid = cubicAt(segmentControls(sub.nodes[1], sub.nodes[2]), 0.5);
		const want = cr(P[0], P[1], P[2], P[3], 0.5);
		expect(near(mid[0], want[0], 1e-9) && near(mid[1], want[1], 1e-9)).toBe(true);
		// open ends: no handle off the end
		expect(sub.nodes[0].ix).toBe(0);
		expect(sub.nodes[4].ox).toBe(0);
	});

	test('a tilted loop lies on its own plane (z = Newell normal, x / y in plane, right-handed)', () => {
		const s = Math.SQRT1_2;
		const pts = [[0, 0, 0], [1, s, s], [1, 1 + s, -1 + s], [0, 1, -1]].map((p) => p);
		const f = planeFrame(pts);
		const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
		expect(near(dot(f.x, f.z), 0, 1e-9) && near(dot(f.y, f.z), 0, 1e-9) && near(dot(f.x, f.y), 0, 1e-9)).toBe(true);
		for (const p of pts) expect(Math.abs(dot([p[0] - f.origin[0], p[1] - f.origin[1], p[2] - f.origin[2]], f.z))).toBeLessThan(1e-9);
	});

	test('a round trip vector -> Path -> vector keeps a straight outline exactly', () => {
		const [rect] = rectPath(2, 1, 0);
		const c = subpathToCurvePoints(rect);
		const pts3 = c.points.map(([x, y]) => [x, 0, -y]); // laid on the floor
		const back = curvePointsToSubpath(pts3, { closed: c.closed, smooth: c.smooth });
		expect(back.sub.nodes.length).toBe(rect.nodes.length);
		// same side lengths (the frame may rotate it in its plane)
		const len = (ns) => ns.map((n, i) => Math.hypot(ns[(i + 1) % ns.length].x - n.x, ns[(i + 1) % ns.length].y - n.y));
		len(back.sub.nodes).forEach((l, i) => expect(near(l, len(rect.nodes)[i], 1e-9)).toBe(true));
	});

	test('fewer than two points: null', () => {
		expect(curvePointsToSubpath([[0, 0, 0]])).toBeNull();
		expect(subpathToCurvePoints({ closed: false, nodes: [] })).toBeNull();
	});
});
