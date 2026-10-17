import { describe, it, expect } from 'vitest';
import { chainStats, jointAngle, formatLength, formatAngle, chainLabels, segmentDelta, normalizeMeasure, raySegment, nearestScreenPoint, layoutLabels, MEASURE_MAX_POINTS } from '../../src/lib/measureCore.js';

// 47 M1: the Measure tool's arithmetic — chain lengths, the angle between segments, the labels.

describe('chainStats', () => {
	it('sums the segments of a chain and reads the turn at each joint', () => {
		// three corners of a 2 x 1 rectangle: 2 m along x, then 1 m along z — a right angle
		const s = chainStats([
			[0, 0, 0],
			[2, 0, 0],
			[2, 0, 1]
		]);
		expect(s.segments).toEqual([2, 1]);
		expect(s.total).toBe(3);
		expect(s.angles).toHaveLength(1);
		expect(s.angles[0]).toBeCloseTo(90, 9);
	});
	it('has no segment or angle for one point, and no angle for two', () => {
		expect(chainStats([[1, 2, 3]])).toEqual({ segments: [], total: 0, angles: [] });
		const two = chainStats([
			[0, 0, 0],
			[0, 3, 4]
		]);
		expect(two.segments).toEqual([5]);
		expect(two.angles).toEqual([]);
	});
	it('a straight run reads 180 degrees and a fold-back reads 0', () => {
		expect(jointAngle([0, 0, 0], [1, 0, 0], [2, 0, 0])).toBeCloseTo(180, 9);
		expect(jointAngle([0, 0, 0], [1, 0, 0], [0.5, 0, 0])).toBeCloseTo(0, 6);
		expect(jointAngle([1, 0, 0], [0, 0, 0], [1, 1, 0])).toBeCloseTo(45, 9);
	});
	it('a zero-length segment (a double click on one spot) has no angle, never NaN', () => {
		expect(jointAngle([0, 0, 0], [0, 0, 0], [1, 0, 0])).toBeNull();
		const s = chainStats([
			[0, 0, 0],
			[1, 0, 0],
			[1, 0, 0]
		]);
		expect(s.angles).toEqual([null]);
		expect(formatAngle(s.angles[0])).toBe('—');
	});
});

describe('formatting', () => {
	it('metres to the millimetre under 10 m, centimetres above', () => {
		expect(formatLength(1)).toBe('1.000 m');
		expect(formatLength(0.0254)).toBe('0.025 m');
		expect(formatLength(12.345)).toBe('12.35 m');
		expect(formatLength(NaN)).toBe('—');
	});
	it('degrees to one decimal', () => {
		expect(formatAngle(90)).toBe('90.0°');
		expect(formatAngle(null)).toBe('—');
	});
	it('segmentDelta is b minus a per axis', () => {
		expect(segmentDelta([1, 2, 3], [2, 2, 1])).toEqual([1, 0, -2]);
	});
});

describe('chainLabels', () => {
	const chain = [
		[0, 0, 0],
		[2, 0, 0],
		[2, 0, 1],
		[0, 0, 1]
	];
	it('labels every segment at its midpoint, every joint with its angle, and the total at the end', () => {
		const labels = chainLabels(chain, 'c');
		const segments = labels.filter((l) => l.kind === 'segment');
		const angles = labels.filter((l) => l.kind === 'angle');
		const totals = labels.filter((l) => l.kind === 'total');
		expect(segments.map((l) => l.text)).toEqual(['2.000 m', '1.000 m', '2.000 m']);
		expect(segments[0].point).toEqual([1, 0, 0]);
		expect(angles.map((l) => l.text)).toEqual(['90.0°', '90.0°']);
		expect(angles[0].point).toEqual([2, 0, 0]);
		expect(totals).toHaveLength(1);
		expect(totals[0].text).toBe('Total 5.000 m');
		expect(totals[0].point).toEqual([0, 0, 1]);
	});
	it('a single segment has no total; keys are stable per chain and index', () => {
		const labels = chainLabels(chain.slice(0, 2), 'p1');
		expect(labels.map((l) => l.key)).toEqual(['p1:s0']);
		expect(chainLabels(chain, 'p1').map((l) => l.key)).toEqual(['p1:s0', 'p1:s1', 'p1:s2', 'p1:a0', 'p1:a1', 'p1:t']);
	});
});

// 48 B2: a measurement as a scene item — the record boundary, the selection pick, label layout.
describe('normalizeMeasure', () => {
	it('keeps finite points, needs two, caps the chain', () => {
		expect(normalizeMeasure({ points: [[0, 0, 0], [1, 2, 3]] })).toEqual({ v: 1, points: [[0, 0, 0], [1, 2, 3]] });
		expect(normalizeMeasure({ points: [[0, 0, 0]] })).toBeNull();
		expect(normalizeMeasure({ points: [[0, 0, 0], [NaN, 0, 0], ['x'], [1, 1, 1]] })?.points).toEqual([[0, 0, 0], [1, 1, 1]]);
		expect(normalizeMeasure({ points: [[0, 0, 0], ['1', '2', '3']] })?.points[1]).toEqual([1, 2, 3]);
		expect(normalizeMeasure(null)).toBeNull();
		expect(normalizeMeasure({ points: 'no' })).toBeNull();
		const long = Array.from({ length: 200 }, (_, i) => [i, 0, 0]);
		expect(normalizeMeasure({ points: long })?.points.length).toBe(MEASURE_MAX_POINTS);
	});
});

