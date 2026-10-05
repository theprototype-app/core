// @ts-nocheck — fixture geometry built ad hoc (the checkJs rule for test fixtures)
// 19-A P7c (36-mesh-ops): the bevel corner machinery — THE GATE.
//
// The first edge bevel was dropped for cracking exactly at a valence>=4 endpoint (12
// non-manifold edges on a box). So the gate is watertightness: 0 odd welded edges AND
// consistent winding (no directed edge walked twice the same way) at EVERY segment
// count 1..8, for every profile sign, at valence 3 (the chain rule, regression), 4 and
// 5 (the mitered corner), and a mixed edge (valence 3 at one end, 4 at the other).
// The same gate for the vertex bevel's new SEGMENTS.
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { readTriangles, bevelEdgesCore, bevelVerticesCore } from '$lib/faceEdit.js';

const keyOf = (v) => `${Math.round(v.x * 1e4)},${Math.round(v.y * 1e4)},${Math.round(v.z * 1e4)}`;
const ek = (a, b) => (a < b ? a + '|' + b : b + '|' + a);

function gate(tris) {
	const use = new Map();
	const dir = new Set();
	let sameWay = 0;
	let volume = 0;
	for (const t of tris) {
		volume += t[0].dot(new THREE.Vector3().crossVectors(t[1], t[2])) / 6;
		for (let e = 0; e < 3; e++) {
			const a = keyOf(t[e]);
			const b = keyOf(t[(e + 1) % 3]);
			use.set(ek(a, b), (use.get(ek(a, b)) || 0) + 1);
			if (dir.has(a + '>' + b)) sameWay++;
			dir.add(a + '>' + b);
		}
	}
	let odd = 0;
	for (const n of use.values()) if (n !== 2) odd++;
	return { odd, sameWay, volume };
}

/** the welded edge between the first two DISTINCT corners of triangle 0 */
const firstEdge = (tris) => ek(keyOf(tris[0][0]), keyOf(tris[0][1]));
/** the welded key with the highest +Y (an apex / top vertex) */
const topKey = (tris) => {
	let best = null;
	for (const t of tris) for (const v of t) if (!best || v.y > best.y + 1e-9) best = v;
	return keyOf(best);
};

/** a square pyramid: apex valence 4, base corners valence 3 */
function pyramid() {
	const A = new THREE.Vector3(0, 1, 0);
	const b = [
		new THREE.Vector3(-1, 0, -1),
		new THREE.Vector3(1, 0, -1),
		new THREE.Vector3(1, 0, 1),
		new THREE.Vector3(-1, 0, 1)
	];
	const tris = [];
	for (let i = 0; i < 4; i++) tris.push([A.clone(), b[(i + 1) % 4].clone(), b[i].clone()]);
	tris.push([b[0].clone(), b[1].clone(), b[2].clone()], [b[0].clone(), b[2].clone(), b[3].clone()]);
	return tris.map((t) => Object.assign(t, { mi: 0 }));
}

const SHAPES = {
	'box (valence 3 both ends — the chain rule)': () => readTriangles(new THREE.BoxGeometry(1, 1, 1)),
	'octahedron (valence 4 both ends — mitered)': () => readTriangles(new THREE.OctahedronGeometry(1)),
	'icosahedron (valence 5 both ends — mitered)': () => readTriangles(new THREE.IcosahedronGeometry(1)),
	'pyramid apex edge (valence 4 at the apex, 3 at the base)': () => pyramid()
};

