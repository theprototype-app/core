// @ts-nocheck — fixture geometry built ad hoc (the checkJs rule for test fixtures)
// 19-A P6 (36-mesh-ops): the pure cores of the five local operators — edge slide,
// vertex connect (J-cut), dissolve vertices, fill hole, solidify. Triangles in,
// triangles out: no session, no scene, so they run here in node next to the e2e
// suite that drives the same cores through the toolbox (mesh-advanced-ops).
//
// The gate for every operator is WATERTIGHTNESS — the welded edges used other than
// twice must be exactly the ones that were open before (0 on a closed box) — plus
// consistent WINDING: on a closed result every welded edge is walked once each way.
// Every expected number is derived from the fixture, never pasted from a run.
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
	readTriangles,
	pairQuads,
	edgeSlideCore,
	connectVerticesCore,
	dissolveVerticesCore,
	fillHoleCore,
	solidifyCore
} from '$lib/faceEdit.js';

const keyOf = (v) => `${Math.round(v.x * 1e4)},${Math.round(v.y * 1e4)},${Math.round(v.z * 1e4)}`;
const ek = (a, b) => (a < b ? a + '|' + b : b + '|' + a);
const vkey = (x, y, z) => keyOf({ x, y, z });

/** welded edges used other than exactly twice */
function oddEdges(tris) {
	const use = new Map();
	for (const t of tris)
		for (let e = 0; e < 3; e++) {
			const k = ek(keyOf(t[e]), keyOf(t[(e + 1) % 3]));
			use.set(k, (use.get(k) || 0) + 1);
		}
	return [...use.values()].filter((n) => n !== 2).length;
}

/** directed welded edges walked the same way twice — 0 = consistently wound */
function sameWayEdges(tris) {
	const seen = new Map();
	let bad = 0;
	for (const t of tris)
		for (let e = 0; e < 3; e++) {
			const k = keyOf(t[e]) + '>' + keyOf(t[(e + 1) % 3]);
			if (seen.has(k)) bad++;
			seen.set(k, true);
		}
	return bad;
}

/** signed volume — positive when a closed mesh is wound outward */
function volume(tris) {
	let v = 0;
	for (const t of tris) v += t[0].dot(new THREE.Vector3().crossVectors(t[1], t[2])) / 6;
	return v;
}

/** "stored else derived" for a fixture: the pairQuads pairing as a partition */
function partitionOf(tris) {
	const partner = pairQuads(tris);
	const faces = [];
	const claimed = new Uint8Array(tris.length);
	for (let ti = 0; ti < tris.length; ti++) {
		if (claimed[ti]) continue;
		const mate = partner[ti];
		if (mate > ti && !claimed[mate]) {
			claimed[ti] = claimed[mate] = 1;
			faces.push([ti, mate]);
		} else {
			claimed[ti] = 1;
			faces.push([ti]);
		}
	}
	return faces;
}

const box = () => readTriangles(new THREE.BoxGeometry(1, 1, 1));
/** a w x h grid of unit quads in the XY plane, facing +Z */
const grid = (w, h) => readTriangles(new THREE.PlaneGeometry(w, h, w, h));
/** the box with its +Y quad removed — an open top with a 4-edge rim */
function openBox() {
	return box().filter((t) => !t.every((v) => Math.abs(v.y - 0.5) < 1e-6));
}

