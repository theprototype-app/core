// 100-int — the memory slope judged across runs (tests/e2e/cinematic-memory-ab.cjs): the orchestrator's rule.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { judge, median } = require('../e2e/cinematic-memory-ab.cjs');

describe('cinematic-memory-ab judge (100-int)', () => {
	it('median', () => {
		expect(median([3, 1, 2])).toBe(2);
		expect(median([4, 1, 3, 2])).toBe(2.5);
	});
	it('the 2026-11-20 PC Product shot series pass: they overlap (delta 37 > 30)', () => {
		const v = judge([37, 107, 53, 89, 24], [111, 78, 109, 102, 55, 36]);
		expect(v.ok).toBe(true);
		expect(v.allAbove).toBe(false);
		expect(v.d).toBe(37);
	});
	it('within the delta passes even when every run is higher', () => expect(judge([40, 50, 60], [61, 70, 80]).ok).toBe(true));
	it('a clearly higher candidate fails: every run above every base run and the median over the delta', () => {
		const v = judge([24, 37, 53], [120, 140, 160]);
		expect(v.ok).toBe(false);
		expect(v.allAbove).toBe(true);
	});
	it('an empty series fails', () => expect(judge([], [1]).ok).toBe(false));
});
