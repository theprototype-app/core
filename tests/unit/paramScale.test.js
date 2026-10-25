// 75 MU3: log-scale ranges — equal travel is an equal ratio, the ends map to the ends, a
// range that cannot be logarithmic stays linear, and a linear param is untouched.
import { describe, it, expect } from 'vitest';
import { isLogParam, toUnit, fromUnit, moveAlong } from '../../src/lib/paramScale.js';

const cutoff = { key: 'cutoff', kind: 'range', min: 20, max: 20000, scale: 'log' };
const level = { key: 'level', kind: 'range', min: 0, max: 1 };

describe('paramScale', () => {
	it('only a positive, increasing range can be log', () => {
		expect(isLogParam(cutoff)).toBe(true);
		expect(isLogParam({ ...cutoff, min: 0 })).toBe(false);
		expect(isLogParam({ ...cutoff, max: 10 })).toBe(false);
		expect(isLogParam(level)).toBe(false);
		expect(isLogParam({ ...level, scale: 'log' })).toBe(false);
	});
	it('the ends map to the ends; the middle of 20..20000 is the geometric middle', () => {
		expect(toUnit(cutoff, 20)).toBe(0);
		expect(toUnit(cutoff, 20000)).toBeCloseTo(1, 12);
		expect(fromUnit(cutoff, 0.5)).toBeCloseTo(Math.sqrt(20 * 20000), 9);
		expect(fromUnit(cutoff, 1 / 3)).toBeCloseTo(200, 9);
	});
	it('equal travel = equal ratio', () => {
		const a = moveAlong(cutoff, 100, 0.1) / 100;
		const b = moveAlong(cutoff, 5000, 0.1) / 5000;
		expect(a).toBeCloseTo(b, 9);
	});
	it('round-trips and clamps', () => {
		for (const v of [20, 33, 440, 1234.5, 20000]) expect(fromUnit(cutoff, toUnit(cutoff, v))).toBeCloseTo(v, 6);
		expect(fromUnit(cutoff, 2)).toBe(20000);
		expect(fromUnit(cutoff, -1)).toBe(20);
		expect(toUnit(cutoff, 5)).toBe(0);
	});
	it('a linear param keeps linear travel', () => {
		expect(fromUnit(level, 0.25)).toBe(0.25);
		expect(moveAlong(level, 0.5, 0.1)).toBeCloseTo(0.6, 12);
	});
});
