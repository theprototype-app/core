import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { DEFAULT_SEAT, yawOfQuaternion, seatPoint, seatPlace, seatCarry } from '../../src/lib/vr/seatMath.js';

// 37 (21-C Race VR): the seat's offsets, checked by doing what WebXR does with them. A pose in
// the NEW reference space is `inverse(offset) * pose in the old one` — so this applies the
// inverse of each offset to a viewer {head, yaw} and reads where the viewer ended up.

/** @param {{x: number, y: number, z: number}} head @param {number} yaw @param {{x: number, y: number, z: number}} t @param {{y: number, w: number}} [q] */
function applyOffset(head, yaw, t, q) {
	const a = q ? 2 * Math.atan2(q.y, q.w) : 0;
	// inverse(T) = rotate by -a after translating by -t
	const px = head.x - t.x;
	const pz = head.z - t.z;
	const s = Math.sin(-a);
	const c = Math.cos(-a);
	return { head: { x: px * c + pz * s, y: head.y - t.y, z: -px * s + pz * c }, yaw: yaw - a };
}
/** @param {{head: any, yaw: number}} v @param {{turn: any, move: any}} step */
function ride(v, step) {
	let out = v;
	if (step.turn) out = applyOffset(out.head, out.yaw, step.turn.position, step.turn.orientation);
	return applyOffset(out.head, out.yaw, step.move);
}
const wrap = (/** @type {number} */ a) => Math.atan2(Math.sin(a), Math.cos(a));
/** the viewer's head in the car's own frame @param {any} head @param {{position: number[], yaw: number}} pose */
function carLocal(head, pose) {
	const dx = head.x - pose.position[0];
	const dz = head.z - pose.position[2];
	const s = Math.sin(-pose.yaw);
	const c = Math.cos(-pose.yaw);
	return [dx * c + dz * s, head.y - pose.position[1], -dx * s + dz * c];
}

describe('vr seat math', () => {
	it('reads the yaw of a quaternion and ignores pitch and roll', () => {
		const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0.7, 0));
		expect(yawOfQuaternion(q)).toBeCloseTo(0.7, 9);
		const tilted = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.08, -2.5, 0.05, 'YXZ'));
		expect(yawOfQuaternion(tilted)).toBeCloseTo(-2.5, 2);
	});

	it('places an object-local point by the object yaw (forward is -Z)', () => {
		// a car facing +X (yaw -pi/2 turns -Z onto +X): a point 1 m ahead of it is 1 m along +X
		const p = seatPoint({ position: [10, 0, 5], yaw: -Math.PI / 2 }, [0, 0.5, -1]);
		expect(p.x).toBeCloseTo(11, 9);
		expect(p.y).toBeCloseTo(0.5, 9);
		expect(p.z).toBeCloseTo(5, 9);
	});

	it('sits the head on the seat facing the car', () => {
		const pose = { position: [12, 0.6, -4], yaw: 1.2 };
		const v = ride({ head: { x: 1, y: 1.55, z: 2 }, yaw: 0.3 }, seatPlace({ x: 1, y: 1.55, z: 2 }, 0.3, pose, DEFAULT_SEAT));
		const want = seatPoint(pose, DEFAULT_SEAT);
		expect(v.head.x).toBeCloseTo(want.x, 9);
		expect(v.head.y).toBeCloseTo(want.y, 9);
		expect(v.head.z).toBeCloseTo(want.z, 9);
		expect(wrap(v.yaw - pose.yaw)).toBeCloseTo(0, 9);
	});

	it('carries the viewer rigidly: a head off the seat keeps its car-local place and heading', () => {
		const prev = { position: [0, 0.6, 0], yaw: 0.4 };
		const now = { position: [1.3, 0.62, -0.7], yaw: 0.55 };
		const v0 = { head: { x: 0.35, y: 1.4, z: 0.1 }, yaw: 0.9 }; // leaning, looking off to one side
		const v1 = ride(v0, seatCarry(v0.head, prev, now));
		const a = carLocal(v0.head, prev);
		const b = carLocal(v1.head, now);
		for (let i = 0; i < 3; i++) expect(b[i]).toBeCloseTo(a[i], 9);
		expect(wrap(v1.yaw - now.yaw)).toBeCloseTo(wrap(v0.yaw - prev.yaw), 9);
	});

	it('a still car moves nothing (no turn, no translation)', () => {
		const pose = { position: [3, 0.6, 3], yaw: -1 };
		const step = seatCarry({ x: 3.1, y: 1.4, z: 3.2 }, pose, pose);
		expect(step.turn).toBeNull();
		expect(Math.hypot(step.move.x, step.move.y, step.move.z)).toBe(0);
	});

	it('a whole lap of a circle does not drift the seat', () => {
		let pose = { position: [20, 0.6, 0], yaw: Math.PI };
		let v = { head: { x: 0, y: 1.6, z: 0 }, yaw: 0 };
		v = ride(v, seatPlace(v.head, v.yaw, pose, DEFAULT_SEAT));
		const start = carLocal(v.head, pose);
		const N = 720;
		for (let i = 1; i <= N; i++) {
			const th = (i / N) * Math.PI * 2;
			// drive round a 20 m circle, nose along the tangent, bumping up and down a little
			const now = { position: [20 * Math.cos(th), 0.6 + 0.05 * Math.sin(7 * th), 20 * Math.sin(th)], yaw: Math.PI - th };
			v = ride(v, seatCarry(v.head, pose, now));
			pose = now;
		}
		const end = carLocal(v.head, pose);
		for (let i = 0; i < 3; i++) expect(end[i]).toBeCloseTo(start[i], 6);
		expect(wrap(v.yaw - pose.yaw)).toBeCloseTo(0, 6);
	});
});
