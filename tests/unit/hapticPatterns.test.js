// 30b (vr-play) C4: the haptic patterns as data — every contract name, pulses an actuator
// can take (never overlapping: a new pulse REPLACES the running one on a real actuator),
// the scale, and the knock strength curve.
import { describe, it, expect } from 'vitest';
import { HAPTIC_PATTERN_NAMES, hapticSchedule, knockHapticScale } from '../../src/lib/hapticPatterns.js';

describe('haptic patterns', () => {
	it('ships the contract presets', () => {
		expect([...HAPTIC_PATTERN_NAMES].sort()).toEqual(['bump', 'fail', 'heartbeat', 'hit', 'rumble', 'success', 'tap']);
	});

	it('every pulse fits an actuator and pulses never overlap', () => {
		for (const name of HAPTIC_PATTERN_NAMES) {
			const pulses = hapticSchedule(name);
			expect(pulses.length, name).toBeGreaterThan(0);
			pulses.forEach((p, i) => {
				expect(p.intensity).toBeGreaterThan(0);
				expect(p.intensity).toBeLessThanOrEqual(1);
				expect(p.ms).toBeGreaterThanOrEqual(1);
				if (i > 0) expect(p.at, name + ' pulse ' + i).toBeGreaterThanOrEqual(pulses[i - 1].at + pulses[i - 1].ms);
			});
		}
	});

	it('tap is the lightest and rumble the longest', () => {
		const total = (/** @type {string} */ n) => hapticSchedule(n).reduce((s, p) => s + p.ms, 0);
		const peak = (/** @type {string} */ n) => Math.max(...hapticSchedule(n).map((p) => p.intensity));
		for (const n of HAPTIC_PATTERN_NAMES) if (n !== 'tap') expect(peak('tap')).toBeLessThan(peak(n));
		for (const n of HAPTIC_PATTERN_NAMES) if (n !== 'rumble') expect(total('rumble')).toBeGreaterThan(total(n));
	});

	it('unknown names are empty, scale clamps', () => {
		expect(hapticSchedule('buzzz')).toEqual([]);
		expect(hapticSchedule('hit', 10).every((p) => p.intensity <= 1)).toBe(true);
		expect(hapticSchedule('hit', 0.5)[0].intensity).toBeCloseTo(0.425, 6);
		expect(hapticSchedule('hit', -3).every((p) => p.intensity === 0)).toBe(true);
	});

	it('a knock scales from a brush to a full hit', () => {
		expect(knockHapticScale(0)).toBeCloseTo(0.2, 6);
		expect(knockHapticScale(2)).toBeGreaterThan(knockHapticScale(0.5));
		expect(knockHapticScale(50)).toBe(1);
		expect(knockHapticScale(NaN)).toBeCloseTo(0.2, 6);
	});
});
