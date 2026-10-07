// @ts-nocheck — fixture geometry built ad hoc (the checkJs rule for test fixtures)
// 37 R11: the knife's pure core — POLYLINE cuts. Triangles in, triangles out, a projection
// function standing in for the camera, so every case runs in node next to the e2e suite that
// drives the same core through real clicks (mesh-knife).
//
// The gate is the mesh gate: WATERTIGHT (welded edges used other than twice = 0 on a closed
// box) and consistently WOUND (no directed edge walked twice the same way) — plus the things a
// polyline adds: every corner the user placed on the mesh is a real VERTEX, the cut runs along
// mesh edges between them, and a triangle crossed by 3+ cut pieces resolves cleanly.
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { readTriangles, knifeCutCore, trisToUVs } from '$lib/faceEdit.js';

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

function volume(tris) {
	let v = 0;
	for (const t of tris) v += t[0].dot(new THREE.Vector3().crossVectors(t[1], t[2])) / 6;
	return v;
}

const box = () => readTriangles(new THREE.BoxGeometry(2, 2, 2));

/** looking down -Z at the box: x right, y up, 100 px per unit, centred on (500, 500).
 * The front face (z = +1) and the back face (z = -1) land on the same pixels — two layers. */
const ortho = (v) => ({ px: [500 + v.x * 100, 500 - v.y * 100], w: 1 });

/** pixel of a point on the front face in the ortho view */
const px = (x, y) => [500 + x * 100, 500 - y * 100];

function hasVertex(tris, x, y, z, tol = 1e-4) {
	return tris.some((t) => t.some((v) => Math.abs(v.x - x) < tol && Math.abs(v.y - y) < tol && Math.abs(v.z - z) < tol));
}

/** every sample along a 3D segment lies on some mesh EDGE — the cut is made of edges */
function segmentOnEdges(tris, a, b, samples = 9) {
	const edges = [];
	for (const t of tris) for (let e = 0; e < 3; e++) edges.push([t[e], t[(e + 1) % 3]]);
	const line = new THREE.Line3();
	const closest = new THREE.Vector3();
	for (let i = 1; i < samples; i++) {
		const p = a.clone().lerp(b, i / samples);
		const onSome = edges.some(([u, v]) => {
			line.set(u, v);
			line.closestPointToPoint(p, true, closest);
			return closest.distanceTo(p) < 1e-4;
		});
		if (!onSome) return false;
	}
	return true;
}

function minArea(tris) {
	let min = Infinity;
	for (const t of tris) {
		const area = new THREE.Vector3().crossVectors(t[1].clone().sub(t[0]), t[2].clone().sub(t[0])).length() / 2;
		min = Math.min(min, area);
	}
	return min;
}

function gate(tris, startVolume) {
	expect(oddEdges(tris)).toBe(0);
	expect(sameWayEdges(tris)).toBe(0);
	expect(volume(tris)).toBeCloseTo(startVolume, 6);
}

describe('knifeCutCore — straight cuts (the M9b contract, unchanged)', () => {
	it('a line across the whole silhouette splits front AND back, watertight', () => {
		const tris = box();
		const result = knifeCutCore(tris, [px(-3, 0.2), px(3, 0.2)], ortho);
		expect(result).not.toBeNull();
		expect(result.corners).toBe(0); // both ends are off the mesh
		expect(result.tris.length).toBeGreaterThan(tris.length);
		gate(result.tris, volume(tris));
		expect(segmentOnEdges(result.tris, new THREE.Vector3(-1, 0.2, 1), new THREE.Vector3(1, 0.2, 1))).toBe(true);
		expect(segmentOnEdges(result.tris, new THREE.Vector3(-1, 0.2, -1), new THREE.Vector3(1, 0.2, -1))).toBe(true);
	});

	it('a line that misses the mesh touches nothing', () => {
		expect(knifeCutCore(box(), [[2, 2], [2, 400]], ortho)).toBeNull();
	});
});

describe('knifeCutCore — the ENDS become vertices', () => {
	it('a cut that stops inside the face ends exactly where it was clicked', () => {
		const tris = box();
		const result = knifeCutCore(tris, [px(-3, 0.3), px(0.25, 0.3)], ortho);
		gate(result.tris, volume(tris));
		expect(hasVertex(result.tris, 0.25, 0.3, 1)).toBe(true); // front layer
		expect(hasVertex(result.tris, 0.25, 0.3, -1)).toBe(true); // ...and the back one under it
		expect(segmentOnEdges(result.tris, new THREE.Vector3(-1, 0.3, 1), new THREE.Vector3(0.25, 0.3, 1))).toBe(true);
	});
});

