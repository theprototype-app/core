// @ts-nocheck — scene fixtures built ad hoc (the checkJs rule for test fixtures)
// Roadmap 85 G1-G7: the geometry tool HANDLERS on a real objectsGroup, the real history and a
// recording peer — what each call changes, what it sends (the same messages a person's edit
// sends), and that ONE undo (the call's batch) takes it back. Plus the pure selection / data core.
// Two leaves are mocked only because they reach `geometries.svelte.js` (runes need the svelte
// compiler): objectActions (re-nesting) and physics (the static default).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as THREE from 'three';
import { get } from 'svelte/store';

vi.mock('$lib/objectActions', () => ({ moveObjectToGroup: () => {} }));
vi.mock('$lib/physics', () => ({ setPhysicsFor: () => {} }));

const { objectsGroup } = await import('../../src/stores/sceneStore');
const { peers } = await import('../../src/stores/appStore');
const history = await import('../../src/lib/history.js');
const { stampGeometryParams, applyRemoteGeometry } = await import('../../src/lib/geometryEdit.js');
const { geometryTool, cleanParamPatch, tubeRecordOf } = await import('../../src/lib/ai/geometryTools.js');
const core = await import('../../src/lib/ai/meshSelectCore.js');
const { latheGeometry, extrudeGeometry, cleanExtrude, cleanLathe } = await import('../../src/lib/customGeometries.js');
const { summarizeToolCall } = await import('../../src/lib/agentLogCore.js');
const { readTriangles } = await import('../../src/lib/faceEdit.js');

/** @type {any[]} */
let sent = [];
let group;

beforeEach(() => {
	group = new THREE.Group();
	objectsGroup.set(group);
	sent = [];
	peers.set({ send: (m) => sent.push(m) });
	history.undoStack.set([]);

});

/** a primitive the way createGeometry leaves it: a mesh with its params stamped */
function prim(geometry, name = 'Thing') {
	const m = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());
	m.name = name;
	stampGeometryParams(m);
	group.add(m);
	return m;
}

/** create_objects' createOne, minus the replication the handlers do not own */
function createBase(spec, extra) {
	const g = spec.primitive === 'Lathe' ? new THREE.LatheGeometry() : spec.primitive === 'Extrude' ? new THREE.ExtrudeGeometry() : new THREE.BoxGeometry();
	const m = prim(g, spec.name || spec.primitive);
	history.recordObjectPresence('create', m);
	if (spec.position) m.position.fromArray(spec.position);
	return { uuid: m.uuid, name: m.name, extra };
}

/** run a tool inside one history batch, as agentCore does per call */
async function call(name, args) {
	history.beginHistoryBatch();
	try {
		return await geometryTool(name, args, createBase);
	} finally {
		history.endHistoryBatch('Agent: ' + name);
	}
}

const live = (uuid) => group.getObjectByProperty('uuid', uuid);
const bbox = (o) => new THREE.Box3().setFromBufferAttribute(o.geometry.attributes.position);

