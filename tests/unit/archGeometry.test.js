// @ts-nocheck — a fixture test: specs and pieces are asserted non-null by the checks themselves
// 37 R3: the parametric architecture primitives. The builders are pure three, so the shapes are
// checked here, and the claims that matter in play (a doorway you can walk through, a stair the
// walker can climb) are proven in a real rapier world with the same collider descs physics.js
// builds — each against a counterfactual that must fail.
import { describe, test, expect, beforeAll } from 'vitest';
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import {
	ARCH_SPECS,
	STAIR_SHAPES,
	archParams,
	cleanParams,
	wallOpenings,
	wallGeometry,
	doorGeometry,
	doorParts,
	windowGeometry,
	windowParts,
	staircaseGeometry,
	stairBoxes
} from '../../src/lib/arch/archGeometry.js';
import { GEOMETRY_PARAMS } from '../../src/lib/geometryParams.js';
import { colliderSpecOf } from '../../src/lib/colliderSpec.js';
import { colliderDescsFor } from '../../src/lib/colliderDescs.js';

beforeAll(async () => {
	await RAPIER.init();
});

/** every variant the catalog and the Inspector can reach, as [gtype, params] */
const VARIANTS = [
	['Wall', {}],
	['Wall', { doors: 1 }],
	['Wall', { doors: 1, windows: 2 }],
	['Wall', { length: 1, doors: 6, windows: 8 }],
	['Door', {}],
	['Door', { leaves: 'double', panes: 6, threshold: true, swing: 'out' }],
	['Door', { hinge: 'right', panes: 3 }],
	['Window', {}],
	['Window', { opening: 'casement', cols: 6, rows: 6, hinge: 'right' }],
	['Window', { sill: 0, ledge: true }],
	...STAIR_SHAPES.map((shape) => ['Staircase', { shape }]),
	...STAIR_SHAPES.map((shape) => ['Staircase', { shape, solid: false, turn: 'right', steps: 3 }]),
	['Staircase', { shape: 'U', steps: 40, gap: 1 }]
];

/** @param {THREE.BufferGeometry} g */
function bounds(g) {
	g.computeBoundingBox();
	return g.boundingBox;
}

/** @param {THREE.BufferGeometry} g */
function assertPlain(g) {
	expect(g.type).toBe('BufferGeometry');
	expect(g.index).toBeNull();
	expect(g.groups.length).toBe(0);
	expect(Object.keys(g.attributes).sort()).toEqual(['normal', 'position', 'uv']);
	const pos = g.attributes.position;
	expect(pos.count % 3).toBe(0);
	expect(pos.count).toBeGreaterThan(0);
	for (let i = 0; i < pos.array.length; i++) expect(Number.isFinite(pos.array[i])).toBe(true);
}

/** a mesh hit by a ray from `from` along `dir` within `far`? @param {THREE.BufferGeometry} g */
function hits(g, from, dir, far = 5) {
	const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
	mesh.updateMatrixWorld(true);
	const ray = new THREE.Raycaster(new THREE.Vector3(...from), new THREE.Vector3(...dir).normalize(), 0, far);
	return ray.intersectObject(mesh).length > 0;
}

describe('the specs', () => {
	test('all four are registered in GEOMETRY_PARAMS with a build hook and every order key a param', () => {
		for (const gtype of ['Wall', 'Door', 'Window', 'Staircase']) {
			const spec = GEOMETRY_PARAMS[gtype];
			expect(typeof spec.build).toBe('function');
			expect(typeof spec.fromArgs).toBe('function');
			expect(spec.order).toEqual(spec.params.map((p) => p.key));
		}
	});

	test('cleanParams is the wire boundary: clamps, rounds ints, refuses unknown choices, drops unknown keys', () => {
		const p = archParams('Staircase', { steps: 1e9, rise: -5, run: 'x', shape: 'helix', solid: 'yes', evil: 1 });
		expect(p.steps).toBe(40);
		expect(p.rise).toBe(0.1);
		expect(p.run).toBe(0.28); // not a number -> the default
		expect(p.shape).toBe('straight');
		expect(p.solid).toBe(true); // not a boolean -> the default
		expect('evil' in p).toBe(false);
		expect(archParams('Wall', { doors: 2.6 }).doors).toBe(3);
		expect(archParams('Nope', {})).toBeNull();
	});

	test('fromArgs maps the /create numbers to every variant the catalog offers', () => {
		const wall = ARCH_SPECS.Wall.fromArgs([4, 3, 0.25, 3]);
		expect(wall).toMatchObject({ length: 4, height: 3, thickness: 0.25, doors: 1, windows: 2 });
		expect(ARCH_SPECS.Wall.fromArgs([]).doors).toBe(0);
		expect(ARCH_SPECS.Door.fromArgs([1.6, 2.2, 1])).toMatchObject({ width: 1.6, height: 2.2, leaves: 'double' });
		expect(ARCH_SPECS.Window.fromArgs([1, 1, 1, 1]).opening).toBe('casement');
		expect(STAIR_SHAPES.map((_, i) => ARCH_SPECS.Staircase.fromArgs([i]).shape)).toEqual(STAIR_SHAPES);
		expect(ARCH_SPECS.Staircase.fromArgs([99]).shape).toBe('straight');
	});

	test('every Inspector `show` predicate answers for its own spec defaults', () => {
		for (const spec of Object.values(ARCH_SPECS)) {
			const defaults = cleanParams(spec.params, {});
			for (const p of spec.params) if (p.show) expect(typeof p.show(defaults)).toBe('boolean');
		}
	});
});

