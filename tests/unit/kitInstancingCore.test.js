// @ts-nocheck — plain fixtures; the module under test is typed
// 33-scenes — the pure half of kit instancing (src/lib/kitInstancingCore.js): the column key
// and its inverse, the material signature a recolour must change, and every rule that keeps a
// mesh out of a batch.
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { cellKey, cellOf, materialSignature, ineligible, CELL_METRES, MIN_BATCH } from '../../src/lib/kitInstancingCore.js';

describe('cellKey', () => {
	it('round-trips the column centre and both shadow flags', () => {
		for (const [x, z] of [[0, 0], [7.9, -7.9], [8.1, 30], [-100, 250], [1999, -1999]])
			for (const cast of [false, true])
				for (const receive of [false, true]) {
					const c = cellOf(cellKey(x, z, cast, receive));
					expect(Math.abs(c.x - x)).toBeLessThanOrEqual(CELL_METRES / 2);
					expect(Math.abs(c.z - z)).toBeLessThanOrEqual(CELL_METRES / 2);
					expect(c.cast).toBe(cast);
					expect(c.receive).toBe(receive);
				}
	});
	it('columns are centred on the origin, so a level authored around it is ONE column', () => {
		const half = CELL_METRES / 2;
		const k = cellKey(0, 0, true, true);
		expect(cellKey(-half + 0.01, half - 0.01, true, true)).toBe(k);
		expect(cellKey(half - 0.01, -half + 0.01, true, true)).toBe(k);
		expect(cellKey(half + 0.01, 0, true, true)).not.toBe(k);
		expect(cellKey(-half - 0.01, 0, true, true)).not.toBe(k);
	});
	it('the shadow flags split a column (a no-shadow copy cannot share a shadow-casting draw)', () => {
		expect(cellKey(1, 1, true, true)).not.toBe(cellKey(1, 1, false, true));
		expect(cellKey(1, 1, true, true)).not.toBe(cellKey(1, 1, true, false));
	});
	it('is a safe integer far from the origin and clamps beyond the world', () => {
		expect(Number.isSafeInteger(cellKey(1e6, -1e6, true, false))).toBe(true);
		expect(cellKey(1e9, 0, false, false)).toBe(cellKey(2e9, 0, false, false));
	});
	it('a batch needs at least two members', () => {
		expect(MIN_BATCH).toBe(2);
	});
});

describe('materialSignature', () => {
	const base = () => {
		const m = new THREE.MeshStandardMaterial({ color: 0x806040, roughness: 0.8, metalness: 0.1 });
		m.map = new THREE.Texture();
		return m;
	};
	it('a clone draws the same pixels, so it signs the same (and shares the texture)', () => {
		const m = base();
		expect(materialSignature(m.clone())).toBe(materialSignature(m));
	});
	it('every edit a user can make changes it', () => {
		const m = base();
		const sig = materialSignature(m);
		const edits = [
			(c) => c.color.setHex(0x112233),
			(c) => (c.roughness = 0.2),
			(c) => (c.metalness = 1),
			(c) => c.emissive.setHex(0xff0000),
			(c) => (c.emissiveIntensity = 3),
			(c) => (c.map = null),
			(c) => (c.map = new THREE.Texture()),
			(c) => c.map.repeat.set(2, 2),
			(c) => (c.opacity = 0.5),
			(c) => (c.transparent = true),
			(c) => (c.side = THREE.DoubleSide),
			(c) => (c.wireframe = true),
			(c) => (c.normalMap = new THREE.Texture())
		];
		for (const edit of edits) {
			const c = m.clone();
			c.map = m.map; // clone() shares textures in three; keep the identity for the rest
			edit(c);
			expect(materialSignature(c)).not.toBe(sig);
		}
	});
	it('a different material TYPE never signs the same', () => {
		const a = new THREE.MeshStandardMaterial({ color: 0xffffff });
		const b = new THREE.MeshPhysicalMaterial({ color: 0xffffff });
		expect(materialSignature(a)).not.toBe(materialSignature(b));
	});
	it('nothing in, nothing out', () => {
		expect(materialSignature(null)).toBe('');
	});
});

describe('ineligible', () => {
	const make = () => {
		const geometry = new THREE.BoxGeometry(1, 1, 1);
		const material = new THREE.MeshStandardMaterial({ color: 0x808080 });
		const template = new THREE.Mesh(geometry.clone(), material.clone());
		const mesh = new THREE.Mesh(geometry, material);
		const source = { geometry, version: geometry.attributes.position.version, material, template, sig: materialSignature(template.material) };
		return { mesh, source };
	};
	it('a pristine copy is eligible', () => {
		expect(ineligible(make())).toBe('');
	});
	it('every rule names its reason', () => {
		const cases = [
			['not a mesh', (c) => (c.mesh = new THREE.Group())],
			['not a kit piece', (c) => (c.source = null)],
			['skinned or instanced', (c) => (c.mesh = Object.assign(c.mesh, { isInstancedMesh: true }))],
			['material slots', (c) => (c.mesh.material = [c.mesh.material])],
			['geometry replaced', (c) => (c.mesh.geometry = new THREE.BoxGeometry(2, 2, 2))],
			['geometry edited', (c) => c.mesh.geometry.attributes.position.needsUpdate = true],
			['material replaced', (c) => (c.mesh.material = c.mesh.material.clone())],
			['transparent', (c) => (c.mesh.material.transparent = true)],
			['material edited', (c) => c.mesh.material.color.setHex(0xff0000)],
			['selected', (c) => (c.selected = true)]
		];
		for (const [reason, edit] of cases) {
			const c = make();
			edit(c);
			expect(ineligible(c)).toBe(reason);
		}
	});
	it('morph targets keep a mesh out', () => {
		const c = make();
		c.mesh.geometry.morphAttributes.position = [c.mesh.geometry.attributes.position.clone()];
		expect(ineligible(c)).toBe('morph targets');
	});
});
