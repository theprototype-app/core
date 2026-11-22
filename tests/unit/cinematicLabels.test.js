// 100 C2-1 — troika text in the Cinematic view: the pure layout half (labelLayout.js) that turns troika's own
// typesetting into what a 2D canvas paints and the quads it lands on.
import { describe, it, expect } from 'vitest';
import { parsePercent, coverBounds, rasterPlan, glyphChars, glyphCells, charRuns, orientBasis, baselineY, bleed, PX_PER_EM, MAX_PX, MARGIN_EM } from '../../src/lib/cinematic/labelLayout.js';

/** caret boxes for a line of `n` characters, each `w` wide, from x0, on the line [bottom, top] @param {number} n @param {number} w */
const line = (n, w, x0 = 0, bottom = -0.2, top = 0.8) => Array.from({ length: n }, (_, i) => [x0 + i * w, x0 + (i + 1) * w, bottom, top]).flat();

describe('parsePercent', () => {
	it('reads numbers and percents of the font size', () => {
		expect(parsePercent(0.02, 1)).toBe(0.02);
		expect(parsePercent('10%', 0.5)).toBeCloseTo(0.05);
		expect(parsePercent('0.3', 1)).toBeCloseTo(0.3);
		expect(parsePercent(undefined, 1)).toBe(0);
		expect(parsePercent(NaN, 1)).toBe(0);
	});
});

describe('coverBounds / rasterPlan', () => {
	it('covers the block and the glyphs plus outline and margin', () => {
		const b = coverBounds({ blockBounds: [-1, -0.5, 1, 0.5], visibleBounds: [-1.1, -0.6, 0.9, 0.4] }, 1, 0.1);
		const m = 0.1 + MARGIN_EM;
		expect(b[0]).toBeCloseTo(-1.1 - m);
		expect(b[1]).toBeCloseTo(-0.6 - m);
		expect(b[2]).toBeCloseTo(1 + m);
		expect(b[3]).toBeCloseTo(0.5 + m);
	});
	it('an empty text covers nothing', () => {
		expect(coverBounds({ blockBounds: [0, 0, 0, 0] }, 1)).toEqual([0, 0, 0, 0]);
		expect(rasterPlan([0, 0, 0, 0], 1).w).toBe(0);
	});
	it('draws PX_PER_EM per em, capped at MAX_PX on the long side', () => {
		const p = rasterPlan([0, 0, 1, 0.5], 0.25);
		expect(p.px).toBeCloseTo(PX_PER_EM / 0.25);
		expect(p.w).toBe(Math.ceil(PX_PER_EM / 0.25));
		const big = rasterPlan([0, 0, 200, 1], 1);
		expect(big.w).toBeLessThanOrEqual(MAX_PX);
		expect(big.h).toBeGreaterThanOrEqual(1);
	});
});

describe('glyphChars', () => {
	it('maps each glyph to the caret box holding its centre, skipping spaces (no glyph)', () => {
		// "ab c": 4 caret boxes; glyphs for a, b, c only
		const carets = line(4, 0.5);
		const glyphs = [0.05, -0.1, 0.45, 0.7, 0.55, -0.1, 0.95, 0.7, 1.55, -0.1, 1.95, 0.7];
		expect([...glyphChars(glyphs, carets)]).toEqual([0, 1, 3]);
	});
	it('a newline (zero-width caret) is never chosen; a glyph off the line goes to the nearest box on its line', () => {
		const carets = [...line(2, 0.5), 1, 1, -0.2, 0.8, ...line(1, 0.5, 0, -1.4, -0.4)];
		const glyphs = [0.6, -0.1, 0.9, 0.7, 0.1, -1.3, 0.4, -0.5];
		expect([...glyphChars(glyphs, carets)]).toEqual([1, 3]);
	});
});

describe('charRuns', () => {
	it('one run per line, starting at the first character, whitespace-only runs dropped', () => {
		const text = 'Hi there\nyou';
		const carets = [...line(8, 0.5), 4, 4, -0.2, 0.8, ...line(3, 0.5, 0, -1.4, -0.4)];
		const runs = charRuns(text, carets);
		expect(runs.map((r) => r.s)).toEqual(['Hi there', 'you']);
		expect(runs[1].x).toBe(0);
		expect(runs[1].bottom).toBeCloseTo(-1.4);
	});
	it('splits on colour and on a gap (justified or wrapped text keeps troika x for each piece)', () => {
		const carets = [...line(2, 0.5), 1.5, 2, -0.2, 0.8];
		const runs = charRuns('abc', carets, (i) => (i === 0 ? 0xff0000 : 0x00ff00));
		expect(runs.map((r) => [r.s, r.x, r.color])).toEqual([['a', 0, 0xff0000], ['b', 0.5, 0x00ff00], ['c', 1.5, 0x00ff00]]);
	});
	it('reads a surrogate pair as one character at its first unit', () => {
		const text = 'a\u{1F600}b';
		const carets = [...line(1, 0.5), 0.5, 1, -0.2, 0.8, 1, 1, -0.2, 0.8, 1, 1.5, -0.2, 0.8];
		expect(charRuns(text, carets).map((r) => r.s)).toEqual([text]);
	});
});

describe('glyphCells', () => {
	it('cells abut inside a word and reach out by pad at its ends', () => {
		const carets = line(3, 0.5);
		const glyphs = [0.05, -0.1, 0.45, 0.7, 0.55, -0.3, 0.95, 0.9, 1.05, -0.1, 1.45, 0.7];
		const charOf = glyphChars(glyphs, carets);
		const c = glyphCells(glyphs, carets, charOf, 0.1);
		expect([...c.slice(0, 4)].map((v) => +v.toFixed(3))).toEqual([-0.1, -0.3, 0.5, 0.9]);
		// the middle glyph's own reach widens its line box (-0.3 / 0.9 beyond the caret's -0.2 / 0.8)
		expect([...c.slice(4, 8)].map((v) => +v.toFixed(3))).toEqual([0.5, -0.4, 1, 1]);
		expect(c[10]).toBeCloseTo(1.6);
	});
});

describe('orientBasis', () => {
	it('the default is the identity', () => {
		expect(orientBasis(undefined)).toBe(null);
		expect(orientBasis('+x+y')).toBe(null);
		expect(orientBasis('nonsense')).toBe(null);
	});
	it('+x-z lays the text flat on the ground, facing up', () => {
		expect(orientBasis('+x-z')).toEqual([1, 0, 0, 0, 0, -1, 0, 1, 0]);
	});
});

describe('baselineY / bleed', () => {
	it('the baseline sits (ascent - descent) / 2 under the caret centre', () => {
		// caret [-0.2, 0.8] (centre 0.3), font box 90 px up / 30 px down at 100 px per unit: baseline 0.3 - 0.3 = 0
		expect(baselineY(-0.2, 0.8, 90, 30, 100)).toBeCloseTo(0);
	});
	it('transparent texels take the ink colour, the rest are untouched', () => {
		const d = new Uint8ClampedArray([0, 0, 0, 0, 10, 20, 30, 128]);
		bleed(d, [200, 100, 50]);
		expect([...d]).toEqual([200, 100, 50, 0, 10, 20, 30, 128]);
	});
});
