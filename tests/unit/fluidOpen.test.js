// @ts-nocheck — plain fixtures; the solver under test is typed
// 36-fb (F16/F23/F25): the solver's open-domain additions — a wall mask, the escaped
// particles handed back, the lifetime cap, and moving colliders that CARRY water.
import { describe, it, expect } from 'vitest';
import { FluidSolver, spacingFor, ESCAPE_CAP } from '../../src/lib/sim/fluidCore.js';

const min = [-0.4, -0.3, -0.3];
const max = [0.4, 0.3, 0.3];
const size = [0.8, 0.6, 0.6];
const G = { gravity: [0, -9.81, 0], viscosity: 0.05, surfaceTension: 0.5 };

function tank(count = 800, fill = 0.4) {
	const s = new FluidSolver({ min, max, capacity: count, spacing: spacingFor(size, count, fill) });
	s.fillBlock(fill, count);
	return s;
}

describe('wall mask', () => {
	it('all walls (the default) keeps every particle and escapes none', () => {
		const s = tank();
		for (let f = 0; f < 60; f++) s.step(1 / 60, { ...G, gravity: [6, -9.81, 0] });
		expect(s.count).toBe(800);
		expect(s.takeEscaped().length).toBe(0);
	});
	it('a missing x-high wall lets a sideways-tilted tank spill: escaped particles come back with position + velocity', () => {
		const s = tank();
		s.setWalls([true, false, true, true, true, true]);
		let escaped = 0;
		let sample = null;
		for (let f = 0; f < 120; f++) {
			s.step(1 / 60, { ...G, gravity: [9, -4, 0] });
			const e = s.takeEscaped();
			if (e.length && !sample) sample = Array.from(e.slice(0, 6));
			escaped += e.length / 6;
		}
		expect(escaped).toBeGreaterThan(200);
		expect(s.count + escaped + s.escapedDropped).toBe(800);
		// it left through +x, moving outward
		expect(sample[0]).toBeGreaterThan(max[0]);
		expect(sample[3]).toBeGreaterThan(0);
		// nothing left through the walls that are still there
		for (let i = 0; i < s.count; i++) expect(s.x[i * 3]).toBeGreaterThan(min[0] - 1e-6);
	});
	it('the mask also rides step options (the worker forwards m.walls)', () => {
		const s = tank();
		for (let f = 0; f < 90; f++) s.step(1 / 60, { ...G, gravity: [0, 9.81, 0], walls: [true, true, true, false, true, true] });
		expect(s.count).toBeLessThan(800);
		expect(s.walls[3]).toBe(false);
	});
	it('the escape buffer is capped; the overflow is counted, never kept', () => {
		const s = new FluidSolver({ min, max, capacity: 3000, spacing: spacingFor(size, 3000, 0.9) });
		s.fillBlock(0.9, 3000);
		s.setWalls([false, false, false, false, false, false]);
		for (let f = 0; f < 40; f++) s.step(1 / 60, { ...G, gravity: [0, -30, 0] });
		const e = s.takeEscaped();
		expect(e.length).toBeLessThanOrEqual(ESCAPE_CAP * 6);
		expect(e.length / 6 + s.escapedDropped + s.count).toBe(3000);
	});
});

describe('lifetime cap', () => {
	it('particles older than the lifetime expire; fresh spawns do not', () => {
		const s = tank(400);
		for (let f = 0; f < 30; f++) s.step(1 / 60, { ...G, lifetime: 1 });
		expect(s.count).toBe(400); // 0.5 s old
		for (let f = 0; f < 40; f++) s.step(1 / 60, { ...G, lifetime: 1 });
		expect(s.count).toBe(0);
		expect(s.expired).toBe(400);
		s.spawn([0, 0, 0], [0, 0, 0]);
		s.step(1 / 60, { ...G, lifetime: 1 });
		expect(s.count).toBe(1);
	});
	it('no lifetime = forever (the tank default)', () => {
		const s = tank(300);
		for (let f = 0; f < 200; f++) s.step(1 / 60, G);
		expect(s.count).toBe(300);
	});
});

describe('moving colliders carry water (F25)', () => {
	/** mean sideways velocity of the water right over a floor plate sliding along +x */
	function dragged(withMotion) {
		const s = tank(800, 0.35);
		for (let f = 0; f < 60; f++) s.step(1 / 60, G); // settle
		let x = -0.2;
		for (let f = 0; f < 20; f++) {
			x += 0.6 / 60;
			const plate = { kind: 'box', center: [x, min[1] + 0.01, 0], half: [0.1, 0.02, 0.28], quat: [0, 0, 0, 1], ...(withMotion ? { vel: [0.6, 0, 0] } : {}) };
			s.step(1 / 60, { ...G, colliders: [plate] });
		}
		let vx = 0, n = 0;
		for (let i = 0; i < s.count; i++)
			if (s.x[i * 3 + 1] < min[1] + 0.12 && Math.abs(s.x[i * 3] - x) < 0.1) {
				vx += s.v[i * 3];
				n++;
			}
		return vx / Math.max(n, 1);
	}
	it('a plate sliding under the water drags it along (tangential carry), counterfactual: same pose, no velocity = no drag', () => {
		const moving = dragged(true);
		const still = dragged(false);
		expect(moving).toBeGreaterThan(still + 0.4); // measured 1.01 vs 0.25 m/s
	});
	it('a spinning wheel drags the water around it (ω × r), counterfactual: no omega = no swirl', () => {
		function swirl(omega) {
			const s = tank(800, 0.5);
			for (let f = 0; f < 40; f++) s.step(1 / 60, G);
			for (let f = 0; f < 30; f++)
				s.step(1 / 60, { ...G, colliders: [{ kind: 'sphere', center: [0, -0.15, 0], half: [0.12], quat: [0, 0, 0, 1], ...(omega ? { omega: [0, 0, 6] } : {}) }] });
			// tangential (about z) velocity of the particles near the wheel
			let t = 0, n = 0;
			for (let i = 0; i < s.count; i++) {
				const k = i * 3;
				const rx = s.x[k], ry = s.x[k + 1] + 0.15;
				const r = Math.hypot(rx, ry);
				if (r > 0.25) continue;
				t += (-ry * s.v[k] + rx * s.v[k + 1]) / Math.max(r, 1e-3);
				n++;
			}
			return t / Math.max(n, 1);
		}
		expect(swirl(true)).toBeGreaterThan(swirl(false) + 0.03);
	});
});

describe('thin walls do not leak (36-fb)', () => {
	it('water pressed hard against a thin wall stays on its own side', () => {
		const s = new FluidSolver({ min: [-0.5, -0.3, -0.3], max: [0.5, 0.3, 0.3], capacity: 900, spacing: 0.04 });
		// fill the -x half
		let n = 0;
		for (let x = -0.48; x < -0.06 && n < 900; x += 0.04)
			for (let y = -0.28; y < 0.2 && n < 900; y += 0.04)
				for (let z = -0.28; z < 0.28 && n < 900; z += 0.04) {
					s.spawn([x, y, z], [0, 0, 0]);
					n++;
				}
		const wall = { kind: 'box', center: [0, 0, 0], half: [0.02, 0.3, 0.3], quat: [0, 0, 0, 1] };
		for (let f = 0; f < 180; f++) s.step(1 / 60, { gravity: [40, -9.81, 0], viscosity: 0.05, surfaceTension: 0.5, colliders: [wall] });
		let across = 0;
		for (let i = 0; i < s.count; i++) if (s.x[i * 3] > 0.02) across++;
		expect(across).toBe(0);
	});
});
