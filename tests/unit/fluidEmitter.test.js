// @ts-nocheck — plain fixtures; the code under test is typed
// 36-fb F23: the Fluid emitter's pure core + the solver in an OPEN area, headless — every
// hard cap (particles, lifetime, area, burst amount) holds on its own, the floor holds water,
// a sink (a W1 pool) swallows what reaches it, and garbage settings are clamped.
import { describe, it, expect } from 'vitest';
import { FluidSolver } from '../../src/lib/sim/fluidCore.js';
import {
	normalizeEmitter,
	EMITTER_DEFAULTS,
	EMITTER_MAX_PARTICLES,
	QUEST_EMITTER_CAP,
	MAX_CELLS,
	capFor,
	domainOf,
	releaseCount,
	nozzleBatch,
	spawnBatch,
	applySinks,
	fitArea,
	normalizeInteraction,
	budgetLimits,
	governorFactor,
	DEFAULT_FLUID_BUDGET,
	QUEST_FLUID_BUDGET
} from '../../src/lib/sim/fluidEmitterCore.js';
import { normalizeFlowPath, compileFlow, applyFlows } from '../../src/lib/sim/flowPathCore.js';

const G = { gravity: [0, -9.81, 0], viscosity: 0.05, surfaceTension: 0.5 };

/** run an emitter headless the way the runtime does (main-thread half + worker half) */
function run(specIn, frames, { sinks = null, colliders = [], flows = null } = {}) {
	const spec = normalizeEmitter(specIn);
	const { min, max, walls } = domainOf(spec);
	const cap = capFor(spec, false);
	const s = new FluidSolver({ min, max, capacity: cap, spacing: spec.particleSize });
	s.setWalls(walls);
	const acc = { carry: 0, released: 0 };
	const rng = { seed: 7 };
	const nozzle = [0, max[1] - 0.2, 0];
	let peak = 0;
	let sunk = 0;
	for (let f = 0; f < frames; f++) {
		const n = releaseCount(spec, acc, 1 / 60, s.count, cap);
		spawnBatch(s, n ? nozzleBatch(n, nozzle, spec.dir, spec.speed, spec.spread, spec.particleSize, rng) : null);
		s.step(1 / 60, { ...G, colliders, walls, lifetime: spec.lifetime, cohesion: spec.cohesion, floorFriction: spec.friction });
		if (flows) applyFlows(s, flows, 1 / 60);
		sunk += applySinks(s, sinks, 1e6).length / 3;
		s.takeEscaped();
		peak = Math.max(peak, s.count);
	}
	return { s, acc, peak, sunk, spec };
}

describe('normalizeEmitter', () => {
	it('types and clamps every field; garbage takes the default', () => {
		const e = normalizeEmitter({ rate: 1e9, maxParticles: 1e9, lifetime: -5, spread: 400, mode: 'flood', dir: [0, 0, 0], color: 'blue', area: { size: [99, 'x', 1], offset: [0, 99, 0] }, particleSize: 9 });
		expect(e.rate).toBe(3000);
		expect(e.maxParticles).toBe(EMITTER_MAX_PARTICLES);
		expect(e.lifetime).toBe(0.5); // never "forever": a lifetime is a hard cap
		expect(e.spread).toBe(90);
		expect(e.mode).toBe('stream');
		expect(e.dir).toEqual([0, -1, 0]); // a zero direction is not a direction
		expect(e.color).toBe(EMITTER_DEFAULTS.color);
		expect(e.area.offset[1]).toBe(16);
		expect(e.particleSize).toBe(0.12);
		expect(normalizeEmitter(null).on).toBe(true);
	});
	it('the area is shrunk until its neighbour grid fits MAX_CELLS', () => {
		const e = normalizeEmitter({ particleSize: 0.025, area: { size: [16, 16, 16] } });
		const cell = 2 * e.particleSize;
		const cells = e.area.size.reduce((n, v) => n * Math.ceil(v / cell), 1);
		expect(cells).toBeLessThanOrEqual(MAX_CELLS);
		expect(e.area.size[0]).toBeLessThan(16);
		// a small area is left alone
		expect(fitArea([2, 2, 2], 0.05)).toEqual([2, 2, 2]);
	});
	it('the Quest tier caps the particles', () => {
		expect(capFor(normalizeEmitter({ maxParticles: 5000 }), true)).toBe(QUEST_EMITTER_CAP);
		expect(capFor(normalizeEmitter({ maxParticles: 300 }), true)).toBe(300);
		expect(capFor(normalizeEmitter({ maxParticles: 5000 }), false)).toBe(5000);
	});
	it('interaction modes', () => {
		expect(normalizeInteraction('float')).toBe('float');
		expect(normalizeInteraction('bogus')).toBe('auto');
		expect(normalizeInteraction(undefined)).toBe('auto');
	});
});

