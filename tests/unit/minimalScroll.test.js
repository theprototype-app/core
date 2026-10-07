// 38 NOTES-38 #1: the minimal scrollbar's thumb geometry (src/lib/ui/minimalScroll.js).
import { describe, it, expect } from 'vitest';
import { thumbGeometry } from '../../src/lib/ui/minimalScroll.js';

describe('thumbGeometry', () => {
	it('draws nothing when the content fits', () => {
		expect(thumbGeometry({ scrollTop: 0, scrollHeight: 400, clientHeight: 400 }).visible).toBe(false);
		expect(thumbGeometry({ scrollTop: 0, scrollHeight: 401, clientHeight: 400 }).visible).toBe(false);
	});
	it('sizes the thumb by the visible share, never under the minimum', () => {
		const g = thumbGeometry({ scrollTop: 0, scrollHeight: 800, clientHeight: 400 });
		expect(g.visible).toBe(true);
		expect(g.height).toBeCloseTo(198, 0);
		expect(thumbGeometry({ scrollTop: 0, scrollHeight: 100000, clientHeight: 400 }).height).toBe(24);
	});
	it('sits at the top at rest and at the bottom at the end, in content coordinates', () => {
		const top = thumbGeometry({ scrollTop: 0, scrollHeight: 800, clientHeight: 400 });
		expect(top.top).toBe(2);
		const end = thumbGeometry({ scrollTop: 400, scrollHeight: 800, clientHeight: 400 });
		// scrolled 400 down: the thumb's bottom is at the viewport's bottom minus the inset
		expect(end.top + end.height).toBeCloseTo(400 + 400 - 2, 5);
	});
	it('clamps an overscrolled reading', () => {
		const g = thumbGeometry({ scrollTop: 900, scrollHeight: 800, clientHeight: 400 });
		expect(g.top + g.height).toBeCloseTo(900 + 400 - 2, 5);
	});
});
