// @ts-nocheck — plain fixtures; the solver under test is typed
// 36-sim U2b: the fluid tank's PBF solver, headless — stays in the glass, settles to a
// level near its fill, pours from the emitter, drains, flows around a static collider and
// pushes a dynamic one up (the reaction a floating toy feels).
import { describe, it, expect } from 'vitest';
import { FluidSolver, spacingFor, normalizeFluid, pourAndDrain, FLUID_MAX_PARTICLES } from '../../src/lib/sim/fluidCore.js';

const min = [-0.4, -0.3, -0.3];
const max = [0.4, 0.3, 0.3];
const size = [0.8, 0.6, 0.6];
const G = { gravity: [0, -9.81, 0], viscosity: 0.05, surfaceTension: 0.5 };

function tank(count = 1200, fill = 0.4) {
	const s = new FluidSolver({ min, max, capacity: count, spacing: spacingFor(size, count, fill) });
	s.fillBlock(fill, count);
	return s;
}

/** @param {FluidSolver} s */
function stats(s) {
	let maxSpeed = 0, sum = 0, inside = true;
	const ys = [];
	for (let i = 0; i < s.count; i++) {
		const k = i * 3;
		const sp = Math.hypot(s.v[k], s.v[k + 1], s.v[k + 2]);
		maxSpeed = Math.max(maxSpeed, sp);
		sum += sp;
		ys.push(s.x[k + 1]);
		for (let a = 0; a < 3; a++) if (s.x[k + a] < min[a] - 1e-6 || s.x[k + a] > max[a] + 1e-6) inside = false;
	}
	ys.sort((a, b) => a - b);
	return { maxSpeed, mean: sum / Math.max(1, s.count), top: ys[Math.floor(ys.length * 0.97)] ?? min[1], inside };
}

describe('normalizeFluid', () => {
	it('types and clamps every field', () => {
		const f = normalizeFluid({ count: 1e6, viscosity: -1, color: 'red', emitter: { on: true, at: [2, 0.5, 'x'] }, quality: 'ultra' });
		expect(f.count).toBe(FLUID_MAX_PARTICLES);
		expect(f.viscosity).toBe(0);
		expect(f.color).toBe('#2f8fd8');
		expect(f.emitter.on).toBe(true);
		expect(f.emitter.at).toEqual([1, 0.5, 0.5]);
		expect(f.quality).toBe('auto');
		expect(normalizeFluid(null).drain.on).toBe(false);
	});
});

describe('FluidSolver', () => {
	it('settles inside the glass near its fill level, calm', () => {
		const s = tank();
		for (let f = 0; f < 180; f++) s.step(1 / 60, G);
		const st = stats(s);
		expect(st.inside).toBe(true);
		expect(s.count).toBe(1200);
		const expectedTop = min[1] + size[1] * 0.4;
		expect(Math.abs(st.top - expectedTop)).toBeLessThan(0.25 * size[1] * 0.4 + 0.03);
		expect(st.mean).toBeLessThan(0.25); // no boiling
		expect(st.maxSpeed).toBeLessThan(2);
	});
	it('a tilted gravity sloshes it to one side', () => {
		const s = tank();
		for (let f = 0; f < 120; f++) s.step(1 / 60, { ...G, gravity: [6, -8, 0] });
		let mx = 0;
		for (let i = 0; i < s.count; i++) mx += s.x[i * 3];
		expect(mx / s.count).toBeGreaterThan(0.08);
	});
	it('the emitter pours up to the count; the drain empties it', () => {
		const s = new FluidSolver({ min, max, capacity: 800, spacing: spacingFor(size, 800, 0.4) });
		const spec = normalizeFluid({ count: 600, emitter: { on: true, rate: 1200 } });
		const acc = { carry: 0, drainCarry: 0 };
		for (let f = 0; f < 60; f++) {
			pourAndDrain(s, spec, 1 / 60, acc);
			s.step(1 / 60, G);
		}
		expect(s.count).toBe(600); // capped at the spec count, not the capacity
		expect(stats(s).inside).toBe(true);
		const drainSpec = normalizeFluid({ count: 600, drain: { on: true, rate: 1200, at: [0.5, 0, 0.5], radius: 0.3 } });
		for (let f = 0; f < 240; f++) {
			pourAndDrain(s, drainSpec, 1 / 60, acc);
			s.step(1 / 60, G);
		}
		expect(s.count).toBeLessThan(300);
	});
	it('flows around a static box: nothing ends up inside it', () => {
		const s = tank();
		const box = { kind: 'box', center: [0, -0.2, 0], half: [0.1, 0.1, 0.1], quat: [0, 0, 0, 1] };
		for (let f = 0; f < 120; f++) s.step(1 / 60, { ...G, colliders: [box] });
		for (let i = 0; i < s.count; i++) {
			const k = i * 3;
			const inside = Math.abs(s.x[k]) < 0.1 - 1e-4 && Math.abs(s.x[k + 1] + 0.2) < 0.1 - 1e-4 && Math.abs(s.x[k + 2]) < 0.1 - 1e-4;
			expect(inside).toBe(false);
		}
	});
	it('pushes a submerged dynamic body UP (the reaction the runtime applies to rapier)', () => {
		const s = tank(1500, 0.6);
		for (let f = 0; f < 60; f++) s.step(1 / 60, G);
		let up = 0;
		const ball = { kind: 'sphere', center: [0, -0.15, 0], half: [0.08, 0.08, 0.08], quat: [0, 0, 0, 1], dynamic: true, id: 'ball' };
		for (let f = 0; f < 30; f++) {
			s.step(1 / 60, { ...G, colliders: [ball] });
			up += s.impulses.ball?.[1] ?? 0;
		}
		expect(up).toBeGreaterThan(0);
	});
});
