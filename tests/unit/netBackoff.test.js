import { describe, it, expect } from 'vitest';
import { backoffDelay, backoffSchedule } from '../../src/lib/netBackoff.js';

// 27-I (audit L9). netBackoff's own header calls itself "pure and deterministic … so it
// unit-tests cleanly", and until now there was no unit layer to test it in — only an e2e
// suite that spawns a browser to exercise arithmetic. 27-F then gave it jitter and an
// unbounded max, which are exactly the options a wrong edit breaks silently.

describe('the default schedule is a contract', () => {
	it('is 500/1000/2000/4000 and then exhausted', () => {
		expect(backoffSchedule()).toEqual([500, 1000, 2000, 4000]);
		expect(backoffDelay(1)).toBe(500);
		expect(backoffDelay(4)).toBe(4000);
		expect(backoffDelay(5)).toBe(null);
		expect(backoffDelay(0)).toBe(null);
	});

	it('is deterministic, because every peer computes the same one', () => {
		expect(backoffSchedule()).toEqual(backoffSchedule());
	});

	it('never schedules a shorter wait than the attempt before it', () => {
		const s = backoffSchedule({ max: 6, cap: 100000 });
		expect(s.every((d, i) => i === 0 || d >= s[i - 1])).toBe(true);
	});
});

describe('27-F: jitter is additive and inert by default', () => {
	it('changes nothing unless asked for', () => {
		expect(backoffDelay(1, { base: 1000 })).toBe(1000);
		expect(backoffDelay(3, { base: 1000 })).toBe(4000);
	});

	it('spreads +/- a fraction, using an INJECTED rng so the test is not a coin toss', () => {
		expect(backoffDelay(1, { base: 1000, jitter: 0.25, rng: () => 0 })).toBe(750);
		expect(backoffDelay(1, { base: 1000, jitter: 0.25, rng: () => 0.5 })).toBe(1000);
		expect(backoffDelay(1, { base: 1000, jitter: 0.25, rng: () => 1 })).toBe(1250);
	});

	it('clamps at zero, because a negative wait would hammer the server', () => {
		expect(backoffDelay(1, { base: 100, jitter: 4, rng: () => 0 })).toBe(0);
	});
});

describe('27-F: an unbounded retry', () => {
	const unbounded = { base: 800, cap: 8000, max: Infinity };

	it('always has a delay, and saturates at the cap rather than giving up', () => {
		expect(backoffDelay(1, unbounded)).toBe(800);
		expect(backoffDelay(5, unbounded)).not.toBe(null);
		expect(backoffDelay(99, unbounded)).toBe(8000);
		expect(backoffDelay(10_000, unbounded)).toBe(8000);
	});

	it('TERMINATES when asked for its schedule', () => {
		// the pre-27-F module looped forever here — measured as RangeError: Invalid array
		// length — because the loop bound was the unbounded max itself.
		expect(backoffSchedule(unbounded)).toHaveLength(10);
		expect(backoffSchedule({ ...unbounded, limit: 3 })).toHaveLength(3);
	});
});
