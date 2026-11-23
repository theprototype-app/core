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
