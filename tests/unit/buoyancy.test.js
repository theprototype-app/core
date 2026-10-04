// 36-sim I1: buoyancy — the maths, then HEADLESS PROOFS on a real rapier world through the
// same `applyBuoyancy` physics.js calls: a crate floats at the expected draft (±10%), a
// stone sinks, a ball in a river drifts downstream.
import { describe, it, expect, beforeAll } from 'vitest';
import RAPIER from '@dimforge/rapier3d-compat';
import {
	normalizeFloats,
	shapeSamples,
	bodySamples,
	buoyancyStep,
	buoyancyOut,
	applyBuoyancy,
	expectedDraft,
	FLOAT_PRESETS
} from '../../src/lib/sim/buoyancy.js';

beforeAll(async () => {
	const warn = console.warn;
	console.warn = () => {};
	await RAPIER.init();
	console.warn = warn;
});

/** a pool: surface y=0, floor y=-3, x/z in ±10; `flow` optional
 * @param {number[]} [flow] */
function pool(flow) {
	const vol = { id: 'pool' };
	return (/** @type {number} */ x, /** @type {number} */ y, /** @type {number} */ z) =>
		Math.abs(x) <= 10 && Math.abs(z) <= 10 && y >= -3 && y <= 0.5
			? { surfaceY: 0, flow: flow ?? null, density: 1000, linearDrag: 1, angularDrag: 1, volume: vol }
			: null;
}

/**
 * Run one body in a pool for `seconds` at 60 Hz through applyBuoyancy.
 * @param {{kind: 'box'|'sphere', he: {x:number,y:number,z:number}, mass: number, at: number[],
 *   floats?: any, flow?: number[], seconds?: number, rot?: number[]}} o
 */
function run(o) {
	const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
	world.timestep = 1 / 60;
	// pool floor so a sinker comes to rest
	world.createCollider(RAPIER.ColliderDesc.cuboid(20, 0.1, 20).setTranslation(0, -3.1, 0));
	const desc = RAPIER.RigidBodyDesc.dynamic().setCanSleep(false).setTranslation(o.at[0], o.at[1], o.at[2]);
	if (o.rot) desc.setRotation({ x: o.rot[0], y: o.rot[1], z: o.rot[2], w: o.rot[3] });
	const body = world.createRigidBody(desc);
	const cd = o.kind === 'sphere' ? RAPIER.ColliderDesc.ball(o.he.x) : RAPIER.ColliderDesc.cuboid(o.he.x, o.he.y, o.he.z);
	world.createCollider(cd.setMass(o.mass), body);
	const samples = bodySamples([{ kind: o.kind, he: o.he, t: [0, 0, 0], q: [0, 0, 0, 1] }]);
	const floats = normalizeFloats(o.floats);
	const query = pool(o.flow);
	const out = buoyancyOut();
	/** @type {number[]} */ const ys = [];
	const steps = Math.round((o.seconds ?? 10) * 60);
	for (let i = 0; i < steps; i++) {
		applyBuoyancy(body, samples, query, floats, -9.81, 1 / 60, out);
		world.step();
		ys.push(body.translation().y);
	}
	const t = body.translation();
	return { pos: [t.x, t.y, t.z], ys, body, world };
}

describe('normalizeFloats', () => {
	it('defaults, clamps and drops garbage', () => {
		expect(normalizeFloats(undefined)).toEqual({ off: false, density: 500, multiplier: 1 });
		expect(normalizeFloats({ density: 1e9, multiplier: -3 })).toEqual({ off: false, density: 20000, multiplier: 0 });
		expect(normalizeFloats({ density: 'mass', off: true })).toEqual({ off: true, density: 'mass', multiplier: 1 });
		expect(normalizeFloats({ density: 'lots', multiplier: NaN, evil: 1 })).toEqual({ off: false, density: 500, multiplier: 1 });
	});
});

