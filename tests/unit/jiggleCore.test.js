// 36-sim U2b: the jiggle spring — lags behind a move, overshoots on a stop, settles,
// sags under gravity, never exceeds maxOffset, restarts on a teleport, and an impact
// excites the wobble which then dies away.
import { describe, it, expect } from 'vitest';
import { normalizeJiggle, jiggleState, stepJiggle, wobbleOf, boneMatcher, JIGGLE_DEFAULTS } from '../../src/lib/sim/jiggleCore.js';

const dt = 1 / 60;

describe('normalizeJiggle', () => {
	it('defaults and clamps', () => {
		expect(normalizeJiggle(null)).toEqual({ ...JIGGLE_DEFAULTS });
		const n = normalizeJiggle({ stiffness: -5, damping: 'x', pivot: 'side', bones: 7, maxOffset: 99 });
		expect(n.stiffness).toBe(1);
		expect(n.damping).toBe(JIGGLE_DEFAULTS.damping);
		expect(n.pivot).toBe('bottom');
		expect(n.bones).toBe('');
		expect(n.maxOffset).toBe(5);
	});
});

describe('stepJiggle', () => {
	const p = normalizeJiggle({ gravity: 0 });
	it('at rest it stays at rest', () => {
		const s = jiggleState();
		for (let i = 0; i < 120; i++) stepJiggle(s, [1, 2, 3], p, dt);
		expect(Math.hypot(...s.d)).toBeLessThan(1e-9);
	});
	it('moving right leaves it behind (negative x), stopping flings it past, then it settles', () => {
		const s = jiggleState();
		let x = 0;
		stepJiggle(s, [x, 0, 0], p, dt);
		let minD = 0;
		for (let i = 0; i < 30; i++) {
			x += 2 * dt; // 2 m/s
			stepJiggle(s, [x, 0, 0], p, dt);
			minD = Math.min(minD, s.d[0]);
		}
		expect(minD).toBeLessThan(-0.01); // lagged
		let maxD = -1;
		for (let i = 0; i < 30; i++) {
			stepJiggle(s, [x, 0, 0], p, dt);
			maxD = Math.max(maxD, s.d[0]);
		}
		expect(maxD).toBeGreaterThan(0.005); // overshot forward after the stop
		for (let i = 0; i < 600; i++) stepJiggle(s, [x, 0, 0], p, dt);
		expect(Math.abs(s.d[0])).toBeLessThan(1e-3); // settled
	});
	it('gravity sags it by g x gravity / stiffness', () => {
		const q = normalizeJiggle({ gravity: 1, stiffness: 100, damping: 1 });
		const s = jiggleState();
		for (let i = 0; i < 600; i++) stepJiggle(s, [0, 0, 0], q, dt);
		expect(s.d[1]).toBeCloseTo(-9.81 / 100, 3);
	});
	it('never exceeds maxOffset', () => {
		const q = normalizeJiggle({ maxOffset: 0.1, stiffness: 5, damping: 0 });
		const s = jiggleState();
		let x = 0;
		for (let i = 0; i < 200; i++) {
			x += (i % 40 < 20 ? 3 : -3) * dt;
			stepJiggle(s, [x, 0, 0], q, dt);
			expect(Math.hypot(...s.d)).toBeLessThanOrEqual(0.1 + 1e-9);
		}
	});
	it('a teleport restarts the spring instead of flinging it', () => {
		const s = jiggleState();
		stepJiggle(s, [0, 0, 0], p, dt);
		stepJiggle(s, [50, 0, 0], p, dt);
		expect(Math.hypot(...s.d)).toBe(0);
		expect(Math.hypot(...s.v)).toBe(0);
	});
	it('an impact excites the wobble, which dies away', () => {
		const s = jiggleState();
		let y = 2;
		let vy = 0;
		stepJiggle(s, [0, y, 0], p, dt);
		// fall then stop dead on the floor
		for (let i = 0; i < 30; i++) {
			vy -= 9.81 * dt;
			y += vy * dt;
			stepJiggle(s, [0, y, 0], p, dt);
		}
		const before = s.excite;
		stepJiggle(s, [0, y, 0], p, dt); // landed: velocity 5 m/s -> 0 in one frame
		expect(s.excite).toBeGreaterThan(before + 0.3);
		let peak = 0;
		for (let i = 0; i < 20; i++) {
			stepJiggle(s, [0, y, 0], p, dt);
			peak = Math.max(peak, Math.abs(wobbleOf(s, p)));
		}
		expect(peak).toBeGreaterThan(0.02);
		for (let i = 0; i < 600; i++) stepJiggle(s, [0, y, 0], p, dt);
		expect(Math.abs(wobbleOf(s, p))).toBeLessThan(1e-3);
	});
	it('wind sways it with no motion at all', () => {
		const q = normalizeJiggle({ wind: 10, gravity: 0 });
		const s = jiggleState();
		let maxX = 0;
		for (let i = 0; i < 300; i++) {
			stepJiggle(s, [0, 0, 0], q, dt, i * dt);
			maxX = Math.max(maxX, Math.abs(s.d[0]));
		}
		expect(maxX).toBeGreaterThan(0.03);
	});
	it('a kick (a VR grab yank) moves it and excites the wobble', () => {
		const s = jiggleState();
		stepJiggle(s, [0, 0, 0], p, dt);
		stepJiggle(s, [0, 0, 0], p, dt, 0, [0, 2, 0]);
		expect(s.excite).toBeGreaterThan(0.4);
		expect(s.d[1]).toBeGreaterThan(0);
	});
});

describe('boneMatcher', () => {
	it('globs, case-insensitive, empty = null', () => {
		expect(boneMatcher('')).toBeNull();
		const m = /** @type {(n: string) => boolean} */ (boneMatcher('hair*, Tail_?'));
		expect(m('Hair_01')).toBe(true);
		expect(m('tail_1')).toBe(true);
		expect(m('tail_12')).toBe(false);
		expect(m('spine')).toBe(false);
	});
});
