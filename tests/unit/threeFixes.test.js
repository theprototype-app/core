// @ts-nocheck
// 36-fb-water F14: a transmissive MeshPhysicalMaterial survives a JSON round trip.
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { pack } from 'peerjs-js-binarypack';

describe('threeFixes', () => {
	it('COUNTERFACTUAL: three alone loses attenuationDistance through JSON (null = black jelly)', () => {
		const m = new THREE.MeshPhysicalMaterial({ transmission: 0.35, thickness: 0.6 });
		// and toJSON carries Infinity itself, which the binarypack object wire cannot pack
		expect(m.toJSON().attenuationDistance).toBe(Infinity);
		expect(() => pack(m.toJSON())).toThrow(/Invalid integer/);
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
	it('36-int-125: with the fix toJSON omits the non-finite value, so the peer wire packs it and a reader gets Infinity', async () => {
		await import('../../src/lib/threeFixes.js');
		const m = new THREE.MeshPhysicalMaterial({ transmission: 0.35, thickness: 0.6 });
		const json = m.toJSON();
		expect('attenuationDistance' in json).toBe(false);
		expect(() => pack(json)).not.toThrow();
		expect(new THREE.MaterialLoader().parse(json).attenuationDistance).toBe(Infinity);
		// an object (the shape sendObject puts on the wire) packs too, and a finite value still travels
		const mesh = new THREE.Mesh(new THREE.BoxGeometry(), m);
		expect(() => pack(mesh.toJSON())).not.toThrow();
		m.attenuationDistance = 2.5;
		expect(m.toJSON().attenuationDistance).toBe(2.5);
	});
});