describe('the geometry', () => {
	test.each(VARIANTS)('%s %j is a plain, group-free, finite triangle soup', (gtype, params) => {
		assertPlain(ARCH_SPECS[gtype].build(params));
	});

	test('builds are deterministic (every peer rebuilds the same vertices from the params)', () => {
		for (const [gtype, params] of VARIANTS) {
			const a = ARCH_SPECS[gtype].build(params).attributes.position.array;
			const b = ARCH_SPECS[gtype].build(params).attributes.position.array;
			expect(Array.from(a)).toEqual(Array.from(b));
		}
	});

	test('a wall runs along +X from its origin, stands on the floor and is centred on its thickness', () => {
		const b = bounds(wallGeometry({ length: 5, height: 3, thickness: 0.3 }));
		expect(b.min.x).toBeCloseTo(0, 6);
		expect(b.max.x).toBeCloseTo(5, 6);
		expect(b.min.y).toBeCloseTo(0, 6);
		expect(b.max.y).toBeCloseTo(3, 6);
		expect(b.min.z).toBeCloseTo(-0.15, 6);
		expect(b.max.z).toBeCloseTo(0.15, 6);
	});

	test('openings centre on half metres, doors take the middle slots, and keep a pier', () => {
		expect(wallOpenings({ length: 4, doors: 1 })).toEqual([{ kind: 'door', cx: 2, x0: 1.5, x1: 2.5, y0: 0, y1: 2.1 }]);
		const three = wallOpenings({ length: 6, doors: 1, windows: 2 });
		expect(three.map((o) => o.kind)).toEqual(['window', 'door', 'window']);
		expect(three.map((o) => o.cx)).toEqual([1, 3, 5]);
		const crowded = wallOpenings({ length: 1, doors: 6, windows: 8 });
		for (const o of crowded) {
			expect(o.x0).toBeGreaterThanOrEqual(0.1 - 1e-9);
			expect(o.x1).toBeLessThanOrEqual(0.9 + 1e-9);
		}
		for (let i = 1; i < crowded.length; i++) expect(crowded[i].x0 - crowded[i - 1].x1).toBeGreaterThanOrEqual(0.1 - 1e-9);
		// an opening never reaches the top of the wall (a lintel stays)
		for (const o of wallOpenings({ height: 2, doors: 1, doorHeight: 4, windows: 1, sill: 3 })) expect(o.y1).toBeLessThanOrEqual(1.9 + 1e-9);
	});

	test('the openings are holes: a ray through each passes, a ray through the wall beside it does not', () => {
		const params = { length: 6, doors: 1, windows: 2 };
		const g = wallGeometry(params);
		for (const o of wallOpenings(params)) {
			const y = (o.y0 + o.y1) / 2;
			expect(hits(g, [o.cx, y, -1], [0, 0, 1])).toBe(false);
			expect(hits(g, [o.x0 - 0.05, y, -1], [0, 0, 1])).toBe(true);
		}
		// the counterfactual: the same rays hit a wall with no openings
		const solid = wallGeometry({ length: 6 });
		expect(hits(solid, [3, 1, -1], [0, 0, 1])).toBe(true);
	});

	test('a door frame fits the opening it is named for: outer width = width, the leaf fills the inside', () => {
		const b = bounds(doorGeometry({ width: 1, height: 2.1, depth: 0.2 }));
		expect(b.max.x - b.min.x).toBeCloseTo(1, 6);
		expect(b.max.y).toBeCloseTo(2.1, 6);
		expect(b.max.z - b.min.z).toBeCloseTo(0.2, 6);
		// nothing of the frame across the middle of the doorway
		expect(hits(doorGeometry({}), [0, 1, -1], [0, 0, 1])).toBe(false);
	});

	test('door leaves swing the way they say: in = toward -z, out = toward +z, for either hinge', () => {
		for (const hinge of ['left', 'right'])
			for (const swing of ['in', 'out']) {
				const [part] = doorParts({ hinge, swing, angle: 90 });
				const b = bounds(part.leaf);
				// the free edge, in the pivot frame, swung by the opening angle
				const freeX = hinge === 'left' ? b.max.x : b.min.x;
				const edge = new THREE.Vector3(freeX, 1, 0).applyAxisAngle(new THREE.Vector3(0, 1, 0), part.angle);
				if (swing === 'in') expect(edge.z).toBeLessThan(-0.5);
				else expect(edge.z).toBeGreaterThan(0.5);
				// the hinge sits on the jamb side the name says
				expect(Math.sign(part.pivot[0])).toBe(hinge === 'left' ? -1 : 1);
			}
	});

	test('a double door is two leaves meeting in the middle, glass split between them', () => {
		const parts = doorParts({ leaves: 'double', panes: 4, width: 2 });
		expect(parts.map((p) => p.name)).toEqual(['DoorLeafL', 'DoorLeafR']);
		expect(parts.every((p) => p.glass)).toBe(true);
		const reach = parts.map((p) => {
			const b = bounds(p.leaf);
			return p.pivot[0] + (p.name === 'DoorLeafL' ? b.max.x : b.min.x);
		});
		// handles stick out past the leaf faces, never past the meeting line
		expect(Math.abs(reach[0])).toBeLessThan(0.02);
		expect(Math.abs(reach[1])).toBeLessThan(0.02);
	});

	test('panes cut through the leaf: a ray through the glass misses the leaf body', () => {
		const [part] = doorParts({ panes: 1, width: 1, height: 2.1 });
		const glass = bounds(part.glass);
		const cx = (glass.min.x + glass.max.x) / 2;
		const cy = (glass.min.y + glass.max.y) / 2;
		expect(hits(part.leaf, [cx, cy, -1], [0, 0, 1])).toBe(false);
		expect(hits(part.glass, [cx, cy, -1], [0, 0, 1])).toBe(true);
	});

	test('a window sits at its sill height; a casement opens outward (+z)', () => {
		const b = bounds(windowGeometry({ sill: 1, height: 1.2, ledge: false }));
		expect(b.min.y).toBeCloseTo(1, 6);
		expect(b.max.y).toBeCloseTo(2.2, 6);
		for (const hinge of ['left', 'right']) {
			const part = windowParts({ opening: 'casement', hinge });
			const lb = bounds(part.leaf);
			const freeX = hinge === 'left' ? lb.max.x : lb.min.x;
			const edge = new THREE.Vector3(freeX, 1.5, 0).applyAxisAngle(new THREE.Vector3(0, 1, 0), part.angle);
			expect(edge.z).toBeGreaterThan(0.3);
		}
		expect(windowParts({}).angle).toBe(0);
		// the glass panes number cols x rows
		const glass = windowParts({ cols: 3, rows: 2 }).glass;
		expect(glass.attributes.position.count).toBe(3 * 2 * 36);
	});

	test('a straight stair climbs toward -z to steps x rise over steps x run', () => {
		const b = bounds(staircaseGeometry({ steps: 10, rise: 0.2, run: 0.3, width: 1 }));
		expect(b.max.y).toBeCloseTo(2, 6);
		expect(b.min.z).toBeCloseTo(-3, 6);
		expect(b.max.z).toBeCloseTo(0, 6);
		expect(b.max.x - b.min.x).toBeCloseTo(1, 6);
	});

	test('L and U turn toward the side asked for; the spiral reaches the full height round its column', () => {
		const left = bounds(staircaseGeometry({ shape: 'L', turn: 'left' }));
		const right = bounds(staircaseGeometry({ shape: 'L', turn: 'right' }));
		expect(left.min.x).toBeLessThan(-1);
		expect(left.max.x).toBeCloseTo(0.5, 6);
		expect(right.max.x).toBeGreaterThan(1);
		const u = stairBoxes({ shape: 'U', steps: 9, turn: 'right', gap: 0.2 });
		// the last step of the U comes back toward +z beside the first flight
		const last = u[u.length - 1];
		expect((last[0] + last[3]) / 2).toBeCloseTo(1.2, 6);
		expect(last[5]).toBeGreaterThan(-0.5);
		expect(Math.max(...u.map((s) => s[4]))).toBeCloseTo(9 * 0.18, 6);
		const spiral = bounds(staircaseGeometry({ shape: 'spiral', steps: 16, rise: 0.2, width: 1, core: 0.15 }));
		expect(spiral.max.y).toBeCloseTo(3.2, 6);
		expect(spiral.max.x).toBeLessThanOrEqual(1.15 + 1e-6);
		// every step's top is exactly one rise above the last (the walker's autostep relies on it)
		const tops = stairBoxes({ steps: 12, rise: 0.17 }).map((s) => s[4]);
		tops.forEach((t, i) => expect(t).toBeCloseTo((i + 1) * 0.17, 9));
	});

	test('too few steps for a turn degrade to a straight flight instead of a broken landing', () => {
		expect(stairBoxes({ shape: 'L', steps: 2 })).toEqual(stairBoxes({ shape: 'straight', steps: 2 }));
	});
});

