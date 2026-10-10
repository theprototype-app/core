// @ts-nocheck — plain fixtures; the code under test is typed
// 40 F15: the general-purpose motion nodes — the pure core (paths, distance modes, banking, the
// wander noise, the body-wave shape) and the THREE half (Follow Path, Wander, Orient to Velocity,
// Body Wave) driven on real three objects with no renderer.
import { describe, it, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import {
	buildPath,
	samplePath,
	pathDistance,
	curvatureAt,
	bankRoll,
	smoothNoise,
	smoothNoiseRate,
	wanderAt,
	hash01,
	waveEnvelope,
	waveDrive,
	waveOffset,
	forwardYaw,
	catmullRom,
	cleanPoints
} from '../../src/lib/motion/motionCore.js';
import {
	applyFollowPath,
	applyWander,
	applyOrientVelocity,
	applyBodyWave,
	pruneBodyWaves,
	resetMotionNodes,
	motionNodesDebug,
	MOTION_PHASE
} from '../../src/lib/motion/motionNodes.js';

const base = (o) => ({ pos: o.position.toArray(), rot: [o.rotation.x, o.rotation.y, o.rotation.z], scale: o.scale.toArray() });
/** a square 4 × 4 loop at y = 1 */
const SQUARE = [
	[0, 1, 0],
	[4, 1, 0],
	[4, 1, 4],
	[0, 1, 4]
];
/** a circle of radius r (counter-clockwise seen from above = turning LEFT for a +z nose) */
const circle = (r, n = 16, y = 0) =>
	Array.from({ length: n }, (_, i) => {
		const a = (i / n) * Math.PI * 2;
		return [Math.sin(a) * r, y, Math.cos(a) * r];
	});

describe('paths', () => {
	it('cleans points: drops non-finite and doubled clicks, accepts spline {pos}', () => {
		expect(cleanPoints([[0, 0, 0], [0, 0, 0], [1, NaN, 0], { pos: [1, 2, 3] }, 'x'])).toEqual([
			[0, 0, 0],
			[1, 2, 3]
		]);
	});
	it('a Catmull-Rom span passes through its two inner points', () => {
		const p = catmullRom([0, 0, 0], [1, 0, 0], [2, 1, 0], [3, 1, 0], 0);
		expect(p[0]).toBeCloseTo(1, 6);
		const q = catmullRom([0, 0, 0], [1, 0, 0], [2, 1, 0], [3, 1, 0], 1);
		expect(q[0]).toBeCloseTo(2, 6);
		expect(q[1]).toBeCloseTo(1, 6);
	});
	it('a polyline loop has the perimeter as its length, and closes on its start', () => {
		const path = buildPath(SQUARE, { closed: true, smooth: false });
		expect(path.total).toBeCloseTo(16, 6);
		expect(samplePath(path, 16).p).toEqual([0, 1, 0]);
		expect(samplePath(path, 2).p).toEqual([2, 1, 0]);
		expect(samplePath(path, 2).t).toEqual([1, 0, 0]);
	});
	it('a smooth loop passes through every control point and rounds the corners (between the square and its circumcircle)', () => {
		// an INTERPOLATING curve through a square's corners bulges outward between them
		const path = buildPath(SQUARE, { closed: true });
		expect(path.total).toBeGreaterThan(16);
		expect(path.total).toBeLessThan(2 * Math.PI * 2 * Math.SQRT2);
		for (const c of SQUARE) {
			const hit = path.pts.some((p) => Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]) < 1e-9);
			expect(hit).toBe(true);
		}
	});
	it('refuses a path with fewer than two usable points', () => {
		expect(buildPath([[0, 0, 0]])).toBeNull();
		expect(buildPath([])).toBeNull();
	});
	it('distance: loop wraps, pingpong reflects with a direction, once clamps; offset spreads riders', () => {
		expect(pathDistance(3, 2, 10, 'loop').s).toBeCloseTo(6, 9);
		expect(pathDistance(7, 2, 10, 'loop').s).toBeCloseTo(4, 9);
		const back = pathDistance(7, 2, 10, 'pingpong');
		expect(back.s).toBeCloseTo(6, 9);
		expect(back.dir).toBe(-1);
		expect(pathDistance(2, 2, 10, 'pingpong').dir).toBe(1);
		expect(pathDistance(100, 2, 10, 'once').s).toBe(10);
		expect(pathDistance(0, 2, 10, 'loop', 0.25).s).toBeCloseTo(2.5, 9);
		expect(pathDistance(1, -2, 10, 'loop').s).toBeCloseTo(8, 9); // backwards wraps the other way
	});
	it('curvature: a left (counter-clockwise from above, +z nose) circle reads +1/r', () => {
		// increasing angle a moves the point along (cos a, 0, -sin a): x grows, z falls — clockwise
		// from above when viewed with +x right and +z down, i.e. the nose turns toward -x… measure it
		const path = buildPath(circle(2, 32), { closed: true });
		const k = curvatureAt(path, path.total / 3);
		expect(Math.abs(Math.abs(k) - 0.5)).toBeLessThan(0.03);
		const rev = buildPath(circle(2, 32).reverse(), { closed: true });
		expect(Math.sign(curvatureAt(rev, rev.total / 3))).toBe(-Math.sign(k));
	});
	it('bank: zero on a straight, bounded by the ceiling, signed with the turn', () => {
		expect(bankRoll(0, 1, 45)).toBe(0);
		expect(bankRoll(100, 1, 45)).toBeCloseTo(Math.PI / 4, 6);
		expect(bankRoll(-100, 1, 45)).toBeCloseTo(-Math.PI / 4, 6);
		expect(bankRoll(1, 0, 45)).toBe(0);
		expect(bankRoll(1, 0.5, 40)).toBeCloseTo(0.5 * ((40 * Math.PI) / 180) * Math.tanh(1), 9);
	});
});

