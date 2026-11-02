// 54i u: flipping renderer.shadowMap.enabled must mark every material for recompile —
// three bakes the shadow state into the program and does not re-check it per draw.
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { setShadowMapEnabled } from '../../src/lib/lightParams.js';

function sceneWith() {
	const scene = new THREE.Scene();
	const a = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
	const b = new THREE.Mesh(new THREE.BoxGeometry(), [new THREE.MeshStandardMaterial(), new THREE.MeshBasicMaterial()]);
	const g = new THREE.Group(); g.add(b); scene.add(a, g);
	return { scene, mats: [a.material, ...b.material] };
}

describe('setShadowMapEnabled', () => {
	it('a flip marks every material (single and array) for update', () => {
		const { scene, mats } = sceneWith();
		const before = mats.map((m) => m.version);
		const renderer = { shadowMap: { enabled: true, needsUpdate: false } };
		expect(setShadowMapEnabled(renderer, false, scene)).toBe(true);
		expect(renderer.shadowMap.enabled).toBe(false);
		expect(renderer.shadowMap.needsUpdate).toBe(true);
		mats.forEach((m, i) => expect(m.version).toBeGreaterThan(before[i]));
	});
	it('no change = no recompile', () => {
		const { scene, mats } = sceneWith();
		const before = mats.map((m) => m.version);
		const renderer = { shadowMap: { enabled: false, needsUpdate: false } };
		expect(setShadowMapEnabled(renderer, false, scene)).toBe(false);
		mats.forEach((m, i) => expect(m.version).toBe(before[i]));
	});
	it('no renderer is a no-op', () => {
		expect(setShadowMapEnabled(null, true, new THREE.Scene())).toBe(false);
	});
});