describe('release + nozzle', () => {
	it('rate × time, carried between frames, stopped by the cap and by Off', () => {
		const spec = normalizeEmitter({ rate: 90 });
		const acc = { carry: 0, released: 0 };
		let total = 0;
		for (let f = 0; f < 60; f++) total += releaseCount(spec, acc, 1 / 60, 0, 1e6);
		expect(total).toBe(90);
		expect(releaseCount(spec, { carry: 0.99, released: 0 }, 1, 95, 100)).toBe(5); // the cap
		expect(releaseCount(normalizeEmitter({ on: false }), { carry: 0, released: 0 }, 1, 0, 100)).toBe(0);
	});
	it('a burst releases its amount once', () => {
		const spec = normalizeEmitter({ mode: 'burst', amount: 120, rate: 3000 });
		const acc = { carry: 0, released: 0 };
		let total = 0;
		for (let f = 0; f < 120; f++) total += releaseCount(spec, acc, 1 / 60, 0, 1e6);
		expect(total).toBe(120);
	});
	it('directions stay inside the spread cone, speeds near the speed', () => {
		const b = nozzleBatch(400, [0, 0, 0], [0, -1, 0], 2, 10, 0.05, { seed: 3 });
		const cosMax = Math.cos((10 * Math.PI) / 180);
		for (let k = 0; k < b.length; k += 6) {
			const sp = Math.hypot(b[k + 3], b[k + 4], b[k + 5]);
			expect(sp).toBeGreaterThan(1.79);
			expect(sp).toBeLessThan(2.21);
			expect(-b[k + 4] / sp).toBeGreaterThanOrEqual(cosMax - 1e-6);
		}
		// zero spread = one direction
		const z = nozzleBatch(10, [0, 0, 0], [1, 0, 0], 1, 0, 0.05, { seed: 3 });
		for (let k = 0; k < z.length; k += 6) expect(z[k + 3] / Math.hypot(z[k + 3], z[k + 4], z[k + 5])).toBeCloseTo(1, 5);
	});
});

describe('hard caps in an open area (the solver as the runtime drives it)', () => {
	const area = { size: [1.6, 1.2, 1.6], offset: [0, 0, 0] };
	it('max particles: a fast stream never holds more than the cap', () => {
		const r = run({ rate: 2000, maxParticles: 300, lifetime: 600, area }, 180);
		expect(r.peak).toBeLessThanOrEqual(300);
		expect(r.s.count).toBeGreaterThan(280); // a splash off the open sides is the area cap at work
	});
	it('lifetime: with no other cap, the count settles at rate × lifetime', () => {
		const r = run({ rate: 120, maxParticles: 6000, lifetime: 1, area }, 240);
		expect(r.s.count).toBeLessThanOrEqual(122);
		expect(r.s.count).toBeGreaterThan(100);
		expect(r.s.expired).toBeGreaterThan(200);
	});
	it('area: with the floor off, water falls out of the box and is gone', () => {
		const r = run({ rate: 200, maxParticles: 6000, lifetime: 600, floor: false, area }, 180);
		expect(r.s.count).toBeLessThan(200); // ~0.5 s of falling stays inside, the rest left
		for (let i = 0; i < r.s.count; i++) expect(r.s.x[i * 3 + 1]).toBeGreaterThan(-0.6 - r.s.h - 1e-6);
	});
	it('the floor holds water: it pools at the bottom, inside the box', () => {
		// open sides: a puddle that spreads to the edge runs off (the area cap); what stays pools
		const r = run({ rate: 300, maxParticles: 800, lifetime: 600, area }, 240);
		expect(r.s.count).toBeGreaterThan(400);
		let low = 0;
		for (let i = 0; i < r.s.count; i++) if (r.s.x[i * 3 + 1] < -0.6 + 0.25) low++;
		expect(low / r.s.count).toBeGreaterThan(0.6);
		for (let i = 0; i < r.s.count; i++) expect(r.s.x[i * 3 + 1]).toBeGreaterThan(-0.6 - 1e-6);
	});
	it('a burst (spill) releases its amount and stops', () => {
		const r = run({ mode: 'burst', amount: 250, rate: 600, maxParticles: 6000, lifetime: 600, area }, 200);
		expect(r.acc.released).toBe(250);
		expect(r.peak).toBeGreaterThan(240);
		expect(r.peak).toBeLessThanOrEqual(250);
	});
	it('a sink (a pool) swallows what reaches it — counterfactual: no sink, it piles up', () => {
		const sinks = [{ min: [-0.8, -0.6, -0.8], max: [0.8, -0.3, 0.8] }];
		const r = run({ rate: 300, maxParticles: 6000, lifetime: 600, area }, 180, { sinks });
		const without = run({ rate: 300, maxParticles: 6000, lifetime: 600, area }, 180);
		expect(r.sunk).toBeGreaterThan(300);
		expect(r.s.count).toBeLessThan(without.s.count / 2);
	});
	it('a basin built from boxes holds the water poured into it', () => {
		// a 0.8 m basin of five slabs sitting on the floor, the stream lands in it
		const slab = (c, h) => ({ kind: 'box', center: c, half: h, quat: [0, 0, 0, 1] });
		const colliders = [
			slab([0, -0.58, 0], [0.4, 0.02, 0.4]),
			slab([0.4, -0.45, 0], [0.02, 0.15, 0.4]),
			slab([-0.4, -0.45, 0], [0.02, 0.15, 0.4]),
			slab([0, -0.45, 0.4], [0.4, 0.15, 0.02]),
			slab([0, -0.45, -0.4], [0.4, 0.15, 0.02])
		];
		const r = run({ rate: 200, maxParticles: 600, lifetime: 600, spread: 4, area: { size: [2, 1.2, 2], offset: [0, 0, 0] } }, 300, { colliders });
		let inside = 0;
		for (let i = 0; i < r.s.count; i++) {
			const x = r.s.x[i * 3], y = r.s.x[i * 3 + 1], z = r.s.x[i * 3 + 2];
			if (Math.abs(x) < 0.4 && Math.abs(z) < 0.4 && y > -0.57) inside++;
		}
		expect(inside / r.s.count).toBeGreaterThan(0.8);
	});
});