describe('G1 set_geometry', () => {
	it('changes params through the geometry message + history kind; one undo restores', async () => {
		const box = prim(new THREE.BoxGeometry(1, 1, 1), 'Wall');
		const r = await call('set_geometry', { updates: [{ uuid: box.uuid, params: { width: 4, height: 2.5 } }] });
		expect(r.updated[0].ok).toBe(true);
		expect(live(box.uuid).geometry.parameters.width).toBe(4);
		expect(sent.find((m) => m.type === 'geometry')).toMatchObject({ uuid: box.uuid, gtype: 'Box', params: { width: 4, height: 2.5 } });
		expect(get(history.undoStack).length).toBe(1);
		history.undo();
		expect(live(box.uuid).geometry.parameters.width).toBe(1);
	});

	it('changes the TYPE in place, keeping uuid / transform / material; undo brings the box back', async () => {
		const box = prim(new THREE.BoxGeometry(1, 1, 1));
		box.position.set(3, 0.5, -2);
		const mat = box.material;
		const r = await call('set_geometry', { updates: [{ uuid: box.uuid, type: 'cylinder', params: { radiusTop: 0.2 } }] });
		expect(r.updated[0]).toMatchObject({ ok: true, from: 'Box', geometry: { type: 'Cylinder', radiusTop: 0.2, radiusBottom: 1 } });
		const o = live(box.uuid);
		expect(o.geometry.type).toBe('CylinderGeometry');
		expect(o.position.toArray()).toEqual([3, 0.5, -2]);
		expect(o.material).toBe(mat);
		expect(sent.at(-1)).toMatchObject({ type: 'geometry', gtype: 'Cylinder' });
		history.undo();
		expect(live(box.uuid).geometry.type).toBe('BoxGeometry');
		expect(live(box.uuid).userData.geometryParams.gtype).toBe('Box');
		history.redo();
		expect(live(box.uuid).geometry.type).toBe('CylinderGeometry');
	});

	it('validates: unknown keys, wrong types, clamps counts and huge sizes with a warning', () => {
		expect(cleanParamPatch('Box', { width: 3, colour: 1 }).errors[0]).toMatch(/colour.*one of width/);
		expect(cleanParamPatch('Cylinder', { openEnded: 'yes' }).errors[0]).toMatch(/true or false/);
		const c = cleanParamPatch('Sphere', { widthSegments: 999, radius: 5000 });
		expect(c.patch).toEqual({ widthSegments: 64, radius: 1000 });
		expect(c.warnings.length).toBe(2);
		// create_objects' positional form maps onto the constructor order
		expect(cleanParamPatch('Box', [2, 3, 4]).patch).toEqual({ width: 2, height: 3, depth: 4 });
	});

	it('refuses an unknown type, a non-mesh and a mesh with no params', async () => {
		const box = prim(new THREE.BoxGeometry());
		const raw = new THREE.Mesh(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3)));
		group.add(raw);
		const g = new THREE.Group();
		group.add(g);
		const r = await call('set_geometry', { updates: [{ uuid: box.uuid, type: 'Blob' }, { uuid: raw.uuid, params: { width: 1 } }, { uuid: g.uuid, params: {} }, { uuid: 'nope' }] });
		expect(r.error).toMatch(/nothing was reshaped/);
		expect(r.updated.map((u) => u.error)).toEqual([expect.stringMatching(/type: one of/), expect.stringMatching(/no editable params/), expect.stringMatching(/not a mesh/), expect.stringMatching(/no object/)]);
		expect(get(history.undoStack).length).toBe(0);
	});

	it('G7: a hand-edited object refuses without force; with force it rebuilds and says so', async () => {
		const box = prim(new THREE.BoxGeometry());
		box.userData.vertexEdited = true;
		const r = await call('set_geometry', { updates: [{ uuid: box.uuid, params: { width: 2 } }] });
		expect(r.error).toMatch(/edited by hand.*force: true/);
		expect(live(box.uuid).geometry.parameters.width).toBe(1);
		const f = await call('set_geometry', { updates: [{ uuid: box.uuid, params: { width: 2 }, force: true }] });
		expect(f.updated[0].ok).toBe(true);
		expect(f.updated[0].warnings.join()).toMatch(/hand edits were replaced/);
		expect(live(box.uuid).userData.vertexEdited).toBeUndefined();
	});

	it('the A8 line names what happened', () => {
		expect(summarizeToolCall('set_geometry', {}, { updated: [{ uuid: 'a', ok: true }, { uuid: 'b', ok: true }] }, () => 'Wall')).toBe('reshaped 2 objects (Wall)');
		expect(summarizeToolCall('set_geometry', {}, { updated: [{ uuid: 'a', ok: true, from: 'Box', geometry: { type: 'Cylinder' } }] })).toBe('turned 1 object into Cylinder');
		expect(summarizeToolCall('create_lathe', {}, { created: [{ uuid: 'v', name: 'Vase' }] })).toBe('made a lathe (Vase)');
		expect(summarizeToolCall('edit_mesh', { object: 'x' }, { object: 'x', faces: [] })).toBeNull();
		expect(summarizeToolCall('edit_mesh', {}, { updated: [{ uuid: 'x', ok: true, ops: [{ op: 'extrude' }, { op: 'bevel' }] }] }, () => 'Crate')).toBe('edited the mesh of Crate (extrude, bevel)');
	});
});

