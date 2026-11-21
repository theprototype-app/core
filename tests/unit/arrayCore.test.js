// @ts-nocheck — fixture records as plain literals
import { describe, it, expect } from 'vitest';
import { normalizeArray, arrayTotal, arrayCopyPoses, arraySummary, measurePolyline, pointAt, ARRAY_MAX } from '../../src/lib/arrayCore.js';

// 102b-arrange row 1: the array record and the copy poses.

const base = { position: [1, 0, 2], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] };
const near = (a, b, eps = 1e-6) => a.every((v, i) => Math.abs(v - b[i]) < eps);

describe('normalizeArray', () => {
	it('fills defaults and drops junk', () => {
		const r = normalizeArray({ mode: 'line', count: 3, evil: 1 });
		expect(r.count).toBe(3);
		expect(r.evil).toBeUndefined();
		expect(r.step).toEqual([2, 0, 0]);
	});
	it('refuses non-objects and unknown modes', () => {
		expect(normalizeArray(null)).toBeNull();
		expect(normalizeArray([])).toBeNull();
		expect(normalizeArray({ mode: 'spiral' })).toBeNull();
	});
	it('clamps the count and shrinks a grid over the cap', () => {
		expect(normalizeArray({ count: 99999 }).count).toBe(ARRAY_MAX);
		expect(normalizeArray({ count: 1 }).count).toBe(2);
		const g = normalizeArray({ mode: 'grid', grid: [50, 50, 50] });
		expect(arrayTotal(g)).toBeLessThanOrEqual(ARRAY_MAX);
		expect(g.grid[0]).toBe(50);
	});
	it('keeps NaN and Infinity out', () => {
		const r = normalizeArray({ step: [NaN, Infinity, 1], radius: -4 });
		expect(r.step).toEqual([2, 0, 1]);
		expect(r.radius).toBe(0);
	});
});

describe('arrayCopyPoses', () => {
	it('line: n-1 copies at i x step from the object', () => {
		const p = arrayCopyPoses(normalizeArray({ mode: 'line', count: 4, step: [0, 0, 1.5] }), base);
		expect(p.length).toBe(3);
		expect(p.map((c) => c.position)).toEqual([
			[1, 0, 3.5],
			[1, 0, 5],
			[1, 0, 6.5]
		]);
	});
	it('grid: x fastest, then y, then z', () => {
		const p = arrayCopyPoses(normalizeArray({ mode: 'grid', grid: [2, 1, 2], gridStep: [1, 1, 3] }), base);
		expect(p.map((c) => c.position)).toEqual([
			[2, 0, 2],
			[1, 0, 5],
			[2, 0, 5]
		]);
	});
	it('circle: a full ring stays on the radius and faces out', () => {
		const rec = normalizeArray({ mode: 'circle', count: 4, radius: 2 });
		const p = arrayCopyPoses(rec, base);
		// centre at (-1, 0, 2)
		for (const c of p) expect(Math.hypot(c.position[0] + 1, c.position[2] - 2)).toBeCloseTo(2, 6);
		expect(near(p[1].position, [-3, 0, 2])).toBe(true); // half way round
		// a quarter turn about Y for copy 1
		expect(Math.abs(p[0].quaternion[1])).toBeCloseTo(Math.sin(Math.PI / 4), 6);
	});
	it('circle: an arc ends exactly on its last angle', () => {
		const p = arrayCopyPoses(normalizeArray({ mode: 'circle', count: 3, radius: 1, arc: 180, faceOut: false }), base);
		expect(near(p[1].position, [-1, 0, 2])).toBe(true);
		expect(p[1].quaternion).toEqual([0, 0, 0, 1]);
	});
	it('path: follows the shape of the polyline from the object, evenly spread', () => {
		const path = { points: [[0, 0, 0], [4, 0, 0], [4, 0, 4]], closed: false };
		const p = arrayCopyPoses(normalizeArray({ mode: 'path', count: 3 }), base, path);
		expect(p.length).toBe(2);
		expect(near(p[0].position, [5, 0, 2])).toBe(true); // 4 m along: the corner
		expect(near(p[1].position, [5, 0, 6])).toBe(true); // the end
	});
	it('path: spacing past an open end makes no copy; no path = none', () => {
		const path = { points: [[0, 0, 0], [3, 0, 0]], closed: false };
		expect(arrayCopyPoses(normalizeArray({ mode: 'path', count: 10, spacing: 1 }), base, path).length).toBe(3);
		expect(arrayCopyPoses(normalizeArray({ mode: 'path', count: 10 }), base, null)).toEqual([]);
	});
	it('rotation and scale steps grow per copy', () => {
		const p = arrayCopyPoses(normalizeArray({ count: 3, rotStep: [0, 90, 0], scaleStep: 0.5 }), base);
		expect(p[0].scale).toEqual([1.5, 1.5, 1.5]);
		expect(p[1].scale).toEqual([2, 2, 2]);
		expect(Math.abs(p[1].quaternion[1])).toBeCloseTo(1, 6); // 180 degrees
	});
	it('never shrinks a copy to nothing', () => {
		const p = arrayCopyPoses(normalizeArray({ count: 5, scaleStep: -0.9 }), base);
		expect(Math.min(...p.map((c) => c.scale[0]))).toBeGreaterThan(0);
	});
});

describe('polyline helpers + summary', () => {
	it('measures and samples', () => {
		const l = measurePolyline([[0, 0, 0], [0, 0, 0], [0, 2, 0]], false);
		expect(l.length).toBe(2);
		expect(pointAt(l, 1).point).toEqual([0, 1, 0]);
		expect(pointAt(l, 1).tangent).toEqual([0, 1, 0]);
	});
	it('says what the array is', () => {
		expect(arraySummary(normalizeArray({ count: 5 }))).toBe('5 in a line');
		expect(arraySummary(normalizeArray({ mode: 'grid', grid: [2, 3, 1] }))).toBe('2 x 3 x 1 grid (6)');
	});
});