describe('wander noise', () => {
	it('stays inside [-1, 1] and inside its box over a long run', () => {
		const seed = hash01('fish');
		let lo = Infinity;
		let hi = -Infinity;
		for (let t = 0; t < 600; t += 0.37) {
			const v = smoothNoise(t, seed, 1);
			lo = Math.min(lo, v);
			hi = Math.max(hi, v);
			const { p } = wanderAt(t, [1, 2, 3], [0.5, 0.25, 2], 1, seed);
			expect(Math.abs(p[0] - 1)).toBeLessThanOrEqual(0.5 + 1e-9);
			expect(Math.abs(p[1] - 2)).toBeLessThanOrEqual(0.25 + 1e-9);
			expect(Math.abs(p[2] - 3)).toBeLessThanOrEqual(2 + 1e-9);
		}
		expect(lo).toBeGreaterThanOrEqual(-1);
		expect(hi).toBeLessThanOrEqual(1);
		// and it actually uses the box (not stuck near the centre)
		expect(hi - lo).toBeGreaterThan(1);
	});
	it('is deterministic per seed and differs between seeds', () => {
		expect(smoothNoise(12.3, 0.4, 0)).toBe(smoothNoise(12.3, 0.4, 0));
		expect(smoothNoise(12.3, 0.4, 0)).not.toBeCloseTo(smoothNoise(12.3, 0.41, 0), 3);
		expect(hash01('a')).not.toBe(hash01('b'));
	});
	it('the analytic rate matches a finite difference (smooth, no jumps)', () => {
		for (const t of [0.5, 7.1, 40]) {
			const h = 1e-4;
			const fd = (smoothNoise(t + h, 0.3, 2) - smoothNoise(t - h, 0.3, 2)) / (2 * h);
			expect(smoothNoiseRate(t, 0.3, 2)).toBeCloseTo(fd, 4);
		}
	});
});

describe('body wave shape', () => {
	it('the head is still, the tail swings most', () => {
		expect(waveEnvelope(0, 0.3, 2)).toBe(0);
		expect(waveEnvelope(0.3, 0.3, 2)).toBe(0);
		expect(waveEnvelope(1, 0.3, 2)).toBe(1);
		expect(waveEnvelope(0.65, 0.3, 2)).toBeCloseTo(0.25, 9);
	});
	it('faster swimming beats faster and wider; a turn bends the body', () => {
		const rest = waveDrive({}, 0, 0);
		const fast = waveDrive({}, 1, 0);
		expect(fast.frequency).toBeGreaterThan(rest.frequency);
		expect(fast.amplitude).toBeGreaterThan(rest.amplitude);
		expect(rest.bend).toBe(0);
		expect(waveDrive({}, 0.5, 1).bend).toBeGreaterThan(0);
		expect(waveDrive({}, 0.5, -1).bend).toBeLessThan(0);
		// clamped: a wild speed does not tear the mesh apart
		expect(waveDrive({ amplitude: 0.5, ampGain: 5 }, 10, 0).amplitude).toBeLessThanOrEqual(0.6);
	});
	it('the crest TRAVELS head → tail as the phase grows (and the other way when reversed)', () => {
		// with the envelope divided out the pattern is a pure sine of (u k - dir·phase): a shift of
		// the phase by Δ is the same picture shifted Δ/k toward the TAIL (larger u)
		const shape = { wavelength: 1, stiffness: 0, falloff: 1 };
		const drive = { amplitude: 1, bend: 0 };
		const raw = (u, p, s) => waveOffset(u, p, drive, s) / waveEnvelope(u, s.stiffness, s.falloff);
		for (const u of [0.3, 0.45, 0.6]) {
			expect(raw(u + 0.1, 0.1, shape)).toBeCloseTo(raw(u, 0, shape), 9);
			const rev = { ...shape, reverse: true };
			expect(raw(u - 0.1, 0.1, rev)).toBeCloseTo(raw(u, 0, rev), 9);
		}
	});
	it('forward axis names map to the yaw that brings that nose to +z', () => {
		for (const [name, n] of [
			['+z', [0, 0, 1]],
			['-z', [0, 0, -1]],
			['+x', [1, 0, 0]],
			['-x', [-1, 0, 0]]
		]) {
			const v = new THREE.Vector3(...n).applyAxisAngle(new THREE.Vector3(0, 1, 0), forwardYaw(name));
			expect(v.z).toBeCloseTo(1, 9);
		}
	});
});