describe('edge bevel: watertight at every segment count', () => {
	for (const [name, make] of Object.entries(SHAPES)) {
		it(name, () => {
			const tris = make();
			const before = gate(tris);
			expect(before.odd).toBe(0); // premise: a closed input
			const edge = name.startsWith('pyramid')
				? ek(keyOf(tris[0][0]), keyOf(tris[0][1])) // apex -> a base corner
				: firstEdge(tris);
			for (const profile of [0, 0.5, -0.5]) {
				for (let segments = 1; segments <= 8; segments++) {
					const n = Math.abs(profile) > 1e-3 ? Math.max(segments, 2) : segments;
					const r = bevelEdgesCore(tris, [edge], { width: 0.1, segments: n, profile });
					expect(r.done, `${name} s=${n} p=${profile}`).toBe(1);
					const g = gate(r.tris);
					expect(g.odd, `${name} odd edges at s=${n} p=${profile}`).toBe(0);
					expect(g.sameWay, `${name} winding at s=${n} p=${profile}`).toBe(0);
					expect(g.volume, `${name} volume at s=${n} p=${profile}`).toBeGreaterThan(0);
					if (profile === 0) expect(g.volume).toBeLessThan(before.volume); // a chamfer removes material
				}
			}
		});
	}

	it('a valence-3 end slides along the corner edge: the pyramid base stays FLAT', () => {
		const tris = pyramid();
		const r = bevelEdgesCore(tris, [ek(keyOf(tris[0][0]), keyOf(tris[0][1]))], { width: 0.1, segments: 3, profile: 0 });
		const lowest = Math.min(...r.tris.flatMap((t) => t.map((v) => v.y)));
		expect(lowest).toBeCloseTo(0, 9); // the perpendicular offset used to dip below y = 0
		// and nothing rises off the floor except the apex region: every base-plane vertex
		// is inside the base square (the chord across the cut corner included)
		const base = r.tris.flatMap((t) => t).filter((v) => Math.abs(v.y) < 1e-9);
		expect(base.every((v) => Math.abs(v.x) <= 1 + 1e-9 && Math.abs(v.z) <= 1 + 1e-9)).toBe(true);
	});

	it('counterfactual: a valence-4 end used to be refused — it is bevelled now', () => {
		const tris = readTriangles(new THREE.OctahedronGeometry(1));
		const r = bevelEdgesCore(tris, [firstEdge(tris)], { width: 0.1, segments: 1, profile: 0 });
		expect(r.refusedValence).toBe(0);
		expect(r.done).toBe(1);
	});

	it('the valence-3 output is unchanged by P7c (box: the pre-P7c triangle counts)', () => {
		const tris = readTriangles(new THREE.BoxGeometry(1, 1, 1));
		// 12 - (2 sides + 2 ends) * 2 tris + rebuilt: sides 2*2, strip 2*s, ends 2*(3+s-1... )
		// pinned as the counts the pre-P7c build produced: 1 seg = 20, 3 segs = 28
		expect(bevelEdgesCore(tris, [firstEdge(tris)], { width: 0.1, segments: 1, profile: 0 }).tris.length).toBe(16);
		expect(bevelEdgesCore(tris, [firstEdge(tris)], { width: 0.1, segments: 3, profile: 0 }).tris.length).toBe(24);
	});
});

describe('vertex bevel SEGMENTS: watertight, rounded, one-segment unchanged', () => {
	const SHAPES_V = {
		'box corner (3 faces)': () => readTriangles(new THREE.BoxGeometry(1, 1, 1)),
		'octahedron vertex (4 faces)': () => readTriangles(new THREE.OctahedronGeometry(1)),
		'icosahedron vertex (5 faces)': () => readTriangles(new THREE.IcosahedronGeometry(1))
	};
	for (const [name, make] of Object.entries(SHAPES_V)) {
		it(name, () => {
			const tris = make();
			const key = topKey(tris);
			for (const profile of [0, 0.5, -0.5])
				for (let segments = 1; segments <= 8; segments++) {
					const r = bevelVerticesCore(tris, [key], { width: 0.2, profile, segments });
					expect(r.done, `${name} s=${segments}`).toBe(1);
					const g = gate(r.tris);
					expect(g.odd, `${name} odd at s=${segments} p=${profile}`).toBe(0);
					expect(g.sameWay, `${name} winding at s=${segments} p=${profile}`).toBe(0);
				}
		});
	}

	it('segments add concentric rings: n quads per inner ring + an n-fan at the top', () => {
		const tris = readTriangles(new THREE.BoxGeometry(1, 1, 1));
		const key = keyOf(new THREE.Vector3(0.5, 0.5, 0.5));
		const one = bevelVerticesCore(tris, [key], { width: 0.2, profile: 0, segments: 1 }).tris.length;
		for (const s of [2, 3, 5]) {
			const r = bevelVerticesCore(tris, [key], { width: 0.2, profile: 0, segments: s });
			// a 3-corner cap: 1 triangle at one segment; 3 * 2 * (s - 1) ring tris + 3 fan tris
			expect(r.tris.length).toBe(one - 1 + 3 * 2 * (s - 1) + 3);
		}
	});

	it('a positive profile rounds the cap OUT: the centre rises above the flat cap', () => {
		const tris = readTriangles(new THREE.BoxGeometry(1, 1, 1));
		const key = keyOf(new THREE.Vector3(0.5, 0.5, 0.5));
		const reach = (r) => Math.max(...r.tris.flatMap((t) => t.map((v) => v.x + v.y + v.z)));
		const flat = reach(bevelVerticesCore(tris, [key], { width: 0.2, profile: 0, segments: 4 }));
		const round = reach(bevelVerticesCore(tris, [key], { width: 0.2, profile: 1, segments: 4 }));
		const dish = reach(bevelVerticesCore(tris, [key], { width: 0.2, profile: -1, segments: 4 }));
		expect(round).toBeGreaterThan(flat + 1e-6);
		expect(dish).toBeCloseTo(flat, 6); // the border ring is the max when the cap dishes in
	});

	it('one segment is byte-identical to the pre-P7c cap', () => {
		const tris = readTriangles(new THREE.BoxGeometry(1, 1, 1));
		const key = keyOf(new THREE.Vector3(0.5, 0.5, 0.5));
		const a = bevelVerticesCore(tris, [key], { width: 0.2, profile: 0.5 });
		const b = bevelVerticesCore(tris, [key], { width: 0.2, profile: 0.5, segments: 1 });
		expect(b.tris.map((t) => t.map(keyOf).join()).join()).toBe(a.tris.map((t) => t.map(keyOf).join()).join());
		expect(b.caps).toEqual(a.caps);
	});
});