describe('G2 create_lathe / G4 extrude_shape', () => {
	it('a lathe from a profile; the points ride the params and survive an Inspector edit', async () => {
		const profile = [[0, 0], [0.4, 0.05], [0.5, 0.5], [0.25, 1], [0.3, 1.2], [0, 1.2]];
		const r = await call('create_lathe', { profile, segments: 32, name: 'Vase' });
		const uuid = r.created[0].uuid;
		const o = live(uuid);
		expect(o.userData.geometryParams).toMatchObject({ gtype: 'Lathe', params: { points: profile, segments: 32 } });
		expect(o.geometry.parameters.points.length).toBe(6);
		const msg = sent.find((m) => m.type === 'geometry');
		expect(msg.params.points).toEqual(profile);
		// the Inspector's row patch keeps the profile
		await call('set_geometry', { updates: [{ uuid, params: { segments: 8 } }] });
		expect(live(uuid).geometry.parameters.points.length).toBe(6);
		expect(live(uuid).geometry.parameters.segments).toBe(8);
		// one call = one undo step: the lathe goes away whole
		history.undo();
		history.undo();
		expect(live(uuid)).toBeUndefined();
	});

	it('refuses a bad profile', async () => {
		expect((await call('create_lathe', { profile: [[0, 0]] })).error).toMatch(/at least 2/);
		expect((await call('create_lathe', { profile: [[-1, 0], [1, 1]] })).error).toMatch(/radius/);
		expect((await call('create_lathe', { profile: [[0, 'a'], [1, 1]] })).error).toMatch(/profile\[0\]/);
		expect(group.children.length).toBe(0);
	});

	it('an extrusion is centred on its depth and cuts its holes; a peer cleans the raw wire', async () => {
		const sign = [[-1, -0.5], [1, -0.5], [1, 0.5], [-1, 0.5]];
		const hole = [[-0.2, -0.2], [0.2, -0.2], [0.2, 0.2], [-0.2, 0.2]];
		const r = await call('extrude_shape', { points: sign, holes: [hole], depth: 0.1, bevel: { thickness: 0.01, size: 0.01 } });
		const o = live(r.created[0].uuid);
		const b = bbox(o);
		expect(b.min.z).toBeCloseTo(-0.06, 3);
		expect(b.max.z).toBeCloseTo(0.06, 3);
		expect(o.userData.geometryParams.params).toMatchObject({ depth: 0.1, bevel: true, holes: [hole] });
		const solid = extrudeGeometry({ points: sign, depth: 0.1 });
		const holed = extrudeGeometry({ points: sign, holes: [hole], depth: 0.1 });
		expect(holed.attributes.position.count).toBeGreaterThan(solid.attributes.position.count);
		// a hostile `geometry` message: the builder only ever sees the cleaned set
		applyRemoteGeometry({ uuid: o.uuid, gtype: 'Extrude', params: { points: [[1e9, 0], [0, 'x']], depth: -5 } });
		expect(live(o.uuid).userData.geometryParams.params.depth).toBe(0.001);
		expect(cleanExtrude({ points: [[0, 0], [1, 0]] }).points.length).toBe(4); // under 3 → the default square
		expect(cleanLathe({ points: Array.from({ length: 900 }, (_, i) => [1, i]) }).points.length).toBe(200);
	});

	it('the default Lathe (no points) is still three\'s preset', () => {
		expect(latheGeometry({ segments: 12 }).parameters.points.length).toBe(new THREE.LatheGeometry().parameters.points.length);
	});
});

