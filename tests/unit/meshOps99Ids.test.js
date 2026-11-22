// @ts-nocheck — scene fixtures built ad hoc (the checkJs rule for test fixtures)
// Roadmap 99 K4 family 1: the kernel operators through the app's real commit + history (faceOpOnObject,
// the headless path the agent's edit_mesh takes — the same op mesh, opOutput and commitMesh the session
// path uses). ELEMENT IDS SURVIVE: the op keeps every pre-op vertex / face ID, the history entry holds
// both sides' channels, an undo / redo brings them back with the geometry, and the next operator
// rebuilds with exactly those IDs (no re-weld renumbering). Family 2 adds the face and vertex bevels (the edge
// bevel reads the live face session, so tests/e2e/mesh-kernel-ops.test.cjs holds it to the same rules).
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
const ops = await import('../../src/lib/meshOps/index.js');
const { readStoredFaces } = await import('../../src/lib/meshTopology.js');

let group;
let sent;
beforeEach(async () => {
	group = new THREE.Group();
	objectsGroup.set(group);
	sent = [];
	peers.set({ send: (m) => sent.push(m) });
	history.undoStack.set([]);
	history.redoStack?.set?.([]);
	await fe.loadKernelOps();
});

function box() {
	const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
	group.add(m);
	return m;
}
const live = (uuid) => group.getObjectByProperty('uuid', uuid);
const topTris = (g) => {
	const tris = fe.readTriangles(g);
	return tris.map((t, i) => [t, i]).filter(([t]) => t.every((v) => v.y > 0.49)).map(([, i]) => i);
};
const lastEntry = () => get(history.undoStack).at(-1);
const same = (a, b) => expect(Array.from(a)).toEqual(Array.from(b));

/** the IDs the next operator would build `geometry` with (what sessionOpMesh / faceOpOnObject see) */
function rebuildIds(geometry) {
	const applied = session.geometryIds.get(geometry);
	return applied?.ids ?? null;
}

describe('99 K4 family 1: element IDs through commit, undo and redo', () => {
	for (const op of ['extrude', 'inset', 'move']) {
		it(`${op}: pre-op IDs survive, undo/redo restore both sides, the next op rebuilds with them`, () => {
			const m = box();
			const cap = topTris(m.geometry);
			const r = fe.faceOpOnObject(m.uuid, op, cap, { amount: 0.3 });
			expect(r.ok).toBe(true);
			const e = lastEntry();
			expect(e.kind).toBe('meshgeo');
			const before = e.before.ids;
			const after = e.after.ids;
			expect(before && after).toBeTruthy();
			// every pre-op triangle keeps its face and corner vertices (walls and rings APPEND)
			const n = before.triFace.length;
			same(after.triFace.subarray(0, n), before.triFace);
			// the cap moved but its corners kept their vertex IDs, except where a detach duplicated them;
			// the triangles OFF the cap keep theirs exactly
			const capSet = new Set(cap);
			for (let t = 0; t < n; t++) {
				if (capSet.has(t) && op !== 'move') continue;
				for (let k = 0; k < 3; k++) expect(after.cornerVertex[t * 3 + k]).toBe(before.cornerVertex[t * 3 + k]);
			}
			// the stored partition and the ID channels describe one mesh
			expect(readStoredFaces(live(m.uuid).geometry).flat().length).toBe(after.triFace.length);
			same(rebuildIds(live(m.uuid).geometry).triFace, after.triFace);

			history.undo();
			same(rebuildIds(live(m.uuid).geometry).triFace, before.triFace);
			same(rebuildIds(live(m.uuid).geometry).cornerVertex, before.cornerVertex);
			history.redo();
			same(rebuildIds(live(m.uuid).geometry).cornerVertex, after.cornerVertex);

			// a second op starts from exactly the redone IDs (no weld renumbering in between)
			const r2 = fe.faceOpOnObject(m.uuid, 'move', topTris(live(m.uuid).geometry), { amount: 0.1 });
			expect(r2.ok).toBe(true);
			const e2 = lastEntry();
			same(e2.before.ids.cornerVertex, after.cornerVertex);
			same(e2.before.ids.triFace, after.triFace);
			// a move changes no topology: history shares the channels by reference
			expect(e2.after.ids).toBe(e2.before.ids);
		});
	}

	it('a rebuild from the recorded IDs is the same op mesh (kernel IDs, partition, output)', () => {
		const m = box();
		fe.faceOpOnObject(m.uuid, 'extrude', topTris(m.geometry), { amount: 0.4 });
		const g = live(m.uuid).geometry;
		const ids = rebuildIds(g);
		const om = ops.opMeshFromArrays({
			positions: ops.plainAttribute(g.attributes.position).array,
			index: g.index ? ops.plainAttribute(g.index).array : null,
			uv: g.attributes.uv ? ops.plainAttribute(g.attributes.uv).array : null,
			groups: g.groups,
			partition: readStoredFaces(g),
			ids
		});
		const back = ops.idChannels(om);
		same(back.triFace, ids.triFace);
		same(back.cornerVertex, ids.cornerVertex);
		const out = ops.opOutput(om, { order: 'stored' });
		expect(out.faces).toEqual(readStoredFaces(g));
		same(out.positions, g.attributes.position.array);
	});

	it('a write since the IDs were noted drops them (a drag landing two vertices on one key must weld)', () => {
		const m = box();
		fe.faceOpOnObject(m.uuid, 'extrude', topTris(m.geometry), { amount: 0.4 });
		const g = live(m.uuid).geometry;
		expect(rebuildIds(g)).toBeTruthy();
		g.attributes.position.setX(0, g.attributes.position.getX(0) + 0.01);
		g.attributes.position.needsUpdate = true;
		// still remembered, but stale: the next op welds afresh and still succeeds
		const r = fe.faceOpOnObject(m.uuid, 'move', topTris(g), { amount: 0.1 });
		expect(r.ok).toBe(true);
	});

	it('the closed-region refusal and the loading refusal', () => {
		const m = box();
		const all = fe.readTriangles(m.geometry).map((_, i) => i);
		expect(fe.faceOpOnObject(m.uuid, 'extrude', all, { amount: 1 }).error).toMatch(/CLOSED/);
		const held = session.ops;
		session.ops = null;
		try {
			expect(fe.faceOpOnObject(m.uuid, 'extrude', topTris(m.geometry), { amount: 1 }).error).toMatch(/still loading/);
		} finally {
			session.ops = held;
		}
	});

	it('the soup exports keep their shape (mi / uv tags, appended walls) on the kernel', () => {
		const g = new THREE.BoxGeometry(1, 1, 1);
		const tris = fe.readTriangles(g);
		const face = { triIndices: topTris(g), normal: new THREE.Vector3(0, 1, 0) };
		const out = fe.extrudeFace(tris, face, 0.5);
		expect(out.length).toBe(tris.length + 8);
		expect(out.every((t) => Number.isInteger(t.mi) && Array.isArray(t.uv))).toBe(true);
		for (const ti of face.triIndices) expect(out[ti].every((v) => Math.abs(v.y - 1) < 1e-6)).toBe(true);
	});
});

