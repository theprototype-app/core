// @ts-nocheck — plain fixture poses
// 37 (R8): the Camera Rig's maths — the goal pose (follow / look at / both, world or target-space
// offset) and the frame-rate-independent damping step.
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { rigGoal, rigStep, validVec } from '../../src/lib/cameraRig.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const cam = () => ({ pos: V(0, 0, 0), quat: new THREE.Quaternion() });
const forward = (q) => V(0, 0, -1).applyQuaternion(q);

describe('rigGoal', () => {
	it('follows at a world offset and aims -Z (the camera forward) at the target', () => {
		const g = rigGoal(cam(), { pos: V(10, 0, 0) }, { offset: [0, 2, 5] });
		expect(g.pos.toArray()).toEqual([10, 2, 5]);
		const toTarget = V(10, 0, 0).sub(g.pos).normalize();
		expect(forward(g.quat).dot(toTarget)).toBeGreaterThan(0.9999);
	});
	it('follow keeps the camera\'s own orientation; lookat keeps its position', () => {
		const c = cam();
		c.quat.setFromEuler(new THREE.Euler(0, 0.7, 0));
		const f = rigGoal(c, { pos: V(3, 0, 0) }, { mode: 'follow', offset: [0, 1, 0] });
		expect(f.pos.toArray()).toEqual([3, 1, 0]);
		expect(f.quat.angleTo(c.quat)).toBeLessThan(1e-9);
		const l = rigGoal(c, { pos: V(0, 0, -8) }, { mode: 'lookat' });
		expect(l.pos.toArray()).toEqual([0, 0, 0]);
		expect(forward(l.quat).dot(V(0, 0, -1))).toBeGreaterThan(0.9999);
	});
	it('a target-space offset turns with the target (a chase camera stays behind it)', () => {
		const yaw = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI / 2, 0));
		const g = rigGoal(cam(), { pos: V(0, 0, 0), quat: yaw }, { space: 'target', offset: [0, 0, 5], mode: 'follow' });
		expect(g.pos.x).toBeCloseTo(5, 6);
		expect(g.pos.z).toBeCloseTo(0, 6);
	});
	it('aim raises the look point; a bad offset falls back to the default', () => {
		const g = rigGoal(cam(), { pos: V(0, 0, -10) }, { mode: 'lookat', aim: 10 });
		expect(forward(g.quat).y).toBeGreaterThan(0.6);
		expect(rigGoal(cam(), { pos: V(0, 0, 0) }, { offset: ['x', 1] }).pos.toArray()).toEqual([0, 2, 5]);
		expect(validVec([1, '2', 3])).toEqual([1, 2, 3]);
		expect(validVec([1, NaN, 3])).toBe(null);
	});
});

describe('rigStep', () => {
	const goal = { pos: V(10, 0, 0), quat: new THREE.Quaternion() };
	it('damping 0 is rigid', () => {
		expect(rigStep(cam(), goal, 0, 1 / 60).pos.x).toBe(10);
	});
	it('the lag is a time constant: one 1/30 s step lands where two 1/60 s steps do', () => {
		const one = rigStep(cam(), goal, 0.5, 1 / 30).pos.x;
		const half = rigStep(cam(), goal, 0.5, 1 / 60);
		const two = rigStep(half, goal, 0.5, 1 / 60).pos.x;
		expect(one).toBeCloseTo(two, 9);
		expect(one).toBeGreaterThan(0);
		expect(one).toBeLessThan(10);
	});
	it('a long stall (a backgrounded tab) is clamped, never overshoots', () => {
		const p = rigStep(cam(), goal, 0.5, 30).pos.x;
		expect(p).toBeLessThanOrEqual(10);
		expect(p).toBeCloseTo(10 * (1 - Math.exp(-0.25 / 0.5)), 9);
	});
});
