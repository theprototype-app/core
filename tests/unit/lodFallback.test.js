// @ts-nocheck — plain fixtures; the code under test is typed
// 40 F14: a FALLBACK LOD group — the object's own (simplified) meshes are LOD0 and draw only
// while the real model's levels are unavailable; the pick runs over levels 1..n.
import { describe, it, expect } from 'vitest';
import { normalizeLodGroup, pickFallbackLevel, pickGroupLevel, thresholdsOf, withThreshold } from '../../src/lib/lodGroupCore.js';
import { addLodTree, removeLodTree, lodTreesOf, allLodTrees, onLodTreesChanged } from '../../src/lib/lodTrees.js';

const BLOCK = {
	fallback: true,
	levels: [
		{ source: 'self', screenSize: 0.9 },
		{ source: 'pack', ref: 'aquarium-kit/FishClown/fish-clown.glb', screenSize: 0.06 },
		{ source: 'pack', ref: 'aquarium-kit/FishClown/fish-clown.lod1.glb', screenSize: 0.025 },
		{ source: 'pack', ref: 'aquarium-kit/FishClown/fish-clown.lod2.glb', screenSize: 0.01 }
	]
};

describe('fallback LOD groups', () => {
	it('normalize keeps the flag (2+ levels only) and withThreshold keeps it too', () => {
		const g = normalizeLodGroup(BLOCK);
		expect(g.fallback).toBe(true);
		expect(g.levels[0].source).toBe('self');
		expect(normalizeLodGroup({ fallback: true, levels: [{ source: 'self' }] }).fallback).toBeUndefined();
		expect(normalizeLodGroup({ ...BLOCK, fallback: 'yes' }).fallback).toBeUndefined();
		expect(withThreshold(g, 2, 0.03).fallback).toBe(true);
	});
	it('never picks LOD0 by size: close = level 1, far = the coarse levels', () => {
		const g = normalizeLodGroup(BLOCK);
		const { thresholds } = thresholdsOf(g);
		expect(pickFallbackLevel(2, thresholds, 1)).toBe(1); // filling the screen: still the real model
		expect(pickFallbackLevel(0.3, thresholds, 1)).toBe(1);
		expect(pickFallbackLevel(0.04, thresholds, 1)).toBe(2);
		expect(pickFallbackLevel(0.015, thresholds, 2)).toBe(3);
		expect(pickFallbackLevel(0.001, thresholds, 3)).toBe(3); // no cull: stays on the last
		expect(pickFallbackLevel(0.001, thresholds, 3, { cull: true })).toBe(-1);
		// the counterfactual: an ordinary group with the same thresholds DOES pick LOD0 up close
		expect(pickGroupLevel(2, thresholds, 0)).toBe(0);
	});
	it('keeps hysteresis in the shifted numbering (coming back finer needs the band)', () => {
		const g = normalizeLodGroup(BLOCK);
		const { thresholds } = thresholdsOf(g);
		const edge = thresholds[1];
		expect(pickFallbackLevel(edge * 0.99, thresholds, 1)).toBe(2);
		expect(pickFallbackLevel(edge * 1.05, thresholds, 2)).toBe(2); // inside the 15 % band
		expect(pickFallbackLevel(edge * 1.2, thresholds, 2)).toBe(1);
	});
	it('the substitute registry: per object, all, and change listeners', () => {
		const root = {};
		const tree = { uuid: 't' };
		let n = 0;
		const off = onLodTreesChanged(() => n++);
		addLodTree(root, tree);
		expect(lodTreesOf(root)).toEqual([tree]);
		expect(allLodTrees()).toContain(tree);
		removeLodTree(root, tree);
		expect(lodTreesOf(root)).toEqual([]);
		expect(n).toBe(2);
		off();
	});
});
