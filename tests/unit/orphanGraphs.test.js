import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { flowGraphs, orphanGraphIds, graphTotals, SCENE_GRAPH } from '../../src/stores/flowStore';
import { objectsGroup } from '../../src/stores/sceneStore';

describe('orphan object graphs (55, 1.48.1 Q1)', () => {
	it("an object graph whose owner left the scene is an orphan; the count leaves it out; an undo brings it back", () => {
		const group = new THREE.Group();
		const box = new THREE.Mesh();
		const nested = new THREE.Group();
		const inner = new THREE.Mesh();
		nested.add(inner);
		group.add(box, nested);
		objectsGroup.set(group);
		const n = (/** @type {string} */ id) => ({ id, type: 'spin', position: { x: 0, y: 0 }, data: {} });
		flowGraphs.set({
			[SCENE_GRAPH]: { nodes: [n('s1')], edges: [] },
			[box.uuid]: { nodes: [n('b1'), n('b2')], edges: [] },
			[inner.uuid]: { nodes: [n('i1')], edges: [] },
			gone: { nodes: [n('g1')], edges: [] }
		});
		expect([...orphanGraphIds()]).toEqual(['gone']);
		expect(graphTotals()).toBe(4);
		group.remove(box);
		expect([...orphanGraphIds()].sort()).toEqual(['gone', box.uuid].sort());
		expect(graphTotals()).toBe(2);
		group.add(box); // the undo
		expect([...orphanGraphIds()]).toEqual(['gone']);
	});
	it('no scene yet: nothing is judged', () => {
		objectsGroup.set(/** @type {any} */ (null));
		expect(orphanGraphIds().size).toBe(0);
	});
});
