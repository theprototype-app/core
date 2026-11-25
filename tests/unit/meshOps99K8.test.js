// @ts-nocheck — scene fixtures built ad hoc (the checkJs rule for test fixtures)
// Roadmap 99 K8 (lane 99-newops): the new operators through the app's real commit + history (the agent's
// faceOpOnObject path, which needs no face session): smooth subdivide (Catmull-Clark) and bisect. ELEMENT IDS
// SURVIVE: every pre-op vertex keeps its ID unless the op consumed it, both history sides carry the channels, undo /
// redo bring them back, and the next operator starts from them. The in-app twin is tests/e2e/mesh-newops.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as THREE from 'three';
import { get } from 'svelte/store';

vi.mock('$lib/objectActions', () => ({ moveObjectToGroup: () => {}, duplicateObject: () => null }));
vi.mock('$lib/physics', () => ({ setPhysicsFor: () => {}, physicsShapeChanged: () => {} }));

const { objectsGroup } = await import('../../src/stores/sceneStore');
const { peers } = await import('../../src/stores/appStore');
const history = await import('../../src/lib/history.js');
const fe = await import('../../src/lib/faceEdit.js');
const { session } = await import('../../src/lib/editSessionState.js');
const { readStoredFaces } = await import('../../src/lib/meshTopology.js');

let group;
beforeEach(async () => {
	group = new THREE.Group();
	objectsGroup.set(group);
	peers.set({ send: () => {} });
	history.undoStack.set([]);
	history.redoStack?.set?.([]);
	await fe.loadKernelOps();
});

/** a 2x2x2-segment box (interior vertices on every side, so a dissolve has work), a stored partition */
function box() {
	const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1, 2, 2, 2), new THREE.MeshStandardMaterial());
	group.add(m);
	// store the quad partition the editor would (a first op on a fresh mesh stores one)
	const { partition } = fe.facePartitionOf(m.geometry);
	m.geometry.userData.__topo = { counts: partition.map((f) => f.length), tris: partition.flat() };
	return m;
}
const live = (uuid) => group.getObjectByProperty('uuid', uuid);
const key = (v) => `${Math.round(v.x * 1e4)},${Math.round(v.y * 1e4)},${Math.round(v.z * 1e4)}`;
const topTris = (g) =>
	fe
		.readTriangles(g)
		.map((t, i) => [t, i])
		.filter(([t]) => t.every((v) => v.y > 0.49))
		.map(([, i]) => i);
/** the triangles on the +x side (relative: a smoothed box no longer reaches x = 0.5) */
const sideTris = (g) => {
	const tris = fe.readTriangles(g);
	const top = Math.max(...tris.flat().map((v) => v.x));
	return tris
		.map((t, i) => [t, i])
		.filter(([t]) => t.reduce((a, v) => a + v.x, 0) / 3 > top * 0.6)
		.map(([, i]) => i);
};
const lastEntry = () => get(history.undoStack).at(-1);
const same = (a, b) => expect(Array.from(a)).toEqual(Array.from(b));
const idsOf = (geometry) => session.geometryIds.get(geometry)?.ids ?? null;

/** the shared checks: both sides carry IDs; the surviving vertex IDs are the pre-op ones minus `consumed`;
 * undo / redo restore the channels; the next op starts from the redone IDs */
function checkIds(uuid, { consumed }) {
	const e = lastEntry();
	expect(e.kind).toBe('meshgeo');
	const before = e.before.ids;
	const after = e.after.ids;
	expect(before && after).toBeTruthy();
	const kept = new Set(after.cornerVertex);
	const lost = [...new Set(before.cornerVertex)].filter((v) => !kept.has(v));
	if (consumed !== undefined) expect(lost.length).toBe(consumed);
	expect(readStoredFaces(live(uuid).geometry).flat().length).toBe(after.triFace.length);
	same(idsOf(live(uuid).geometry).triFace, after.triFace);
	history.undo();
	same(idsOf(live(uuid).geometry).cornerVertex, before.cornerVertex);
	same(idsOf(live(uuid).geometry).triFace, before.triFace);
	history.redo();
	same(idsOf(live(uuid).geometry).cornerVertex, after.cornerVertex);
	// the next operator starts from exactly the redone IDs
	const r2 = fe.faceOpOnObject(uuid, 'move', sideTris(live(uuid).geometry).slice(0, 2), { amount: 0.05 });
	expect(r2.ok).toBe(true);
	same(lastEntry().before.ids.cornerVertex, after.cornerVertex);
	expect(lastEntry().after.ids).toBe(lastEntry().before.ids);
	return { before, after, lost };
}

const box1 = () => {
	const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
	group.add(m);
	const { partition } = fe.facePartitionOf(m.geometry);
	m.geometry.userData.__topo = { counts: partition.map((f) => f.length), tris: partition.flat() };
	return m;
};

