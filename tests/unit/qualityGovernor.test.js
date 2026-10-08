import { describe, it, expect } from 'vitest';
import {
	createGovernor,
	overridesAt,
	stepLabelsAt,
	GOVERNOR_STEPS,
	MAX_LEVEL,
	FULL_QUALITY,
	drawGapFor,
	INGEST_DRAW_GAP_MS
} from '../../src/lib/qualityGovernorCore.js';

/**
 * feed `ms`-long frames from `from` for `durationMs`; returns the time reached
 * @param {ReturnType<typeof createGovernor>} gov @param {number} from @param {number} durationMs @param {number} ms
 */
function run(gov, from, durationMs, ms) {
	let t = from;
	while (t < from + durationMs) {
		t += ms;
		gov.noteFrame(ms, t);
	}
	return t;
}

describe('overridesAt', () => {
	it('level 0 is full quality and every level is the sum of the steps before it', () => {
		expect(overridesAt(0)).toEqual(FULL_QUALITY);
		expect(overridesAt(1)).toEqual({ ...FULL_QUALITY, shadowsOff: true });
		const top = overridesAt(MAX_LEVEL);
		expect(top.dprScale).toBe(0.5);
		expect(top.shadowsOff && top.aoOff && top.postOff && top.particlesCapped && top.presenceSlow).toBe(true);
	});
	it('a later resolution step replaces an earlier one, never compounds it', () => {
		const at = GOVERNOR_STEPS.findIndex((s) => s.key === 'res72') + 1;
		expect(overridesAt(at).dprScale).toBe(0.72);
	});
	it('SHADOWS come first: 26-E measured draw calls, not fill, as the cost', () => {
		expect(GOVERNOR_STEPS[0].key).toBe('shadows');
	});
	it('clamps silly levels and names every step in effect', () => {
		expect(overridesAt(-3)).toEqual(FULL_QUALITY);
		expect(overridesAt(999)).toEqual(overridesAt(MAX_LEVEL));
		expect(stepLabelsAt(2)).toEqual([GOVERNOR_STEPS[0].label, GOVERNOR_STEPS[1].label]);
	});
});

