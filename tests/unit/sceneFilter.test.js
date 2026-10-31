import { describe, it, expect } from 'vitest';
import * as THREE from 'three';

import { sceneFilter } from '../../src/lib/ai/sceneFilter.js';

/** @param {string} name @param {number[]} pos @param {string} [gtype] */
const obj = (name, pos, gtype) => {
	const m = new THREE.Mesh();
	m.name = name;
	m.position.fromArray(pos);
	if (gtype) m.userData.geometryParams = { gtype, params: {} };
	return m;
};

describe('list_scene filters (55, 1.48.1)', () => {
	const wall = obj('North Wall', [0, 1, 5], 'Wall');
	const door = obj('Front door', [10, 0, 0], 'Box');
	it('none = null (the plain summary)', () => expect(sceneFilter({})).toBe(null));
	it('name: a glob, or contains; case-insensitive', () => {
		expect(sceneFilter({ name: '*wall' })?.(wall)).toBe(true);
		expect(sceneFilter({ name: 'wall*' })?.(wall)).toBe(false);
		expect(sceneFilter({ name: 'DOOR' })?.(door)).toBe(true);
	});
	it('type: the three type or the primitive shape', () => {
		expect(sceneFilter({ type: 'wall' })?.(wall)).toBe(true);
		expect(sceneFilter({ type: 'Mesh' })?.(door)).toBe(true);
		expect(sceneFilter({ type: 'Group' })?.(door)).toBe(false);
	});
	it('near: world position within radius, nested objects too', () => {
		const g = new THREE.Group();
		g.position.set(100, 0, 0);
		const child = obj('kid', [1, 0, 0]);
		g.add(child);
		expect(sceneFilter({ near: { position: [101, 0, 0], radius: 0.5 } })?.(child)).toBe(true);
		expect(sceneFilter({ near: { position: [1, 0, 0], radius: 0.5 } })?.(child)).toBe(false);
		expect(sceneFilter({ near: { position: [0, 0, 0], radius: 6 }, name: 'wall' })?.(wall)).toBe(true);
	});
});
