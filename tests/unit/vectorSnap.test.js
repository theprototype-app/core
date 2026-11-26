// @ts-nocheck — a fixture test
// 64-vector-edit (D5 row 2): the order of the snapping rules in a shape's plane — point, edge, smart
// guides per axis, grid on the axes no guide took — and that nothing in reach leaves the point alone.
import { describe, test, expect } from 'vitest';
import { snap2d, nearestOnSegment, roundTo } from '../../src/lib/vector/vectorSnapCore.js';

const grid = (step) => (p) => [roundTo(p[0], step), roundTo(p[1], step)];

describe('snap2d', () => {
	test('nothing configured: the point stays', () => {
		expect(snap2d([0.123, 0.456], {})).toEqual({ at: [0.123, 0.456], kind: null, guides: [] });
	});
	test('a point inside tol wins over everything, the nearest of several', () => {
		const r = snap2d([1.02, 0.99], { points: [[1, 1], [1.03, 0.99]], tol: 0.05, guides: true, guideTol: 0.01, grid: grid(0.5) });
		expect(r.kind).toBe('point');
		expect(r.at).toEqual([1.03, 0.99]);
	});
	test('an edge inside tol: the nearest spot on it', () => {
		const r = snap2d([0.5, 0.03], { segments: [[[0, 0], [1, 0]]], tol: 0.05 });
		expect(r.kind).toBe('edge');
		expect(r.at[0]).toBeCloseTo(0.5, 9);
		expect(r.at[1]).toBeCloseTo(0, 9);
	});
	test('out of tol: points and edges do not answer, the grid does', () => {
		const r = snap2d([0.37, 0.62], { points: [[3, 3]], segments: [[[5, 5], [6, 6]]], tol: 0.05, grid: grid(0.25) });
		expect(r).toEqual({ at: [0.25, 0.5], kind: 'grid', guides: [] });
	});
	test('smart guides take x and y independently, the grid fills the rest', () => {
		const r = snap2d([2.004, 0.71], { guidePoints: [[2, 5], [9, 9]], guides: true, guideTol: 0.01, grid: grid(0.5) });
		expect(r.kind).toBe('guide');
		expect(r.at).toEqual([2, 0.5]);
		expect(r.guides).toEqual([{ axis: 0, value: 2, from: [2, 5] }]);
		const both = snap2d([2.004, 4.996], { guidePoints: [[2, 1], [7, 5]], guides: true, guideTol: 0.01 });
		expect(both.at).toEqual([2, 5]);
		expect(both.guides.map((g) => g.axis)).toEqual([0, 1]);
	});
	test('guides off: guide points are ignored', () => {
		expect(snap2d([2.004, 0.71], { guidePoints: [[2, 5]], guides: false, guideTol: 0.01 }).kind).toBe(null);
	});
	test('equal guide offsets: the candidate nearer along the other axis draws the guide (deterministic)', () => {
		const r = snap2d([0, 0], { guidePoints: [[0, 9], [0, 1]], guides: true, guideTol: 0.01 });
		expect(r.guides[0].from).toEqual([0, 1]);
	});
});

describe('helpers', () => {
	test('nearestOnSegment clamps to the ends and survives a zero-length segment', () => {
		expect(nearestOnSegment([0, 0], [1, 0], [2, 1])).toEqual([1, 0]);
		expect(nearestOnSegment([0, 0], [1, 0], [-2, 1])).toEqual([0, 0]);
		expect(nearestOnSegment([1, 1], [1, 1], [5, 5])).toEqual([1, 1]);
	});
	test('roundTo: a step <= 0 leaves the value', () => {
		expect(roundTo(0.26, 0.25)).toBe(0.25);
		expect(roundTo(0.26, 0)).toBe(0.26);
	});
});