describe('createGovernor', () => {
	it('a slow HEAVY scene steps down once, then holds', () => {
		const g = createGovernor();
		let t = run(g, 0, 2100, 50);
		expect(g.decide(t, { heavy: true }).moved).toBe('up');
		expect(g.level()).toBe(1);
		// the very next moment: no fresh window, no second step
		t = run(g, t, 500, 50);
		expect(g.decide(t, { heavy: true }).moved).toBe(null);
		// after the hold with frames still slow: the next step
		t = run(g, t, 2600, 50);
		expect(g.decide(t, { heavy: true }).moved).toBe('up');
		expect(g.level()).toBe(2);
	});
	it('the hitch a change itself causes is not evidence for the next step', () => {
		const g = createGovernor();
		let t = run(g, 0, 2100, 50);
		expect(g.decide(t, { heavy: true }).moved).toBe('up');
		// the recompile right after the step: a burst of slow frames and THREE long tasks —
		// more than the long-task trigger allows, still inside its 5s window at the next
		// decision, so without the settle window this alone would take another step
		t = run(g, t, 500, 120);
		g.noteLongTask(t - 400);
		g.noteLongTask(t - 250);
		g.noteLongTask(t - 100);
		// then the reduced scene runs at a steady 30fps
		t = run(g, t, 2600, 33.4);
		expect(g.decide(t, { heavy: true }).moved).toBe(null);
		expect(g.level()).toBe(1);
	});
	it('a slow LIGHT scene is never governed (the 26-G ruling: a slow machine is not an overloaded scene)', () => {
		const g = createGovernor();
		const t = run(g, 0, 5000, 400);
		expect(g.decide(t, { heavy: false }).moved).toBe(null);
		expect(g.level()).toBe(0);
	});
	it('a steady 30fps is NOT overloaded: vsync quantises it to 33.3-33.4ms (26-E)', () => {
		const g = createGovernor();
		let t = 0;
		for (let i = 0; i < 150; i++) {
			const ms = i % 2 ? 33.4 : 33.3;
			t += ms;
			g.noteFrame(ms, t);
		}
		expect(g.decide(t, { heavy: true }).moved).toBe(null);
	});
	it('a smooth heavy scene is left alone', () => {
		const g = createGovernor();
		const t = run(g, 0, 5000, 16.7);
		expect(g.decide(t, { heavy: true }).moved).toBe(null);
	});
	it('decides nothing on a window that is not full yet', () => {
		const g = createGovernor();
		const t = run(g, 0, 600, 60);
		expect(g.decide(t, { heavy: true }).moved).toBe(null);
	});
	it('long tasks alone can trigger a step', () => {
		const g = createGovernor();
		const t = run(g, 0, 3100, 16.7);
		for (const at of [t - 3000, t - 2000, t - 1000]) g.noteLongTask(at);
		const d = g.decide(t, { heavy: true });
		expect(d.moved).toBe('up');
		expect(d.reason).toBe('long tasks');
	});
	it('recovers one step after 10s of good frames, and not before', () => {
		const g = createGovernor();
		let t = run(g, 0, 2100, 50);
		g.decide(t, { heavy: true });
		t = run(g, t, 9000, 16.7);
		expect(g.decide(t, { heavy: true }).moved).toBe(null);
		t = run(g, t, 1500, 16.7);
		expect(g.decide(t, { heavy: true }).moved).toBe('down');
		expect(g.level()).toBe(0);
	});
	it('a PINNED level never walks back', () => {
		const g = createGovernor();
		let t = run(g, 0, 2100, 50);
		g.decide(t, { heavy: true });
		t = run(g, t, 20000, 16.7);
		expect(g.decide(t, { heavy: true, pinned: true }).moved).toBe(null);
		expect(g.level()).toBe(1);
	});
	it('a scene that becomes light is handed back without waiting for good frames', () => {
		const g = createGovernor();
		let t = run(g, 0, 2100, 50);
		g.decide(t, { heavy: true });
		t = run(g, t, 10500, 60);
		expect(g.decide(t, { heavy: false }).reason).toBe('scene is light');
	});
	it('FLAPPING doubles the next recovery hold, and a later honest step resets it', () => {
		const g = createGovernor();
		let t = run(g, 0, 2100, 50);
		g.decide(t, { heavy: true }); // up
		t = run(g, t, 10500, 16.7);
		g.decide(t, { heavy: true }); // down
		// a walk down is a change too: the next step still waits out the 3s hold
		t = run(g, t, 3100, 50);
		expect(g.decide(t, { heavy: true }).moved).toBe('up'); // back up within 20s
		expect(g.recoverHoldMs()).toBe(20000);
		t = run(g, t, 10500, 16.7);
		expect(g.decide(t, { heavy: true }).moved).toBe(null); // 10s is no longer enough
		// 40 F12: ...and that flap LOCKED level 1 — good frames never walk below it again
		t = run(g, t, 30000, 16.7);
		expect(g.decide(t, { heavy: true })).toMatchObject({ moved: null, reason: 'held (flapped)' });
		expect(g.flapLock()).toBe(1);
		// a new scene clears the lock; the doubled hold is already served, so it walks down
		g.clearFlapLock();
		expect(g.decide(t, { heavy: true }).moved).toBe('down');
		// much later, a heavier scene: not a flap
		t = run(g, t + 60000, 2100, 50);
		expect(g.decide(t, { heavy: true }).moved).toBe('up');
		expect(g.recoverHoldMs()).toBe(10000);
	});
	it('forget() discards the evidence (a hidden tab, a pause)', () => {
		const g = createGovernor();
		const t = run(g, 0, 2100, 50);
		g.forget();
		expect(g.decide(t, { heavy: true }).moved).toBe(null);
	});
	it('never climbs past the last step', () => {
		const g = createGovernor();
		let t = 0;
		for (let i = 0; i < MAX_LEVEL + 3; i++) {
			t = run(g, t, 3100, 50);
			g.decide(t, { heavy: true });
		}
		expect(g.level()).toBe(MAX_LEVEL);
	});
	it('uses the VR thresholds on the vr profile', () => {
		const g = createGovernor();
		const t = run(g, 0, 2100, 16.7);
		expect(g.decide(t, { heavy: true, profile: 'vr' }).moved).toBe('up');
	});
});

describe('drawGapFor (the ingest rule)', () => {
	const base = { engaged: false, draining: true, backlog: 500, p95: 50 };
	it('throttles drawing while a big batch drains through slow frames', () => {
		expect(drawGapFor(base)).toBe(INGEST_DRAW_GAP_MS);
	});
	it('leaves a fast frame, a small backlog, or no drain alone', () => {
		expect(drawGapFor({ ...base, p95: 16.7 })).toBe(0);
		expect(drawGapFor({ ...base, backlog: 10 })).toBe(0);
		expect(drawGapFor({ ...base, draining: false })).toBe(0);
	});
	it('is STICKY for the drain: throttled frames are cheap, and must not switch it off', () => {
		expect(drawGapFor({ ...base, engaged: true, p95: 5, backlog: 1 })).toBe(INGEST_DRAW_GAP_MS);
		expect(drawGapFor({ ...base, engaged: true, draining: false })).toBe(0);
	});
});

// 31-perf P3 — the headset: thresholds from the refresh rate, the override seam, and the
// framebuffer scale handed to the next entry.
import { xrThresholds, XR_FRAMEBUFFER_SCALE, XR_START_LEVEL } from '../../src/lib/qualityGovernorCore.js';