describe('edge slide', () => {
	// a 3x3 grid; the vertical line x = -0.5 runs between quads its whole length
	const tris = grid(3, 3);
	const faces = partitionOf(tris);
	const chain = [];
	for (const y of [-1.5, -0.5, 0.5]) chain.push(ek(vkey(-0.5, y, 0), vkey(-0.5, y + 1, 0)));
	const xsOf = (out) => {
		const xs = new Set();
		for (const t of out) for (const v of t) if (Math.abs(v.x + 0.5) < 0.6 && Math.abs(v.x + 0.5) > 1e-6 && Math.abs(v.x + 1.5) > 1e-6 && Math.abs(v.x - 0.5) > 1e-6) xs.add(v.x.toFixed(4));
		return xs;
	};

	it('factor 0 moves nothing but resolves every rail', () => {
		const r = edgeSlideCore(tris, faces, chain, { factor: 0 });
		expect(r.moved).toBe(4);
		expect(r.poles).toBe(0);
		expect(r.tris.map((t) => t.map(keyOf).join()).join()).toBe(tris.map((t) => t.map(keyOf).join()).join());
	});

	it('±1 lands the whole line on one neighbour line or the other', () => {
		const plus = edgeSlideCore(tris, faces, chain, { factor: 1 });
		const minus = edgeSlideCore(tris, faces, chain, { factor: -1 });
		const lineX = (out) => {
			// every key of the moved line: the new edge keys' x
			const xs = new Set();
			for (const k of out.newEdgeKeys) for (const p of k.split('|')) xs.add(Number(p.split(',')[0]) / 1e4);
			return [...xs];
		};
		const a = lineX(plus);
		const b = lineX(minus);
		expect(a.length).toBe(1);
		expect(b.length).toBe(1);
		expect([a[0], b[0]].sort((p, q) => p - q)).toEqual([-1.5, 0.5]);
	});

	it('±0.5 lands halfway, the triangle count and the open border unchanged', () => {
		const r = edgeSlideCore(tris, faces, chain, { factor: 0.5 });
		const xs = new Set();
		for (const k of r.newEdgeKeys) for (const p of k.split('|')) xs.add(Number(p.split(',')[0]) / 1e4);
		expect(xs.size).toBe(1);
		expect([-1, 0]).toContain([...xs][0]);
		expect(r.tris.length).toBe(tris.length);
		expect(oddEdges(r.tris)).toBe(oddEdges(tris));
		expect(sameWayEdges(r.tris)).toBe(0);
		void xsOf;
	});

	it('a box edge is all poles on the side whose rail is the next picked edge', () => {
		const b = box();
		const top = [
			ek(vkey(-0.5, 0.5, -0.5), vkey(0.5, 0.5, -0.5)),
			ek(vkey(0.5, 0.5, -0.5), vkey(0.5, 0.5, 0.5))
		];
		const r = edgeSlideCore(b, partitionOf(b), top, { factor: 0.5 });
		const s = edgeSlideCore(b, partitionOf(b), top, { factor: -0.5 });
		// the corner vertex they share has a rail on exactly one side; the two far ends
		// have one rail per side — so one direction moves 3 vertices, the other 2
		expect([r.moved, s.moved].sort()).toEqual([2, 3]);
		expect(oddEdges(r.tris)).toBe(0);
		expect(oddEdges(s.tris)).toBe(0);
	});
});

describe('connect (J-cut)', () => {
	it('two opposite corners of a box face split it into two faces, nothing else changes', () => {
		const b = box();
		const faces = partitionOf(b);
		const r = connectVerticesCore(b, faces, vkey(-0.5, 0.5, -0.5), vkey(0.5, 0.5, 0.5));
		expect('error' in r).toBe(false);
		expect(r.tris.length).toBe(12);
		expect(r.faces.length).toBe(faces.length + 1);
		expect(oddEdges(r.tris)).toBe(0);
		expect(sameWayEdges(r.tris)).toBe(0);
		expect(volume(r.tris)).toBeCloseTo(1, 6);
		// the cut is a real edge of both new faces
		const cut = ek(vkey(-0.5, 0.5, -0.5), vkey(0.5, 0.5, 0.5));
		const owners = r.faces.filter((f) =>
			f.some((ti) => [0, 1, 2].some((e) => ek(keyOf(r.tris[ti][e]), keyOf(r.tris[ti][(e + 1) % 3])) === cut))
		);
		expect(owners.length).toBe(2);
	});

	it('a 5-corner face splits into a triangle and a quad', () => {
		// a 2x1 grid's bottom row dissolved into one pentagon-ish face is overkill; a
		// plain 2x1 strip is ONE stored hexagon face when its partition says so
		const tris = grid(2, 1);
		const faces = [[0, 1, 2, 3]];
		const r = connectVerticesCore(tris, faces, vkey(-1, -0.5, 0), vkey(0, 0.5, 0));
		expect('error' in r).toBe(false);
		const sizes = r.faces.map((f) => f.length).sort();
		expect(sizes).toEqual([1, 3]); // the triangle and the pentagon (6 corners - 1 cut)
		expect(oddEdges(r.tris)).toBe(oddEdges(tris));
		expect(sameWayEdges(r.tris)).toBe(0);
	});

	it('refuses neighbours and vertices that share no face, by rule', () => {
		const b = box();
		const faces = partitionOf(b);
		const near = connectVerticesCore(b, faces, vkey(-0.5, 0.5, -0.5), vkey(0.5, 0.5, -0.5));
		expect(near.error).toMatch(/already share an edge/);
		const far = connectVerticesCore(b, faces, vkey(-0.5, 0.5, -0.5), vkey(0.5, -0.5, 0.5));
		expect(far.error).toMatch(/SAME face/);
	});
});

