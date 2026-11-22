import { describe, it, expect } from 'vitest';
import { dragScrollStep, DRAG_SLOP } from '../../src/lib/ui/dragScroll.js';

// 103 H14 row 1: the main menu's mouse drag-scroll. The click threshold is the owner's 6 px, and the coast after a
// release decays to a stop (a little momentum, never a run-away scroll).
describe('drag scroll', () => {
	it('a press is a click until it travels 6 px', () => {
		expect(DRAG_SLOP).toBe(6);
	});
	it('the coast moves by speed x time and slows every frame', () => {
		const a = dragScrollStep(1, 16);
		expect(a.dy).toBe(16);
		expect(a.v).toBeGreaterThan(0.85);
		expect(a.v).toBeLessThan(1);
	});
	it('the coast is frame-rate independent: two 8 ms frames slow it like one 16 ms frame', () => {
		const one = dragScrollStep(1, 16).v;
		const two = dragScrollStep(dragScrollStep(1, 8).v, 8).v;
		expect(two).toBeCloseTo(one, 6);
	});
	it('it always comes to rest, and travels a bounded distance', () => {
		let v = 3;
		let travelled = 0;
		let frames = 0;
		while (v && frames < 1000) {
			const s = dragScrollStep(v, 16);
			travelled += s.dy;
			v = s.v;
			frames++;
		}
		expect(v).toBe(0);
		expect(frames).toBeLessThan(200);
		expect(travelled).toBeLessThan(1000);
	});
	it('scrolling up coasts up', () => {
		expect(dragScrollStep(-2, 16).dy).toBeLessThan(0);
	});
});
