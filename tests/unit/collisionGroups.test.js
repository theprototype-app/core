// @ts-nocheck — a fixture test against the real rapier API
// 36 X5: collision groups. The leaf's packing is checked against rapier's own rule,
// then three level-design cases run in a real rapier world, each with the
// counterfactual that shows the group is what made the difference: a GHOST WALL the
// walker's capsule passes and a crate does not, a PROJECTILE-ONLY barrier, and a
// WATER trigger a ball falls into (and that reports it) instead of landing on.
import { describe, test, expect, beforeAll } from 'vitest';
import RAPIER from '@dimforge/rapier3d-compat';
import {
	COLLISION_GROUPS,
	COLLIDES_WITH_GROUPS,
	ALL_FILTER,
	groupOf,
	filterOf,
	interactionGroups,
	playerInteractionGroups,
	groupsInteract,
	normalizeCollidesWith,
	isGroupId
} from '../../src/lib/collisionGroups.js';

beforeAll(async () => {
	await RAPIER.init();
});

describe('X5 packing', () => {
	test('six groups an object can be in, plus Player in the filter list', () => {
		expect(COLLISION_GROUPS.map((g) => g.id)).toEqual(['default', 'a', 'b', 'c', 'd', 'water']);
		expect(COLLIDES_WITH_GROUPS.at(-1).id).toBe('player');
		expect(isGroupId('player')).toBe(false); // nothing but the capsule is IN Player
	});

	test('groupOf: explicit pick, else water for a W1 volume, else default', () => {
		expect(groupOf({ group: 'b' }, null)).toBe('b');
		expect(groupOf(null, { version: 1 })).toBe('water');
		expect(groupOf({ group: 'a' }, { version: 1 })).toBe('a');
		expect(groupOf({ group: 'bogus' }, null)).toBe('default');
		expect(groupOf(undefined, undefined)).toBe('default');
	});

	test('filterOf: absent = everything; unknown ids ignored; empty = nothing', () => {
		expect(filterOf(undefined)).toBe(ALL_FILTER);
		expect(filterOf(null)).toBe(ALL_FILTER);
		expect(filterOf(['a', 'zzz'])).toBe(1 << 1);
		expect(filterOf([])).toBe(0);
	});

	test('the packed value is unsigned and agrees with rapier InteractionGroups semantics', () => {
		const v = interactionGroups('player');
		expect(v).toBeGreaterThan(0);
		expect(v >>> 16).toBe(1 << 6);
		const def = interactionGroups('default');
		const ghost = interactionGroups('a', ['default', 'a', 'b', 'c', 'd', 'water']);
		expect(groupsInteract(def, def)).toBe(true);
		expect(groupsInteract(ghost, def)).toBe(true); // crates still hit the ghost wall
		expect(groupsInteract(ghost, playerInteractionGroups())).toBe(false); // the player does not
		const barrier = interactionGroups('b', ['b']);
		expect(groupsInteract(barrier, def)).toBe(false);
		expect(groupsInteract(barrier, interactionGroups('b'))).toBe(true);
	});

	test('normalizeCollidesWith: everything stores as null, order is the catalogue', () => {
		expect(normalizeCollidesWith(COLLIDES_WITH_GROUPS.map((g) => g.id))).toBeNull();
		expect(normalizeCollidesWith(['player', 'a'])).toEqual(['a', 'player']);
		expect(normalizeCollidesWith('a')).toBeNull();
	});
});

/** @param {any} world @param {number[]} he @param {number[]} at @param {number} groups */
function wall(world, he, at, groups, sensor = false) {
	const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(at[0], at[1], at[2]));
	const desc = RAPIER.ColliderDesc.cuboid(he[0], he[1], he[2]).setCollisionGroups(groups);
	if (sensor) desc.setSensor(true).setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
	return world.createCollider(desc, body);
}

/** @param {any} world @param {number[]} at @param {number[]} vel @param {number} groups */
function ball(world, at, vel, groups) {
	const body = world.createRigidBody(
		RAPIER.RigidBodyDesc.dynamic().setTranslation(at[0], at[1], at[2]).setLinvel(vel[0], vel[1], vel[2]).setCanSleep(false)
	);
	world.createCollider(
		RAPIER.ColliderDesc.ball(0.2).setFriction(0).setCollisionGroups(groups).setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS),
		body
	);
	return body;
}

function floor(world) {
	world.createCollider(RAPIER.ColliderDesc.cuboid(50, 0.1, 50).setTranslation(0, -0.1, 0));
}

