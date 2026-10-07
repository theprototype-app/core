// 37 R10 — the dollhouse layout with no browser: the model's floor centre lands on the table point ahead of
// the head, its longest side is 0.9 m, the rig keeps its orientation, a content point maps back to the world
// through any rig, and a pointed ray finds the model's floor.
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
	dollhouseLayout,
	contentToWorld,
	rayToContentFloor,
	DOLLHOUSE_SIZE,
	DOLLHOUSE_AHEAD,
	DOLLHOUSE_DROP,
	DOLLHOUSE_MIN_SCALE
} from '../../src/lib/vr/dollhouseMath.js';

const ID = [0, 0, 0, 1];
/** @param {number[]} a @param {number[]} b */
const near = (a, b, d = 6) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], d));

describe('dollhouseLayout', () => {
	const box = { min: [-10, 0, -6], max: [10, 3, 6] }; // 20 m x 12 m
	const head = [1, 1.6, 2];
	it('scales the longest side to 0.9 m', () => {
		const l = dollhouseLayout(box, head, 0, ID);
		expect(l.scale).toBeCloseTo(DOLLHOUSE_SIZE / 20, 9);
	});
	it("puts the model's floor centre on the table point ahead of the head", () => {
		const l = dollhouseLayout(box, head, 0, ID);
		near(l.anchor, [1, 1.6 - DOLLHOUSE_DROP, 2 - DOLLHOUSE_AHEAD]);
		// the content floor centre (0, 0, 0) through the rig lands on the anchor
		near(contentToWorld([0, 0, 0], l), l.anchor);
	});
	it('follows the heading (facing +X: yaw = -90 deg)', () => {
		const l = dollhouseLayout(box, head, -Math.PI / 2, ID);
		near(l.anchor, [1 + DOLLHOUSE_AHEAD, 1.6 - DOLLHOUSE_DROP, 2]);
	});
	it("keeps the rig's orientation, and the floor centre still lands on the anchor", () => {
		const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.7).toArray();
		const off = { min: [4, 1, 4], max: [14, 2, 10] };
		const l = dollhouseLayout(off, head, 0, q);
		near(l.quat, q);
		near(contentToWorld([9, 1, 7], l), l.anchor);
	});
	it('frames a lone cube as a 4 m room, and clamps a huge world', () => {
		expect(dollhouseLayout({ min: [-0.5, 0, -0.5], max: [0.5, 1, 0.5] }, head, 0, ID).scale).toBeCloseTo(DOLLHOUSE_SIZE / 4, 9);
		expect(dollhouseLayout({ min: [-5000, 0, -5000], max: [5000, 1, 5000] }, head, 0, ID).scale).toBe(DOLLHOUSE_MIN_SCALE);
	});
});

describe('rayToContentFloor', () => {
	const rig = { pos: [0, 1, -0.6], quat: ID, scale: 0.05 };
	it('lands a downward ray on the model floor in content metres', () => {
		// straight down onto world (0.1, 1, -0.6) = content (2, 0, 0)
		const p = rayToContentFloor([0.1, 1.5, -0.6], [0, -1, 0], rig, 0);
		near(/** @type {number[]} */ (p), [2, 0, 0]);
	});
	it('a level or rising ray never reaches it', () => {
		expect(rayToContentFloor([0, 1.5, 0], [0, 0, -1], rig, 0)).toBeNull();
		expect(rayToContentFloor([0, 1.5, 0], [0, 0.3, -1], rig, 0)).toBeNull();
	});
	it('a floor point maps back to where the ray met the table', () => {
		const p = /** @type {number[]} */ (rayToContentFloor([0.3, 1.4, 0], [-0.2, -0.7, -0.5], rig, 0));
		const w = contentToWorld(p, rig);
		expect(w[1]).toBeCloseTo(1, 9); // the table height = rig.pos.y + floor
	});
});
