// @ts-nocheck — fixtures are partial models
// 36 F11 / S4 — the tidy-graph leaf: the wire model, the lint, repair and the layered layout.
import { describe, it, expect } from 'vitest';
import { bezierControls, bezierPoints, lintGraph, repairLayout, layeredLayout, boxesOverlap, lintSummary } from '../../src/lib/graphLayout.js';

const box = (id, x, y, w = 150, h = 80, kind) => ({ id, x, y, w, h, ...(kind ? { kind } : {}) });
/** a wire from the right middle of `s` to the left middle of `t` */
const wire = (s, t, sh = 40, th = 40) => ({ id: `e-${s}-${t}`, source: s, target: t, sx: 150, sy: sh, tx: 0, ty: th });

describe('the wire model', () => {
	it('uses xyflow getBezierPath control points (curvature 0.25)', () => {
		// forward wire: both controls offset by half the horizontal distance
		expect(bezierControls(0, 0, 200, 100)).toEqual({ c1x: 100, c1y: 0, c2x: 100, c2y: 100 });
		// a wire running BACKWARDS loops out: offset = 0.25 * 25 * sqrt(dx)
		const back = bezierControls(200, 0, 100, 0);
		expect(back.c1x).toBeCloseTo(200 + 0.25 * 25 * 10);
		expect(back.c2x).toBeCloseTo(100 - 0.25 * 25 * 10);
	});
	it('samples from handle to handle', () => {
		const pts = bezierPoints(0, 0, 300, 120);
		expect(pts[0]).toEqual([0, 0]);
		expect(pts.at(-1)).toEqual([300, 120]);
		expect(pts.length).toBe(49);
	});
});

describe('lintGraph', () => {
	it('a clean row has no problems', () => {
		const r = lintGraph([box('a', 0, 0), box('b', 300, 0)], [wire('a', 'b')]);
		expect(r.ok).toBe(true);
		expect(lintSummary(r)).toBe('0 overlaps, 0 wires through cards, 0 frame clashes');
	});
	it('finds overlapping cards', () => {
		const r = lintGraph([box('a', 0, 0), box('b', 100, 50)], []);
		expect(r.overlaps).toEqual([{ a: 'a', b: 'b' }]);
	});
	it('finds a wire through a card, never through its own ends', () => {
		const r = lintGraph([box('a', 0, 0), box('m', 260, 0), box('b', 520, 0)], [wire('a', 'b')]);
		expect(r.wireHits).toEqual([{ wire: 'e-a-b', box: 'm' }]);
	});
	it('a card inside a frame is fine; half in is a clash; frames do not clash with their own wires', () => {
		const frame = box('f', -20, -20, 500, 200, 'frame');
		expect(lintGraph([frame, box('a', 0, 0), box('b', 300, 0)], [wire('a', 'b')]).ok).toBe(true);
		const r = lintGraph([frame, box('a', 0, 0), box('b', 400, 0)], [wire('a', 'b')]);
		expect(r.frameOverlaps).toEqual([{ a: 'f', b: 'b' }]);
	});
});

describe('repairLayout', () => {
	it('moves the card in a wire’s way out of the wire, the shorter way', () => {
		const boxes = [box('a', 0, 0), box('m', 260, 10), box('b', 520, 0)];
		const r = repairLayout(boxes, [wire('a', 'b')]);
		expect(r.lint.ok).toBe(true);
		expect(r.moved).toEqual(['m']);
		expect(r.boxes.find((b) => b.id === 'a')).toEqual(boxes[0]); // the others stay put
	});
	it('pushes the lower of two overlapping cards down, and never moves a pinned one', () => {
		const r = repairLayout([box('a', 0, 0), box('b', 50, 40)], []);
		expect(r.lint.ok).toBe(true);
		expect(r.boxes[1].y).toBeGreaterThanOrEqual(80);
		const p = repairLayout([box('a', 0, 0), { ...box('b', 50, 40), pinned: true }], []);
		expect(p.boxes[1]).toMatchObject({ x: 50, y: 40 });
		expect(p.boxes[0].y).toBeGreaterThanOrEqual(120);
	});
	it('settles a pile-up (every card on one spot) into a clean column', () => {
		const boxes = Array.from({ length: 8 }, (_, i) => box('n' + i, 0, 0));
		const r = repairLayout(boxes, []);
		expect(r.lint.ok).toBe(true);
	});
});

describe('layeredLayout', () => {
	const chain = () => ({
		boxes: [box('c', 0, 0), box('a', 0, 100), box('b', 0, 200), box('d', 0, 300)],
		wires: [wire('a', 'b'), wire('b', 'c'), wire('a', 'd'), wire('d', 'c')]
	});
	it('lays the flow out left to right in layers', () => {
		const { boxes, wires } = chain();
		const r = layeredLayout(boxes, wires);
		const at = Object.fromEntries(r.boxes.map((b) => [b.id, b]));
		expect(at.a.x).toBeLessThan(at.b.x);
		expect(at.b.x).toBe(at.d.x);
		expect(at.b.x).toBeLessThan(at.c.x);
		expect(r.lint.ok).toBe(true);
		expect(r.layers).toBe(3);
	});
	it('is deterministic', () => {
		const one = layeredLayout(chain().boxes, chain().wires).boxes;
		const two = layeredLayout(chain().boxes, chain().wires).boxes;
		expect(two).toEqual(one);
	});
	it('breaks a cycle instead of looping', () => {
		const r = layeredLayout([box('a', 0, 0), box('b', 300, 0), box('c', 600, 0)], [wire('a', 'b'), wire('b', 'c'), wire('c', 'a')]);
		expect(r.reversed).toBe(1);
		expect(r.layers).toBe(3);
	});
	it('notes ride above the card they describe; a far note comes first (top-left)', () => {
		const boxes = [box('a', 0, 0), box('b', 400, 0), box('na', 0, -140, 220, 100, 'note'), box('readme', -2000, -2000, 300, 200, 'note')];
		const r = layeredLayout(boxes, [wire('a', 'b')]);
		const at = Object.fromEntries(r.boxes.map((b) => [b.id, b]));
		expect(at.na.x).toBe(at.a.x);
		expect(at.na.y + at.na.h).toBeLessThanOrEqual(at.a.y);
		expect(at.readme.x <= at.a.x && at.readme.y <= at.a.y).toBe(true);
		expect(at.readme.x < at.a.x || at.readme.y + at.readme.h <= at.na.y).toBe(true);
		expect(r.lint.ok).toBe(true);
	});
	it('a fan of long wires around a busy middle still lints clean', () => {
		const boxes = [box('src', 0, 0)];
		const wires = [];
		for (let i = 0; i < 6; i++) {
			boxes.push(box('m' + i, 0, 100 * (i + 1)));
			boxes.push(box('t' + i, 0, 100 * (i + 1) + 50));
			wires.push(wire('src', 'm' + i), wire('m' + i, 't' + i));
		}
		boxes.push(box('far', 0, 900));
		wires.push(wire('src', 'far'), { ...wire('t0', 'far'), id: 'e-t0-far' });
		const r = layeredLayout(boxes, wires);
		expect(r.lint.ok).toBe(true);
		for (let i = 0; i < r.boxes.length; i++) for (let j = i + 1; j < r.boxes.length; j++) expect(boxesOverlap(r.boxes[i], r.boxes[j])).toBe(false);
	});
});