describe('dissolve vertices', () => {
	it('the centre of a 2x2 grid: four quads become ONE octagon face', () => {
		const tris = grid(2, 2);
		const r = dissolveVerticesCore(tris, partitionOf(tris), [vkey(0, 0, 0)]);
		expect(r.done).toBe(1);
		expect(r.tris.length).toBe(6); // 8 corners -> 6 fan triangles
		expect(r.faces.length).toBe(1);
		expect(oddEdges(r.tris)).toBe(8); // the open border, untouched
		expect(sameWayEdges(r.tris)).toBe(0);
		expect(r.tris.every((t) => t.every((v) => keyOf(v) !== vkey(0, 0, 0)))).toBe(true);
		// the octagon's edge midpoints are collinear with its corners: a corner start
		// would emit zero-area slivers, so the best-start fan has none
		for (const t of r.tris) {
			const area = new THREE.Vector3().subVectors(t[1], t[0]).cross(new THREE.Vector3().subVectors(t[2], t[0])).length() / 2;
			expect(area).toBeGreaterThan(1e-6);
		}
	});

	it('a box corner: three quads become one hexagon, still closed and outward', () => {
		const b = box();
		const r = dissolveVerticesCore(b, partitionOf(b), [vkey(0.5, 0.5, 0.5)]);
		expect(r.done).toBe(1);
		expect(r.tris.length).toBe(12 - 6 + 4);
		expect(oddEdges(r.tris)).toBe(0);
		expect(sameWayEdges(r.tris)).toBe(0);
		expect(volume(r.tris)).toBeGreaterThan(0);
	});

	it('a two-edge vertex (an edge midpoint) leaves BOTH faces, which stay separate', () => {
		// a tent: two non-coplanar faces sharing edge A-B with a midpoint M on it
		const A = new THREE.Vector3(0, 0, 0);
		const B = new THREE.Vector3(2, 0, 0);
		const M = new THREE.Vector3(1, 0, 0);
		const C = new THREE.Vector3(1, 1, 1);
		const D = new THREE.Vector3(1, 1, -1);
		const tris = [
			[A.clone(), M.clone(), C.clone()],
			[M.clone(), B.clone(), C.clone()],
			[B.clone(), M.clone(), D.clone()],
			[M.clone(), A.clone(), D.clone()]
		].map((t) => Object.assign(t, { mi: 0 }));
		const r = dissolveVerticesCore(tris, [[0, 1], [2, 3]], [keyOf(M)]);
		expect(r.done).toBe(1);
		expect(r.faces.length).toBe(2);
		expect(r.tris.length).toBe(2);
		expect(sameWayEdges(r.tris)).toBe(0);
		const shared = r.tris.filter((t) => [0, 1, 2].some((e) => ek(keyOf(t[e]), keyOf(t[(e + 1) % 3])) === ek(keyOf(A), keyOf(B))));
		expect(shared.length).toBe(2);
	});

	it('two picks on one face both land (the partition travels between keys)', () => {
		const tris = grid(3, 1);
		const r = dissolveVerticesCore(tris, partitionOf(tris), [vkey(-0.5, 0.5, 0), vkey(0.5, 0.5, 0)]);
		expect(r.done).toBe(2);
		expect(oddEdges(r.tris)).toBe(oddEdges(tris) - 2);
		expect(sameWayEdges(r.tris)).toBe(0);
	});
});

