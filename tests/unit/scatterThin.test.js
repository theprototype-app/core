// 51 — device thinning, the pure planner: far instances go first, near ones never, the drawn
// triangles stay inside the budget, the edge fades, and Auto reads the device.
import { describe, test, expect } from 'vitest';
import { thinPlan, fadeAt, scatterBudget, thinProfileOf, NEAR_KEEP, SCATTER_SHARE } from '../../src/lib/scatterThinCore.js';

/** n instances spread from 0 to `far` metres, `t` triangles each @param {number} n @param {number} far @param {number} t */
const row = (n, far, t) => ({ dists: Float32Array.from({ length: n }, (_, i) => (i / (n - 1)) * far), tris: new Float32Array(n).fill(t) });

describe('51 thinning planner', () => {
	test('under budget: nothing thinned', () => {
		const { dists, tris } = row(100, 200, 100);
		expect(thinPlan(dists, tris, 1e6).cutoff).toBe(Infinity);
	});

	test('over budget: the cutoff keeps the nearest that fit, inside the budget', () => {
		const { dists, tris } = row(1000, 500, 1000); // 1M triangles over 500 m
		const plan = thinPlan(dists, tris, 250000);
		expect(plan.cutoff).toBeGreaterThan(NEAR_KEEP);
		expect(plan.cutoff).toBeLessThan(500);
		const kept = Array.from(dists).filter((d) => d < plan.cutoff).length;
		expect(kept * 1000).toBeLessThanOrEqual(250000);
		expect(kept).toBeGreaterThanOrEqual(249);
		// nearest first: every kept instance is nearer than every dropped one
		expect(plan.drawnTris).toBe(kept * 1000);
	});

	test('near instances are never thinned, even past the budget', () => {
		const { dists, tris } = row(100, 20, 100000); // all within NEAR_KEEP, 10M triangles
		expect(thinPlan(dists, tris, 1000).cutoff).toBe(Infinity);
		const mix = { dists: Float32Array.from([1, 5, 10, 29, 31, 60]), tris: new Float32Array(6).fill(1000) };
		const plan = thinPlan(mix.dists, mix.tris, 500);
		expect(plan.cutoff).toBeGreaterThanOrEqual(NEAR_KEEP);
		expect(Array.from(mix.dists).filter((d) => fadeAt(d, plan) > 0).length).toBe(4);
	});

	test('the edge fades: 1 inside, 0 past the cutoff, between in the band', () => {
		const plan = { cutoff: 100, fadeStart: 80 };
		expect(fadeAt(50, plan)).toBe(1);
		expect(fadeAt(100, plan)).toBe(0);
		const mid = fadeAt(90, plan);
		expect(mid).toBeGreaterThan(0);
		expect(mid).toBeLessThan(1);
		expect(fadeAt(85, plan)).toBeGreaterThan(fadeAt(95, plan));
	});

	test('the budget is the device line share, raised to what the scene leaves', () => {
		expect(scatterBudget(300000)).toBe(300000 * SCATTER_SHARE);
		expect(scatterBudget(300000, 50000)).toBe(250000);
		expect(scatterBudget(300000, 290000)).toBe(75000);
		expect(scatterBudget(Infinity)).toBe(Infinity);
	});

	test('profiles: auto reads the device, a pick wins, off draws everything', () => {
		expect(thinProfileOf('auto', { xr: true, coarse: true })).toBe('quest');
		expect(thinProfileOf('auto', { xr: false, coarse: true })).toBe('phone');
		expect(thinProfileOf('auto', { xr: false, coarse: false })).toBe('desktop');
		expect(thinProfileOf('quest', { xr: false, coarse: false })).toBe('quest');
		expect(thinProfileOf('off', { xr: true, coarse: true })).toBe(null);
	});
});

describe('51 thinning runtime', () => {
	test('the module evaluates (its store subscribe runs at import — the TDZ rule)', async () => {
		const mod = await import('../../src/lib/scatterThin.js');
		expect(typeof mod.registerThinMesh).toBe('function');
		expect(mod.scatterThinStats().meshes).toBe(0);
	});
});
