import { describe, it, expect } from 'vitest';
import { planSlop, TARGET } from '../../src/lib/ui/hitSlopCore.js';

/** @param {number} l @param {number} t @param {number} w @param {number} h */
const box = (l, t, w, h) => ({ l, t, r: l + w, b: t + h });
/** @param {{l:number,t:number,r:number,b:number}} r @param {{t:number,r:number,b:number,l:number}} s */
const grown = (r, s) => ({ l: r.l - s.l, t: r.t - s.t, r: r.r + s.r, b: r.b + s.b });
/** @param {{l:number,t:number,r:number,b:number}} a @param {{l:number,t:number,r:number,b:number}} b */
const meets = (a, b) => a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;

describe('hit slop', () => {
	it('a lone 24 px button reaches 44 px each way', () => {
		const [s] = planSlop([{ r: box(100, 100, 24, 24), small: true }]);
		expect(s).toEqual({ t: 10, r: 10, b: 10, l: 10 });
	});
	it('a wide but short control only grows vertically', () => {
		const [s] = planSlop([{ r: box(0, 0, 200, 28), small: true }]);
		expect(s.l).toBe(0);
		expect(s.r).toBe(0);
		expect(s.t).toBe(8);
		expect(s.b).toBe(8);
	});
	it('two buttons 4 px apart share the gap: 2 px each, no overlap', () => {
		const items = [{ r: box(0, 0, 28, 28), small: true }, { r: box(32, 0, 28, 28), small: true }];
		const [a, b] = planSlop(items);
		expect(a.r).toBe(2);
		expect(b.l).toBe(2);
		expect(a.l).toBe(TARGET / 2 - 14);
		expect(meets(grown(items[0].r, a), grown(items[1].r, b))).toBe(false);
	});
	it('touching buttons get no slop toward each other', () => {
		const items = [{ r: box(0, 0, 28, 28), small: true }, { r: box(28, 0, 28, 28), small: true }];
		const [a, b] = planSlop(items);
		expect(a.r).toBe(0);
		expect(b.l).toBe(0);
	});
	it('a large neighbour blocks without growing', () => {
		const items = [{ r: box(0, 0, 24, 24), small: true }, { r: box(30, 0, 120, 48), small: false }];
		const [a, b] = planSlop(items);
		expect(a.r).toBe(3);
		expect(b).toEqual({ t: 0, r: 0, b: 0, l: 0 });
	});
	it('a control nested in another gets none', () => {
		const [s] = planSlop([{ r: box(10, 10, 16, 16), small: true, nested: true }]);
		expect(s).toEqual({ t: 0, r: 0, b: 0, l: 0 });
	});
	it('two boxes overlapping by a few px keep their slop on the far sides', () => {
		// the notification bell laid 3 px over a window's ✕ (measured at 718 px)
		const items = [{ r: box(592, 66, 44, 44), small: false }, { r: box(615, 107, 28, 28), small: true }];
		const [, x] = planSlop(items);
		expect(x.t).toBe(0);
		expect(x.l).toBe(0);
		expect(x.b).toBe(8);
		expect(x.r).toBe(8);
	});
	it('a badge wholly inside a button gets nothing', () => {
		const [, s] = planSlop([{ r: box(0, 0, 40, 40), small: true }, { r: box(30, 0, 10, 10), small: true }]);
		expect(s).toEqual({ t: 0, r: 0, b: 0, l: 0 });
	});
	it('a dense grid never overlaps after planning', () => {
		const items = [];
		for (let y = 0; y < 5; y++) for (let x = 0; x < 6; x++) items.push({ r: box(x * 30, y * 26, 24, 22), small: true });
		const s = planSlop(items);
		for (let i = 0; i < items.length; i++)
			for (let j = i + 1; j < items.length; j++) expect(meets(grown(items[i].r, s[i]), grown(items[j].r, s[j]))).toBe(false);
	});
});
