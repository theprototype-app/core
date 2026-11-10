// 78 PL9: "Lowered for now" names only the steps in force — one resolution, the deepest
import { describe, it, expect } from 'vitest';
import { holdingLabels, stepLabelsAt, MAX_LEVEL } from '../../src/lib/qualityGovernorCore.js';

describe('holdingLabels', () => {
	it('keeps only the deepest resolution step, in place', () => {
		const all = stepLabelsAt(MAX_LEVEL);
		const held = holdingLabels(all);
		expect(held.filter((l) => /^Resolution /.test(l))).toEqual(['Resolution 50%']);
		expect(held.length).toBe(all.length - 3);
		expect(held[0]).toBe(all[0]);
	});
	it('leaves a list with one or no resolution step alone', () => {
		expect(holdingLabels(['Shadows off'])).toEqual(['Shadows off']);
		expect(holdingLabels(['Shadows off', 'Resolution 85%'])).toEqual(['Shadows off', 'Resolution 85%']);
		expect(holdingLabels([])).toEqual([]);
	});
});
