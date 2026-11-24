// 80a-fix4-ui G16: see-through materials load see-through. The showcase scenes (lighthouse beams, the winter aurora
// band) were written with an opacity below 1 and no `transparent` flag, which three draws SOLID. The load path
// (loadGuard.parseCheckedObject, every scene / autosave / import parse) now infers the flag.
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { parseCheckedObject, seeThroughFromOpacity } from '../../src/lib/loadGuard.js';

/** a mesh saved as toJSON, its material forced to `fields` (as a script writing the file would) @param {any} fields */
function saved(fields) {
	const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
	mesh.name = 'beam';
	const json = /** @type {any} */ (mesh.toJSON());
	Object.assign(json.materials[0], fields);
	return json;
}

describe('G16 see-through materials load see-through', () => {
	it('opacity 0.1 saved without the flag (the showcase beams) loads transparent', () => {
		const o = /** @type {any} */ (parseCheckedObject(saved({ opacity: 0.1, transparent: false }), 'file', 'scene'));
		expect(o.material.opacity).toBeCloseTo(0.1);
		expect(o.material.transparent).toBe(true);
	});
	it('the counterfactual: three alone keeps it solid', () => {
		const o = /** @type {any} */ (new THREE.ObjectLoader().parse(saved({ opacity: 0.1, transparent: false })));
		expect(o.material.transparent).toBe(false);
	});
	it('a save -> reload round trip stays see-through', () => {
		const first = /** @type {any} */ (parseCheckedObject(saved({ opacity: 0.35, transparent: false }), 'file', 'scene'));
		const again = /** @type {any} */ (parseCheckedObject(first.toJSON(), 'file', 'scene'));
		expect(again.material.transparent).toBe(true);
		expect(again.material.opacity).toBeCloseTo(0.35);
	});
	it('left alone: opaque, already transparent, opacity 0, alpha hash', () => {
		expect(/** @type {any} */ (parseCheckedObject(saved({ opacity: 1, transparent: false }), 'file', 'scene')).material.transparent).toBe(false);
		expect(/** @type {any} */ (parseCheckedObject(saved({ opacity: 0.5, transparent: true }), 'file', 'scene')).material.transparent).toBe(true);
		expect(/** @type {any} */ (parseCheckedObject(saved({ opacity: 0, transparent: false }), 'file', 'scene')).material.transparent).toBe(false);
		const hashed = new THREE.MeshStandardMaterial({ opacity: 0.5, alphaHash: true });
		expect(seeThroughFromOpacity(hashed)).toBe(false);
		expect(hashed.transparent).toBe(false);
	});
	it('a multi-material mesh: each slot on its own', () => {
		const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), [new THREE.MeshStandardMaterial(), new THREE.MeshStandardMaterial()]);
		const json = /** @type {any} */ (mesh.toJSON());
		json.materials[1].opacity = 0.2;
		const o = /** @type {any} */ (parseCheckedObject(json, 'file', 'scene'));
		expect(o.material.map((/** @type {any} */ m) => m.transparent)).toEqual([false, true]);
	});
});