describe('99 K8 smooth subdivide (Catmull-Clark) on the agent path', () => {
	it('the whole box, one level: 24 quads = 48 triangles, rounded, every vertex keeps its ID', () => {
		const m = box1();
		const all = fe.readTriangles(m.geometry).map((_, i) => i);
		const r = fe.faceOpOnObject(m.uuid, 'subdivide_smooth', all, { levels: 1 });
		expect(r.ok).toBe(true);
		expect(r.triangles).toBe(48);
		const g = live(m.uuid).geometry;
		const faces = readStoredFaces(g);
		expect(faces.length).toBe(24);
		expect(faces.every((f) => f.length === 2)).toBe(true);
		// a cube corner (0.5, 0.5, 0.5) moves to 5/9 of the way: (5/9) * 0.5
		const corner = fe.readTriangles(g).flat().reduce((b, v) => (v.x + v.y + v.z > b.x + b.y + b.z ? v : b));
		expect(corner.x).toBeCloseTo((5 / 9) * 0.5, 5);
		checkIds(m.uuid, { consumed: 0 });
	});

	it('a picked quad on a segmented box: only its corners stay pinned, the neighbours gain the edge points', () => {
		const m = box();
		const quad = topTris(m.geometry).slice(0, 2);
		const before = fe.readTriangles(m.geometry).length;
		const r = fe.faceOpOnObject(m.uuid, 'subdivide_smooth', quad, { levels: 2 });
		expect(r.ok).toBe(true);
		// 4 corners -> 4 quads -> 16 quads (32 triangles); the four neighbours each gain corners (triangulated more)
		expect(r.triangles).toBeGreaterThan(before - 2 + 32);
		const faces = readStoredFaces(live(m.uuid).geometry);
		expect(faces.length).toBe(24 - 1 + 16);
		checkIds(m.uuid, { consumed: 0 });
	});

	it('refuses before running when the result would pass the sync ceiling', () => {
		const m = new THREE.Mesh(new THREE.SphereGeometry(1, 256, 128), new THREE.MeshStandardMaterial());
		group.add(m);
		const all = fe.readTriangles(m.geometry).map((_, i) => i);
		const r = fe.faceOpOnObject(m.uuid, 'subdivide_smooth', all, { levels: 3 });
		expect(r.ok).toBe(false);
		expect(r.error).toMatch(/too large/);
	});
});

describe('99 K8 shortest-path select in the editor currency (pathBetween)', () => {
	const grid = () => {
		const m = new THREE.Mesh(new THREE.PlaneGeometry(4, 4, 4, 4), new THREE.MeshStandardMaterial());
		group.add(m);
		return m;
	};
	const k = (x, y) => `${Math.round(x * 1e4)},${Math.round(y * 1e4)},0`;

	it('vertices: corner to corner along the border is 5 vertices by steps, a straight row by length', () => {
		const m = grid();
		const r = fe.pathBetween(m.geometry, 'vertex', k(-2, -2), k(2, -2));
		expect(r.keys).toEqual([k(-2, -2), k(-1, -2), k(0, -2), k(1, -2), k(2, -2)]);
	});

	it('edges: the chain between two border edges walks the border; keys are sorted pairs', () => {
		const m = grid();
		const e = (a, b) => (a < b ? a + '|' + b : b + '|' + a);
		const r = fe.pathBetween(m.geometry, 'edge', e(k(-2, -2), k(-1, -2)), e(k(1, -2), k(2, -2)));
		expect(r.keys[0]).toBe(e(k(-2, -2), k(-1, -2)));
		expect(r.keys.at(-1)).toBe(e(k(1, -2), k(2, -2)));
		expect(r.keys.length).toBe(4);
		for (const key of r.keys) expect(key.split('|')[0] < key.split('|')[1]).toBe(true);
	});

	it('faces: a whole quad per step (both its triangles), a row of four quads', () => {
		const m = grid();
		const tris = fe.readTriangles(m.geometry);
		const centre = (t) => t.reduce((a, v) => [a[0] + v.x / 3, a[1] + v.y / 3], [0, 0]);
		const at = (x, y) => tris.findIndex((t) => Math.hypot(centre(t)[0] - x, centre(t)[1] - y) < 0.4);
		const from = at(-1.5 - 0.17, 1.5 + 0.17);
		const to = at(1.5 - 0.17, 1.5 + 0.17);
		expect(from).toBeGreaterThanOrEqual(0);
		const r = fe.pathBetween(m.geometry, 'face', from, to);
		expect(r.tris.length).toBe(8);
		for (const t of r.tris) expect(centre(tris[t])[1]).toBeGreaterThan(1);
	});

	it('steps vs length: a far-pulled vertex is skipped by length, crossed by steps', async () => {
		const { meshPathTopological } = await import('../../src/lib/meshToolParams.js');
		const m = grid();
		// pull the vertex (0, 1) far out of the plane: the 2-step path through it is long, the 4-step detour short
		const p = m.geometry.attributes.position;
		for (let i = 0; i < p.count; i++) if (Math.abs(p.getX(i)) < 1e-6 && Math.abs(p.getY(i) - 1) < 1e-6) p.setZ(i, 40);
		p.needsUpdate = true;
		const byLen = fe.pathBetween(m.geometry, 'vertex', k(-1, 1), k(1, 1));
		meshPathTopological.set(true);
		const bySteps = fe.pathBetween(m.geometry, 'vertex', k(-1, 1), k(1, 1));
		meshPathTopological.set(false);
		// (the pulled vertex unpairs its quads, so a diagonal may shorten the detour: 4 or 5 vertices)
		expect(byLen.keys.length).toBeGreaterThan(3);
		expect(byLen.keys).not.toContain('0,10000,400000');
		expect(bySteps.keys).toEqual([k(-1, 1), '0,10000,400000', k(1, 1)]);
	});

	it('nothing connects two shells: null', () => {
		const g = new THREE.PlaneGeometry(1, 1);
		const h = new THREE.PlaneGeometry(1, 1).translate(5, 0, 0);
		const pos = new Float32Array([...g.toNonIndexed().attributes.position.array, ...h.toNonIndexed().attributes.position.array]);
		const geo = new THREE.BufferGeometry();
		geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
		const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial());
		group.add(m);
		expect(fe.pathBetween(m.geometry, 'vertex', k(-0.5, -0.5), k(5.5, 0.5))).toBeNull();
	});
});

