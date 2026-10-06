// @ts-nocheck — plain fixtures (rapier + W1 stand-ins); the modules under test are typed
// 36-fb-water F12: the scene ground with holes where water goes below it. The maths, then the
// HEADLESS PROOF of the reported bug on a real rapier world (Pool party's shape: a pool sunk into
// the ground, surface at the ground height): with the classic one-slab ground a body placed under
// the water rises into the slab's underside and stays there; with the holes it surfaces and
// floats, and a heavy one still comes to rest on the hole's floor.
import { describe, it, expect, beforeAll } from 'vitest';
import RAPIER from '@dimforge/rapier3d-compat';
import { waterHoles, groundSlabs, holesKey, GROUND_HALF, GROUND_THICK } from '../../src/lib/sim/groundHoles.js';
import { bodySamples, applyBuoyancy, buoyancyOut, normalizeFloats } from '../../src/lib/sim/buoyancy.js';

beforeAll(async () => {
	const warn = console.warn;
	console.warn = () => {};
	await RAPIER.init();
	console.warn = warn;
});

/** column-major translation(+uniform scale) matrix */
const mat = (tx, ty, tz, s = 1) => ({ elements: [s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, tx, ty, tz, 1] });
/** a W1-shaped volume: local bounds ±hx/±hy/±hz around an object at (tx,ty,tz) */
const volume = (shape, [tx, ty, tz], [hx, hy, hz], level) => ({
	shape,
	bounds: { minX: -hx, maxX: hx, minY: -hy, maxY: hy, minZ: -hz, maxZ: hz },
	level: level ?? hy,
	object: { matrixWorld: mat(tx, ty, tz) }
});
// Pool party: water box 8.2 x 1.6 x 5.2 centred at y -0.8 (surface 0, bottom -1.6)
const POOL = volume('box', [0, -0.8, 0], [4.1, 0.8, 2.6]);

const area = (slabs) => slabs.reduce((s, b) => s + 4 * b.hx * b.hz, 0);

describe('waterHoles', () => {
	it('a sunk pool cuts its footprint, with a floor at its bottom', () => {
		const [h] = waterHoles([POOL], 0);
		expect(h.minX).toBeCloseTo(-4.1);
		expect(h.maxX).toBeCloseTo(4.1);
		expect(h.minZ).toBeCloseTo(-2.6);
		expect(h.maxZ).toBeCloseTo(2.6);
		expect(h.floorY).toBeCloseTo(-1.6);
	});
	it('a tank standing ON the ground leaves the ground whole', () => {
		expect(waterHoles([volume('box', [0, 0.6, 0], [1, 0.6, 0.5])], 0)).toEqual([]);
	});
	it('a tank buried well under the ground is left alone (a lid there is the author\'s)', () => {
		expect(waterHoles([volume('box', [0, -5, 0], [1, 0.5, 1])], 0)).toEqual([]);
	});
	it('an ocean (plane) cuts with no floor', () => {
		const [h] = waterHoles([volume('plane', [0, -3, 0], [40, 3, 40])], 0);
		expect(h.floorY).toBeNull();
	});
	it('a rotated volume cuts its world AABB; level below the top is respected', () => {
		const c = Math.cos(Math.PI / 4), s = Math.sin(Math.PI / 4);
		const v = { ...POOL, object: { matrixWorld: { elements: [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, -0.8, 0, 1] } } };
		const [h] = waterHoles([v], 0);
		expect(h.maxX).toBeCloseTo((4.1 + 2.6) * c, 3);
		// a level well below the top: surface at world -1.3, under the slab — buried, no hole
		expect(waterHoles([{ ...POOL, level: -0.5 }], 0)).toHaveLength(0);
	});
});

