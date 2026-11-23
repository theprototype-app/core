// @ts-nocheck — scene fixtures built ad hoc (the checkJs rule for test fixtures)
// Roadmap 99 K4 families 4-6 (lane 99-ops-b): the kernel operators through the app's real commit + history —
// the paths that need no face session (the agent's faceOpOnObject delete, the vertex-mode delete / dissolve) and,
// where node can run one, the face session itself. ELEMENT IDS SURVIVE: the op keeps every pre-op vertex / face ID
// it did not consume, the history entry holds both sides' channels, undo / redo bring them back with the geometry,
// and the next operator starts from exactly those IDs. The in-app twin is tests/e2e/mesh-kernel-ops-b.
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
const sideTris = (g) =>
	fe
		.readTriangles(g)
		.map((t, i) => [t, i])
		.filter(([t]) => t.every((v) => v.x > 0.49))
		.map(([, i]) => i);
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

describe('99 K4 families 5-6: element IDs through commit, undo and redo', () => {
	it('delete (the agent path): survivors keep their face and vertex IDs, the cap-only vertices go', () => {
		const m = box();
		const cap = topTris(m.geometry);
		const r = fe.faceOpOnObject(m.uuid, 'delete', cap);
		expect(r.ok).toBe(true);
		expect(r.triangles).toBe(48 - cap.length);
		// the top's one interior vertex is used by nothing else
		const { before, after } = checkIds(m.uuid, { consumed: 1 });
		const capSet = new Set(cap);
		let i = 0;
		for (let t = 0; t < before.triFace.length; t++) {
			if (capSet.has(t)) continue;
			expect(after.triFace[i]).toBe(before.triFace[t]);
			for (let k = 0; k < 3; k++) expect(after.cornerVertex[i * 3 + k]).toBe(before.cornerVertex[t * 3 + k]);
			i++;
		}
	});

	it('delete vertices (vertex mode): the picked vertex and the faces on it go, everything else keeps its IDs', () => {
		const m = box();
		const centre = fe.readTriangles(m.geometry).flat().find((v) => v.y > 0.49 && Math.abs(v.x) < 1e-6 && Math.abs(v.z) < 1e-6);
		expect(fe.deleteVertices(m.uuid, [key(centre)])).toBe(true);
		checkIds(m.uuid, { consumed: 1 });
	});

	it('dissolve vertices (vertex mode): the four quads around a face centre become one n-gon', () => {
		const m = box();
		const tris0 = fe.readTriangles(m.geometry).length;
		const centre = fe.readTriangles(m.geometry).flat().find((v) => v.y > 0.49 && Math.abs(v.x) < 1e-6 && Math.abs(v.z) < 1e-6);
		expect(fe.dissolveVertices(m.uuid, [key(centre)])).toBe(true);
		const g = live(m.uuid).geometry;
		expect(fe.readTriangles(g).length).toBe(tris0 - 2); // an octagon: 6 triangles for 8
		const faces = readStoredFaces(g);
		expect(faces.some((f) => f.length === 6)).toBe(true);
		checkIds(m.uuid, { consumed: 1 });
	});

	it('subdivide (the agent path, family 6): every vertex keeps its ID, the picked quad becomes a 2x2 grid', () => {
		const m = box();
		const quad = topTris(m.geometry).slice(0, 2);
		const r = fe.faceOpOnObject(m.uuid, 'subdivide', quad);
		expect(r.ok).toBe(true);
		expect(r.triangles).toBe(48 - 2 + 8);
		const faces = readStoredFaces(live(m.uuid).geometry);
		expect(faces.filter((f) => f.length === 2).length).toBe(24 - 1 + 4);
		const { before, after } = checkIds(m.uuid, { consumed: 0 });
		// the untouched faces keep their face IDs
		const kept = new Set(after.triFace);
		const pickedFaces = new Set(quad.map((t) => before.triFace[t]));
		for (const f of new Set(before.triFace)) if (!pickedFaces.has(f)) expect(kept.has(f)).toBe(true);
	});

	it('the refusals change nothing and record nothing', () => {
		const m = box();
		const stack = get(history.undoStack).length;
		expect(fe.deleteVertices(m.uuid, ['9,9,9'])).toBe(false);
		expect(fe.dissolveVertices(m.uuid, ['9,9,9'])).toBe(false);
		const all = fe.readTriangles(m.geometry).map((_, i) => i);
		expect(fe.faceOpOnObject(m.uuid, 'delete', all).ok).toBe(false);
		expect(get(history.undoStack).length).toBe(stack);
	});

	it('a mesh with no stored partition: delete vertices commits every survivor as its own face (the soup rule)', () => {
		const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
		group.add(m);
		const corner = fe.readTriangles(m.geometry).flat().find((v) => v.x > 0 && v.y > 0 && v.z > 0);
		expect(fe.deleteVertices(m.uuid, [key(corner)])).toBe(true);
		const faces = readStoredFaces(live(m.uuid).geometry);
		expect(faces.every((f) => f.length === 1)).toBe(true);
		expect(faces.length).toBe(fe.readTriangles(live(m.uuid).geometry).length);
	});

	it('the loading refusal', () => {
		const m = box();
		const held = session.ops;
		session.ops = null;
		try {
			expect(fe.faceOpOnObject(m.uuid, 'delete', topTris(m.geometry)).error).toMatch(/still loading/);
		} finally {
			session.ops = held;
		}
	});
});
