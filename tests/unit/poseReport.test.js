import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { reportedPose } from '../../src/lib/ai/poseReport.js';
import { spinAngle } from '../../src/lib/flowRuntime';

const object = (/** @type {number[]} */ pos, /** @type {number[]} */ rot) => {
	const o = new THREE.Object3D();
	o.position.fromArray(pos);
	o.rotation.set(rot[0], rot[1], rot[2]);
	return o;
};

describe('mcp-fix: list_scene reports the authored pose', () => {
	it('an object nothing animates reads as it always did, with no flag', () => {
		expect(reportedPose(object([1, 2, 3], [0, 0.5, 0]), null)).toEqual({ position: [1, 2, 3], rotation: [0, 0.5, 0], scale: [1, 1, 1], visible: true });
	});
	it('a running effect: the top level is the base and this frame is beside it', () => {
		const o = object([1, 4.25, 3], [0, 2, 0]);
		o.visible = false;
		expect(reportedPose(o, { pos: [1, 4, 3], rot: [0, 0, 0], scale: [1, 1, 1], visible: true })).toEqual({
			position: [1, 4, 3],
			rotation: [0, 0, 0],
			scale: [1, 1, 1],
			visible: true,
			animated: true,
			live: { position: [1, 4.25, 3], rotation: [0, 2, 0], scale: [1, 1, 1], visible: false }
		});
	});
	it('a frame that matches the base has no live copy to mistake for anything', () => {
		const r = reportedPose(object([1, 2, 3], [0, 0, 0]), { pos: [1, 2, 3], rot: [0, 0, 0], scale: [1, 1, 1], visible: true });
		expect(r.animated).toBe(true);
		expect(r.live).toBeUndefined();
	});
	it('a clip base carries no visible flag: the object says', () => {
		expect(reportedPose(object([0, 0, 0], [0, 0, 0]), { pos: [0, 0, 0], rot: [0, 0, 0], scale: [1, 1, 1] }).visible).toBe(true);
	});
});

describe('mcp-fix: a Spin angle stays inside one turn', () => {
	const TURN = Math.PI * 2;
	it('never grows with the age of the session', () => {
		for (const t of [0, 1, 1e3, 1e6, 24313, 1.7e9]) for (const s of [1, -1, 2.5, 50]) expect(Math.abs(spinAngle(t, s))).toBeLessThan(TURN);
	});
	it('is the same pose as the unwrapped angle', () => {
		for (const [t, s] of [[7, 3], [100, -2], [12345.678, 0.5]]) {
			const a = spinAngle(t, s);
			expect(Math.sin(a)).toBeCloseTo(Math.sin(t * s), 6);
			expect(Math.cos(a)).toBeCloseTo(Math.cos(t * s), 6);
		}
	});
	it('is a pure function, so peers on one clock agree', () => {
		expect(spinAngle(987.654, 1.25)).toBe(spinAngle(987.654, 1.25));
	});
	it('still turns at the authored speed inside a turn', () => {
		expect(spinAngle(0.5, 2)).toBe(1);
		expect(spinAngle(0, 9)).toBe(0);
	});
});