describe('31-perf: XR thresholds', () => {
	it('come from the refresh rate: a missed frame is over, an on-time session recovers', () => {
		const t72 = xrThresholds(72);
		expect(t72.overMs).toBeCloseTo(18.06, 1);
		expect(t72.underMs).toBeCloseTo(15.56, 1);
		// a healthy 72 Hz session reads 13.9 at every percentile: that must count as calm,
		// which the static VR pair (under 11.1) never could
		expect(1000 / 72).toBeLessThan(t72.underMs);
		expect(1000 / 72).toBeLessThan(xrThresholds(72).overMs);
		// one missed frame reads twice the budget: over
		expect((2 * 1000) / 72).toBeGreaterThan(t72.overMs);
		expect(xrThresholds(90).overMs).toBeCloseTo(14.44, 1);
		expect(xrThresholds(0).hz).toBe(72); // nonsense falls back to 72
	});
	it('a governor judged by them steps on missed frames and recovers on on-time ones', () => {
		const g = createGovernor();
		g.setThresholds(xrThresholds(72));
		let t = 1000;
		// 3 s of frames where every 5th is missed (27.8 ms): p95 = 27.8 > 18
		for (let i = 0; i < 180; i++) {
			const ms = i % 5 === 0 ? 27.8 : 13.9;
			t += ms;
			g.noteFrame(ms, t);
		}
		expect(g.decide(t, { profile: 'vr', heavy: true }).moved).toBe('up');
		// then on-time frames for the recovery window: back down
		for (let i = 0; i < 1200; i++) {
			t += 13.9;
			g.noteFrame(13.9, t);
		}
		expect(g.decide(t, { profile: 'vr', heavy: true }).moved).toBe('down');
	});
	it('COUNTERFACTUAL: without the override, a healthy 72 Hz session could never recover', () => {
		const g = createGovernor();
		let t = 1000;
		g.setLevel(1, t);
		t += 700;
		for (let i = 0; i < 1200; i++) {
			t += 13.9;
			g.noteFrame(13.9, t);
		}
		// the static vr pair (underMs 11.1) reads 13.9 as NOT calm: stuck at level 1
		expect(g.decide(t, { profile: 'vr', heavy: true }).moved).toBe(null);
		g.setThresholds(xrThresholds(72));
		expect(g.decide(t, { profile: 'vr', heavy: true }).moved).toBe('down');
		g.setThresholds(null);
		expect(g.thresholds()).toBe(null);
	});
	it('the entry floor is the shadows step, and a headset eye buffer is never lowered (crisp panel text)', () => {
		expect(GOVERNOR_STEPS[XR_START_LEVEL - 1].key).toBe('shadows');
		expect(XR_FRAMEBUFFER_SCALE).toBe(1);
	});
});

// 33 G1 — a phone starts lighter and is always governed.
import { PHONE_START_LEVEL, isPhoneLike, overridesAt as phoneOverridesAt } from '../../src/lib/qualityGovernorCore.js';

describe('33 G1: phones', () => {
	it('a phone is a coarse pointer, no hover and a short screen side', () => {
		expect(isPhoneLike({ coarse: true, hover: false, minSide: 412 })).toBe(true);
		expect(isPhoneLike({ coarse: true, hover: false, minSide: 820 })).toBe(true); // a small tablet
		expect(isPhoneLike({ coarse: true, hover: true, minSide: 412 })).toBe(false); // a touch laptop has hover
		expect(isPhoneLike({ coarse: false, hover: false, minSide: 412 })).toBe(false);
		expect(isPhoneLike({ coarse: true, hover: false, minSide: 1080 })).toBe(false);
		expect(isPhoneLike({ coarse: true, hover: false, minSide: 0 })).toBe(false);
		expect(isPhoneLike({})).toBe(false);
	});
	it('the phone start is shadows off, 72 % resolution and AO off — the post look stays', () => {
		expect(GOVERNOR_STEPS.slice(0, PHONE_START_LEVEL).map((s) => s.key)).toEqual(['shadows', 'res85', 'res72', 'ao']);
		const o = phoneOverridesAt(PHONE_START_LEVEL);
		expect(o).toMatchObject({ shadowsOff: true, dprScale: 0.72, aoOff: true, postOff: false });
	});
	it('a LIGHT scene on slow frames: governed when judged heavy (the phone rule), never when not', () => {
		const run = (/** @type {boolean} */ heavy) => {
			const g = createGovernor();
			let t = 1000;
			g.setLevel(PHONE_START_LEVEL, t);
			t += 700;
			for (let i = 0; i < 100; i++) {
				t += 50;
				g.noteFrame(50, t);
			}
			return g.decide(t, { heavy });
		};
		expect(run(true).moved).toBe('up');
		// the desktop rule: a light scene is never governed — and is walked back to full quality
		const light = run(false);
		expect(light.moved).not.toBe('up');
	});
});
