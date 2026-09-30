import { describe, it, expect } from 'vitest';
import { normalizeReach, bodyDistance, withinReach, carryLimit, REACH_MIN, REACH_MAX } from '../../src/lib/playReach.js';

// 31-towers P1: grab reach is measured from the BODY (feet..eye), not the eye.
const eye = { x: 0, y: 1.7, z: 0 };
const feet = 0;

describe('normalizeReach', () => {
	it('absent, empty and nonsense mean "no limit"', () => {
		for (const v of [undefined, null, '', 'far', NaN, 0, -1, true, false]) expect(normalizeReach(v)).toBe(null);
	});
	it('a number clamps into range', () => {
		expect(normalizeReach(1.3)).toBe(1.3);
		expect(normalizeReach('2')).toBe(2);
		expect(normalizeReach(0.05)).toBe(REACH_MIN);
		expect(normalizeReach(999)).toBe(REACH_MAX);
	});
});

describe('bodyDistance', () => {
	it('a crate at your feet is as far as it is horizontally (the eye would say 1.7 m)', () => {
		expect(bodyDistance({ x: 0.8, y: 0.3, z: 0 }, eye, feet)).toBeCloseTo(0.8, 6);
	});
	it('between the feet and the eye it is the horizontal distance', () => {
		expect(bodyDistance({ x: 0, y: 1.2, z: -1.1 }, eye, feet)).toBeCloseTo(1.1, 6);
	});
	it('above the eye it bends round the head', () => {
		expect(bodyDistance({ x: 0.3, y: 2.9, z: 0 }, eye, feet)).toBeCloseTo(Math.hypot(0.3, 1.2), 6);
	});
	it('below the feet it is measured from the feet', () => {
		expect(bodyDistance({ x: 0, y: -0.5, z: 0.4 }, eye, feet)).toBeCloseTo(Math.hypot(0.4, 0.5), 6);
	});
});

describe('withinReach', () => {
	it('no reach = always', () => {
		expect(withinReach({ x: 40, y: 9, z: 0 }, eye, feet, null)).toBe(true);
	});
	it('a piece on a 3 m ledge is out of a 1.3 m reach from the floor, in reach after a 1 m jump', () => {
		const piece = { x: 0, y: 3.05, z: -0.5 };
		expect(withinReach(piece, eye, feet, 1.3)).toBe(false);
		expect(withinReach(piece, { x: 0, y: 2.7, z: 0 }, 1.0, 1.3)).toBe(true);
	});
	it('standing on a 0.6 m crate brings it in reach too', () => {
		expect(withinReach({ x: 0, y: 3.05, z: -0.5 }, { x: 0, y: 2.3, z: 0 }, 0.6, 1.3)).toBe(true);
	});
});

describe('carryLimit', () => {
	const flat = { x: 0, y: 0, z: -1 };
	it('no reach keeps the fallback', () => {
		expect(carryLimit(flat, 1.7, null, 4.2)).toBe(4.2);
	});
	it('straight ahead the limit is the reach; looking up it is the reach again', () => {
		expect(carryLimit(flat, 1.7, 1.3, 9)).toBeCloseTo(1.3, 6);
		expect(carryLimit({ x: 0, y: 0.6, z: -0.8 }, 1.7, 1.3, 9)).toBeCloseTo(1.3, 6);
	});
	it('looking down the limit grows — the body segment is under you — and always lands ON the boundary', () => {
		for (const deg of [10, 30, 50, 70, 85]) {
			const a = (deg * Math.PI) / 180;
			const dir = { x: 0, y: -Math.sin(a), z: -Math.cos(a) };
			const t = carryLimit(dir, 1.7, 1.3, 99);
			expect(t).toBeGreaterThanOrEqual(1.3 - 1e-9);
			const p = { x: eye.x + dir.x * t, y: eye.y + dir.y * t, z: eye.z + dir.z * t };
			expect(bodyDistance(p, eye, eye.y - 1.7)).toBeCloseTo(1.3, 5);
		}
	});
});
