// @ts-nocheck — plain three fixtures
// 36-fb-water F16/F17: the drop system — a pour emitter spawns, never exceeds its cap, its
// drops die at their lifetime, settle on the ground, and splash INTO water (absorbed, a
// ripple); a tank spill turns escaped solver particles into world drops.
import { describe, it, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import { normalizePour, tickPours, pourDebug, resetPours, spillDrops, totalDropCount, MAX_DROPS_PER_SOURCE } from '../../src/lib/water/pourDrops.js';
import { waterVolumes } from '../../src/lib/water/volumes.js';

function world() {
	const scene = new THREE.Scene();
	const root = new THREE.Group();
	scene.add(root);
	return { scene, root };
}
/** run n frames of 1/60 s */
function run(root, n, t0 = 1000) {
	for (let i = 0; i < n; i++) tickPours(root, null, null, t0 + i * (1000 / 60));
	return t0 + n * (1000 / 60);
}
function spout(root, pour, pos = [0, 2, 0]) {
	const o = new THREE.Mesh(new THREE.SphereGeometry(0.05), new THREE.MeshBasicMaterial());
	o.position.set(...pos);
	o.userData.pour = pour;
	root.add(o);
	o.updateMatrixWorld(true);
	return o;
}

beforeEach(() => resetPours());

describe('normalizePour', () => {
	it('defaults, clamps, drops garbage', () => {
		const p = normalizePour({ rate: 1e9, maxParticles: 1e9, color: 'red', evil: 1, dir: [5, 'x'] });
		expect(p.rate).toBe(500);
		expect(p.maxParticles).toBe(MAX_DROPS_PER_SOURCE);
		expect(p.color).toBe('#4aa8e8');
		expect(p.dir).toEqual([1, 0.35, 0]);
		expect(p.evil).toBeUndefined();
		expect(normalizePour(null).enabled).toBe(true);
	});
});

describe('pour emitter', () => {
	it('spawns at its rate and never exceeds maxParticles', () => {
		const { root } = world();
		spout(root, { rate: 300, maxParticles: 50, lifetime: 30, speed: 0 }, [0, 50, 0]);
		run(root, 10);
		const a = pourDebug()[0];
		expect(a.count).toBeGreaterThan(30);
		run(root, 120, 2000);
		expect(pourDebug()[0].count).toBeLessThanOrEqual(50);
		expect(totalDropCount()).toBeLessThanOrEqual(50);
	});
	it('drops die at their lifetime (the pool drains when the spout stops)', () => {
		const { root } = world();
		const o = spout(root, { rate: 120, maxParticles: 400, lifetime: 1, speed: 0 }, [0, 500, 0]);
		run(root, 30);
		expect(pourDebug()[0].count).toBeGreaterThan(10);
		o.userData.pour.enabled = false;
		run(root, 90, 3000);
		expect(pourDebug()[0].count).toBe(0);
	});
	it('drops settle on the ground and dry up', () => {
		const { root } = world();
		spout(root, { rate: 60, maxParticles: 200, lifetime: 20, speed: 0.5, dir: [1, 0, 0] }, [0, 1, 0]);
		run(root, 90);
		const d = pourDebug()[0];
		expect(d.settled).toBeGreaterThan(5);
		expect(d.flying).toBeLessThan(d.count);
	});
	it('drops falling into water splash and are absorbed (a ripple each)', () => {
		const { root } = world();
		const pool = new THREE.Mesh(new THREE.BoxGeometry(4, 1, 4), new THREE.MeshBasicMaterial());
		pool.position.set(0, -0.5, 0); // surface y 0
		pool.userData.water = { version: 1, shape: 'box' };
		root.add(pool);
		pool.updateMatrixWorld(true);
		waterVolumes.setRoot(root);
		spout(root, { rate: 60, maxParticles: 200, lifetime: 20, speed: 0 }, [0, 1.5, 0]);
		run(root, 120);
		const d = pourDebug()[0];
		expect(d.splashes).toBeGreaterThan(20);
		expect(d.settled).toBe(0); // nothing settles ON the water
		expect(waterVolumes.ripplesOf(waterVolumes.list()[0]).length).toBeGreaterThan(0);
	});
});

describe('tank spill', () => {
	it('escaped particles become world drops, capped by the spill limit', () => {
		const { root } = world();
		const tank = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
		root.add(tank);
		const frame = new THREE.Matrix4().makeTranslation(2, 1, 0);
		const n = 100;
		const esc = new Float32Array(n * 6);
		for (let i = 0; i < n; i++) esc.set([0.1, 0.6, 0, 1, 0, 0], i * 6);
		const made = spillDrops(tank, esc, frame, new THREE.Quaternion(), { on: true, maxDrops: 40, lifetime: 5 });
		expect(made).toBe(40);
		run(root, 1);
		const s = pourDebug().find((x) => x.kind === 'spill');
		expect(s.count).toBe(40);
	});
});
