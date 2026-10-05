// @ts-nocheck
// 36-fb-water F14: a transmissive MeshPhysicalMaterial survives a JSON round trip.
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';

describe('threeFixes', () => {
	it('COUNTERFACTUAL: three alone loses attenuationDistance through JSON (null = black jelly)', () => {
		const m = new THREE.MeshPhysicalMaterial({ transmission: 0.35, thickness: 0.6 });
		const json = JSON.parse(JSON.stringify(m.toJSON()));
		expect(json.attenuationDistance).toBeNull();
		const back = new THREE.MaterialLoader().parse(json);
		expect(back.attenuationDistance).toBeNull();
	});
	it('with the fix the loader restores Infinity, and a finite value is kept', async () => {
		await import('../../src/lib/threeFixes.js');
		const m = new THREE.MeshPhysicalMaterial({ transmission: 0.35, thickness: 0.6 });
		const back = new THREE.MaterialLoader().parse(JSON.parse(JSON.stringify(m.toJSON())));
		expect(back.attenuationDistance).toBe(Infinity);
		m.attenuationDistance = 2.5;
		expect(new THREE.MaterialLoader().parse(JSON.parse(JSON.stringify(m.toJSON()))).attenuationDistance).toBe(2.5);
		// a standard material has no such field and is untouched
		const s = new THREE.MaterialLoader().parse(JSON.parse(JSON.stringify(new THREE.MeshStandardMaterial().toJSON())));
		expect(s.attenuationDistance).toBeUndefined();
	});
});