describe('G3 create_tube', () => {
	it('a tube along a path with per-point radii: the record travels, the object sits at the centre', async () => {
		const path = [[0, 1, 0], [2, 1.5, 0], [4, 1, 1], [6, 1, 3]];
		const r = await call('create_tube', { path, radii: [0.05, 0.1, 0.1, 0.02], name: 'Rail' });
		const o = live(r.created[0].uuid);
		expect(o.name).toBe('Rail');
		expect(o.position.toArray()).toEqual([3, 1.125, 1]);
		expect(o.userData.spline.points.map((p) => p.radius)).toEqual([0.05, 0.1, 0.1, 0.02]);
		expect(sent.map((m) => m.type)).toEqual(['object', 'splineedit']);
		expect(sent[1].spline.points.length).toBe(4);
		// set_geometry on a tube: new radii through the spline path
		const s = await call('set_geometry', { updates: [{ uuid: o.uuid, radius: 0.2 }] });
		expect(s.updated[0].ok).toBe(true);
		expect(live(o.uuid).userData.spline.points.every((p) => p.radius === 0.2)).toBe(true);
		history.undo();
		expect(live(o.uuid).userData.spline.points[1].radius).toBe(0.1);
		history.undo();
		expect(live(o.uuid)).toBeUndefined();
	});

	it('refuses a bad path', () => {
		expect(tubeRecordOf({ path: [[0, 0, 0]] }).error).toMatch(/at least 2/);
		expect(tubeRecordOf({ path: [[0, 0, 0], [1, 1]] }).error).toMatch(/path\[1\]/);
		expect(tubeRecordOf({ path: [[0, 0, 0], [1, 1, 1]], radii: [1] }).error).toMatch(/one positive radius per path point/);
	});
});

/** a unit cube as quads (8 vertices, 6 faces) */
const CUBE = {
	vertices: [[-0.5, -0.5, -0.5], [0.5, -0.5, -0.5], [0.5, 0.5, -0.5], [-0.5, 0.5, -0.5], [-0.5, -0.5, 0.5], [0.5, -0.5, 0.5], [0.5, 0.5, 0.5], [-0.5, 0.5, 0.5]],
	faces: [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [3, 7, 6, 2], [0, 4, 7, 3], [1, 2, 6, 5]]
};

describe('G6 create_mesh', () => {
	it('builds the triangles, stores the quads as faces, sends raw bytes on meshgeo', async () => {
		const r = await call('create_mesh', { ...CUBE, name: 'Crate', position: [0, 0.5, 0] });
		expect(r.created[0]).toMatchObject({ name: 'Crate', triangles: 12, faces: 6 });
		const o = live(r.created[0].uuid);
		expect(o.geometry.attributes.position.count).toBe(36);
		expect(o.geometry.attributes.normal).toBeTruthy();
		expect(sent.map((m) => m.type)).toEqual(['object', 'meshgeo']);
		expect(sent[1].positions).toBeInstanceOf(ArrayBuffer);
		const top = core.applySelect(core.facesOf(readTriangles(o.geometry), [[0, 1], [2, 3], [4, 5], [6, 7], [8, 9], [10, 11]]), core.parseSelect({ normal: 'up' }), (f) => f.centroid).picked;
		expect(top.map((f) => f.index)).toEqual([3]); // wound outward: face 3 (y = +0.5) is the top
		history.undo();
		expect(live(o.uuid)).toBeUndefined();
	});

	it('checks every index and the caps', () => {
		expect(core.meshFromData({ vertices: CUBE.vertices, faces: [[0, 1, 99]] }).error).toMatch(/index 99/);
		expect(core.meshFromData({ vertices: CUBE.vertices, faces: [[0, 1, 1]] }).error).toMatch(/repeated/);
		expect(core.meshFromData({ vertices: CUBE.vertices, faces: [[0, 1]] }).error).toMatch(/3-32/);
		expect(core.meshFromData({ vertices: [[0, 0, 0], [1, 0, 0], [0, 1, NaN]], faces: [[0, 1, 2]] }).error).toMatch(/vertices\[2\]/);
		expect(core.meshFromData({ vertices: CUBE.vertices, faces: CUBE.faces, uvs: [[0, 0]] }).error).toMatch(/one \[u, v\] per vertex/);
		const big = Array.from({ length: core.MESH_MAX_VERTICES + 1 }, () => [0, 0, 0]);
		expect(core.meshFromData({ vertices: big, faces: [[0, 1, 2]] }).error).toMatch(/at most/);
		const ok = core.meshFromData({ ...CUBE, uvs: CUBE.vertices.map(() => [0.5, 0.5]) });
		expect(ok.partition.map((f) => f.length)).toEqual([2, 2, 2, 2, 2, 2]);
		expect(ok.uvs.length).toBe(36 * 2);
	});
});

