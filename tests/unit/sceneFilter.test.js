import { describe, it, expect } from 'vitest';
import * as THREE from 'three';

import { sceneFilter, cursorOffset, cursorAt } from '../../src/lib/ai/sceneFilter.js';

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

describe('85b R7: bounds + paging cursors', () => {
	it('bounds: world position inside the box (corners in any order)', () => {
		const a = obj('a', [1, 1, 1]);
		expect(sceneFilter({ bounds: { min: [0, 0, 0], max: [2, 2, 2] } })?.(a)).toBe(true);
		expect(sceneFilter({ bounds: { min: [2, 2, 2], max: [0, 0, 0] } })?.(a)).toBe(true);
		expect(sceneFilter({ bounds: { min: [2, 0, 0], max: [3, 2, 2] } })?.(a)).toBe(false);
		expect(sceneFilter({ bounds: { min: [0, 0], max: [2, 2, 2] } })).toBe(null);
	});
	it('a cursor is an offset; junk starts over', () => {
		expect(cursorOffset(cursorAt(40))).toBe(40);
		expect(cursorOffset('nope')).toBe(0);
		expect(cursorOffset(undefined)).toBe(0);
	});
});

describe('mcp-diorama2 28: near / bounds test the world mesh bounds when asked', () => {
	// a 10 m wall along x, its origin at x = 0
	const wall = new THREE.Mesh(new THREE.BoxGeometry(10, 2, 0.2), new THREE.MeshStandardMaterial());
	wall.name = 'Long wall';
	wall.position.set(0, 1, 0);
	const lamp = new THREE.PointLight();
	lamp.position.set(4, 1, 0);
	it('bounds: origin misses a wall crossing in; touches finds it; inside wants all of it', () => {
		const box = { min: [3, 0, -1], max: [8, 3, 1] };
		expect(sceneFilter({ bounds: box })?.(wall)).toBe(false);
		expect(sceneFilter({ bounds: { ...box, by: 'touches' } })?.(wall)).toBe(true);
		expect(sceneFilter({ bounds: { ...box, by: 'inside' } })?.(wall)).toBe(false);
		expect(sceneFilter({ bounds: { min: [-6, 0, -1], max: [6, 3, 1], by: 'inside' } })?.(wall)).toBe(true);
		// a light draws nothing: its origin decides
		expect(sceneFilter({ bounds: { ...box, by: 'inside' } })?.(lamp)).toBe(true);
	});
	it('near: touches = any part within the radius; inside = all of it', () => {
		const near = { position: [5, 1, 0], radius: 1 };
		expect(sceneFilter({ near })?.(wall)).toBe(false);
		expect(sceneFilter({ near: { ...near, by: 'touches' } })?.(wall)).toBe(true);
		expect(sceneFilter({ near: { ...near, by: 'inside' } })?.(wall)).toBe(false);
		expect(sceneFilter({ near: { position: [0, 1, 0], radius: 6, by: 'inside' } })?.(wall)).toBe(true);
	});
});
