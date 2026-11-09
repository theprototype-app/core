// 78 PL32 — the near-avatar fade and the joiner's side step (pure halves)
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { nearFadeAlpha, sideStepSpot, fadeAvatar, NEAR_FADE, JOIN_CLEARANCE } from '../../src/lib/nearAvatars.js';

describe('nearFadeAlpha', () => {
	it('is gone inside the hide distance, full past the full distance, linear between', () => {
		expect(nearFadeAlpha(0)).toBe(0);
		expect(nearFadeAlpha(NEAR_FADE.hide)).toBe(0);
		expect(nearFadeAlpha(NEAR_FADE.full)).toBe(1);
		expect(nearFadeAlpha(10)).toBe(1);
		expect(nearFadeAlpha((NEAR_FADE.hide + NEAR_FADE.full) / 2)).toBeCloseTo(0.5);
		expect(nearFadeAlpha(NaN)).toBe(1);
	});
});

describe('sideStepSpot', () => {
	const right = [1, 0, 0];
	it('keeps an eye that is already clear', () => {
		const eye = [0, 2, 3];
		expect(sideStepSpot(eye, right, [[5, 2, 3]])).toBe(eye);
		expect(sideStepSpot(eye, right, [])).toBe(eye);
	});
	it('steps 1.5 m to the right of an avatar on the same spot, height kept', () => {
		expect(sideStepSpot([0, 2, 3], right, [[0, 2, 3]])).toEqual([1.5, 2, 3]);
	});
	it('tries left when the right is taken, then further out', () => {
		expect(sideStepSpot([0, 2, 3], right, [[0, 2, 3], [1.5, 2, 3]])).toEqual([-1.5, 2, 3]);
		expect(sideStepSpot([0, 2, 3], right, [[0, 2, 3], [1.5, 2, 3], [-1.5, 2, 3]])).toEqual([3, 2, 3]);
	});
	it('every result is clear of every avatar', () => {
		const others = [[0, 2, 3], [1.4, 2, 3.2]];
		const p = sideStepSpot([0.2, 2, 3], right, others);
		for (const o of others) expect(Math.hypot(o[0] - p[0], o[1] - p[1], o[2] - p[2])).toBeGreaterThanOrEqual(JOIN_CLEARANCE);
	});
	it('steps sideways only, even when the camera looks down', () => {
		// a right vector with height in it is flattened onto the floor
		const p = sideStepSpot([0, 2, 0], [0.6, 0.8, 0], [[0, 2, 0]]);
		expect(p[1]).toBe(2);
		expect(p[0]).toBeCloseTo(1.5);
	});
});

describe('fadeAvatar', () => {
	const make = () => {
		const root = new THREE.Group();
		const mat = new THREE.MeshBasicMaterial({ opacity: 0.8 });
		const mesh = new THREE.Mesh(new THREE.BoxGeometry(), mat);
		mesh.castShadow = true;
		root.add(mesh);
		return { root, mat, mesh };
	};
	it('fades in place and puts every value back at alpha 1', () => {
		const { root, mat, mesh } = make();
		fadeAvatar([root], 0.5);
		expect(mesh.material).toBe(mat);
		expect(mat.transparent).toBe(true);
		expect(mat.opacity).toBeCloseTo(0.4);
		expect(mat.depthWrite).toBe(false);
		fadeAvatar([root], 0.25);
		expect(mat.opacity).toBeCloseTo(0.2);
		fadeAvatar([root], 1);
		expect(mat.opacity).toBeCloseTo(0.8);
		expect(mat.transparent).toBe(false);
		expect(mat.depthWrite).toBe(true);
		expect(mat.userData.__fadeBase).toBeUndefined();
		expect(mesh.castShadow).toBe(true);
	});
	it('a fully faded body casts no shadow', () => {
		const { root, mesh } = make();
		fadeAvatar([root], 0);
		expect(mesh.castShadow).toBe(false);
		fadeAvatar([root], 1);
		expect(mesh.castShadow).toBe(true);
	});
	it('leaves instanced meshes (shared dizzy stars) and a never-faded avatar alone', () => {
		const shared = new THREE.MeshBasicMaterial();
		const root = new THREE.Group();
		root.add(new THREE.InstancedMesh(new THREE.BoxGeometry(), shared, 2));
		fadeAvatar([root, null], 0.3);
		expect(shared.transparent).toBe(false);
		const { root: r2, mat } = make();
		fadeAvatar([r2], 1);
		expect(mat.opacity).toBeCloseTo(0.8);
		expect(mat.userData.__fadeBase).toBeUndefined();
	});
});
