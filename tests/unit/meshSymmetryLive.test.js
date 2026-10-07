// @ts-nocheck — fixture geometry built ad hoc (the checkJs rule for test fixtures)
// 37 R11: LIVE symmetry's pure pieces — `mirrorTrisCore` (the half Symmetrize and the live
// mode share) and `editSide` (which side of the plane an edit happened on). The live mode
// itself is session plumbing and is driven end to end by e2e `mesh-symmetry-live`.
//
// The gate is the mesh gate (watertight + consistently wound) plus SYMMETRY: every vertex
// of the result has a twin at its mirror position.
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { readTriangles, mirrorTrisCore, editSide, trisToUVs } from '$lib/faceEdit.js';

const keyOf = (v) => `${Math.round(v.x * 1e4)},${Math.round(v.y * 1e4)},${Math.round(v.z * 1e4)}`;
const ek = (a, b) => (a < b ? a + '|' + b : b + '|' + a);

function oddEdges(tris) {
	const use = new Map();
	for (const t of tris)
		for (let e = 0; e < 3; e++) {
			const k = ek(keyOf(t[e]), keyOf(t[(e + 1) % 3]));
			use.set(k, (use.get(k) || 0) + 1);
		}
	return [...use.values()].filter((n) => n !== 2).length;
}

function sameWayEdges(tris) {
	const seen = new Set();
	let bad = 0;
	for (const t of tris)
		for (let e = 0; e < 3; e++) {
			const k = keyOf(t[e]) + '>' + keyOf(t[(e + 1) % 3]);
			if (seen.has(k)) bad++;
			seen.add(k);
		}
	return bad;
}

/** vertices with no twin across x = 0 */
function asymmetricVertices(tris) {
	const keys = new Set();
	for (const t of tris) for (const v of t) keys.add(keyOf(v));
	let lonely = 0;
	for (const t of tris)
		for (const v of t) if (!keys.has(keyOf(new THREE.Vector3(-v.x, v.y, v.z)))) lonely++;
	return lonely;
}

const box = () => readTriangles(new THREE.BoxGeometry(2, 2, 2));

/** push every vertex with x below `limit` further out by `by` — an "edit" on the -x side */
function pullLeft(tris, limit, by) {
	return tris.map((t) => {
		const out = t.map((v) => (v.x < limit ? new THREE.Vector3(v.x - by, v.y, v.z) : v.clone()));
		if (t.uv) out.uv = t.uv;
		out.mi = t.mi;
		return out;
	});
}

describe('mirrorTrisCore', () => {
	it('a plain box: clipped at the plane, mirrored, watertight and symmetric', () => {
		const result = mirrorTrisCore(box(), null, 'x', 1, 1e-5);
		expect(result).not.toBeNull();
		expect(result.clipped).toBeGreaterThan(0); // a box has no vertex on x = 0
		expect(oddEdges(result.tris)).toBe(0);
		expect(sameWayEdges(result.tris)).toBe(0);
		expect(asymmetricVertices(result.tris)).toBe(0);
		expect(trisToUVs(result.tris).length).toBe(result.tris.length * 6);
	});

	it('`kept` maps a wholly-kept triangle to an IDENTICAL output triangle', () => {
		const tris = mirrorTrisCore(box(), null, 'x', 1, 1e-5).tris; // seam on the plane now
		const again = mirrorTrisCore(tris, null, 'x', 1, 1e-5);
		expect(again.kept.size).toBeGreaterThan(0);
		for (const [from, to] of again.kept) {
			expect(again.tris[to].map(keyOf)).toEqual(tris[from].map(keyOf));
		}
	});

	it('nothing on the kept side: null', () => {
		const right = box().filter((t) => t.every((v) => v.x > 0.5)); // the +x face only
		expect(mirrorTrisCore(right, null, 'x', -1, 1e-5)).toBeNull();
	});
});

describe('editSide', () => {
	it('names the side an edit CHANGED, either way round', () => {
		const sym = mirrorTrisCore(box(), null, 'x', 1, 1e-5).tris;
		expect(editSide(sym, pullLeft(sym, -0.5, 0.4), 'x')).toBe(-1);
		const pushedRight = sym.map((t) => t.map((v) => (v.x > 0.5 ? new THREE.Vector3(v.x + 0.4, v.y, v.z) : v.clone())));
		expect(editSide(sym, pushedRight, 'x')).toBe(1);
	});

	it('an edit ON the plane (or the same on both sides) is balanced: null', () => {
		const sym = mirrorTrisCore(box(), null, 'x', 1, 1e-5).tris;
		const lifted = sym.map((t) => t.map((v) => (v.y > 0.5 ? new THREE.Vector3(v.x, v.y + 0.5, v.z) : v.clone())));
		expect(editSide(sym, lifted, 'x')).toBeNull();
		expect(editSide(sym, sym, 'x')).toBeNull(); // no change at all
	});
});

describe('live symmetry: the edited side wins', () => {
	it('an edit on -x is mirrored to +x (and keeping a FIXED +x side would have thrown it away)', () => {
		const sym = mirrorTrisCore(box(), null, 'x', 1, 1e-5).tris;
		const edited = pullLeft(sym, -0.5, 0.4); // the -x face now sits at x = -1.4
		const side = editSide(sym, edited, 'x');
		const live = mirrorTrisCore(edited, null, 'x', side, 1e-5);
		expect(oddEdges(live.tris)).toBe(0);
		expect(sameWayEdges(live.tris)).toBe(0);
		expect(asymmetricVertices(live.tris)).toBe(0);
		const maxX = Math.max(...live.tris.flatMap((t) => t.map((v) => v.x)));
		const minX = Math.min(...live.tris.flatMap((t) => t.map((v) => v.x)));
		expect(maxX).toBeCloseTo(1.4, 6);
		expect(minX).toBeCloseTo(-1.4, 6);
		// the counterfactual: always keeping +x (the one-shot command's default) restores the
		// OLD -x half over the user's edit
		const fixed = mirrorTrisCore(edited, null, 'x', 1, 1e-5);
		const fixedMin = Math.min(...fixed.tris.flatMap((t) => t.map((v) => v.x)));
		expect(fixedMin).toBeCloseTo(-1, 6);
	});
});
