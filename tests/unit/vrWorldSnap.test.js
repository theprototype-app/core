// 37 R10 — world-grab snapping with no browser: the yaw steps of the ABSOLUTE heading, the scale
// detents (both ways from 1:1) with their catch/release bands and hysteresis on both. grip.js's
// gesture maths with the snap applied is covered by e2e vr-world-snap (grip.js needs the app runtime).
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { snapWorldGrab, scaleLabel, yawLabel, yawOf, YAW_STEP, SCALE_DETENTS } from '../../src/lib/vr/worldSnap.js';

const deg = (/** @type {number} */ d) => (d * Math.PI) / 180;

describe('yaw steps', () => {
	it('rounds the absolute heading to 15°', () => {
		const r = snapWorldGrab({ total: 1, yaw: deg(22), yaw0: 0 }, null);
		expect(r.step).toBe(1);
		expect(r.yaw).toBeCloseTo(deg(15), 9);
		expect(snapWorldGrab({ total: 1, yaw: deg(-8), yaw0: 0 }, null).step).toBe(-1);
	});
	it('snaps the ABSOLUTE heading: a rig that started off-grid lands back on the axes', () => {
		// started at 7°, twisted 10° -> 17° absolute -> the 15° step, i.e. a delta of 8°
		const r = snapWorldGrab({ total: 1, yaw: deg(10), yaw0: deg(7) }, null);
		expect(r.step).toBe(1);
		expect(r.yaw).toBeCloseTo(deg(8), 9);
	});
	it('holds a step a little past half-way (no chatter on the boundary)', () => {
		const prev = { step: 1, detent: 1 };
		// 23° is past the 22.5° line but inside the 2° hysteresis -> still step 1
		expect(snapWorldGrab({ total: 1, yaw: deg(23), yaw0: 0 }, prev).step).toBe(1);
		// 25° is clear of it -> step 2
		expect(snapWorldGrab({ total: 1, yaw: deg(25), yaw0: 0 }, prev).step).toBe(2);
		// counterfactual: with no previous state 23° rounds to step 2 straight away
		expect(snapWorldGrab({ total: 1, yaw: deg(23), yaw0: 0 }, null).step).toBe(2);
	});
});

describe('scale detents', () => {
	it('lists 1/2/5/10 both ways', () => {
		expect(SCALE_DETENTS).toEqual([0.1, 0.2, 0.5, 1, 2, 5, 10]);
	});
	it('sticks inside ±7 % and slides freely between', () => {
		expect(snapWorldGrab({ total: 2.1, yaw: 0, yaw0: 0 }, null)).toMatchObject({ total: 2, detent: 2 });
		expect(snapWorldGrab({ total: 0.47, yaw: 0, yaw0: 0 }, null)).toMatchObject({ total: 0.5, detent: 0.5 });
		const free = snapWorldGrab({ total: 3.3, yaw: 0, yaw0: 0 }, null);
		expect(free.detent).toBeNull();
		expect(free.total).toBe(3.3);
	});
	it('keeps a caught detent until it is pulled clearly off', () => {
		const prev = { step: 0, detent: 2 };
		// 2.18 is outside the 7 % catch but inside the 11 % release -> still 2
		expect(snapWorldGrab({ total: 2.18, yaw: 0, yaw0: 0 }, prev).detent).toBe(2);
		expect(snapWorldGrab({ total: 2.18, yaw: 0, yaw0: 0 }, null).detent).toBeNull();
		expect(snapWorldGrab({ total: 2.3, yaw: 0, yaw0: 0 }, prev).detent).toBeNull();
	});
});

describe('labels', () => {
	it('reads like the readout', () => {
		expect(scaleLabel(2)).toBe('2×');
		expect(scaleLabel(0.5)).toBe('½×');
		expect(scaleLabel(0.1)).toBe('⅒×');
		expect(scaleLabel(3.3)).toBe('3.3×');
		expect(yawLabel(3)).toBe('45°');
		expect(yawLabel(-1)).toBe('345°');
	});
	it('yawOf reads a Y rotation back', () => {
		const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), deg(30));
		expect(yawOf(q.toArray())).toBeCloseTo(deg(30), 9);
	});
});

it('YAW_STEP is 15°', () => expect(YAW_STEP).toBeCloseTo(deg(15), 12));