describe('puddles: friction + cohesion (an open fluid has no glass to hold it)', () => {
	const area = { size: [3, 2.4, 3], offset: [0, 0, 0] };
	/** mean neighbours + mean speed of what is left after pouring onto the floor */
	function puddle(friction, cohesion) {
		const r = run({ rate: 260, maxParticles: 1200, lifetime: 600, friction, cohesion, area }, 420);
		let nb = 0, sp = 0;
		for (let i = 0; i < r.s.count; i++) {
			nb += r.s.nbrCount[i];
			sp += Math.hypot(r.s.v[i * 3], r.s.v[i * 3 + 1], r.s.v[i * 3 + 2]);
		}
		return { n: r.s.count, nbr: nb / r.s.count, speed: sp / r.s.count };
	}
	it('with the defaults the water settles into a puddle — counterfactual: no friction, it sprays into loose drops and keeps skating', () => {
		const on = puddle(EMITTER_DEFAULTS.friction, EMITTER_DEFAULTS.cohesion);
		const off = puddle(0, 0);
		expect(on.nbr).toBeGreaterThan(12); // measured 15.3
		expect(on.speed).toBeLessThan(0.15); // measured 0.03
		expect(off.nbr).toBeLessThan(6); // measured 3.7
		expect(off.speed).toBeGreaterThan(0.5); // measured 1.05
	});
	it('a flow path is not slowed by the floor friction (particles in a tube are exempt)', () => {
		const spec = normalizeFlowPath({ points: [[-1.4, -1.15, 0], [1.4, -1.15, 0]], width: 0.6, depth: 0.25, speed: 1.5, strength: 6 });
		const flows = [compileFlow(spec, spec.points)];
		const r = run({ rate: 200, maxParticles: 600, lifetime: 600, friction: 0.3, spread: 3, dir: [0, -1, 0], area }, 240, { flows });
		let vx = 0, n = 0;
		for (let i = 0; i < r.s.count; i++)
			if (Math.abs(r.s.x[i * 3 + 2]) < 0.3 && r.s.x[i * 3 + 1] < -0.95) {
				vx += r.s.v[i * 3];
				n++;
			}
		expect(n).toBeGreaterThan(20);
		expect(vx / n).toBeGreaterThan(1.0); // close to the path speed (friction alone holds ~0.3×)
	});
});

describe('S3: one fluid budget for the whole scene', () => {
	const list = [
		{ uuid: 'a', maxParticles: 4000, cap: 4000 },
		{ uuid: 'b', maxParticles: 2000, cap: 2000 },
		{ uuid: 'c', maxParticles: 2000, cap: 2000 }
	];
	it('within budget every emitter gets its own max', () => {
		const l = budgetLimits(list, 9000, 0, false);
		expect([...l.values()]).toEqual([4000, 2000, 2000]);
	});
	it('over budget the budget is split in proportion, and the total never exceeds it', () => {
		const l = budgetLimits(list, 4000, 0, false);
		expect([...l.values()]).toEqual([2000, 1000, 1000]);
		expect([...l.values()].reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(4000);
	});
	it('the governor lowers it as frames drop (level 0 = all of it, never below a fifth)', () => {
		expect(governorFactor(0)).toBe(1);
		expect(governorFactor(4)).toBeLessThan(governorFactor(2));
		expect(governorFactor(99)).toBe(0.2);
		const full = [...budgetLimits(list, 8000, 0, false).values()].reduce((a, b) => a + b, 0);
		const stepped = [...budgetLimits(list, 8000, 5, false).values()].reduce((a, b) => a + b, 0);
		expect(stepped).toBeLessThan(full * 0.6);
	});
	it('a headset runs at most QUEST_FLUID_BUDGET whatever the scene allows', () => {
		const t = [...budgetLimits(list, 20000, 0, true).values()].reduce((a, b) => a + b, 0);
		expect(t).toBeLessThanOrEqual(QUEST_FLUID_BUDGET);
	});
	it('an absent budget is the default', () => {
		const t = [...budgetLimits([{ uuid: 'a', maxParticles: 6000, cap: 6000 }, { uuid: 'b', maxParticles: 6000, cap: 6000 }], undefined, 0, false).values()].reduce((a, b) => a + b, 0);
		expect(t).toBe(DEFAULT_FLUID_BUDGET);
	});
});
