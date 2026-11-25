// @ts-nocheck — fixture geometry built ad hoc (the checkJs rule for test fixtures)
// Lane 99-scrub: a mesh's first grab commit stores its derived partition from the geometry's own frame
// (`derivedPartnerOf`) instead of `pairQuads(readTriangles(g))` (67k triangle objects at 67k). The pairing must be
// the same, element for element, on every shape the editor meets: indexed and not, multi-slot, uv-split, skinned.
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { readTriangles, pairQuads, derivedPartnerOf } from '$lib/faceEdit.js';
import { fixtureSet } from './fixtures/meshOps99Fixtures.js';

function multiSlotBox() {
	const g = new THREE.BoxGeometry(1, 1, 1, 2, 2, 2).toNonIndexed();
	g.clearGroups();
	const n = g.attributes.position.count;
	g.addGroup(0, n / 2, 0);
	g.addGroup(n / 2, n / 2, 1);
	return g;
}

const shapes = [
	...fixtureSet({ big: !!process.env.MESHOPS_BIG }).map((fx) => [fx.name, fx.make]),
	['indexed sphere 32x16', () => new THREE.SphereGeometry(1, 32, 16)],
	['non-indexed sphere 48x24', () => new THREE.SphereGeometry(1, 48, 24).toNonIndexed()],
	['plane 8x8', () => new THREE.PlaneGeometry(4, 4, 8, 8)],
	['torus', () => new THREE.TorusGeometry(1, 0.3, 12, 24)],
	['multi-slot box', multiSlotBox]
];

describe('99-scrub: derivedPartnerOf = pairQuads(readTriangles)', () => {
	for (const [name, make] of shapes)
		it(name, () => {
			const g = make();
			const want = pairQuads(readTriangles(g));
			const got = derivedPartnerOf(g);
			expect(got.length).toBe(want.length);
			expect(Array.from(got)).toEqual(Array.from(want));
			expect(Array.from(got).some((p) => p >= 0)).toBe(true); // something paired (the premise)
		});
});
