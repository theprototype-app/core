import { describe, it, expect } from 'vitest';
import { nextPreset, presetRect, SIZE_PRESETS, SMALL_PRESET, WIN_MARGIN } from '../../src/lib/windowSize.js';

// 78 PL39: Small / Half / Full for a floating window, inside the free area between the sidebars.
const AREA = { left: 320, right: 1600, top: 60, bottom: 1000 };

describe('size presets', () => {
	it('a double click cycles Half -> Full -> Small -> Half, starting at Half', () => {
		expect(SIZE_PRESETS).toEqual(['small', 'half', 'full']);
		expect(nextPreset(undefined)).toBe('half');
		expect(nextPreset('half')).toBe('full');
		expect(nextPreset('full')).toBe('small');
		expect(nextPreset('small')).toBe('half');
	});
	it('Full fills the free area inside the margin', () => {
		const r = presetRect('full', AREA, { left: 500, top: 100, w: 400, h: 300 });
		expect(r).toEqual({ left: AREA.left + WIN_MARGIN, top: AREA.top + WIN_MARGIN, w: AREA.right - AREA.left - 2 * WIN_MARGIN, h: AREA.bottom - AREA.top - 2 * WIN_MARGIN });
	});
	it('Half takes the half the window is on, full height', () => {
		const W = AREA.right - AREA.left - 2 * WIN_MARGIN;
		const w = Math.floor((W - WIN_MARGIN) / 2);
		const left = presetRect('half', AREA, { left: 400, top: 100, w: 300, h: 300 });
		expect(left.left).toBe(AREA.left + WIN_MARGIN);
		expect(left.w).toBe(w);
		const right = presetRect('half', AREA, { left: 1300, top: 100, w: 200, h: 300 });
		expect(right.left + right.w).toBe(AREA.right - WIN_MARGIN);
		expect(right.h).toBe(AREA.bottom - AREA.top - 2 * WIN_MARGIN);
	});
	it('Small keeps the window where it is, pulled inside the area', () => {
		const r = presetRect('small', AREA, { left: 1500, top: 950, w: 600, h: 500 });
		expect(r.w).toBe(SMALL_PRESET.w);
		expect(r.h).toBe(SMALL_PRESET.h);
		expect(r.left + r.w).toBeLessThanOrEqual(AREA.right - WIN_MARGIN);
		expect(r.top + r.h).toBeLessThanOrEqual(AREA.bottom - WIN_MARGIN);
		const stay = presetRect('small', AREA, { left: 600, top: 200, w: 600, h: 500 });
		expect([stay.left, stay.top]).toEqual([600, 200]);
	});
	it('a window minimum wins over Small, the area wins over the minimum', () => {
		expect(presetRect('small', AREA, { left: 600, top: 200, w: 1, h: 1 }, { minW: 500, minH: 400 }).w).toBe(500);
		const tiny = { left: 0, right: 300, top: 0, bottom: 250 };
		const r = presetRect('full', tiny, { left: 0, top: 0, w: 10, h: 10 }, { minW: 500, minH: 400 });
		expect(r.w).toBeLessThanOrEqual(300);
		expect(r.h).toBeLessThanOrEqual(250);
	});
});