describe('shapeSamples', () => {
	it('fills each shape and carries its analytic volume', () => {
		const box = shapeSamples('box', { x: 0.5, y: 0.5, z: 0.5 });
		expect(box.points.length / 3).toBe(27);
		expect(box.volume).toBeCloseTo(1, 6);
		const ball = shapeSamples('sphere', { x: 0.5, y: 0.5, z: 0.5 });
		expect(ball.volume).toBeCloseTo((4 / 3) * Math.PI * 0.125, 6);
		for (let i = 0; i < ball.points.length; i += 3)
			expect(Math.hypot(ball.points[i], ball.points[i + 1], ball.points[i + 2])).toBeLessThanOrEqual(0.5);
		const cyl = shapeSamples('cylinder', { x: 0.3, y: 1, z: 0.3 });
		expect(cyl.volume).toBeCloseTo(Math.PI * 0.09 * 2, 6);
	});
	it('body samples rotate into the body frame and weights sum to 1', () => {
		const s = bodySamples([
			{ kind: 'box', he: { x: 1, y: 0.1, z: 0.1 }, t: [0, 2, 0], q: [0, 0, Math.SQRT1_2, Math.SQRT1_2] }
		]);
		let sum = 0;
		for (const w of s.weights) sum += w;
		expect(sum).toBeCloseTo(1, 5);
		// a long X plank rotated 90 degrees about Z stands along Y around y=2
		let maxY = -Infinity;
		for (let i = 1; i < s.points.length; i += 3) maxY = Math.max(maxY, s.points[i]);
		expect(maxY).toBeGreaterThan(2.5);
	});
});

describe('buoyancyStep', () => {
	it('no water, no force; fully submerged = weight x density ratio', () => {
		const samples = bodySamples([{ kind: 'box', he: { x: 0.5, y: 0.5, z: 0.5 }, t: [0, 0, 0], q: [0, 0, 0, 1] }]);
		const out = buoyancyOut();
		const body = { pos: [0, 50, 0], quat: [0, 0, 0, 1], com: [0, 50, 0], linvel: [0, 0, 0], angvel: [0, 0, 0], mass: 2, gravity: -10, dt: 1 };
		expect(buoyancyStep(body, samples, pool(), normalizeFloats({}), out)).toBe(false);
		body.pos = [0, -2, 0];
		body.com = [0, -2, 0];
		expect(buoyancyStep(body, samples, pool(), normalizeFloats({ density: 250 }), out)).toBe(true);
		expect(out.submerged).toBeCloseTo(1, 5);
		expect(out.impulse[1]).toBeCloseTo(2 * 10 * (1000 / 250), 3); // m g rho_w/rho_b
		// symmetric body, upright: no torque
		expect(Math.abs(out.torque[0]) + Math.abs(out.torque[2])).toBeLessThan(1e-6);
	});
	it('off means off', () => {
		const samples = bodySamples([{ kind: 'box', he: { x: 0.5, y: 0.5, z: 0.5 }, t: [0, 0, 0], q: [0, 0, 0, 1] }]);
		const out = buoyancyOut();
		const body = { pos: [0, -2, 0], quat: [0, 0, 0, 1], com: [0, -2, 0], linvel: [0, 0, 0], angvel: [0, 0, 0], mass: 2, gravity: -10, dt: 1 };
		expect(buoyancyStep(body, samples, pool(), normalizeFloats({ off: true }), out)).toBe(false);
	});
});

