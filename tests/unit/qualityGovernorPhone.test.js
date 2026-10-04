// 36 G1 — the phone governor judges against the MEASURED refresh rate and never steps a
// trivially light scene. The numbers are the 1.20 beacon's (STATUS-34-integrate "Device
// reports"): an Android phone on a menu, steady 16.6 ms at 60 Hz, 3 draw calls, stepped
// quality 0 -> 1 -> 2 -> 3 -> 4; in the same sessions the Architecture shell in Edit drew
// p50 12.0 / p95 21.2 ms on a 60-90 Hz panel with 122-157 calls and stalls of 100-274 ms.
import { describe, it, expect } from 'vitest';
import {
	createGovernor,
	phoneThresholds,
	measureRefreshHz,
	isTriviallyLight,
	TRIVIAL_CALLS,
	THRESHOLDS
} from '../../src/lib/qualityGovernorCore.js';

/** feed frames from a pattern, deciding every 250 ms like the wiring does; returns {t, moves}
 * @param {ReturnType<typeof createGovernor>} gov @param {number} from @param {number} durationMs
 * @param {(i: number) => number} msAt @param {{calls?: number, longTaskEveryMs?: number, profile?: 'desktop'}} ctx */
function drive(gov, from, durationMs, msAt, ctx) {
	let t = from;
	let i = 0;
	let nextDecide = from + 250;
	let nextTask = ctx.longTaskEveryMs ? from + ctx.longTaskEveryMs : Infinity;
	/** @type {string[]} */
	const moves = [];
	while (t < from + durationMs) {
		const ms = msAt(i++);
		t += ms;
		gov.noteFrame(ms, t);
		if (t >= nextTask) {
			gov.noteLongTask(t);
			nextTask += /** @type {number} */ (ctx.longTaskEveryMs);
		}
		if (t >= nextDecide) {
			nextDecide += 250;
			const d = gov.decide(t, { profile: 'desktop', heavy: true, calls: ctx.calls });
			if (d.moved) moves.push(`${d.moved}->${d.level} (${d.reason})`);
		}
	}
	return { t, moves };
}

describe('phoneThresholds', () => {
	it('derives the budget from the refresh rate (60 / 90 / 120 Hz)', () => {
		expect(phoneThresholds(60).budgetMs).toBeCloseTo(16.67, 1);
		expect(phoneThresholds(90).overMs).toBeCloseTo(14.44, 1);
		expect(phoneThresholds(120).underMs).toBeCloseTo(9.33, 1);
		// a healthy frame at each rate is UNDER its own over-threshold and a missed one is over
		for (const hz of [60, 90, 120]) {
			const t = phoneThresholds(hz);
			expect(1000 / hz).toBeLessThan(t.overMs);
			expect(2000 / hz).toBeGreaterThan(t.overMs);
		}
		expect(phoneThresholds(0).hz).toBe(60); // nonsense falls back to 60
		expect(phoneThresholds(1000).hz).toBe(60);
	});
});

describe('measureRefreshHz', () => {
	const jitter = (/** @type {number} */ base) => (/** @type {number} */ i) => base + ((i * 7919) % 11) / 20 - 0.25;
	it('reads 60, 90 and 120 Hz panels from their frame intervals', () => {
		expect(measureRefreshHz(Array.from({ length: 120 }, (_, i) => jitter(16.67)(i)))).toBe(60);
		expect(measureRefreshHz(Array.from({ length: 120 }, (_, i) => jitter(11.11)(i)))).toBe(90);
		expect(measureRefreshHz(Array.from({ length: 120 }, (_, i) => jitter(8.33)(i)))).toBe(120);
	});
	it('missed frames (multiples of the period) do not lower the reading', () => {
		// a 90 Hz panel missing every third frame: 11.1, 11.1, 22.2 ...
		const f = Array.from({ length: 150 }, (_, i) => (i % 3 === 2 ? 22.22 : 11.11));
		expect(measureRefreshHz(f)).toBe(90);
	});
	it('says nothing on too few frames or a reading near no real rate', () => {
		expect(measureRefreshHz([16.6, 16.7])).toBe(null);
		expect(measureRefreshHz(Array(60).fill(26))).toBe(null); // 38 Hz: no panel runs there
	});
});

