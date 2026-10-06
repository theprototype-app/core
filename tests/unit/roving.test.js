import { describe, it, expect } from 'vitest';
import { rovingIndex, ROVING_KEYS } from '../../src/lib/ui/roving.js';

// 38 R3: Segmented (radiogroup) and Tabs (tablist) share this. One tab stop, arrows move
// AND select, disabled items are skipped, the ends wrap — and a key it does not own returns
// -1 so the component lets it through (Tab must still leave the group).
describe('rovingIndex', () => {
	const none = [false, false, false, false];

	it('moves forward and back with wrap', () => {
		expect(rovingIndex(0, 'ArrowRight', none)).toBe(1);
		expect(rovingIndex(3, 'ArrowRight', none)).toBe(0);
		expect(rovingIndex(0, 'ArrowLeft', none)).toBe(3);
		expect(rovingIndex(2, 'ArrowDown', none)).toBe(3);
		expect(rovingIndex(2, 'ArrowUp', none)).toBe(1);
	});

	it('Home / End go to the first / last ENABLED item', () => {
		expect(rovingIndex(2, 'Home', [true, false, false, false])).toBe(1);
		expect(rovingIndex(0, 'End', [false, false, false, true])).toBe(2);
	});

	it('skips disabled items in both directions', () => {
		expect(rovingIndex(0, 'ArrowRight', [false, true, true, false])).toBe(3);
		expect(rovingIndex(3, 'ArrowLeft', [false, true, true, false])).toBe(0);
	});

	it('respects orientation (a horizontal tablist ignores up/down)', () => {
		expect(rovingIndex(1, 'ArrowDown', none, 'horizontal')).toBe(-1);
		expect(rovingIndex(1, 'ArrowRight', none, 'vertical')).toBe(-1);
		expect(rovingIndex(1, 'ArrowDown', none, 'vertical')).toBe(2);
	});

	it('returns -1 for foreign keys and an all-disabled group', () => {
		expect(rovingIndex(0, 'Tab', none)).toBe(-1);
		expect(rovingIndex(0, 'Enter', none)).toBe(-1);
		expect(rovingIndex(0, 'ArrowRight', [true, true])).toBe(-1);
		expect(rovingIndex(0, 'ArrowRight', [])).toBe(-1);
		expect(ROVING_KEYS).not.toContain('Tab');
	});

	it('an out-of-range current starts from the first item', () => {
		expect(rovingIndex(-1, 'ArrowRight', none)).toBe(1);
	});
});
