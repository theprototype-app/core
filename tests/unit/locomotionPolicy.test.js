import { describe, it, expect } from 'vitest';
import {
	locomotionPolicy,
	normalizeLocomotion,
	normalizeSpawn,
	yawForward,
	yawOf,
	vrSpawnOffsets
} from '../../src/lib/locomotionPolicy.js';

// 30b P3/P4: who may fly or teleport, and the VR spawn as WebXR offsets.

describe('locomotionPolicy', () => {
	it('Edit keeps the editor movement: fly, teleport, the world gestures, no walls', () => {
		expect(locomotionPolicy('edit', null)).toEqual({
			walk: false, fly: true, teleport: true, collide: false, gravity: false, worldGestures: true
		});
		// a play block never narrows the EDITOR
		expect(locomotionPolicy('edit', { teleport: false, fly: false }).teleport).toBe(true);
	});
	it('Interact walks with walls and gravity; no fly or teleport by default', () => {
		expect(locomotionPolicy('interact', null)).toEqual({
			walk: true, fly: false, teleport: false, collide: true, gravity: true, worldGestures: false
		});
		expect(locomotionPolicy('interact', {})).toEqual(locomotionPolicy('interact', null));
	});
	it('a play block can allow teleport and fly in Interact (fly drops gravity, keeps walls)', () => {
		const p = locomotionPolicy('interact', { teleport: true, fly: true });
		expect(p.teleport).toBe(true);
		expect(p.fly).toBe(true);
		expect(p.gravity).toBe(false);
		expect(p.collide).toBe(true);
		expect(p.worldGestures).toBe(false);
	});
	it('only a literal true allows (truthy strings do not)', () => {
		expect(locomotionPolicy('interact', /** @type {any} */ ({ teleport: 'yes', fly: 1 })).teleport).toBe(false);
	});
});

describe('normalizeLocomotion', () => {
	it('keeps booleans only; an empty block is absent', () => {
		expect(normalizeLocomotion({ teleport: true, fly: 'x', other: 1 })).toEqual({ teleport: true });
		expect(normalizeLocomotion({ fly: false })).toEqual({ fly: false });
		expect(normalizeLocomotion({})).toBe(null);
		expect(normalizeLocomotion(null)).toBe(null);
		expect(normalizeLocomotion('fly')).toBe(null);
	});
});

describe('normalizeSpawn', () => {
	it('takes the stored shape and the api pair', () => {
		expect(normalizeSpawn({ position: [1, 0, -2], yaw: 1.5 })).toEqual({ position: [1, 0, -2], yaw: 1.5 });
		expect(normalizeSpawn([1, 0.5, -2], 0.25)).toEqual({ position: [1, 0.5, -2], yaw: 0.25 });
		expect(normalizeSpawn([1, 0.5, -2])).toEqual({ position: [1, 0.5, -2], yaw: 0 });
	});
	it('refuses anything that is not three finite numbers', () => {
		expect(normalizeSpawn({ position: [1, 2] })).toBe(null);
		expect(normalizeSpawn([1, NaN, 2])).toBe(null);
		expect(normalizeSpawn([1e9, 0, 0])).toBe(null);
		expect(normalizeSpawn(null)).toBe(null);
		expect(normalizeSpawn({ position: [0, 0, 0], yaw: 'x' })).toEqual({ position: [0, 0, 0], yaw: 0 });
	});
});

describe('yaw convention (three rotation.y; 0 faces -Z)', () => {
	it('forward and back', () => {
		expect(yawForward(0)).toEqual({ x: -0, y: 0, z: -1 });
		const f = yawForward(Math.PI / 2); // turned LEFT: facing -X
		expect(f.x).toBeCloseTo(-1);
		expect(f.z).toBeCloseTo(0);
		for (const yaw of [0, 0.7, -2.1, 3]) expect(yawOf(yawForward(yaw))).toBeCloseTo(yaw);
	});
});

// ---- the VR spawn, checked against WebXR's own composition rule ------------------------
// A pose in the new space = inverse(originOffset) * pose in the old one. Rotations here
// are about +Y only, so a pose is {x, y, z, yaw} and an offset is a translation `t`
// followed by a yaw `a` (XRRigidTransform = T(t) * R(a)).
/** @param {number} a @param {{x: number, z: number}} p */
const rotY = (a, p) => ({ x: Math.cos(a) * p.x + Math.sin(a) * p.z, z: -Math.sin(a) * p.x + Math.cos(a) * p.z });
/** apply inverse(T(t) R(a)) to a pose @param {{x: number, y: number, z: number, yaw: number}} pose
 * @param {{x: number, y: number, z: number}} t @param {number} a */
function viaOffset(pose, t, a) {
	const d = rotY(-a, { x: pose.x - t.x, z: pose.z - t.z });
	return { x: d.x, y: pose.y - t.y, z: d.z, yaw: pose.yaw - a };
}
/** @param {number} a */
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

describe('vrSpawnOffsets', () => {
	const cases = [
		{ head: { x: 0, y: 1.6, z: 0 }, yaw: 0, spawn: { position: [3, 0, -4], yaw: Math.PI / 2 } },
		{ head: { x: -2, y: 5.1, z: 7 }, yaw: 2.4, spawn: { position: [0.5, 1.2, 0.5], yaw: -1 } },
		{ head: { x: 10, y: 1.7, z: -3 }, yaw: -0.3, spawn: { position: [10, 0, -3], yaw: -0.3 } }
	];
	for (const [i, c] of cases.entries()) {
		it(`the feet land on the spawn, facing its yaw (case ${i})`, () => {
			const headHeight = 1.6;
			const { turn, move } = vrSpawnOffsets(c.head, c.yaw, headHeight, c.spawn);
			const afterTurn = viaOffset({ ...c.head, yaw: c.yaw }, turn.position, turn.angle);
			// the turn is IN PLACE
			expect(afterTurn.x).toBeCloseTo(c.head.x, 6);
			expect(afterTurn.z).toBeCloseTo(c.head.z, 6);
			const after = viaOffset(afterTurn, move, 0);
			expect(after.x).toBeCloseTo(c.spawn.position[0], 6);
			expect(after.z).toBeCloseTo(c.spawn.position[2], 6);
			expect(after.y - headHeight).toBeCloseTo(c.spawn.position[1], 6); // the FEET
			expect(wrap(after.yaw - c.spawn.yaw)).toBeCloseTo(0, 6);
		});
	}
	it('the turn quaternion is the rotation by `angle` about +Y', () => {
		const { turn } = vrSpawnOffsets({ x: 0, y: 1.6, z: 0 }, 0.4, 1.6, { position: [0, 0, 0], yaw: -0.6 });
		expect(turn.angle).toBeCloseTo(1.0);
		expect(turn.orientation.y).toBeCloseTo(Math.sin(0.5));
		expect(turn.orientation.w).toBeCloseTo(Math.cos(0.5));
	});
});
