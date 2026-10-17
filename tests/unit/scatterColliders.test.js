// @ts-nocheck — a fixture test: shapes/bodies are asserted non-null by the checks themselves
// 48 B1: colliders for scatter sets. The data half (terrainScatterCore) is pure; the physics
// half builds the SAME descs physics.js builds (scatterColliders) into a real headless rapier
// world, so "a ball stops on a scattered rock" is a ball dropped onto one — with `none` as the
// counterfactual that lets it fall to the ground.
import { describe, test, expect, beforeAll } from 'vitest';
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { normalizeScatter, scatterColliderOf, encodeInstances, SCATTER_COLLIDERS } from '../../src/lib/terrainScatterCore.js';
import { scatterShapeOf, scatterColliderDescs, terrainScatterDescs, HULL_MAX_POINTS } from '../../src/lib/scatterColliders.js';

beforeAll(async () => {
	await RAPIER.init();
});

const BOUNDS = { minX: -10, minZ: -10, sizeX: 20, sizeZ: 20 };
const b64 = (/** @type {Uint8Array} */ u) => Buffer.from(u).toString('base64');
const unb64 = (/** @type {string} */ s) => new Uint8Array(Buffer.from(s, 'base64'));

/** a rock the way terrainSurface builds a primitive part: base at y 0 */
function rockParts() {
	const geometry = new THREE.DodecahedronGeometry(0.5);
	geometry.computeBoundingBox();
	geometry.translate(0, -geometry.boundingBox.min.y, 0);
	return [{ geometry }];
}

/** @param {number} x @param {number} z @param {number} scale @param {number} [yaw] */
function at(x, z, scale, yaw = 0) {
	return new THREE.Matrix4().compose(new THREE.Vector3(x, 0, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw), new THREE.Vector3(scale, scale, scale));
}

/** a world with a ground slab (top at y 0) + the scatter descs on one fixed body */
function worldWith(descs) {
	const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
	world.createCollider(RAPIER.ColliderDesc.cuboid(50, 0.1, 50).setTranslation(0, -0.1, 0));
	const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
	descs.forEach((d) => world.createCollider(d, body));
	return world;
}

/** drop a ball over (x, z) and let it settle; returns its resting height */
function dropBall(world, x, z, r = 0.15) {
	const ball = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(x, 4, z).setCanSleep(false));
	world.createCollider(RAPIER.ColliderDesc.ball(r).setFriction(1).setRestitution(0), ball);
	for (let i = 0; i < 240; i++) world.step();
	return ball.translation();
}

describe('B1 data — the set field', () => {
	const data = b64(encodeInstances([{ x: 0, z: 0, yaw: 0, scale: 1 }], BOUNDS));
	const set = (/** @type {any} */ extra) => ({ id: 'p:Dodecahedron', source: { kind: 'primitive', type: 'Dodecahedron' }, align: false, data, ...extra });

	test('a known collider survives normalize; none / unknown are never written', () => {
		expect(SCATTER_COLLIDERS).toEqual(['none', 'box', 'sphere', 'hull']);
		for (const kind of ['box', 'sphere', 'hull']) expect(normalizeScatter({ v: 1, sets: [set({ collider: kind })] }, unb64).sets[0].collider).toBe(kind);
		for (const bad of ['none', 'trimesh', 42, null, undefined]) {
			const out = normalizeScatter({ v: 1, sets: [set({ collider: bad })] }, unb64).sets[0];
			expect('collider' in out).toBe(false);
		}
		expect(scatterColliderOf('mesh')).toBe('none');
	});

	test('an old (47) set normalizes byte-identically — no collider key appears', () => {
		const old = normalizeScatter({ v: 1, sets: [set({})] }, unb64);
		expect(JSON.stringify(old)).toBe(JSON.stringify({ v: 1, sets: [{ id: 'p:Dodecahedron', source: { kind: 'primitive', type: 'Dodecahedron' }, align: false, data, count: 1 }] }));
	});
});

