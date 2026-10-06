import { describe, it, expect } from 'vitest';
import { iconSize, lucideName, ICON_SIZES, ICON_DISPLAY_SIZES, ICON_STROKE } from '../../src/lib/ui/icons.js';

// 38 R10: two UI sizes (16/20) plus a display scale for placeholder art; everything else
// snaps, so no third UI size can creep back in through a literal.
describe('iconSize', () => {
	it('snaps small sizes to 16 and medium ones to 20', () => {
		for (const n of [9, 10, 12, 13, 14, 15, 16, 17]) expect(iconSize(n)).toBe(16);
		for (const n of [18, 20, 22]) expect(iconSize(n)).toBe(20);
	});
	it('puts big placeholder glyphs on the display scale', () => {
		expect(iconSize(24)).toBe(24);
		expect(iconSize(26)).toBe(24);
		expect(iconSize(28)).toBe(32);
		expect(iconSize(36)).toBe(32);
		expect(iconSize(40)).toBe(48);
		expect(iconSize(44)).toBe(48);
	});
	it('defaults to 16 for missing or junk sizes', () => {
		expect(iconSize(undefined)).toBe(16);
		expect(iconSize('x')).toBe(16);
		expect(iconSize('20')).toBe(20);
	});
	it('only ever returns a standard size', () => {
		const allowed = new Set([...ICON_SIZES, ...ICON_DISPLAY_SIZES]);
		for (let n = 0; n <= 80; n++) expect(allowed.has(iconSize(n))).toBe(true);
		expect(ICON_STROKE).toBe(1.75);
	});
});

describe('lucideName', () => {
	it('matches lucide kebab-case names', () => {
		expect(lucideName('Trash2')).toBe('trash-2');
		expect(lucideName('Grid3x3')).toBe('grid-3x3');
		expect(lucideName('Move3d')).toBe('move-3d');
		expect(lucideName('MousePointer2')).toBe('mouse-pointer-2');
		expect(lucideName('AlignHorizontalSpaceAround')).toBe('align-horizontal-space-around');
		expect(lucideName('X')).toBe('x');
		expect(lucideName('RectangleGoggles')).toBe('rectangle-goggles');
	});
});