describe('99 K4 family 2: element IDs through the bevels', () => {
	const keyOf = (v) => `${Math.round(v.x * 1e4)},${Math.round(v.y * 1e4)},${Math.round(v.z * 1e4)}`;

	it('face bevel: pre-op IDs survive, undo/redo restore both sides, the next op rebuilds with them', () => {
		const m = box();
		const cap = topTris(m.geometry);
		const r = fe.faceOpOnObject(m.uuid, 'bevel', cap, { width: 0.1, segments: 2 });
		expect(r.ok).toBe(true);
		const e = lastEntry();
		const before = e.before.ids;
		const after = e.after.ids;
		expect(before && after).toBeTruthy();
		// the rings APPEND: every pre-op triangle keeps its face ID, every one off the cap its corner vertices
		const n = before.triFace.length;
		same(after.triFace.subarray(0, n), before.triFace);
		const capSet = new Set(cap);
		for (let t = 0; t < n; t++) {
			if (capSet.has(t)) continue;
			for (let k = 0; k < 3; k++) expect(after.cornerVertex[t * 3 + k]).toBe(before.cornerVertex[t * 3 + k]);
		}
		history.undo();
		same(rebuildIds(live(m.uuid).geometry).cornerVertex, before.cornerVertex);
		history.redo();
		same(rebuildIds(live(m.uuid).geometry).cornerVertex, after.cornerVertex);
		const r2 = fe.faceOpOnObject(m.uuid, 'move', topTris(live(m.uuid).geometry), { amount: 0.1 });
		expect(r2.ok).toBe(true);
		same(lastEntry().before.ids.cornerVertex, after.cornerVertex);
	});

	it('vertex bevel: every vertex ID but the bevelled corner survives, undo/redo restore both sides', () => {
		const m = box();
		const corner = fe.readTriangles(m.geometry).flat().find((v) => v.x > 0.49 && v.y > 0.49 && v.z > 0.49);
		expect(fe.bevelVertices(m.uuid, [keyOf(corner)], { width: 0.2 })).toBe(true);
		const e = lastEntry();
		const before = e.before.ids;
		const after = e.after.ids;
		expect(before && after).toBeTruthy();
		const kept = new Set(Array.from(after.cornerVertex));
		const gone = [...new Set(Array.from(before.cornerVertex))].filter((v) => !kept.has(v));
		expect(gone.length).toBe(1); // the corner, replaced by its cap
		history.undo();
		same(rebuildIds(live(m.uuid).geometry).cornerVertex, before.cornerVertex);
		same(rebuildIds(live(m.uuid).geometry).triFace, before.triFace);
		history.redo();
		same(rebuildIds(live(m.uuid).geometry).cornerVertex, after.cornerVertex);
		same(rebuildIds(live(m.uuid).geometry).triFace, after.triFace);
		// the next op starts from the redone IDs
		const r2 = fe.faceOpOnObject(m.uuid, 'move', fe.readTriangles(live(m.uuid).geometry).map((t, i) => [t, i]).filter(([t]) => t.every((v) => v.y < -0.49)).map(([, i]) => i), { amount: 0.1 });
		expect(r2.ok).toBe(true);
		same(lastEntry().before.ids.cornerVertex, after.cornerVertex);
	});
});
