// 31-perf P2 — the LOD rule (src/lib/lodCore.js), pure: level selection with hysteresis,
// which levels are worth building, option normalisation, the quality bias, the signature.
import { describe, it, expect } from 'vitest';
import {
	DEFAULT_LOD,
	normalizeLodOptions,
	levelsToBuild,
	pickLevel,
	lodBiasFor,
	geometrySignature
} from '../../src/lib/lodCore.js';

describe('pickLevel', () => {
	const edges = [8, 20, 50];
	it('draws the source up close and each level past its edge (distance in radii)', () => {
		expect(pickLevel(5, 1, edges, 1, 0, 0.12)).toBe(0);
		expect(pickLevel(8.01, 1, edges, 1, 0, 0.12)).toBe(1);
		expect(pickLevel(25, 1, edges, 1, 0, 0.12)).toBe(2);
		expect(pickLevel(500, 1, edges, 1, 0, 0.12)).toBe(3);
	});
	it('measures in RADII: a 10 m statue at 50 m is as close as a 1 m crate at 5 m', () => {
		expect(pickLevel(50, 10, edges, 1, 0, 0.12)).toBe(pickLevel(5, 1, edges, 1, 0, 0.12));
		expect(pickLevel(100, 10, edges, 1, 0, 0.12)).toBe(1);
	});
	it('HYSTERESIS: a coarse level holds until the distance is back inside its edge by the band', () => {
		// at 7.5 radii a mesh that was already coarse stays coarse (7.5 > 8 * 0.88 = 7.04)…
		expect(pickLevel(7.5, 1, edges, 1, 1, 0.12)).toBe(1);
		// …while one coming from full detail stays full (7.5 < 8)
		expect(pickLevel(7.5, 1, edges, 1, 0, 0.12)).toBe(0);
		// and inside the band, detail returns
		expect(pickLevel(7, 1, edges, 1, 1, 0.12)).toBe(0);
		// the band applies per edge: level 2 held at 19 radii, dropped to 1 at 17
		expect(pickLevel(19, 1, edges, 1, 2, 0.12)).toBe(2);
		expect(pickLevel(17, 1, edges, 1, 2, 0.12)).toBe(1);
	});
	it('the BIAS pulls every edge in (a struggling device goes coarse sooner)', () => {
		expect(pickLevel(6, 1, edges, 1, 0, 0)).toBe(0);
		expect(pickLevel(6, 1, edges, 0.5, 0, 0)).toBe(1);
		expect(pickLevel(12, 1, edges, 0.5, 0, 0)).toBe(2);
	});
	it('degenerate input never throws and never goes coarse', () => {
		expect(pickLevel(100, 0, edges, 1, 0, 0.1)).toBe(0);
		expect(pickLevel(NaN, 1, edges, 1, 0, 0.1)).toBe(0);
		expect(pickLevel(100, 1, [], 1, 0, 0.1)).toBe(0);
		expect(pickLevel(100, 1, edges, 0, 0, 0.1)).toBe(3); // a nonsense bias reads as 1
	});
});

describe('levelsToBuild', () => {
	const opts = normalizeLodOptions({});
	it('builds every default level for a dense mesh', () => {
		expect(levelsToBuild(20000, opts)).toEqual([0, 1, 2]);
	});
	it('drops a level that would fall under the floor', () => {
		// 1000 tris: 500, 250 kept; 100 < 120 floor dropped
		expect(levelsToBuild(1000, opts)).toEqual([0, 1]);
		expect(levelsToBuild(200, opts)).toEqual([]);
	});
	it('drops a level that is not meaningfully coarser than the one before', () => {
		const o = normalizeLodOptions({ ratios: [0.5, 0.45, 0.1], distances: [5, 10, 20] });
		expect(levelsToBuild(10000, o)).toEqual([0, 2]);
	});
});

describe('normalizeLodOptions', () => {
	it('defaults', () => {
		const o = normalizeLodOptions();
		expect(o.ratios).toEqual(DEFAULT_LOD.ratios);
		expect(o.distances).toEqual(DEFAULT_LOD.distances);
		expect(o.minTriangles).toBe(DEFAULT_LOD.minTriangles);
	});
	it('keeps only finite, strictly monotone values and pairs the two arrays', () => {
		const o = normalizeLodOptions(/** @type {any} */ ({ ratios: [0.6, 'x', 1.4, 0.3, 0.3, 0.1], distances: [4, 4, 10] }));
		expect(o.ratios).toEqual([0.6, 0.3]);
		expect(o.distances).toEqual([4, 10]);
	});
	it('clamps hysteresis and accepts minTriangles 0', () => {
		expect(normalizeLodOptions({ hysteresis: 3 }).hysteresis).toBe(0.5);
		expect(normalizeLodOptions({ minTriangles: 0 }).minTriangles).toBe(0);
		expect(normalizeLodOptions({ minTriangles: -4 }).minTriangles).toBe(DEFAULT_LOD.minTriangles);
	});
});

describe('lodBiasFor', () => {
	it('is 1 at full quality and falls with each governor step, never below 0.35', () => {
		expect(lodBiasFor(0)).toBe(1);
		expect(lodBiasFor(1)).toBeCloseTo(0.85);
		expect(lodBiasFor(3)).toBeLessThan(lodBiasFor(2));
		expect(lodBiasFor(40)).toBe(0.35);
	});
	it('takes a caller multiplier (the per-game Quality setting)', () => {
		expect(lodBiasFor(0, 0.5)).toBe(0.5);
		expect(lodBiasFor(0, 1.5)).toBe(1.5);
		expect(lodBiasFor(0, 9)).toBe(2);
		expect(lodBiasFor(0, -1)).toBe(1);
	});
});

describe('geometrySignature', () => {
	it('two parses of the same asset agree; different content does not', () => {
		const a = new Float32Array(3000).map((_, i) => Math.sin(i));
		const b = Float32Array.from(a);
		const c = Float32Array.from(a);
		c[1500] += 0.01; // not necessarily sampled: the counts still separate most assets
		expect(geometrySignature(a, 900)).toBe(geometrySignature(b, 900));
		expect(geometrySignature(a, 900)).not.toBe(geometrySignature(a, 903));
		const d = Float32Array.from(a);
		d[0] += 1;
		expect(geometrySignature(a, 900)).not.toBe(geometrySignature(d, 900));
	});
});
