import { describe, it, expect } from 'vitest';
import { createClapState, stepClap, normalizeClapOptions, CLAP_DEFAULTS } from '../../src/lib/clapGesture.js';

// 31 S3: the clap detector — two hands close, held, re-armed by parting, cooled.
const L = [-0.03, 1.2, -0.4];
const R = [0.03, 1.2, -0.4]; // 6 cm apart
const FAR_L = [-0.3, 1.2, -0.4];
const FAR_R = [0.3, 1.2, -0.4];

/** feed `frames` frames of 16 ms from `t0`; returns the frames that fired
 * @param {any} state @param {any} left @param {any} right @param {number} t0 @param {number} frames @param {any} [opts]
 * @returns {{t: number, point: number[]}[]} */
function run(state, left, right, t0, frames, opts) {
	const fired = [];
	for (let i = 0; i < frames; i++) {
		const t = t0 + i * 16;
		const r = stepClap(state, left, right, t, opts);
		if (r.fired && r.point) fired.push({ t, point: r.point });
	}
	return fired;
}

describe('stepClap', () => {
	it('fires once the hands have been together for the hold time, at their midpoint', () => {
		const s = createClapState();
		const fired = run(s, L, R, 0, 30); // 480 ms together
		expect(fired.length).toBe(1);
		expect(fired[0].t).toBeGreaterThanOrEqual(CLAP_DEFAULTS.holdMs);
		expect(fired[0].t).toBeLessThan(CLAP_DEFAULTS.holdMs + 32);
		expect(fired[0].point[0]).toBeCloseTo(0, 6);
		expect(fired[0].point[1]).toBeCloseTo(1.2, 6);
		expect(fired[0].point[2]).toBeCloseTo(-0.4, 6);
	});

	it('a brush shorter than the hold is not a clap', () => {
		const s = createClapState();
		expect(run(s, L, R, 0, 10).length).toBe(0); // 160 ms
		expect(run(s, FAR_L, FAR_R, 160, 2).length).toBe(0);
		expect(run(s, L, R, 200, 10).length).toBe(0); // the hold restarts
	});

	it('hands farther apart than the distance never fire', () => {
		const s = createClapState();
		expect(run(s, [-0.06, 1.2, -0.4], [0.06, 1.2, -0.4], 0, 60).length).toBe(0); // 12 cm
	});

	it('holding the hands together is ONE clap, whatever the cooldown', () => {
		const s = createClapState();
		expect(run(s, L, R, 0, 300).length).toBe(1); // ~4.8 s together
	});

	it('parting past the release distance re-arms, and the cooldown still spaces claps', () => {
		const s = createClapState();
		expect(run(s, L, R, 0, 20).length).toBe(1); // clap at ~256 ms
		expect(run(s, FAR_L, FAR_R, 320, 2).length).toBe(0); // part (re-arms)
		// back together straight away: held by ~610 ms but the 1 s cooldown holds it to ~1.26 s
		const early = run(s, L, R, 352, 70); // to ~1.46 s
		expect(early.length).toBe(1);
		expect(early[0].t).toBeGreaterThanOrEqual(256 + CLAP_DEFAULTS.cooldownMs);
	});

	it('a part that stays inside the release distance does not re-arm', () => {
		const s = createClapState();
		expect(run(s, L, R, 0, 20).length).toBe(1);
		// 15 cm apart: out of the close radius, inside the 20 cm release
		expect(run(s, [-0.075, 1.2, -0.4], [0.075, 1.2, -0.4], 320, 10).length).toBe(0);
		expect(run(s, L, R, 480, 200).length).toBe(0);
	});

	it('a missing hand breaks the hold without re-arming or firing', () => {
		const s = createClapState();
		expect(run(s, L, R, 0, 10).length).toBe(0);
		expect(stepClap(s, L, null, 170).fired).toBe(false);
		expect(s.closeSince).toBe(null);
		expect(run(s, L, R, 186, 10).length).toBe(0); // the hold starts over
		expect(run(s, L, R, 346, 20).length).toBe(1);
		// lost tracking after a clap is not "parted": it stays disarmed
		stepClap(s, null, null, 700);
		expect(run(s, L, R, 716, 200).length).toBe(0);
	});

	it('options are clamped and the release radius never sits inside the close radius', () => {
		const o = normalizeClapOptions(/** @type {any} */ ({ distance: 0.3, releaseDistance: 0.1, holdMs: -5, cooldownMs: 'x' }));
		expect(o.distance).toBe(0.3);
		expect(o.releaseDistance).toBeGreaterThan(0.3);
		expect(o.holdMs).toBe(0);
		expect(o.cooldownMs).toBe(CLAP_DEFAULTS.cooldownMs);
		const d = normalizeClapOptions(null);
		expect(d).toEqual({ ...CLAP_DEFAULTS });
	});

	it('custom distance and hold are honoured', () => {
		const s = createClapState();
		const opts = { distance: 0.15, holdMs: 0 };
		const fired = run(s, [-0.06, 1.2, -0.4], [0.06, 1.2, -0.4], 0, 3, opts);
		expect(fired.length).toBe(1);
		expect(fired[0].t).toBe(0);
	});
});
