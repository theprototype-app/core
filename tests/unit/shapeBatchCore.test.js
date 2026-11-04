import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { shapePose, resolveShape, checkShapes, SHAPE_ACTIONS, SHAPES_MAX } from '../../src/lib/ai/shapeBatchCore.js';
import { CONNECTOR_FAMILIES } from '../../tools/agent/src/catalog.js';

/** the app's order for a nested part: made at the root, attach() into the group (keeps the world pose), then the LOCAL pose */
function nestThenPlace(/** @type {THREE.Object3D} */ group, /** @type {any} */ args) {
	const part = new THREE.Object3D();
	const root = /** @type {THREE.Object3D} */ (group.parent);
	root.add(part);
	group.attach(part);
	const pose = /** @type {any} */ (shapePose(args, true));
	part.position.fromArray(pose.position);
	part.rotation.set(pose.rotation[0], pose.rotation[1], pose.rotation[2]);
	part.scale.fromArray(pose.scale);
	return part;
}

describe('shapePose (mcp-shapes item 1)', () => {
	it('fills the group frame when nested and leaves a root pose alone', () => {
		expect(shapePose({}, true)).toEqual({ position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] });
		expect(shapePose({}, false)).toEqual({});
		expect(shapePose({ position: [1, 2, 3] }, false)).toEqual({ position: [1, 2, 3] });
		expect(shapePose({ rotation: [0, 1, 0] }, true)).toEqual({ position: [0, 0, 0], rotation: [0, 1, 0], scale: [1, 1, 1] });
	});
	it('names a bad field', () => {
		expect(shapePose({ position: [1, 2] }, true)).toEqual({ error: 'position: [x, y, z] numbers' });
		expect(shapePose({ scale: [1, NaN, 1] }, false)).toEqual({ error: 'scale: [x, y, z] numbers' });
	});
	it("the agent's repro: a part in a group turned -90 deg sits at the group's origin and turns with it", () => {
		const root = new THREE.Object3D();
		const group = new THREE.Group();
		root.add(group);
		group.position.set(-0.9, 0, 0.9);
		group.rotation.set(0, -Math.PI / 2, 0);
		root.updateMatrixWorld(true);
		const part = nestThenPlace(group, {});
		expect(part.position.toArray()).toEqual([0, 0, 0]); // LOCAL, as list_scene reports it
		expect(part.rotation.y).toBe(0);
		root.updateMatrixWorld(true);
		const w = new THREE.Vector3().setFromMatrixPosition(part.matrixWorld);
		expect(w.x).toBeCloseTo(-0.9, 6);
		expect(w.z).toBeCloseTo(0.9, 6);
		// a local offset is in the GROUP's axes: -90 deg about y maps local +x to world +z
		const off = nestThenPlace(group, { position: [1, 0, 0] });
		root.updateMatrixWorld(true);
		const ow = new THREE.Vector3().setFromMatrixPosition(off.matrixWorld);
		expect(ow.x).toBeCloseTo(-0.9, 6);
		expect(ow.z).toBeCloseTo(1.9, 6);
		// turning the group carries both parts
		group.rotation.y = 0;
		root.updateMatrixWorld(true);
		const ow2 = new THREE.Vector3().setFromMatrixPosition(off.matrixWorld);
		expect(ow2.x).toBeCloseTo(0.1, 6);
		expect(ow2.z).toBeCloseTo(0.9, 6);
	});
});

describe('create_shapes batch (mcp-shapes item 2)', () => {
	it('resolves the connector shape, the flattened shape and a fine tool name', () => {
		expect(resolveShape({ action: 'mesh', mesh: { vertices: [1] } })).toEqual({ tool: 'create_mesh', action: 'mesh', args: { vertices: [1] } });
		expect(resolveShape({ action: 'lathe', profile: [[0, 0]] })).toEqual({ tool: 'create_lathe', action: 'lathe', args: { profile: [[0, 0]] } });
		expect(resolveShape({ action: 'create_tube', path: [] })).toEqual({ tool: 'create_tube', action: 'tube', args: { path: [] } });
		expect(resolveShape({ action: 'extrude_shape', extrude_shape: { points: [] } })).toEqual({ tool: 'extrude_shape', action: 'extrude', args: { points: [] } });
	});
	it('names the entry index in every error', () => {
		const r = /** @type {any} */ (checkShapes([{ action: 'mesh', mesh: {} }, { action: 'cone' }, 'x', { action: 'tube', tube: [1] }]));
		expect(r.errors).toEqual([
			'shapes[1]: action: one of lathe, tube, extrude, mesh (not "cone")',
			'shapes[2]: an object like {"action": "mesh", "mesh": {…}}',
			'shapes[3]: tube: an object with its fields'
		]);
		expect(r.error).toBe(r.errors[0]);
	});
	it('caps the batch and refuses an empty one', () => {
		expect(/** @type {any} */ (checkShapes(Array.from({ length: SHAPES_MAX + 1 }, () => ({ action: 'mesh' })))).error).toMatch(/at most 50/);
		expect(/** @type {any} */ (checkShapes([])).error).toMatch(/shapes:/);
		expect(/** @type {any} */ (checkShapes(Array.from({ length: SHAPES_MAX }, () => ({ action: 'mesh' })))).entries).toHaveLength(SHAPES_MAX);
	});
	it("the actions are the connector's create_shape family", () => {
		// 64-text: `text` (create_text) is a family action made one per call, not a batch entry
		// diorama2: import is one model file per call (base64, chunks or a fetch), never a batch entry
		const { shapes: _batch, text: _text, import: imp, ...actions } = CONNECTOR_FAMILIES.create_shape.actions;
		expect(_text).toBe('create_text');
		expect(imp).toBe('import_shape');
		expect(actions).toEqual(SHAPE_ACTIONS);
	});
});