describe('isTriviallyLight', () => {
	const b60 = 1000 / 60;
	it('few calls AND on-time frames', () => {
		expect(isTriviallyLight({ calls: 3, p95: 16.6, budgetMs: b60 })).toBe(true);
		expect(isTriviallyLight({ calls: TRIVIAL_CALLS - 1, p95: b60 * 1.1, budgetMs: b60 })).toBe(true);
	});
	it('not with many calls, slow frames, or missing readings', () => {
		expect(isTriviallyLight({ calls: TRIVIAL_CALLS, p95: 16.6, budgetMs: b60 })).toBe(false);
		expect(isTriviallyLight({ calls: 3, p95: 21.2, budgetMs: b60 })).toBe(false);
		expect(isTriviallyLight({ calls: null, p95: 16.6, budgetMs: b60 })).toBe(false);
		expect(isTriviallyLight({ calls: 3, p95: null, budgetMs: b60 })).toBe(false);
		expect(isTriviallyLight({ calls: 3, p95: 16.6, budgetMs: null })).toBe(false);
	});
});

describe('the 1.20 beacon: a phone on a menu (steady 16.6 ms at 60 Hz, 3 calls)', () => {
	it('does NOT step — not by frames, and not by the menu\'s own long tasks', () => {
		const gov = createGovernor();
		gov.setThresholds(phoneThresholds(60));
		// 60 s of the menu: steady frames plus a long task every 1.5 s (over the 2-per-5-s rule)
		const r = drive(gov, 0, 60000, () => 16.6, { calls: 3, longTaskEveryMs: 1500 });
		expect(r.moves).toEqual([]);
		expect(gov.level()).toBe(0);
	});
	it('counterfactual: the SAME stream under the 1.20 rules (desktop thresholds, no call count) steps', () => {
		const gov = createGovernor();
		const r = drive(gov, 0, 60000, () => 16.6, { longTaskEveryMs: 1500 });
		expect(r.moves.length).toBeGreaterThan(0); // this is the report: the menu stepped
		expect(r.moves[0]).toMatch(/up->1 \(long tasks\)/);
	});
	it('a menu that DOES miss frames is still governed (the light rule needs on-time frames)', () => {
		const gov = createGovernor();
		gov.setThresholds(phoneThresholds(60));
		// every third frame missed: p95 = 33.3 ms on a 60 Hz panel
		const r = drive(gov, 0, 8000, (i) => (i % 3 === 2 ? 33.3 : 16.7), { calls: 3 });
		expect(r.moves[0]).toMatch(/^up->1/);
	});
});

describe('the 1.20 beacon: the Architecture shell on the phone (122 calls, p95 21.2 ms)', () => {
	it('is governed at 60 Hz: a 21 ms p95 misses the 16.7 ms budget', () => {
		const gov = createGovernor();
		gov.setThresholds(phoneThresholds(60));
		// p50 ~12-16, ~8% of frames at 21-28 ms
		const r = drive(gov, 0, 8000, (i) => (i % 12 === 0 ? 28 : i % 12 === 6 ? 21.2 : 16.7), { calls: 122 });
		expect(r.moves[0]).toMatch(/^up->1 \(frames\)/);
	});
	it('the desktop threshold (35 ms) would never have seen it', () => {
		expect(21.2).toBeLessThan(THRESHOLDS.desktop.overMs);
	});
	it('recovers once frames hold the measured rate again', () => {
		const gov = createGovernor();
		gov.setThresholds(phoneThresholds(90));
		gov.setLevel(2, 0);
		const r = drive(gov, 1, 25000, () => 11.11, { calls: 122 });
		expect(r.moves[0]).toMatch(/^down->1 \(recovered\)/);
	});
});
