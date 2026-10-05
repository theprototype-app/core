// @ts-nocheck — synthetic frame fixtures
// 36-fb-water F27: the frames right after a SCENE LOAD (fluid tanks filling, first screen-space
// passes, shader links) are not the scene's cost — a phone profile stepped 4 -> 5 -> 6 (the fluid's
// points tier) on them and the walk back took minutes (never, on a contended box). `settleFor`
// ignores them; recovery afterwards walks back as before.
import { describe, it, expect } from 'vitest';
import { createGovernor, phoneThresholds, TIMING } from '../../src/lib/qualityGovernorCore.js';

/** frames of `ms` every 16.7 ms from `t0` for `dur` ms; returns the end time */
function feed(g, t0, dur, ms) {
	let t = t0;
	for (; t < t0 + dur; t += 16.7) g.noteFrame(ms, t);
	return t;
}
const ctx = { profile: 'desktop', heavy: true, calls: 60 };

describe('post-load settle (F27)', () => {
	it('COUNTERFACTUAL: without it, a warm-up hitch right after the load steps the level down', () => {
		const g = createGovernor();
		g.setThresholds(phoneThresholds(60));
		g.setLevel(4, 0);
		let t = feed(g, 1000, 2500, 33.3); // the warm-up: p95 33 ms
		expect(g.decide(t, ctx).moved).toBe('up');
		expect(g.level()).toBe(5);
	});
	it('with settleFor at the load end the same hitch is ignored', () => {
		const g = createGovernor();
		g.setThresholds(phoneThresholds(60));
		g.setLevel(4, 0);
		g.settleFor(1000);
		let t = feed(g, 1000, TIMING.loadSettleMs - 100, 33.3);
		expect(g.decide(t, ctx).moved).toBe(null);
		expect(g.level()).toBe(4);
		// …and steady frames after it walk the level back toward full quality
		t = feed(g, t, 10600, 16.7);
		const d = g.decide(t, ctx);
		expect(d.moved).toBe('down');
		expect(g.level()).toBe(3);
	});
	it('a scene that is REALLY too heavy after the settle still steps down', () => {
		const g = createGovernor();
		g.setThresholds(phoneThresholds(60));
		g.setLevel(4, 0);
		g.settleFor(1000);
		let t = feed(g, 1000 + TIMING.loadSettleMs, 3500, 33.3);
		expect(g.decide(t, ctx).moved).toBe('up');
	});
});
