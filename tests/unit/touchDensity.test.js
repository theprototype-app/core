// phone-polish item 3: Touch size — the setting, the URL switch and the effective state
import { describe, it, expect } from 'vitest';
import { normalizeTouchSize, touchSizeFromUrl, touchUiOn } from '../../src/lib/touchDensity.js';

describe('touch size', () => {
	it('normalizes to auto / touch / standard', () => {
		expect(normalizeTouchSize('touch')).toBe('touch');
		expect(normalizeTouchSize('standard')).toBe('standard');
		expect(normalizeTouchSize('large')).toBe('auto');
		expect(normalizeTouchSize(null)).toBe('auto');
	});
	it('auto follows the pointer; touch and standard do not', () => {
		expect(touchUiOn('auto', true)).toBe(true);
		expect(touchUiOn('auto', false)).toBe(false);
		expect(touchUiOn('touch', false)).toBe(true);
		expect(touchUiOn('standard', true)).toBe(false);
	});
	it('the URL switch: ?density=touch|compact|auto (compact = standard), anything else = no say', () => {
		expect(touchSizeFromUrl('?density=touch')).toBe('touch');
		expect(touchSizeFromUrl('?s=abc&density=compact')).toBe('standard');
		expect(touchSizeFromUrl('?density=auto')).toBe('auto');
		expect(touchSizeFromUrl('?density=huge')).toBe(null);
		expect(touchSizeFromUrl('')).toBe(null);
	});
});