describe('headless proofs on rapier', () => {
	it('a wooden crate floats at the expected draft (±10%)', () => {
		const h = 1;
		const { pos, ys } = run({ kind: 'box', he: { x: 0.5, y: 0.5, z: 0.5 }, mass: 30, at: [0, 2, 0], floats: { density: FLOAT_PRESETS.wood }, seconds: 12 });
		const draft = 0.5 - pos[1]; // the bottom face sits at y - 0.5
		const want = /** @type {number} */ (expectedDraft(h, FLOAT_PRESETS.wood));
		expect(want).toBeCloseTo(0.6, 6);
		expect(Math.abs(draft - want) / want).toBeLessThan(0.1);
		// settled: the last second barely moves
		const tail = ys.slice(-60);
		expect(Math.max(...tail) - Math.min(...tail)).toBeLessThan(0.02);
	});
	it('the draft does not depend on mass (1 kg and 30 kg of wood sit equally deep)', () => {
		const a = run({ kind: 'box', he: { x: 0.5, y: 0.5, z: 0.5 }, mass: 1, at: [0, 1, 0], floats: { density: 600 } });
		const b = run({ kind: 'box', he: { x: 0.5, y: 0.5, z: 0.5 }, mass: 30, at: [0, 1, 0], floats: { density: 600 } });
		expect(Math.abs(a.pos[1] - b.pos[1])).toBeLessThan(0.03);
	});
	it('a foam block rides higher than a default one', () => {
		const foam = run({ kind: 'box', he: { x: 0.5, y: 0.5, z: 0.5 }, mass: 1, at: [0, 1, 0], floats: { density: FLOAT_PRESETS.foam } });
		const auto = run({ kind: 'box', he: { x: 0.5, y: 0.5, z: 0.5 }, mass: 1, at: [0, 1, 0] });
		expect(foam.pos[1]).toBeGreaterThan(auto.pos[1] + 0.2);
		expect(Math.abs(0.5 - auto.pos[1] - 0.5) / 0.5).toBeLessThan(0.1); // default 500 -> half under
	});
	it('a stone sinks to the floor', () => {
		const { pos } = run({ kind: 'sphere', he: { x: 0.3, y: 0.3, z: 0.3 }, mass: 5, at: [0, 1, 0], floats: { density: FLOAT_PRESETS.stone }, seconds: 8 });
		expect(pos[1]).toBeLessThan(-2.6); // resting on the floor at -3 (+ radius 0.3)
	});
	it('a stone sinks SLOWER than it falls in air (drag + buoyancy act)', () => {
		const wet = run({ kind: 'sphere', he: { x: 0.3, y: 0.3, z: 0.3 }, mass: 5, at: [0, -0.5, 0], floats: { density: 2500 }, seconds: 0.5 });
		const dry = run({ kind: 'sphere', he: { x: 0.3, y: 0.3, z: 0.3 }, mass: 5, at: [0, -0.5, 0], floats: { off: true }, seconds: 0.5 });
		expect(wet.pos[1]).toBeGreaterThan(dry.pos[1] + 0.3);
	});
	it('a ball in a river drifts downstream', () => {
		const { pos } = run({ kind: 'sphere', he: { x: 0.25, y: 0.25, z: 0.25 }, mass: 1, at: [0, 0.5, 0], flow: [1.5, 0, 0], seconds: 4 });
		expect(pos[0]).toBeGreaterThan(3); // close to 1.5 m/s once it has caught the flow
		expect(Math.abs(pos[2])).toBeLessThan(0.05);
		expect(pos[1]).toBeGreaterThan(-0.3); // still floating
	});
	it('a tipped crate rights itself (forces at the samples make torque)', () => {
		const s = Math.sin(Math.PI / 8);
		const { body } = run({ kind: 'box', he: { x: 1, y: 0.2, z: 1 }, mass: 10, at: [0, 0.3, 0], rot: [s, 0, 0, Math.cos(Math.PI / 8)], floats: { density: 400 }, seconds: 10 });
		const r = body.rotation();
		// back to flat: the local up axis points up again
		const upY = 1 - 2 * (r.x * r.x + r.z * r.z);
		expect(upY).toBeGreaterThan(0.99);
	});
	it('out of the water nothing changes (falls exactly like without buoyancy)', () => {
		const a = run({ kind: 'box', he: { x: 0.5, y: 0.5, z: 0.5 }, mass: 1, at: [30, 10, 0], seconds: 0.5 });
		const b = run({ kind: 'box', he: { x: 0.5, y: 0.5, z: 0.5 }, mass: 1, at: [30, 10, 0], floats: { off: true }, seconds: 0.5 });
		expect(a.pos[1]).toBe(b.pos[1]);
	});
});