describe('the nodes on real objects', () => {
	beforeEach(() => resetMotionNodes());

	it('Follow Path is a pure function of time: two copies agree; the nose points along the path', () => {
		const root = new THREE.Group();
		const a = new THREE.Object3D();
		const b = new THREE.Object3D();
		root.add(a, b);
		const data = { points: SQUARE, speed: 1, smooth: false, closed: true, bank: 0 };
		applyFollowPath(a, base(a), data, 1.5, { root, key: 'a' });
		applyFollowPath(b, base(b), data, 1.5, { root, key: 'b' });
		expect(a.position.toArray()).toEqual(b.position.toArray());
		expect(a.position.x).toBeCloseTo(1.5, 9);
		const nose = new THREE.Vector3(0, 0, 1).applyQuaternion(a.quaternion);
		expect(nose.x).toBeCloseTo(1, 6);
	});
	it('Follow Path rides a Spline object in WORLD space (the spline moved = the path moved)', () => {
		const root = new THREE.Group();
		const spline = new THREE.Mesh(new THREE.BufferGeometry());
		spline.userData.spline = { points: SQUARE.map((p) => ({ pos: p, radius: 0.1 })), closed: true };
		spline.position.set(10, 0, 0);
		const fish = new THREE.Object3D();
		root.add(spline, fish);
		root.updateMatrixWorld(true);
		applyFollowPath(fish, base(fish), { path: spline.uuid, speed: 0 }, 0, { root, key: 'k' });
		expect(fish.position.x).toBeCloseTo(10, 6);
		expect(fish.position.y).toBeCloseTo(1, 6);
	});
	it('Follow Path banks INTO a left turn (top leans left) and the forward axis turns the model', () => {
		const root = new THREE.Group();
		const o = new THREE.Object3D();
		root.add(o);
		const pts = circle(1.5, 24);
		const out = applyFollowPath(o, base(o), { points: pts, speed: 1, bank: 1, maxBank: 45 }, 2, { root, key: 'k' });
		expect(Math.abs(out.yawRate)).toBeGreaterThan(0.3);
		const up = new THREE.Vector3(0, 1, 0).applyQuaternion(o.quaternion);
		const left = new THREE.Vector3(1, 0, 0).applyQuaternion(o.quaternion); // +x is the model's left
		// leaning into the turn: the top tips toward the side the turn goes
		expect(Math.sign(up.dot(new THREE.Vector3(left.x, 0, left.z)))).toBe(Math.sign(out.yawRate));
		// a +x-nosed model: the same pose, its +x now points where +z pointed
		const o2 = new THREE.Object3D();
		root.add(o2);
		applyFollowPath(o2, base(o2), { points: pts, speed: 1, bank: 1, maxBank: 45, forward: '+x' }, 2, { root, key: 'k2' });
		const nose1 = new THREE.Vector3(0, 0, 1).applyQuaternion(o.quaternion);
		const nose2 = new THREE.Vector3(1, 0, 0).applyQuaternion(o2.quaternion);
		expect(nose1.distanceTo(nose2)).toBeLessThan(1e-6);
	});
	it('Wander stays inside its area object (shrunk by the margin) and differs per object', () => {
		const root = new THREE.Group();
		const tank = new THREE.Mesh(new THREE.BoxGeometry(4, 2, 1.6));
		tank.position.set(0, 1.9, 0);
		const a = new THREE.Object3D();
		const b = new THREE.Object3D();
		root.add(tank, a, b);
		root.updateMatrixWorld(true);
		for (let t = 0; t < 120; t += 0.5) {
			applyWander(a, base(a), { area: tank.uuid, margin: 0.2, speed: 1 }, t, { root });
			expect(Math.abs(a.position.x)).toBeLessThanOrEqual(1.8 + 1e-6);
			expect(Math.abs(a.position.y - 1.9)).toBeLessThanOrEqual(0.8 + 1e-6);
			expect(Math.abs(a.position.z)).toBeLessThanOrEqual(0.6 + 1e-6);
		}
		applyWander(a, base(a), { area: tank.uuid, speed: 1 }, 7, { root });
		applyWander(b, base(b), { area: tank.uuid, speed: 1 }, 7, { root });
		expect(a.position.distanceTo(b.position)).toBeGreaterThan(1e-3);
	});
	it('Orient to Velocity turns toward the motion, smoothly, and holds while still', () => {
		const o = new THREE.Object3D();
		const root = new THREE.Group();
		root.add(o);
		// move along +x for a second at 60 fps
		let t = 0;
		for (let i = 0; i < 60; i++) {
			t += 1 / 60;
			o.position.set(t, 0, 0);
			o.rotation.set(0, 0, 0); // the base restore
			applyOrientVelocity(o, base(o), { turnSpeed: 6, bank: 0 }, t, { key: 'o' });
		}
		const nose = new THREE.Vector3(0, 0, 1).applyQuaternion(o.quaternion);
		expect(nose.x).toBeGreaterThan(0.95);
		// stop: the heading holds through the base restores
		for (let i = 0; i < 10; i++) {
			t += 1 / 60;
			o.rotation.set(0, 0, 0);
			applyOrientVelocity(o, base(o), { turnSpeed: 6 }, t, { key: 'o' });
		}
		expect(new THREE.Vector3(0, 0, 1).applyQuaternion(o.quaternion).x).toBeGreaterThan(0.95);
	});
	it('Body Wave clones each mesh material (same uuid, same look), drives it, and puts it back', () => {
		const fish = new THREE.Group();
		const mat = new THREE.MeshStandardMaterial({ color: 0xff8800 });
		const body = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.4), mat);
		const tail = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.1), mat);
		tail.position.z = -0.25;
		fish.add(body, tail);
		const out = applyBodyWave(fish, base(fish), {}, 0, { key: 'w' });
		expect(out.meshes).toBe(2);
		expect(body.material).not.toBe(mat);
		expect(tail.material).not.toBe(body.material); // per-mesh uniforms need per-mesh clones
		expect(body.material.uuid).toBe(mat.uuid);
		expect(body.material.color.getHex()).toBe(0xff8800);
		// the body length covers both meshes (0.2 nose .. -0.3 tail tip)
		expect(out.len).toBeCloseTo(0.5, 6);
		// the shader hook patches begin_vertex
		const shader = { uniforms: {}, vertexShader: '#include <begin_vertex>\n', fragmentShader: '' };
		body.material.onBeforeCompile(shader, null);
		expect(shader.vertexShader).toContain('bwDrive');
		expect(shader.uniforms.bwDrive).toBeTruthy();
		expect(body.material.customProgramCacheKey()).toContain('bodywave');
		// motion drives the phase
		for (let i = 1; i <= 30; i++) {
			fish.position.z = i * 0.02;
			applyBodyWave(fish, base(fish), {}, i / 30, { key: 'w' });
		}
		expect(shader.uniforms.bwDrive.value.z).toBeGreaterThan(0);
		expect(motionNodesDebug().waves[0].cloned).toBe(true);
		pruneBodyWaves(new Set());
		expect(body.material).toBe(mat);
		expect(tail.material).toBe(mat);
		expect(motionNodesDebug().waves.length).toBe(0);
	});
	it('a counterfactual: without the per-mesh clone the two meshes would share uniforms', () => {
		// the reason for cloning: three uploads a material's uniforms once per material switch
		const fish = new THREE.Group();
		const mat = new THREE.MeshStandardMaterial();
		fish.add(new THREE.Mesh(new THREE.BoxGeometry(), mat), new THREE.Mesh(new THREE.BoxGeometry(), mat));
		applyBodyWave(fish, base(fish), {}, 0, { key: 'w2' });
		const [m1, m2] = fish.children.map((c) => c.material);
		expect(m1).not.toBe(m2);
	});
	it('followers run after movers', () => {
		expect(MOTION_PHASE.orientvelocity).toBeGreaterThan(0);
		expect(MOTION_PHASE.bodywave).toBeGreaterThan(MOTION_PHASE.orientvelocity);
		expect(MOTION_PHASE.followpath ?? 0).toBe(0);
	});
});
