// @ts-nocheck — plain descriptors
import { describe, it, expect } from 'vitest';
import { similarKey, matchesSimilar, renamePlan, randomisePlan, seeded } from '../../src/lib/tidyCore.js';
import { normalizeLayers, lockedLayerIds, LAYERS_MAX } from '../../src/lib/layersCore.js';
import { isSeeThrough } from '../../src/lib/selectThrough.js';

// 102b-arrange row 2: select similar, rename many, randomise, the layer table, the lock pass.

describe('select similar', () => {
	const box = { gtype: 'Box', matType: 'MeshStandardMaterial', color: 'ff0000', tags: ['coin', 'gold'], layer: 'L1' };
	it('keys per rule', () => {
		expect(similarKey(box, 'shape')).toBe('prim:Box');
		expect(similarKey({ geomType: 'BufferGeometry', verts: 24 }, 'shape')).toBe('geo:BufferGeometry:24');
		expect(similarKey(box, 'material')).toBe('MeshStandardMaterial:ff0000:0');
		expect(similarKey({ materialId: 'm1', matType: 'x' }, 'material')).toBe('id:m1');
		expect(similarKey({ prefab: 'p9' }, 'prefab')).toBe('p9');
		expect(similarKey({}, 'prefab')).toBeNull();
	});
	it('tags match on any shared tag', () => {
		expect(matchesSimilar({ tags: ['gold'] }, 'tag', ['coin', 'gold'])).toBe(true);
		expect(matchesSimilar({ tags: ['silver'] }, 'tag', ['coin', 'gold'])).toBe(false);
		expect(matchesSimilar({}, 'layer', 'L1')).toBe(false);
	});
});

describe('renamePlan', () => {
	it('counts with padding and keeps the old name on request', () => {
		expect(renamePlan(['a', 'b', 'c'], 'Post {n}', 1, 2)).toEqual(['Post 01', 'Post 02', 'Post 03']);
		expect(renamePlan(['Box', 'Box'], '{name}-{n}', 5)).toEqual(['Box-5', 'Box-6']);
	});
	it('adds a counter when the pattern has none, and never returns empty names', () => {
		expect(renamePlan(['a', 'b'], 'Fence')).toEqual(['Fence 1', 'Fence 2']);
		expect(renamePlan(['a'], '')).toEqual(['a 1']);
	});
});

describe('randomisePlan', () => {
	const poses = [0, 1, 2].map((i) => ({ pos: [i, 0, 0], rot: [0, 0, 0], scale: [1, 1, 1] }));
	it('is seeded and stays inside the ranges', () => {
		const a = randomisePlan(poses, { rot: [0, 90, 0], scale: [0.5, 2], offset: [1, 0, 1], seed: 7 });
		const b = randomisePlan(poses, { rot: [0, 90, 0], scale: [0.5, 2], offset: [1, 0, 1], seed: 7 });
		expect(a).toEqual(b);
		for (const [i, p] of a.entries()) {
			expect(Math.abs(p.rot[1])).toBeLessThanOrEqual(Math.PI / 2 + 1e-9);
			expect(p.rot[0]).toBe(0);
			expect(p.scale[0]).toBeGreaterThanOrEqual(0.5);
			expect(p.scale[0]).toBeLessThanOrEqual(2);
			expect(p.scale[0]).toBe(p.scale[2]); // uniform
			expect(Math.abs(p.pos[0] - i)).toBeLessThanOrEqual(1);
			expect(p.pos[1]).toBe(0);
		}
	});
	it('nothing asked = nothing changes; another seed = another result', () => {
		expect(randomisePlan(poses, {})).toEqual(poses);
		expect(randomisePlan(poses, { rot: [0, 90, 0], seed: 1 })).not.toEqual(randomisePlan(poses, { rot: [0, 90, 0], seed: 2 }));
	});
	it('the generator is the duplicateCore one', () => {
		const r = seeded(1);
		expect(r()).toBeGreaterThanOrEqual(0);
		expect(r()).toBeLessThan(1);
	});
});

describe('layers', () => {
	it('normalizes the table', () => {
		const t = normalizeLayers([{ id: 'a', name: '  Walls ', color: '#FF0000', locked: true }, { id: 'a' }, { id: '', name: 'x' }, { id: 'b', color: 'red' }]);
		expect(t).toEqual([
			{ id: 'a', name: 'Walls', color: '#ff0000', locked: true },
			{ id: 'b', name: 'Layer', color: expect.stringMatching(/^#[0-9a-f]{6}$/) }
		]);
		expect(normalizeLayers([])).toBeNull();
		expect(normalizeLayers('x')).toBeNull();
		expect(normalizeLayers(Array.from({ length: 99 }, (_, i) => ({ id: 'l' + i }))).length).toBe(LAYERS_MAX);
	});
	it('a locked layer is click-through only when the pass carries it', () => {
		const target = { userData: { layer: 'a' } };
		const hit = { object: { visible: true, material: { opacity: 1 } } };
		const pass = { water: true, transparent: false, triggers: false };
		expect(isSeeThrough(hit, target, pass)).toBe(false);
		expect(isSeeThrough(hit, target, { ...pass, lockedLayers: lockedLayerIds([{ id: 'a', locked: true }]) })).toBe(true);
		expect(isSeeThrough(hit, { userData: { layer: 'b' } }, { ...pass, lockedLayers: new Set(['a']) })).toBe(false);
	});
});