describe('G5 edit_mesh', () => {
	it('previews faces / vertices with no ops, and changes nothing', async () => {
		const box = prim(new THREE.BoxGeometry(1, 1, 1), 'Crate');
		const p = await call('edit_mesh', { object: box.uuid, ops: [] });
		expect(p.faceCount).toBe(6);
		expect(p.vertexCount).toBe(8);
		const s = await call('edit_mesh', { object: box.uuid, select: { normal: 'up', angle: 60 } });
		expect(s.selected.faces.map((f) => f.normal)).toEqual([[0, 1, 0]]);
		expect(s.selected.vertices.length).toBe(4); // a corner's averaged normal is 54.7° off up
		expect(sent.length).toBe(0);
		expect(get(history.undoStack).length).toBe(0);
	});

	it('extrudes the top, then extrudes it again (the normal select re-reads the mesh); one undo', async () => {
		const box = prim(new THREE.BoxGeometry(1, 1, 1), 'Tower');
		const r = await call('edit_mesh', { object: box.uuid, select: { normal: 'up' }, ops: [{ op: 'extrude', distance: 0.5 }, { op: 'inset', amount: 0.3 }, { op: 'extrude', distance: 0.25 }] });
		expect(r.updated[0]).toMatchObject({ ok: true, ops: [{ op: 'extrude', faces: 1 }, { op: 'inset' }, { op: 'extrude' }] });
		expect(bbox(live(box.uuid)).max.y).toBeCloseTo(1.25, 4);
		expect(sent.filter((m) => m.type === 'meshgeo').length).toBe(3);
		expect(live(box.uuid).userData.faceEdited).toBe(true);
		expect(get(history.undoStack).length).toBe(1);
		history.undo();
		expect(bbox(live(box.uuid)).max.y).toBeCloseTo(0.5, 4);
	});

	it('bevel / subdivide / delete / flip on faces; closed selections refuse to extrude', async () => {
		const box = prim(new THREE.BoxGeometry(1, 1, 1));
		const tris0 = readTriangles(box.geometry).length;
		const sub = await call('edit_mesh', { object: box.uuid, select: { normal: '+x' }, ops: [{ op: 'subdivide' }] });
		expect(sub.updated[0].triangles).toBe(tris0 + 6);
		const bev = await call('edit_mesh', { object: box.uuid, select: { normal: 'up' }, ops: [{ op: 'bevel', width: 0.1 }] });
		expect(bev.updated[0].ok).toBe(true);
		const closed = prim(new THREE.BoxGeometry());
		const all = await call('edit_mesh', { object: closed.uuid, select: { all: true }, ops: [{ op: 'extrude', distance: 1 }] });
		expect(all.error).toMatch(/CLOSED/);
		const del = await call('edit_mesh', { object: box.uuid, select: { normal: 'down' }, ops: [{ op: 'delete' }] });
		expect(del.updated[0].ok).toBe(true);
		expect(core.facesOf(readTriangles(live(box.uuid).geometry), [[0]]).length).toBe(1);
	});

	it('vertex ops: move a box selection, weld two corners, smooth', async () => {
		const box = prim(new THREE.BoxGeometry(1, 1, 1));
		const top = { mode: 'vertices', box: { min: [-1, 0.4, -1], max: [1, 1, 1] } };
		const m = await call('edit_mesh', { object: box.uuid, select: top, ops: [{ op: 'move', offset: [0, 0.5, 0] }] });
		expect(m.updated[0].ops[0]).toEqual({ op: 'move', vertices: 4 });
		expect(bbox(live(box.uuid)).max.y).toBeCloseTo(1, 4);
		expect(bbox(live(box.uuid)).min.y).toBeCloseTo(-0.5, 4);
		const w = await call('edit_mesh', { object: box.uuid, select: { mode: 'vertices', box: { min: [0.4, 0.9, -1], max: [1, 1.1, 1] } }, ops: [{ op: 'weld' }] });
		expect(w.updated[0].ok).toBe(true);
		expect(core.verticesOf(readTriangles(live(box.uuid).geometry)).length).toBe(7);
		const one = await call('edit_mesh', { object: box.uuid, select: { mode: 'vertices', indices: [0] }, ops: [{ op: 'weld' }] });
		expect(one.error).toMatch(/at least 2/);
	});

	it('says what is wrong: an op of the other mode, an index that does not exist, no selection', async () => {
		const box = prim(new THREE.BoxGeometry());
		expect((await call('edit_mesh', { object: box.uuid, select: { mode: 'faces', all: true }, ops: [{ op: 'weld' }] })).error).toMatch(/not a faces op/);
		expect((await call('edit_mesh', { object: box.uuid, select: { indices: [42] }, ops: [{ op: 'extrude' }] })).error).toMatch(/42 do not exist/);
		expect((await call('edit_mesh', { object: box.uuid, ops: [{ op: 'extrude' }] })).error).toMatch(/no selection/);
		expect((await call('edit_mesh', { object: box.uuid, select: {} })).error).toMatch(/give indices, normal, box or all/);
		expect((await call('edit_mesh', { object: 'nope', ops: [] })).error).toMatch(/no object/);
		// a second op failing keeps the first (still one undo step) and says where it stopped
		const half = await call('edit_mesh', { object: box.uuid, select: { normal: 'up' }, ops: [{ op: 'extrude', distance: 0.2 }, { op: 'connect', select: { mode: 'vertices', all: true } }] });
		expect(half.updated[0]).toMatchObject({ ok: false, ops: [{ op: 'extrude' }] });
		expect(half.warning).toMatch(/stopped at: ops\[1\]/);
	});
});

describe('meshSelectCore', () => {
	it('directions, boxes and angles', () => {
		expect(core.directionOf('UP')).toEqual([0, 1, 0]);
		expect(core.directionOf([0, 2, 0])).toEqual([0, 1, 0]);
		expect(core.directionOf([0, 0, 0])).toBeNull();
		expect(core.parseSelect({ angle: 200, all: true }).error).toMatch(/angle/);
		expect(core.parseSelect({ indices: [-1] }).error).toMatch(/whole numbers/);
		expect(core.parseSelect({ box: { min: [0, 0] } }).error).toMatch(/box/);
		const tris = readTriangles(new THREE.BoxGeometry(1, 1, 1));
		const faces = core.facesOf(tris, tris.map((_, i) => [i]));
		// 90° takes the top and its four side neighbours' half-planes? no: sides are exactly 90° off, cos 0
		expect(core.applySelect(faces, core.parseSelect({ normal: 'up', angle: 89 }), (f) => f.centroid).picked.length).toBe(2);
		expect(core.applySelect(faces, core.parseSelect({ normal: 'up', angle: 90 }), (f) => f.centroid).picked.length).toBe(10);
	});
});