describe('groundSlabs', () => {
	it('no holes = the one classic slab', () => {
		expect(groundSlabs(0, [])).toEqual([{ cx: 0, cz: 0, hx: GROUND_HALF, hz: GROUND_HALF, top: 0 }]);
	});
	it('one hole: the square minus the hole, plus a floor', () => {
		const holes = waterHoles([POOL], 0);
		const slabs = groundSlabs(0, holes);
		const ground = slabs.filter((b) => b.top === 0);
		const floor = slabs.filter((b) => b.top !== 0);
		expect(area(ground)).toBeCloseTo((2 * GROUND_HALF) ** 2 - 8.2 * 5.2, 3);
		expect(floor).toHaveLength(1);
		expect(floor[0].top).toBeCloseTo(-1.6);
		// nothing of the ground covers the hole's interior
		for (const b of ground) {
			const overlapX = Math.min(b.cx + b.hx, 4.1) - Math.max(b.cx - b.hx, -4.1);
			const overlapZ = Math.min(b.cz + b.hz, 2.6) - Math.max(b.cz - b.hz, -2.6);
			expect(overlapX > 1e-6 && overlapZ > 1e-6).toBe(false);
		}
		expect(ground.length).toBeLessThanOrEqual(4); // merged strips, not a cell soup
	});
	it('two overlapping holes still tile the rest exactly', () => {
		const holes = [
			{ minX: -2, maxX: 2, minZ: -2, maxZ: 2, floorY: null },
			{ minX: 1, maxX: 5, minZ: 1, maxZ: 5, floorY: null }
		];
		const ground = groundSlabs(0, holes);
		expect(area(ground)).toBeCloseTo((2 * GROUND_HALF) ** 2 - (16 + 16 - 1), 3);
	});
	it('holesKey changes when a hole moves and not otherwise', () => {
		const a = holesKey(waterHoles([POOL], 0));
		expect(holesKey(waterHoles([POOL], 0))).toBe(a);
		expect(holesKey(waterHoles([volume('box', [1, -0.8, 0], [4.1, 0.8, 2.6])], 0))).not.toBe(a);
	});
});

/** W1-semantics query for POOL: surface 0, bottom -1.6 */
const poolQuery = (x, y, z) =>
	Math.abs(x) <= 4.1 && Math.abs(z) <= 2.6 && y >= -1.6 && y <= 0
		? { surfaceY: 0, flow: null, density: 1000, linearDrag: 1.5, angularDrag: 1, volume: POOL }
		: null;

/** a 0.5 m box placed UNDER the water; returns its y after `seconds` */
function submerged({ holes, density, seconds = 6 }) {
	const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
	world.timestep = 1 / 60;
	for (const s of groundSlabs(0, holes ? waterHoles([POOL], 0) : []))
		world.createCollider(RAPIER.ColliderDesc.cuboid(s.hx, GROUND_THICK / 2, s.hz).setTranslation(s.cx, s.top - GROUND_THICK / 2, s.cz));
	const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setCanSleep(false).setTranslation(0, -1.2, 0));
	world.createCollider(RAPIER.ColliderDesc.cuboid(0.25, 0.25, 0.25).setMass(1), body);
	const samples = bodySamples([{ kind: 'box', he: { x: 0.25, y: 0.25, z: 0.25 }, t: [0, 0, 0], q: [0, 0, 0, 1] }]);
	const floats = normalizeFloats({ density });
	const out = buoyancyOut();
	let maxY = -Infinity;
	for (let i = 0; i < seconds * 60; i++) {
		applyBuoyancy(body, samples, poolQuery, floats, -9.81, 1 / 60, out);
		world.step();
		maxY = Math.max(maxY, body.translation().y);
	}
	return { y: body.translation().y, maxY };
}

describe('F12 proof on rapier: a body placed under the water', () => {
	it('COUNTERFACTUAL: the classic slab is a lid — a light body sticks under it (the report)', () => {
		const { y } = submerged({ holes: false, density: 500 });
		expect(y).toBeCloseTo(-0.45, 1); // slab bottom -0.2 minus the half height
	});
	it('with holes a light body surfaces and floats at its draft', () => {
		const { y } = submerged({ holes: true, density: 500 });
		expect(y).toBeGreaterThan(-0.08); // draft 0.25 -> centre at 0
		expect(y).toBeLessThan(0.08);
	});
	it('foam shoots up past the surface before it settles (it bobs)', () => {
		const { y, maxY } = submerged({ holes: true, density: 150 });
		expect(maxY).toBeGreaterThan(y + 0.02);
		expect(y).toBeGreaterThan(0.1); // floats high: 15% under
	});
	it('a heavy body sinks to the hole floor (no pool floor collider needed)', () => {
		const { y } = submerged({ holes: true, density: 2500 });
		expect(y).toBeCloseTo(-1.35, 1);
	});
});
