import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { meshStats } from '../../src/lib/ai/meshStats.js';

describe('meshStats (list_scene, mcp-shapes item 5)', () => {
	it('counts and boxes a mesh in its own space and in the scene', () => {
		const root = new THREE.Group();
		const g = new THREE.Group();
		g.position.set(10, 0, 0);
		root.add(g);
		const box = new THREE.Mesh(new THREE.BoxGeometry(2, 1, 1));
		box.position.set(0, 1, 0);
		g.add(box);
		root.updateMatrixWorld(true);
		expect(meshStats(box)).toEqual({
			vertexCount: 24,
			faceCount: 12,
			bounds: { local: [[-1, -0.5, -0.5], [1, 0.5, 0.5]], world: [[9, 0.5, -0.5], [11, 1.5, 0.5]] }
		});
	});
	it('a non-indexed soup counts every corner; groups and lights have none', () => {
		const geo = new THREE.BufferGeometry();
		geo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
		const tri = new THREE.Mesh(geo);
		tri.updateMatrixWorld(true);
		expect(meshStats(tri)).toMatchObject({ vertexCount: 3, faceCount: 1 });
		expect(meshStats(new THREE.Group())).toBeNull();
		expect(meshStats(new THREE.PointLight())).toBeNull();
	});
});