describe('knifeCutCore — POLYLINE cuts', () => {
	it('an L through a corner inside the face: the corner is a vertex, both legs are edges', () => {
		const tris = box();
		const points = [px(-3, 0.4), px(0.3, 0.4), px(0.3, -3)];
		const result = knifeCutCore(tris, points, ortho);
		expect(result.corners).toBeGreaterThan(0);
		gate(result.tris, volume(tris));
		expect(hasVertex(result.tris, 0.3, 0.4, 1)).toBe(true);
		const corner = new THREE.Vector3(0.3, 0.4, 1);
		expect(segmentOnEdges(result.tris, new THREE.Vector3(-1, 0.4, 1), corner)).toBe(true);
		expect(segmentOnEdges(result.tris, corner, new THREE.Vector3(0.3, -1, 1))).toBe(true);
	});

	it('a zig-zag with every corner inside the face, watertight', () => {
		const tris = box();
		const points = [px(-0.8, -0.6), px(-0.4, 0.6), px(0, -0.6), px(0.4, 0.6), px(0.8, -0.6)];
		const result = knifeCutCore(tris, points, ortho);
		gate(result.tris, volume(tris));
		for (const [x, y] of [[-0.8, -0.6], [-0.4, 0.6], [0, -0.6], [0.4, 0.6], [0.8, -0.6]]) {
			expect(hasVertex(result.tris, x, y, 1)).toBe(true);
		}
		for (let i = 0; i + 1 < points.length; i++) {
			const a = new THREE.Vector3((points[i][0] - 500) / 100, (500 - points[i][1]) / 100, 1);
			const b = new THREE.Vector3((points[i + 1][0] - 500) / 100, (500 - points[i + 1][1]) / 100, 1);
			expect(segmentOnEdges(result.tris, a, b)).toBe(true);
		}
	});

	it('a polyline that CROSSES ITSELF: the crossing becomes a vertex and nothing cracks', () => {
		const tris = box();
		// a bow-tie: segment 1 and segment 3 cross at (0, 0)
		const points = [px(-0.6, -0.6), px(0.6, 0.6), px(0.6, -0.6), px(-0.6, 0.6)];
		const result = knifeCutCore(tris, points, ortho);
		gate(result.tris, volume(tris));
		expect(hasVertex(result.tris, 0, 0, 1)).toBe(true);
	});

	it('3+ cut pieces inside ONE triangle resolve one segment at a time', () => {
		const tris = box();
		// a tight star inside one front triangle (the box's front face is two triangles split
		// along a diagonal; this stays in the corner near (-0.7, -0.7) whichever way it runs)
		const c = [-0.7, -0.75];
		const points = [];
		for (let i = 0; i < 6; i++) {
			const angle = (i * 4 * Math.PI) / 5;
			points.push(px(c[0] + Math.cos(angle) * 0.12, c[1] + Math.sin(angle) * 0.12));
		}
		const result = knifeCutCore(tris, points, ortho);
		gate(result.tris, volume(tris));
		expect(result.tris.length).toBeGreaterThan(tris.length + 10);
	});

	it('a corner clicked NEXT TO an existing vertex snaps onto it — no needle triangle', () => {
		const tris = box();
		// the front face's top-right corner is (1, 1, 1); click 2 px away from it
		const near = px(1, 1);
		const result = knifeCutCore(tris, [px(-0.5, -0.5), [near[0] - 2, near[1] + 1]], ortho);
		gate(result.tris, volume(tris));
		expect(minArea(result.tris)).toBeGreaterThan(1e-3);
		// and no new vertex appeared within the snap radius of the corner
		const stray = result.tris.some((t) =>
			t.some((v) => Math.abs(v.z - 1) < 1e-4 && v.distanceTo(new THREE.Vector3(1, 1, 1)) > 1e-4 && v.distanceTo(new THREE.Vector3(1, 1, 1)) < 0.06)
		);
		expect(stray).toBe(false);
	});

	it('a corner ON an edge splits that edge for BOTH faces sharing it', () => {
		const tris = box();
		// start on the front face's top edge (a crease with the top face), cut down
		const result = knifeCutCore(tris, [px(0.2, 1), px(0.2, -0.5)], ortho);
		gate(result.tris, volume(tris));
		expect(hasVertex(result.tris, 0.2, 1, 1)).toBe(true);
	});

	it('keeps a COMPLETE uv mapping (new points interpolated)', () => {
		const tris = box();
		const result = knifeCutCore(tris, [px(-3, 0.4), px(0.3, 0.4), px(0.3, -3)], ortho);
		const uvs = trisToUVs(result.tris);
		expect(uvs).not.toBeNull();
		expect(uvs.length).toBe(result.tris.length * 6);
		expect(uvs.every((n) => Number.isFinite(n) && n >= -1e-6 && n <= 1 + 1e-6)).toBe(true);
	});
});

describe('knifeCutCore — PERSPECTIVE', () => {
	it('a corner aimed at a known point lands on it in SPACE (screen barycentrics would drift)', () => {
		const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
		camera.position.set(3.5, 3, 4.5);
		camera.lookAt(0, 0, 0);
		camera.updateMatrixWorld(true);
		const size = 1000;
		const project = (v) => {
			const ndc = v.clone().project(camera);
			const view = v.clone().applyMatrix4(camera.matrixWorldInverse);
			return { px: [((ndc.x + 1) / 2) * size, ((1 - ndc.y) / 2) * size], w: Math.max(-view.z, 1e-6) };
		};
		const target = new THREE.Vector3(0.35, -0.2, 1); // on the front face, off-centre
		// where the first leg enters the front face: the line (-3, 0.6) -> target, at x = -1
		const far = new THREE.Vector3(-3, 0.6, 1);
		const start = far.clone().lerp(target, 2 / (target.x - far.x));
		const tris = box();
		const result = knifeCutCore(tris, [project(far).px, project(target).px, project(new THREE.Vector3(0.35, -3, 1)).px], project);
		gate(result.tris, volume(tris));
		let best = Infinity;
		for (const t of result.tris) for (const v of t) best = Math.min(best, v.distanceTo(target));
		expect(best).toBeLessThan(1e-3);
		expect(segmentOnEdges(result.tris, start, target)).toBe(true);
	});
});
