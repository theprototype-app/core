// @ts-nocheck — fixture geometry built ad hoc (the checkJs rule for test fixtures)
// B10 (36-mesh-ops): the CSG core — two geometries + world matrices in, the result
// in the TARGET's local frame out. Volumes are DERIVED from the box arithmetic, and
// the closed-in → closed-out rule is the gate (0 open welded edges).
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import * as csg from 'three-bvh-csg';
import { booleanGeometry, openEdgeCount } from '$lib/meshBooleanCore.js';
import { readTriangles } from '$lib/faceEdit.js';

const volume = (tris) => {
	let v = 0;
	for (const t of tris) v += t[0].dot(new THREE.Vector3().crossVectors(t[1], t[2])) / 6;
	return v;
};
const at = (x, y, z, s = 1) => new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion(), new THREE.Vector3(s, s, s));
const box = () => new THREE.BoxGeometry(1, 1, 1);

describe('booleanGeometry', () => {
	// two unit boxes offset by 0.5 on X overlap in a 0.5 x 1 x 1 slab
	const A = at(0, 0, 0);
	const B = at(0.5, 0, 0);

	it('union = 1 + 1 - 0.5, closed and outward', () => {
		const tris = readTriangles(booleanGeometry(csg, box(), A, box(), B, 'union'));
		expect(volume(tris)).toBeCloseTo(1.5, 4);
		expect(openEdgeCount(tris)).toBe(0);
	});

	it('subtract = 1 - 0.5, closed', () => {
		const tris = readTriangles(booleanGeometry(csg, box(), A, box(), B, 'subtract'));
		expect(volume(tris)).toBeCloseTo(0.5, 4);
		expect(openEdgeCount(tris)).toBe(0);
	});

	it('intersect = the 0.5 slab, closed', () => {
		const tris = readTriangles(booleanGeometry(csg, box(), A, box(), B, 'intersect'));
		expect(volume(tris)).toBeCloseTo(0.5, 4);
		expect(openEdgeCount(tris)).toBe(0);
	});

	it("the result is in the TARGET's local frame, whatever its transform", () => {
		// the same world arrangement, but the target sits at x = 3 scaled x2: its local
		// result must come back half-size and shifted so that, re-placed, it is the same
		const A2 = at(3, 0, 0, 2);
		const B2 = at(3.75, 0, 0, 1); // spans x 3.25..4.25: 0.75 into the target's 2..4
		const local = readTriangles(booleanGeometry(csg, new THREE.BoxGeometry(1, 1, 1), A2, box(), B2, 'subtract'));
		// world volume = 8 - (0.75 * 1 * 1) ; local volume = world / 2^3
		expect(volume(local)).toBeCloseTo((8 - 0.75) / 8, 4);
		expect(openEdgeCount(local)).toBe(0);
		const bounds = new THREE.Box3();
		for (const t of local) for (const v of t) bounds.expandByPoint(v);
		expect(bounds.min.x).toBeCloseTo(-0.5, 4);
		expect(bounds.max.x).toBeCloseTo(0.5, 4); // the cut is a notch, the far face stays
	});

	it('carries uvs when both inputs have them', () => {
		const g = booleanGeometry(csg, box(), A, box(), B, 'subtract');
		expect(g.getAttribute('uv')).toBeTruthy();
		expect(g.index).toBeNull();
	});

	it('counterfactual: the raw library output HAS T-junctions — the repair is load-bearing', () => {
		const a = new csg.Brush(box());
		const b = new csg.Brush(box());
		b.position.x = 0.5;
		a.updateMatrixWorld();
		b.updateMatrixWorld();
		const ev = new csg.Evaluator();
		ev.useGroups = false;
		const raw = ev.evaluate(a, b, csg.SUBTRACTION).geometry;
		expect(openEdgeCount(readTriangles(raw))).toBeGreaterThan(0);
	});

	it('a cylinder bored through a box: the exact polygon-prism hole, still closed', () => {
		const n = 24;
		const r = 0.25;
		// taller than the box, so it pierces both faces; the hole = an n-gon prism of height 1
		const tris = readTriangles(booleanGeometry(csg, box(), A, new THREE.CylinderGeometry(r, r, 2, n), at(0, 0, 0), 'subtract'));
		const hole = (n / 2) * r * r * Math.sin((2 * Math.PI) / n) * 1;
		expect(volume(tris)).toBeCloseTo(1 - hole, 4);
		expect(openEdgeCount(tris)).toBe(0);
	});

	it('disjoint intersect is empty (the wrapper refuses it)', () => {
		const tris = readTriangles(booleanGeometry(csg, box(), A, box(), at(5, 0, 0), 'intersect'));
		expect(tris.length).toBe(0);
	});
});
