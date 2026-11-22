// 54i r: "wander group drifts off the ground" — REPRODUCED on the real applyWander (the function
// flowRuntime calls each frame): a group placed at y 0 with the node's defaults bobs within
// ry 0.3 (-0.19 at t 0, +0.05 at t 10), and a 0.2 m ground slab wired as the area pulls it to
// the slab's MIDDLE (y -0.1, half sunk). `ground: true` (a new node's default) keeps the placed
// height while x/z still wander.
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { applyWander } from '../../src/lib/motion/motionNodes.js';

function herd() {
	const root = new THREE.Group();
	const deer = new THREE.Group();
	deer.name = 'Deer herd';
	root.add(deer);
	const ground = new THREE.Mesh(new THREE.BoxGeometry(40, 0.2, 40));
	ground.position.y = -0.1;
	root.add(ground);
	return { root, deer, ground };
}
const DEFAULTS = { speed: 0.3, seed: 0, margin: 0.2, rx: 1, ry: 0.3, rz: 1 };

/** y and the x/z travel over 10 s at 10 Hz @param {any} data */
function walk(data) {
	const { root, deer, ground } = herd();
	const d = { ...data };
	if (d.area === 'ground') d.area = ground.uuid;
	const ys = [];
	let travel = 0;
	let last = null;
	for (let i = 0; i <= 100; i++) {
		applyWander(deer, { pos: [0, 0, 0] }, d, i / 10, { root });
		ys.push(deer.position.y);
		if (last) travel += Math.hypot(deer.position.x - last[0], deer.position.z - last[1]);
		last = [deer.position.x, deer.position.z];
	}
	return { minY: Math.min(...ys), maxY: Math.max(...ys), travel };
}

describe('Wander on the ground (54i r)', () => {
	it('the reported drift is real without it: the defaults bob the group off y 0', () => {
		const r = walk(DEFAULTS);
		expect(r.maxY - r.minY).toBeGreaterThan(0.05);
	});
	it('ground on: y stays at the placed height, x/z still wander', () => {
		const r = walk({ ...DEFAULTS, ground: true });
		expect(r.minY).toBe(0);
		expect(r.maxY).toBe(0);
		expect(r.travel).toBeGreaterThan(0.3);
	});
	it('ground on with a ground slab as the area: not pulled into the slab', () => {
		expect(walk({ ...DEFAULTS, area: 'ground' }).maxY).toBeCloseTo(-0.1, 5); // the bug
		const r = walk({ ...DEFAULTS, area: 'ground', ground: true });
		expect(r.minY).toBe(0);
		expect(r.maxY).toBe(0);
		expect(r.travel).toBeGreaterThan(0.3);
	});
	it('a placed height under a moved parent is kept in world space', () => {
		const { root, deer } = herd();
		root.position.y = 2;
		applyWander(deer, { pos: [0, 0.5, 0] }, { ...DEFAULTS, ground: true }, 3, { root });
		expect(deer.getWorldPosition(new THREE.Vector3()).y).toBeCloseTo(2.5, 6);
	});
});
