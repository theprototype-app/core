// VH2 (roadmap 74, the plan's CO6) — a phone joins a co-located Quest room with two floor taps.
// The property the whole item stands on: a headset calibrating point + aim and a phone tapping the
// same two marks, each in its own private tracking space (the phone's floor at an arbitrary height),
// read every physical point at the same CONTENT coordinates, under any shared room anchor.
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
	alignmentFromPointAim,
	alignmentFromTwoPoints,
	composeRigTransform,
	normalizeRoomAnchor,
	MIN_TAP_SPAN
} from '../../src/lib/colocation.js';
import { roomKeyToJoin } from '../../src/lib/arTableCore.js';

const UP = new THREE.Vector3(0, 1, 0);

/** a seeded generator, so a red run can be replayed @param {number} seed */
function rng(seed) {
	let s = seed >>> 0;
	return () => {
		s = (s * 1664525 + 1013904223) >>> 0;
		return s / 2 ** 32;
	};
}

/** a device's private tracking space: physical -> tracking, a yaw and a translation (y included)
 * @param {() => number} rand @param {number} floorY */
function device(rand, floorY) {
	const yaw = (rand() * 2 - 1) * Math.PI;
	const t = new THREE.Vector3((rand() * 2 - 1) * 5, floorY, (rand() * 2 - 1) * 5);
	const q = new THREE.Quaternion().setFromAxisAngle(UP, yaw);
	return {
		/** @param {THREE.Vector3} p */
		point: (p) => p.clone().applyQuaternion(q).add(t),
		/** @param {THREE.Vector3} d */
		dir: (d) => d.clone().applyQuaternion(q)
	};
}

/** content coords of a TRACKING point under a rig (content -> world): rig⁻¹ · p
 * @param {any} rig @param {THREE.Vector3} p */
function toContent(rig, p) {
	const m = new THREE.Matrix4().compose(new THREE.Vector3().fromArray(rig.pos), new THREE.Quaternion().fromArray(rig.quat), new THREE.Vector3(1, 1, 1));
	return p.clone().applyMatrix4(m.invert());
}

/** @param {() => number} rand */
function randomAnchor(rand) {
	return normalizeRoomAnchor({
		pos: [(rand() * 2 - 1) * 3, rand() * 0.5, (rand() * 2 - 1) * 3],
		quat: new THREE.Quaternion().setFromAxisAngle(UP, rand() * 6).toArray(),
		at: 1
	});
}

describe('alignmentFromTwoPoints', () => {
	it('is the headset ritual: point = first tap, aim = first -> second', () => {
		const a = { x: 1, y: -1.3, z: 2 };
		const b = { x: 1, y: -1.3, z: 1 };
		const two = alignmentFromTwoPoints(a, b);
		const aim = alignmentFromPointAim(a, { x: 0, y: 0, z: -1 });
		expect(two).toEqual(aim);
		expect(two?.py).toBe(-1.3); // the Y term is live: room y = 0 is the agreed point
	});

	it('ignores the height difference between the taps (a heading is horizontal)', () => {
		const flat = alignmentFromTwoPoints({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 });
		const sloped = alignmentFromTwoPoints({ x: 0, y: 0, z: 0 }, { x: 1, y: 0.4, z: 0 });
		expect(sloped?.yaw).toBeCloseTo(flat?.yaw ?? NaN, 12);
	});

	it('refuses taps closer than MIN_TAP_SPAN on the floor, and garbage', () => {
		expect(alignmentFromTwoPoints({ x: 0, y: 0, z: 0 }, { x: MIN_TAP_SPAN * 0.99, y: 0, z: 0 })).toBeNull();
		expect(alignmentFromTwoPoints({ x: 0, y: 0, z: 0 }, { x: 0, y: 2, z: 0 })).toBeNull(); // straight up: no heading
		expect(alignmentFromTwoPoints({ x: 0, y: 0, z: 0 }, { x: MIN_TAP_SPAN * 1.01, y: 0, z: 0 })).not.toBeNull();
		expect(alignmentFromTwoPoints(null, { x: 1, y: 0, z: 0 })).toBeNull();
		expect(alignmentFromTwoPoints({ x: 0, y: 0, z: 0 }, { x: 'a', y: 0, z: 0 })).toBeNull();
	});
});