describe('B1 shapes', () => {
	test('box = the part AABB, sphere reaches the farthest vertex, hull keeps a few points', () => {
		const parts = rockParts();
		const box = scatterShapeOf(parts, 'box');
		const bb = parts[0].geometry.boundingBox;
		expect(box.kind).toBe('box');
		expect(box.half[1] * 2).toBeCloseTo(bb.max.y - bb.min.y, 5);
		expect(box.center[1]).toBeCloseTo((bb.max.y + bb.min.y) / 2, 5);
		const sphere = scatterShapeOf(parts, 'sphere');
		expect(sphere.radius).toBeGreaterThanOrEqual(box.half[1] - 1e-6);
		expect(sphere.radius).toBeLessThan(0.6);
		const hull = scatterShapeOf(parts, 'hull');
		expect(hull.kind).toBe('hull');
		const n = hull.hull.length / 3;
		expect(n).toBeGreaterThanOrEqual(4);
		expect(n).toBeLessThanOrEqual(HULL_MAX_POINTS);
		// a dodecahedron's hull IS its 20 corners (the duplicated soup collapses)
		expect(n).toBe(20);
	});

	test('a flat part cannot hull — it degrades to its box, never to nothing', () => {
		const plane = new THREE.PlaneGeometry(1, 1);
		const shape = scatterShapeOf([{ geometry: plane }], 'hull');
		expect(shape.kind).toBe('box');
		expect(scatterColliderDescs(RAPIER, shape, [at(0, 0, 1)]).length).toBe(1);
	});
});

describe('B1 a ball stops on a scattered rock', () => {
	const ROCK_X = 2;
	const ROCK_Z = -1;
	const SCALE = 2;
	for (const kind of ['box', 'sphere', 'hull']) {
		test(`${kind}: the ball rests on the rock, not on the ground`, () => {
			const sets = [{ collider: kind, parts: rockParts(), matrices: [at(ROCK_X, ROCK_Z, SCALE, 0.7)] }];
			const descs = terrainScatterDescs(RAPIER, sets, new THREE.Matrix4());
			expect(descs.length).toBe(1);
			const p = dropBall(worldWith(descs), ROCK_X, ROCK_Z);
			// the rock is ~1.6 m tall at scale 2; the ground ball would rest at its radius 0.15
			expect(p.y).toBeGreaterThan(1.2);
			expect(p.y).toBeLessThan(2.3);
		});
	}

	test('COUNTERFACTUAL: with no collider the same ball falls through the rock to the ground', () => {
		const p = dropBall(worldWith([]), ROCK_X, ROCK_Z);
		expect(p.y).toBeLessThan(0.2);
	});

	test('the terrain world matrix places the colliders (a raised, moved terrain)', () => {
		const terrain = new THREE.Matrix4().makeTranslation(5, 1, 0);
		const sets = [{ collider: 'box', parts: rockParts(), matrices: [at(0, 0, 1)] }];
		const descs = terrainScatterDescs(RAPIER, sets, terrain);
		const world = worldWith(descs);
		const p = dropBall(world, 5, 0);
		expect(p.y).toBeGreaterThan(1 + 0.7); // terrain at y 1 + a ~0.8 m rock
		const miss = dropBall(world, 0, 0);
		expect(miss.y).toBeLessThan(0.2);
	});
});

describe('B1 perf note — 2,000 instances', () => {
	test('building + stepping stays cheap (numbers printed for STATUS)', () => {
		const rng = (() => {
			let a = 7;
			return () => ((a = (a * 16807) % 2147483647) / 2147483647);
		})();
		const matrices = Array.from({ length: 2000 }, () => at(rng() * 90 - 45, rng() * 90 - 45, 0.6 + rng(), rng() * 6.28));
		const report = {};
		for (const kind of ['box', 'sphere', 'hull']) {
			const t0 = performance.now();
			const descs = terrainScatterDescs(RAPIER, [{ collider: kind, parts: rockParts(), matrices }], new THREE.Matrix4());
			const world = worldWith(descs);
			const built = performance.now() - t0;
			// 20 balls rolling about among them
			for (let i = 0; i < 20; i++) dropBall(world, rng() * 40 - 20, rng() * 40 - 20).y;
			const t1 = performance.now();
			for (let i = 0; i < 120; i++) world.step();
			const stepMs = (performance.now() - t1) / 120;
			report[kind] = { colliders: descs.length, buildMs: +built.toFixed(1), stepMs: +stepMs.toFixed(3) };
			expect(descs.length).toBe(2000);
			world.free();
		}
		console.log('48 B1 scatter collider perf (headless node, 2000 instances, 20 balls):', JSON.stringify(report));
		// generous ceilings: a regression to a per-instance full-model hull would blow these
		expect(report.hull.buildMs).toBeLessThan(3000);
		expect(report.box.stepMs).toBeLessThan(20);
	}, 60000); // ~1.7 s alone; a loaded box (the full run, e2e beside it) needs the room
});