/* ------------------------------------------------------------------ real rapier ------ */

/** a FIXED body the way physics.createBodyFor builds scenery @param {any} world @param {any} object @param {string} kind */
function scenery(world, object, kind) {
	object.updateMatrixWorld(true);
	const spec = colliderSpecOf(object, kind);
	const at = spec.pieces ? object.position : spec.center;
	const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(at.x, at.y, at.z));
	colliderDescsFor(RAPIER, spec, {
		origin: object.position.clone().sub(at),
		center: spec.center.clone().sub(at),
		relQuat: object.quaternion.clone()
	}).forEach((desc) => world.createCollider(desc, body));
	return spec;
}

/** @param {string} gtype @param {any} params */
function archMesh(gtype, params) {
	const mesh = new THREE.Mesh(ARCH_SPECS[gtype].build(params), new THREE.MeshBasicMaterial());
	mesh.name = gtype;
	mesh.userData.geometryParams = { gtype, params: archParams(gtype, params) };
	return mesh;
}

/** @param {any} world @param {number} seconds */
function run(world, seconds) {
	for (let i = 0; i < seconds * 60; i++) world.step();
}

describe('physics (real rapier)', () => {
	test('a ball rolls through a wall doorway on the trimesh — and a wall with no door stops it', () => {
		/** @param {number} doors */
		const roll = (doors) => {
			const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
			world.createCollider(RAPIER.ColliderDesc.cuboid(20, 0.1, 20).setTranslation(0, -0.1, 0));
			const wall = archMesh('Wall', { length: 4, doors });
			scenery(world, wall, 'trimesh');
			const ball = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(2, 0.3, -2).setLinvel(0, 0, 4).setCanSleep(false));
			world.createCollider(RAPIER.ColliderDesc.ball(0.3).setFriction(0), ball);
			run(world, 2);
			return ball.translation().z;
		};
		expect(roll(1)).toBeGreaterThan(2);
		expect(roll(0)).toBeLessThan(0);
	});

	test('the walker climbs a stair on its trimesh with the app’s autostep — and stops at a wall of the same height', () => {
		/** @param {any} object @returns {number} the highest the feet got walking toward -z */
		const climb = (object) => {
			const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
			world.createCollider(RAPIER.ColliderDesc.cuboid(20, 0.1, 20).setTranslation(0, -0.1, 0));
			scenery(world, object, 'trimesh');
			// charController's capsule and settings (enableAutostep 0.3 / 0.2, snap 0.3)
			const capsule = world.createCollider(RAPIER.ColliderDesc.capsule(0.55, 0.25).setSolverGroups(0).setTranslation(0, 0.82, 1));
			const controller = world.createCharacterController(0.02);
			controller.enableAutostep(0.3, 0.2, true);
			controller.enableSnapToGround(0.3);
			controller.setMaxSlopeClimbAngle((50 * Math.PI) / 180);
			controller.setMinSlopeSlideAngle((40 * Math.PI) / 180);
			let top = 0;
			// tickWalker's gravity: vy integrates, and a grounded frame zeroes it
			let vy = 0;
			const dt = 1 / 60;
			for (let i = 0; i < 400; i++) {
				vy -= 9.81 * dt;
				controller.computeColliderMovement(capsule, { x: 0, y: vy * dt, z: -0.04 });
				const m = controller.computedMovement();
				if (controller.computedGrounded() && vy < 0) vy = 0;
				const p = capsule.translation();
				capsule.setTranslation({ x: p.x + m.x, y: p.y + m.y, z: p.z + m.z });
				top = Math.max(top, p.y + m.y - 0.8);
				world.step();
			}
			return top;
		};
		const steps = 8;
		const rise = 0.18;
		const stair = archMesh('Staircase', { steps, rise, run: 0.3 });
		expect(climb(stair)).toBeGreaterThan(steps * rise - 0.1);
		const block = new THREE.Mesh(new THREE.BoxGeometry(1, steps * rise, 2.4).translate(0, (steps * rise) / 2, -1.2), new THREE.MeshBasicMaterial());
		expect(climb(block)).toBeLessThan(0.1);
	});
});