describe('raySegment', () => {
	it('measures how near a ray passes a segment, and where along the ray', () => {
		// a ray down -z from z=10, passing 0.5 above the x segment at z=0
		const r = raySegment([0, 0.5, 10], [0, 0, -1], [-1, 0, 0], [1, 0, 0]);
		expect(r.dist).toBeCloseTo(0.5, 9);
		expect(r.t).toBeCloseTo(10, 9);
		expect(r.point).toEqual([0, 0, 0]);
	});
	it('clamps to the segment ends', () => {
		const r = raySegment([5, 0, 10], [0, 0, -1], [-1, 0, 0], [1, 0, 0]);
		expect(r.point).toEqual([1, 0, 0]);
		expect(r.dist).toBeCloseTo(4, 9);
	});
	it('a ray along the segment line and a zero-length segment do not blow up', () => {
		expect(Number.isFinite(raySegment([0, 0, 0], [1, 0, 0], [2, 0, 0], [3, 0, 0]).dist)).toBe(true);
		expect(raySegment([0, 1, 0], [0, -1, 0], [0, 0, 0], [0, 0, 0]).dist).toBeCloseTo(0, 9);
	});
});

describe('nearestScreenPoint', () => {
	it('picks the closest within the radius, skips points behind the camera', () => {
		expect(nearestScreenPoint([[0, 0], null, [10, 0], [12, 0]], [11.5, 0], 5)).toBe(3);
		expect(nearestScreenPoint([[0, 0], [100, 100]], [50, 50], 10)).toBe(-1);
		expect(nearestScreenPoint([null], [0, 0], 10)).toBe(-1);
	});
});

describe('layoutLabels', () => {
	/** @param {{x0: number, y0: number, x1: number, y1: number}} a @param {{x0: number, y0: number, x1: number, y1: number}} b */
	const overlap = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
	/** @param {any} l */
	const box = (l) => ({ x0: l.x - l.w / 2, y0: l.y - 10.5, x1: l.x + l.w / 2, y1: l.y + 10.5 });

	it('a chain of SHORT segments: no two drawn labels overlap (the 47 blot)', () => {
		// the labels of a 4-segment chain whose segments are 6 px long on screen
		const pts = [[0, 0, 0], [0.01, 0, 0], [0.02, 0, 0], [0.03, 0, 0], [0.04, 0, 0]];
		const anchors = chainLabels(pts, 'c').map((l, i) => ({ ...l, x: 400 + i * 6, y: 300 }));
		// premise: laid on their anchors they DO overlap
		const naive = anchors.map((l) => ({ ...l, w: l.text.length * 7.2 + 16 }));
		expect(naive.some((a, i) => naive.some((b, j) => i < j && overlap(box(a), box(b))))).toBe(true);
		const out = layoutLabels(anchors);
		const shown = out.filter((l) => !l.hidden);
		expect(shown.length).toBeGreaterThanOrEqual(4);
		for (let i = 0; i < shown.length; i++) for (let j = i + 1; j < shown.length; j++) expect(overlap(box(shown[i]), box(shown[j]))).toBe(false);
	});

	it('labels with room stay at their natural spot; order of the input is kept', () => {
		const out = layoutLabels([
			{ key: 'a', kind: 'segment', text: '2.000 m', x: 100, y: 100 },
			{ key: 'b', kind: 'segment', text: '1.000 m', x: 400, y: 100 }
		]);
		expect(out.map((l) => l.key)).toEqual(['a', 'b']);
		expect(out[0].x).toBe(100);
		expect(out[0].y).toBe(85); // the segment label sits above its midpoint
		expect(out.every((l) => !l.hidden)).toBe(true);
	});

	it('segments win a crowded spot over angles; one with no room left is hidden, not stacked', () => {
		const crowd = Array.from({ length: 30 }, (_, i) => ({ key: 'k' + i, kind: i % 2 ? 'angle' : 'segment', text: '1.000 m', x: 200, y: 200 }));
		const out = layoutLabels(crowd);
		expect(out.some((l) => l.hidden)).toBe(true);
		const shown = out.filter((l) => !l.hidden);
		for (let i = 0; i < shown.length; i++) for (let j = i + 1; j < shown.length; j++) expect(overlap(box(shown[i]), box(shown[j]))).toBe(false);
		const shownSeg = shown.filter((l) => l.kind === 'segment').length;
		const shownAng = shown.filter((l) => l.kind === 'angle').length;
		expect(shownSeg).toBeGreaterThanOrEqual(shownAng);
	});
});