/** the walker exactly as charController builds and sweeps it @param {any} world */
function walk(world, steps = 90) {
	const capsule = world.createCollider(
		RAPIER.ColliderDesc.capsule(0.6, 0.3).setSolverGroups(0).setCollisionGroups(playerInteractionGroups()).setTranslation(0, 1, -3)
	);
	const controller = world.createCharacterController(0.02);
	for (let i = 0; i < steps; i++) {
		controller.computeColliderMovement(capsule, { x: 0, y: 0, z: 0.1 }, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, playerInteractionGroups());
		const m = controller.computedMovement();
		const t = capsule.translation();
		capsule.setTranslation({ x: t.x + m.x, y: t.y + m.y, z: t.z + m.z });
		world.step();
	}
	return capsule.translation().z;
}

const ghost = () => interactionGroups('a', ['default', 'a', 'b', 'c', 'd', 'water']); // everything but Player

describe('X5 in a real rapier world', () => {
	test('GHOST WALL: the walker passes, a crate is stopped; a default wall stops the walker', () => {
		const passes = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
		floor(passes);
		wall(passes, [2, 1.5, 0.1], [0, 1.5, 0], ghost());
		expect(walk(passes)).toBeGreaterThan(3);

		const blocks = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
		floor(blocks);
		wall(blocks, [2, 1.5, 0.1], [0, 1.5, 0], interactionGroups('default'));
		expect(walk(blocks)).toBeLessThan(0); // the counterfactual

		const crateWorld = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
		floor(crateWorld);
		wall(crateWorld, [2, 1.5, 0.1], [0, 1.5, 0], ghost());
		const crate = ball(crateWorld, [0, 0.25, -3], [0, 0, 5], interactionGroups('default'));
		for (let i = 0; i < 120; i++) crateWorld.step();
		expect(crate.translation().z).toBeLessThan(0); // props do not pass the ghost wall
	});

	test('PROJECTILE BARRIER: group B collides with B only — a default ball passes, a B ball is stopped', () => {
		/** @param {number} ballGroups */
		const run = (ballGroups) => {
			const world = new RAPIER.World({ x: 0, y: 0, z: 0 });
			wall(world, [2, 2, 0.1], [0, 1, 0], interactionGroups('b', ['b']));
			const b = ball(world, [0, 1, -3], [0, 0, 6], ballGroups);
			for (let i = 0; i < 90; i++) world.step();
			return b.translation().z;
		};
		expect(run(interactionGroups('default'))).toBeGreaterThan(2);
		expect(run(interactionGroups('b'))).toBeLessThan(0);
	});

	test('WATER TRIGGER: a ball falls INTO a water-group sensor and it reports the entry; a solid box catches it', () => {
		const water = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
		floor(water);
		const tank = wall(water, [1, 0.5, 1], [0, 0.5, 0], interactionGroups('water'), true);
		const b = ball(water, [0, 3, 0], [0, 0, 0], interactionGroups('default'));
		const queue = new RAPIER.EventQueue(true);
		let entered = false;
		for (let i = 0; i < 180; i++) {
			water.step(queue);
			queue.drainCollisionEvents((h1, h2, started) => {
				if (started && (h1 === tank.handle || h2 === tank.handle)) entered = true;
			});
		}
		expect(b.translation().y).toBeLessThan(0.3); // down to the floor, through the water box
		expect(entered).toBe(true);

		const solid = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
		floor(solid);
		wall(solid, [1, 0.5, 1], [0, 0.5, 0], interactionGroups('water'));
		const b2 = ball(solid, [0, 3, 0], [0, 0, 0], interactionGroups('default'));
		for (let i = 0; i < 180; i++) solid.step();
		expect(b2.translation().y).toBeGreaterThan(1); // the counterfactual: lands on the lid
	});

	test('a water trigger that leaves a group out of its filter does not report it', () => {
		const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
		floor(world);
		const tank = wall(world, [1, 0.5, 1], [0, 0.5, 0], interactionGroups('water', ['a']), true);
		ball(world, [0, 3, 0], [0, 0, 0], interactionGroups('default'));
		const queue = new RAPIER.EventQueue(true);
		let entered = false;
		for (let i = 0; i < 180; i++) {
			world.step(queue);
			queue.drainCollisionEvents((h1, h2, started) => {
				if (started && (h1 === tank.handle || h2 === tank.handle)) entered = true;
			});
		}
		expect(entered).toBe(false);
	});
});
