// @ts-nocheck — scene fixtures built ad hoc (the checkJs rule for test fixtures)
// mcp-diorama2 (item 8): scatter's `avoid` holes and the placements `scatter {source}` copies an object to — the
// same seeded generator the instances use, so a seed gives the same spots, and nothing lands inside an avoid rect.
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';

const { scatterPlacements, avoidRects } = await import('../../src/lib/terrainSurface.js');

/** a flat 10 x 10 m floor mesh (its top at y = 0) */
function floor() {
	const g = new THREE.PlaneGeometry(10, 10, 10, 10);
	g.rotateX(-Math.PI / 2);
	return new THREE.Mesh(g, new THREE.MeshStandardMaterial());
}
const spots = (mesh, set) => scatterPlacements(mesh, set, true).map((m) => new THREE.Vector3().setFromMatrixPosition(m));

describe('diorama2 scatter avoid + placements', () => {
	it('the same seed gives the same spots; another seed another layout', () => {
		const m = floor();
		const a = spots(m, { seed: 5, gen: { count: 20, rot: true, scaleMin: 1, scaleMax: 1 } });
		const b = spots(m, { seed: 5, gen: { count: 20, rot: true, scaleMin: 1, scaleMax: 1 } });
		const c = spots(m, { seed: 6, gen: { count: 20, rot: true, scaleMin: 1, scaleMax: 1 } });
		expect(a.length).toBe(20);
		expect(a.map((v) => v.toArray().join())).toEqual(b.map((v) => v.toArray().join()));
		expect(a.map((v) => v.toArray().join())).not.toEqual(c.map((v) => v.toArray().join()));
		for (const v of a) expect(Math.abs(v.y)).toBeLessThan(0.01);
	});

	it('nothing lands inside an avoid rectangle (host-local x/z)', () => {
		const m = floor();
		const hole = [-2, -2, 2, 2];
		const all = spots(m, { seed: 3, gen: { density: 2, rot: true, scaleMin: 1, scaleMax: 1 } });
		const kept = spots(m, { seed: 3, gen: { density: 2, rot: true, scaleMin: 1, scaleMax: 1, avoid: [hole] } });
		const inside = (v) => v.x >= hole[0] && v.x <= hole[2] && v.z >= hole[1] && v.z <= hole[3];
		expect(all.some(inside)).toBe(true);
		expect(kept.some(inside)).toBe(false);
		expect(kept.length).toBeGreaterThan(0);
	});

	it('avoidRects keeps up to 16 well-formed rectangles', () => {
		expect(avoidRects({ avoid: [[0, 0, 1, 1], [1, 'x', 2, 2], [3, 3, 2, 4]] })).toEqual([[0, 0, 1, 1]]);
		expect(avoidRects(undefined)).toEqual([]);
		expect(avoidRects({ avoid: Array.from({ length: 20 }, () => [0, 0, 1, 1]) }).length).toBe(16);
	});
});
