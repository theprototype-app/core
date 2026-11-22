// 85 N3 — Ambient Animal on the real functions flowRuntime calls: the rest schedule is a time warp
// (the path pauses and resumes where it stopped), the position is pure of the clock (two peers, one
// place), a resting animal turns to the nearest player, and a flee radius pushes it away.
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { walkTime, nearest, fleeAmount, yawToward, angleTo } from '../../src/lib/motion/ambientCore.js';
import { applyAmbientAnimal, ambientRead, resetAmbientNodes } from '../../src/lib/motion/ambientNodes.js';

const baseOf = (/** @type {any} */ o) => ({ pos: o.position.toArray(), rot: [o.rotation.x, o.rotation.y, o.rotation.z], scale: o.scale.toArray() });

describe('ambientCore', () => {
	it('walkTime: walks, then rests with tau frozen, then resumes from the same tau', () => {
		const data = { rest: 0.5, restTime: 2 }; // cycle 4 s: walk 2, rest 2
		const a = walkTime(1, data, 0);
		expect(a.walking).toBe(true);
		const r1 = walkTime(2.5, data, 0);
		const r2 = walkTime(3.9, data, 0);
		expect(r1.walking).toBe(false);
		expect(r1.tau).toBe(r2.tau);
		expect(r1.tau).toBe(2);
		const b = walkTime(4.5, data, 0);
		expect(b.walking).toBe(true);
		expect(b.tau).toBeCloseTo(2.5);
		expect(walkTime(7, { rest: 0 }, 0.3)).toEqual({ tau: 7, walking: true, restLeft: 0 });
	});
	it('nearest / flee field / yaw helpers', () => {
		expect(nearest([0, 0, 0], [[3, 0, 4], [1, 5, 0]])?.d).toBe(1);
		expect(nearest([0, 0, 0], [])).toBe(null);
		expect(fleeAmount(0, 4, 2)).toBe(2);
		expect(fleeAmount(4, 4, 2)).toBe(0);
		expect(fleeAmount(1, 0, 2)).toBe(0);
		expect(yawToward(0, 1)).toBe(0);
		expect(yawToward(1, 0)).toBeCloseTo(Math.PI / 2);
		expect(angleTo(3, -3)).toBeCloseTo(2 * Math.PI - 6);
	});
});

describe('applyAmbientAnimal (THREE)', () => {
	const make = () => {
		const root = new THREE.Group();
		const deer = new THREE.Mesh(new THREE.BoxGeometry(0.5, 1, 1));
		root.add(deer);
		return { root, deer, base: baseOf(deer) };
	};
	it('pure of the clock: two peers at the same moment put the deer in the same place', () => {
		resetAmbientNodes();
		const A = make();
		const B = make();
		B.deer.uuid = A.deer.uuid; // the same object on two peers
		const data = { speed: 0.4, rx: 3, rz: 3, rest: 0.3, restTime: 2 };
		applyAmbientAnimal(A.deer, A.base, data, 1234.5, { root: A.root, key: 'a', players: [] });
		applyAmbientAnimal(B.deer, B.base, data, 1234.5, { root: B.root, key: 'b', players: [] });
		expect(A.deer.position.toArray()).toEqual(B.deer.position.toArray());
		// stays near home and on the ground (ground default on)
		expect(Math.abs(A.deer.position.x)).toBeLessThanOrEqual(3.01);
		expect(A.deer.position.y).toBe(0);
	});
	it('a resting animal stands still and turns to look at a nearby player', () => {
		resetAmbientNodes();
		const { root, deer, base } = make();
		const data = { speed: 0.4, rest: 0.5, restTime: 4, seed: 7, lookRadius: 10, turnSpeed: 30 };
		// scan forward to a moment well inside a rest (seed 7 shifts the cycle)
		let t = 100;
		let read;
		for (let i = 0; i < 400; i++, t += 0.1) {
			read = applyAmbientAnimal(deer, base, data, t, { root, key: 'k', players: [] });
			if (read.mode === 'resting' && read.restLeft > 1.5) break;
		}
		expect(read?.mode).toBe('resting');
		const p = deer.position.clone();
		const player = [p.x + 3, 0, p.z];
		for (let i = 0; i < 10; i++) applyAmbientAnimal(deer, base, data, t + i * 0.05, { root, key: 'k', players: [player] });
		expect(deer.position.distanceTo(p)).toBeLessThan(1e-9);
		expect(ambientRead('k').mode).toBe('looking');
		expect(angleTo(deer.rotation.y, Math.PI / 2)).toBeCloseTo(0, 1);
	});
	it('a flee radius pushes it away from a player standing on it, and reads as fleeing (the run clip)', () => {
		resetAmbientNodes();
		const { root, deer, base } = make();
		const data = { speed: 0.3, rest: 0, fleeRadius: 4, fleeDistance: 2 };
		applyAmbientAnimal(deer, base, data, 50, { root, key: 'f', players: [] });
		const calm = deer.position.clone();
		const read = applyAmbientAnimal(deer, base, data, 50, { root, key: 'f', players: [[calm.x - 0.5, 0, calm.z]] });
		expect(read.mode).toBe('fleeing');
		expect(read.speed).toBe(2.5);
		expect(deer.position.x - calm.x).toBeGreaterThan(1);
	});
});
