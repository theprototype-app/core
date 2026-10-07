import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { setGrabPivot, poseSetGrab } from '../../src/lib/vr/setGrab.js';

// 37 R1: a VR grip on a member of a selection carries the set. The hand's translation moves
// every member; a wrist twist and the stick's scale act about the pivot mode's point.

/** @param {number} x @param {number} z */
function member(x, z) {
	const root = new THREE.Group();
	const object = new THREE.Object3D();
	object.position.set(x, 0, z);
	root.add(object);
	root.updateMatrixWorld(true);
	const worldPos = object.getWorldPosition(new THREE.Vector3());
	return { object, startWorld: object.matrixWorld.clone(), origin: worldPos.clone(), worldPos };
}
const set = () => [member(1, 0), member(3, 0)];
const quarter = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
const round = (/** @type {THREE.Vector3 | null} */ v) => (v ?? new THREE.Vector3(NaN, NaN, NaN)).toArray().map((n) => Math.round(n * 1000) / 1000 + 0);
const none = new THREE.Vector3();

describe('setGrabPivot', () => {
	it('median = the centre, active = the gripped member, individual = none, parent when shared', () => {
		const m = set();
		expect(round(setGrabPivot('median', m, 0, null))).toEqual([2, 0, 0]);
		expect(round(setGrabPivot('active', m, 1, null))).toEqual([3, 0, 0]);
		expect(setGrabPivot('individual', m, 0, null)).toBe(null);
		expect(round(setGrabPivot('parent', m, 0, new THREE.Vector3(5, 0, 0)))).toEqual([5, 0, 0]);
		expect(round(setGrabPivot('parent', m, 0, null))).toEqual([2, 0, 0]); // no common parent: median
	});
});

describe('poseSetGrab', () => {
	it('a pure hand translation moves every member by it, whatever the mode', () => {
		for (const mode of /** @type {const} */ (['median', 'active', 'individual'])) {
			const m = set();
			poseSetGrab(m, setGrabPivot(mode, m, 0, null), new THREE.Vector3(0, 1, 0), new THREE.Quaternion(), 1);
			expect(round(m[0].object.position)).toEqual([1, 1, 0]);
			expect(round(m[1].object.position)).toEqual([3, 1, 0]);
		}
	});

	it('Median: a quarter twist turns the set about its centre', () => {
		const m = set();
		poseSetGrab(m, setGrabPivot('median', m, 0, null), none, quarter, 1);
		expect(round(m[0].object.position)).toEqual([2, 0, 1]);
		expect(round(m[1].object.position)).toEqual([2, 0, -1]);
	});

	it('Active: the gripped member stays put and the rest orbit it', () => {
		const m = set();
		poseSetGrab(m, setGrabPivot('active', m, 0, null), none, quarter, 1);
		expect(round(m[0].object.position)).toEqual([1, 0, 0]);
		expect(round(m[1].object.position)).toEqual([1, 0, -2]);
	});

	it('Individual: every member turns and scales in place', () => {
		const m = set();
		poseSetGrab(m, null, none, quarter, 2);
		expect(round(m[0].object.position)).toEqual([1, 0, 0]);
		expect(round(m[1].object.position)).toEqual([3, 0, 0]);
		expect(m[0].object.scale.x).toBeCloseTo(2);
		expect(Math.abs(m[1].object.quaternion.angleTo(quarter))).toBeLessThan(1e-6);
	});

	it('Median scale spreads the set about its centre', () => {
		const m = set();
		poseSetGrab(m, setGrabPivot('median', m, 0, null), none, new THREE.Quaternion(), 2);
		expect(round(m[0].object.position)).toEqual([0, 0, 0]);
		expect(round(m[1].object.position)).toEqual([4, 0, 0]);
	});
});