describe('fill hole', () => {
	const rim = [
		ek(vkey(-0.5, 0.5, -0.5), vkey(0.5, 0.5, -0.5)),
		ek(vkey(0.5, 0.5, -0.5), vkey(0.5, 0.5, 0.5)),
		ek(vkey(0.5, 0.5, 0.5), vkey(-0.5, 0.5, 0.5)),
		ek(vkey(-0.5, 0.5, 0.5), vkey(-0.5, 0.5, -0.5))
	];

	it('the four rim edges of an open box: a convex quad cap, closed and outward', () => {
		const tris = openBox();
		expect(oddEdges(tris)).toBe(4);
		const r = fillHoleCore(tris, rim);
		expect('error' in r).toBe(false);
		expect(r.centroid).toBe(false);
		expect(r.cap.length).toBe(2);
		expect(oddEdges(r.tris)).toBe(0);
		expect(sameWayEdges(r.tris)).toBe(0);
		expect(volume(r.tris)).toBeCloseTo(1, 6);
	});

	it('ONE picked rim edge fills its whole loop', () => {
		const r = fillHoleCore(openBox(), [rim[2]]);
		expect('error' in r).toBe(false);
		expect(r.loopKeys.length).toBe(4);
		expect(oddEdges(r.tris)).toBe(0);
	});

	it('a concave L-shaped hole is fanned from its centroid, wound with its neighbours', () => {
		// 4x4 grid, three quads of an L removed from the middle
		const all = grid(4, 4);
		const inQuad = (t, cx, cy) => {
			const c = t[0].clone().add(t[1]).add(t[2]).multiplyScalar(1 / 3);
			return c.x > cx && c.x < cx + 1 && c.y > cy && c.y < cy + 1;
		};
		const tris = all.filter((t) => !(inQuad(t, -1, -1) || inQuad(t, 0, -1) || inQuad(t, -1, 0)));
		const border = oddEdges(tris);
		const edgeL = ek(vkey(-1, -1, 0), vkey(0, -1, 0));
		const r = fillHoleCore(tris, [edgeL]);
		expect('error' in r).toBe(false);
		expect(r.loopKeys.length).toBe(8);
		expect(r.centroid).toBe(true);
		expect(oddEdges(r.tris)).toBe(border - 8);
		expect(sameWayEdges(r.tris)).toBe(0);
		// every cap triangle faces +Z like the grid
		for (const i of r.cap) {
			const t = r.tris[i];
			const n = new THREE.Vector3().subVectors(t[1], t[0]).cross(new THREE.Vector3().subVectors(t[2], t[0]));
			expect(n.z).toBeGreaterThan(0);
		}
	});

	it('refuses interior edges and loops that do not close', () => {
		const tris = openBox();
		expect(fillHoleCore(box(), [rim[0]]).error).toMatch(/BORDER/);
		expect(fillHoleCore(tris, [rim[0], rim[1]]).error).toMatch(/loop/i);
	});
});

describe('solidify', () => {
	it('a single quad becomes a closed slab of the asked thickness, wound outward', () => {
		const tris = grid(1, 1);
		const r = solidifyCore(tris, [0, 1], { thickness: 0.25 });
		expect('error' in r).toBe(false);
		expect(r.tris.length).toBe(2 + 2 + 4 * 2);
		expect(oddEdges(r.tris)).toBe(0);
		expect(sameWayEdges(r.tris)).toBe(0);
		expect(volume(r.tris)).toBeCloseTo(0.25, 6);
		// positive = INTO the surface: the back sits at z = -thickness
		const zs = new Set(r.tris.flatMap((t) => t.map((v) => v.z.toFixed(4))));
		expect([...zs].sort()).toEqual(['-0.2500', '0.0000']);
	});

	it('an open box thickens into closed walls; a negative thickness grows outward', () => {
		const tris = openBox();
		const all = tris.map((_, i) => i);
		const r = solidifyCore(tris, all, { thickness: 0.1 });
		expect(oddEdges(r.tris)).toBe(0);
		expect(sameWayEdges(r.tris)).toBe(0);
		const out = solidifyCore(tris, all, { thickness: -0.1 });
		expect(oddEdges(out.tris)).toBe(0);
		expect(sameWayEdges(out.tris)).toBe(0);
	});

	it('a closed box gets a hollow inner shell and no rim', () => {
		const tris = box();
		const r = solidifyCore(tris, tris.map((_, i) => i), { thickness: 0.1 });
		expect(r.tris.length).toBe(24);
		expect(r.rimFrom).toBe(24);
		expect(oddEdges(r.tris)).toBe(0);
		expect(sameWayEdges(r.tris)).toBe(0);
	});

	it('refuses a patch whose border is shared with unpicked faces', () => {
		const tris = box();
		const top = tris.map((t, i) => (t.every((v) => Math.abs(v.y - 0.5) < 1e-6) ? i : -1)).filter((i) => i >= 0);
		expect(solidifyCore(tris, top, { thickness: 0.1 }).error).toMatch(/OPEN surface/);
	});
});