describe('a Quest (point + aim) and a phone (two taps) agree on the room', () => {
	it('every physical point reads the same content coords on both, under any anchor (200 rooms)', () => {
		const rand = rng(74);
		let worst = 0;
		for (let i = 0; i < 200; i++) {
			const quest = device(rand, 0); // local-floor: the floor is y = 0
			const phone = device(rand, -(0.8 + rand())); // local: the floor is wherever it is
			// the agreed marks, on the physical floor, at least a step apart
			const A = new THREE.Vector3((rand() * 2 - 1) * 2, 0, (rand() * 2 - 1) * 2);
			const heading = rand() * Math.PI * 2;
			const B = A.clone().add(new THREE.Vector3(Math.sin(heading), 0, Math.cos(heading)).multiplyScalar(0.5 + rand() * 2));
			const Mq = alignmentFromPointAim(quest.point(A), quest.dir(B.clone().sub(A)));
			const Mp = alignmentFromTwoPoints(phone.point(A), phone.point(B));
			const K = rand() < 0.2 ? null : randomAnchor(rand);
			const Rq = composeRigTransform(Mq, K);
			const Rp = composeRigTransform(Mp, K);
			for (let j = 0; j < 4; j++) {
				const X = new THREE.Vector3((rand() * 2 - 1) * 4, rand() * 2, (rand() * 2 - 1) * 4);
				const cq = toContent(Rq, quest.point(X));
				const cp = toContent(Rp, phone.point(X));
				worst = Math.max(worst, cq.distanceTo(cp));
			}
		}
		expect(worst).toBeLessThan(1e-9);
	});

	it('COUNTERFACTUAL: the phone reading its taps the wrong way round disagrees by metres', () => {
		const rand = rng(7);
		const quest = device(rand, 0);
		const phone = device(rand, -1.2);
		const A = new THREE.Vector3(0.5, 0, -0.3);
		const B = new THREE.Vector3(0.5, 0, -1.8);
		const Rq = composeRigTransform(alignmentFromPointAim(quest.point(A), quest.dir(B.clone().sub(A))), null);
		const Rp = composeRigTransform(alignmentFromTwoPoints(phone.point(B), phone.point(A)), null);
		const X = new THREE.Vector3(2, 1, 2);
		expect(toContent(Rq, quest.point(X)).distanceTo(toContent(Rp, phone.point(X)))).toBeGreaterThan(1);
	});

	it('the phone rig is yaw-only: the horizon never tilts', () => {
		const rand = rng(3);
		for (let i = 0; i < 50; i++) {
			const phone = device(rand, -1);
			const A = new THREE.Vector3(rand(), 0, rand());
			const B = A.clone().add(new THREE.Vector3(1, 0.05 * (rand() - 0.5), 0.3));
			const R = composeRigTransform(alignmentFromTwoPoints(phone.point(A), phone.point(B)), randomAnchor(rand));
			const up = new THREE.Vector3(0, 1, 0).applyQuaternion(new THREE.Quaternion().fromArray(R?.quat ?? [0, 0, 0, 1]));
			expect(up.y).toBeCloseTo(1, 12);
		}
	});

	it('tap noise of ±1 cm over a 1 m span lands within 4 cm a metre and a half out', () => {
		// the expectation recorded for the docs (measured worst 3.7 cm over 200 draws): a longer span is better
		const rand = rng(11);
		let worst = 0;
		for (let i = 0; i < 200; i++) {
			const jitter = () => new THREE.Vector3((rand() * 2 - 1) * 0.01, 0, (rand() * 2 - 1) * 0.01);
			const A = new THREE.Vector3(0, -1, 0);
			const B = new THREE.Vector3(0, -1, -1);
			const exact = composeRigTransform(alignmentFromTwoPoints(A, B), null);
			const noisy = composeRigTransform(alignmentFromTwoPoints(A.clone().add(jitter()), B.clone().add(jitter())), null);
			const X = new THREE.Vector3(1.5, -0.3, -0.5);
			worst = Math.max(worst, toContent(exact, X).distanceTo(toContent(noisy, X)));
		}
		expect(worst).toBeLessThan(0.04);
	});
});

describe('roomKeyToJoin', () => {
	it('a colocated headset wins over our key and the default', () => {
		expect(roomKeyToJoin({ q1: 'room-abc' }, 'room-mine', 'room-def')).toBe('room-abc');
	});
	it('the most-joined room, ties alphabetical', () => {
		expect(roomKeyToJoin({ a: 'room-z', b: 'room-y', c: 'room-z' }, null, 'room-1')).toBe('room-z');
		expect(roomKeyToJoin({ a: 'room-z', b: 'room-y' }, null, 'room-1')).toBe('room-y');
	});
	it('nobody colocated: ours, else the session default', () => {
		expect(roomKeyToJoin({}, 'room-mine', 'room-def')).toBe('room-mine');
		expect(roomKeyToJoin({}, null, 'room-def')).toBe('room-def');
		expect(roomKeyToJoin({ a: '' }, '', 'room-def')).toBe('room-def');
	});
});
