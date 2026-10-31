// fix-batch-1 #14: what counts as an impact (src/lib/impactSpeed.js, a leaf). Up to 1.43 only
// the downward channel existed, so a sideways hit on a wall or a target never fired On Impact.
import { describe, test, expect } from 'vitest';
import {
	closingSpeed,
	impactStrengthFor,
	IMPACT_MIN_DOWN_VY,
	IMPACT_MIN_SPEED,
	LEGACY_IMPACT_DIRECTION
} from '../../src/lib/impactSpeed.js';
import { propertyRows } from '../../src/lib/nodeProps.js';

/** @param {number} x @param {number} y @param {number} z */
const v = (x, y, z) => ({ x, y, z });
const UP = v(0, 1, 0);
const WALL = v(1, 0, 0); // a wall facing -x/+x

describe('closingSpeed', () => {
	test('a landing on still ground reads the downward speed (the old number)', () => {
		expect(closingSpeed(v(0.3, -4, 0), null, UP)).toBeCloseTo(4);
	});
	test('a sideways hit on a wall reads its speed along the normal; downward is ~0', () => {
		const ball = v(5, 0, 0);
		expect(closingSpeed(ball, null, WALL)).toBeCloseTo(5);
		expect(-ball.y).toBeLessThan(IMPACT_MIN_DOWN_VY); // the old rule never fired here
		expect(closingSpeed(ball, null, WALL)).toBeGreaterThanOrEqual(IMPACT_MIN_SPEED);
	});
	test('an angled hit counts only the normal component, and a graze reads ~0', () => {
		expect(closingSpeed(v(3, 0, 4), null, WALL)).toBeCloseTo(3);
		expect(closingSpeed(v(0, 0, 9), null, WALL)).toBeCloseTo(0);
	});
	test('the normal sign and length do not matter', () => {
		expect(closingSpeed(v(2, 0, 0), null, v(-3, 0, 0))).toBeCloseTo(2);
	});
	test('relative velocity: a mover hitting a body at rest, and two bodies moving together', () => {
		expect(closingSpeed(v(0, 0, 0), v(-3, 0, 0), WALL)).toBeCloseTo(3);
		expect(closingSpeed(v(2, 0, 0), v(2, 0, 0), WALL)).toBeCloseTo(0);
	});
	test('no normal (no manifold) falls back to the vertical', () => {
		expect(closingSpeed(v(5, -2, 0), null, null)).toBeCloseTo(2);
		expect(closingSpeed(v(5, -2, 0), null, v(0, 0, 0))).toBeCloseTo(2);
	});
});

describe('impactStrengthFor', () => {
	test("'any' reads the normal channel, 'down' the landing channel", () => {
		expect(impactStrengthFor('any', null, 5)).toBe(5);
		expect(impactStrengthFor('down', null, 5)).toBe(null); // sideways: a down node stays quiet
		expect(impactStrengthFor('down', 4, 4)).toBe(4);
		expect(impactStrengthFor('any', 4, null)).toBe(null);
	});
	test('a node saved before the option (no direction) keeps the landing rule', () => {
		expect(LEGACY_IMPACT_DIRECTION).toBe('down');
		expect(impactStrengthFor(undefined, null, 5)).toBe(null);
		expect(impactStrengthFor(undefined, 4, 6)).toBe(4);
	});
});

describe('On Impact direction in the Flow ⚙ panel', () => {
	const spec = {
		type: 'onimpact',
		defaults: { pulse: 0.3, minStrength: 1, direction: 'any' },
		params: [
			{ key: 'minStrength', kind: 'range', min: 0, max: 10, step: 0.1 },
			{ key: 'direction', kind: 'select', options: ['any', 'down'], legacy: 'down' }
		]
	};
	test('an old node (no key) shows its legacy value, not the new default', () => {
		const rows = propertyRows({ id: 'n', type: 'onimpact', data: { minStrength: 1 } }, spec, []);
		expect(rows.find((r) => r.key === 'direction')?.value).toBe('down');
	});
	test('a new node shows what it was seeded with', () => {
		const rows = propertyRows({ id: 'n', type: 'onimpact', data: { ...spec.defaults } }, spec, []);
		expect(rows.find((r) => r.key === 'direction')?.value).toBe('any');
	});
});