describe('99 K8 bisect on the agent path', () => {
	const all = (m) => fe.readTriangles(live(m.uuid).geometry).map((_, i) => i);
	it('the whole box at y = 0.1: four walls split, every vertex keeps its ID, the cut lies on the plane', () => {
		const m = box1();
		const r = fe.faceOpOnObject(m.uuid, 'bisect', all(m), { point: [0, 0.1, 0], normal: [0, 1, 0] });
		expect(r.ok).toBe(true);
		const g = live(m.uuid).geometry;
		const faces = readStoredFaces(g);
		expect(faces.length).toBe(10);
		const ys = new Set(fe.readTriangles(g).flat().map((v) => Math.round(v.y * 1e4)));
		expect([...ys].sort((a, b) => a - b)).toEqual([-5000, 1000, 5000]);
		checkIds(m.uuid, { consumed: 0 });
	});

	it('clear outer + fill: a closed lower half under the plane', () => {
		const m = box1();
		const r = fe.faceOpOnObject(m.uuid, 'bisect', all(m), { point: [0, 0.1, 0], normal: [0, 1, 0], clear: 'outer', fill: true });
		expect(r.ok).toBe(true);
		const tris = fe.readTriangles(live(m.uuid).geometry);
		expect(Math.max(...tris.flat().map((v) => v.y))).toBeCloseTo(0.1, 5);
		// closed: every welded edge is used exactly twice
		const count = new Map();
		for (const t of tris)
			for (let i = 0; i < 3; i++) {
				const a = key(t[i]);
				const b = key(t[(i + 1) % 3]);
				const e = a < b ? a + '|' + b : b + '|' + a;
				count.set(e, (count.get(e) ?? 0) + 1);
			}
		expect([...count.values()].every((n) => n === 2)).toBe(true);
		// the top's four corners went with the cleared side
		checkIds(m.uuid, { consumed: 4 });
	});

	it('a plane missing the mesh is refused with nothing committed; no normal is refused', () => {
		const m = box1();
		const n = get(history.undoStack).length;
		const r = fe.faceOpOnObject(m.uuid, 'bisect', all(m), { point: [0, 3, 0], normal: [0, 1, 0] });
		expect(r.ok).toBe(false);
		expect(r.error).toMatch(/does not cross/);
		expect(fe.faceOpOnObject(m.uuid, 'bisect', all(m), { point: [0, 0, 0] }).ok).toBe(false);
		expect(get(history.undoStack).length).toBe(n);
	});

	it('a picked face only: its neighbours gain the crossing, the rest is untouched', () => {
		const m = box();
		const quad = topTris(m.geometry).slice(0, 2);
		const tris = fe.readTriangles(m.geometry);
		const c = quad.flatMap((t) => tris[t]).reduce((a, v) => [a[0] + v.x / 6, a[1] + v.y / 6, a[2] + v.z / 6], [0, 0, 0]);
		const r = fe.faceOpOnObject(m.uuid, 'bisect', quad, { point: c, normal: [1, 0, 0.3] });
		expect(r.ok).toBe(true);
		checkIds(m.uuid, { consumed: 0 });
	});
});
