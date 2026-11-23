// 105-slot-save-fix: a primitive with an added material slot keeps every face through a save, and a file saved before
// the fix loads with its faces back. Counterfactuals: the "plain toJSON" rows are the shipped bug.
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { objectToJSON, losesSlotGroups, settleSlotGroups, healSlotGroups } from '../../src/lib/slotGroups.js';
import { parseCheckedObject } from '../../src/lib/loadGuard.js';

/** triangles that draw (inside a group whose slot exists) @param {any} mesh */
function drawn(mesh) {
	const g = mesh.geometry;
	const count = (g.index ? g.index.count : g.attributes.position.count) / 3;
	if (!Array.isArray(mesh.material)) return count;
	let n = 0;
	for (let t = 0; t < count; t++) {
		const at = t * 3;
		const group = g.groups.find((/** @type {any} */ x) => at >= x.start && at < x.start + x.count);
		if (group && (group.materialIndex || 0) < mesh.material.length) n++;
	}
	return n;
}

/** what "Add material slot" leaves on a fresh primitive: two slots, one group covering every face on slot 0 */
function withAddedSlot(/** @type {any} */ geometry) {
	const mesh = new THREE.Mesh(geometry, [new THREE.MeshStandardMaterial({ color: 0xff0000 }), new THREE.MeshStandardMaterial({ color: 0x00ff00 })]);
	mesh.material[1].name = 'slot1';
	const count = geometry.index ? geometry.index.count : geometry.attributes.position.count;
	geometry.clearGroups();
	geometry.addGroup(0, count, 0);
	return mesh;
}

/** @param {any} json @returns {any} */
const reload = (json) => new THREE.ObjectLoader().parse(JSON.parse(JSON.stringify(json)));
const meshOf = (/** @type {any} */ root) => {
	/** @type {any} */ let m = null;
	root.traverse((/** @type {any} */ o) => (m ??= o.isMesh ? o : null));
	return m;
};

describe('slot groups: the save', () => {
	it('a box with an added slot: plain toJSON loses 8 of 12 triangles (the bug), objectToJSON keeps all 12', () => {
		const box = withAddedSlot(new THREE.BoxGeometry(1, 1, 1));
		expect(drawn(box)).toBe(12);
		expect(losesSlotGroups(box)).toBe(true);
		expect(drawn(reload(box.toJSON()))).toBe(4); // counterfactual: what 1.74.0 writes
		const back = reload(objectToJSON(box));
		expect(drawn(back)).toBe(12);
		expect(back.geometry.groups.map((/** @type {any} */ g) => [g.start, g.count, g.materialIndex])).toEqual([[0, 36, 0]]);
		expect(back.geometry.uuid).toBe(box.geometry.uuid);
		expect(back.material.map((/** @type {any} */ m) => m.name)).toEqual(['', 'slot1']);
	});

	it('a sphere with an added slot: plain toJSON draws nothing, objectToJSON draws every face', () => {
		const sphere = withAddedSlot(new THREE.SphereGeometry(1, 8, 6));
		const all = drawn(sphere);
		expect(drawn(reload(sphere.toJSON()))).toBe(0);
		expect(drawn(reload(objectToJSON(sphere)))).toBe(all);
	});

	it('a slot-list primitive inside a group (nested) is written with its groups too', () => {
		const holder = new THREE.Group();
		holder.add(withAddedSlot(new THREE.CylinderGeometry(1, 1, 1, 8)));
		const all = drawn(holder.children[0]);
		expect(drawn(meshOf(reload(holder.toJSON())))).toBeLessThan(all);
		expect(drawn(meshOf(reload(objectToJSON(holder))))).toBe(all);
	});

	it('an EDITED mesh (plain geometry, faces on two slots) is byte-identical to toJSON and round-trips', () => {
		const flat = new THREE.BufferGeometry().copy(new THREE.BoxGeometry(1, 1, 1));
		flat.clearGroups();
		flat.addGroup(0, 6, 1);
		flat.addGroup(6, 30, 0);
		const mesh = new THREE.Mesh(flat, [new THREE.MeshStandardMaterial(), new THREE.MeshStandardMaterial()]);
		expect(objectToJSON(mesh)).toEqual(mesh.toJSON());
		const back = reload(objectToJSON(mesh));
		expect(back.geometry.groups.map((/** @type {any} */ g) => [g.start, g.count, g.materialIndex])).toEqual([[0, 6, 1], [6, 30, 0]]);
		expect(drawn(back)).toBe(12);
	});

	it('feature unused = zero change: a single-material primitive is written exactly as before', () => {
		const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 1, 1), new THREE.MeshStandardMaterial());
		expect(losesSlotGroups(mesh)).toBe(false);
		expect(objectToJSON(mesh)).toEqual(mesh.toJSON());
	});

	it('a slot list the generator makes itself (6 slots on a box) stays parametric', () => {
		const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), Array.from({ length: 6 }, () => new THREE.MeshStandardMaterial()));
		expect(losesSlotGroups(mesh)).toBe(false);
		const json = objectToJSON(mesh);
		expect(json).toEqual(mesh.toJSON());
		expect(json.geometries[0].type).toBe('BoxGeometry');
	});

	it('a shape-built primitive whose generator makes the slot groups (extrude: caps + sides) stays parametric', () => {
		const shape = new THREE.Shape([new THREE.Vector2(0, 0), new THREE.Vector2(1, 0), new THREE.Vector2(0, 1)]);
		const mesh = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth: 0.2, bevelEnabled: false }), [new THREE.MeshStandardMaterial(), new THREE.MeshStandardMaterial()]);
		expect(losesSlotGroups(mesh)).toBe(false);
		expect(objectToJSON(mesh)).toEqual(mesh.toJSON());
	});

	it('a geometry type the loader cannot rebuild is written plain (the only form that loads)', () => {
		const geometry = /** @type {any} */ (new THREE.BoxGeometry(1, 1, 1));
		geometry.type = 'NoSuchGeometry';
		const mesh = withAddedSlot(geometry);
		expect(losesSlotGroups(mesh)).toBe(true);
		expect(objectToJSON(mesh).geometries[0].type).toBe('BufferGeometry');
	});

	it('two meshes sharing one geometry still share it (one entry, same uuid)', () => {
		const box = withAddedSlot(new THREE.BoxGeometry(1, 1, 1));
		const twin = new THREE.Mesh(box.geometry, box.material);
		const holder = new THREE.Group();
		holder.add(box, twin);
		const json = objectToJSON(holder);
		expect(json.geometries.length).toBe(1);
		expect(json.geometries[0].uuid).toBe(box.geometry.uuid);
		const back = reload(json);
		expect(back.children[0].geometry).toBe(back.children[1].geometry);
		expect(drawn(back.children[1])).toBe(12);
	});

	it('the live object is not touched by objectToJSON', () => {
		const box = withAddedSlot(new THREE.BoxGeometry(1, 1, 1));
		const geometry = box.geometry;
		objectToJSON(box);
		expect(box.geometry).toBe(geometry);
		expect(geometry.type).toBe('BoxGeometry');
	});
});

describe('slot groups: at the source', () => {
	it('settleSlotGroups swaps in a plain copy under the same uuid, userData kept; plain toJSON is then right', () => {
		const box = withAddedSlot(new THREE.BoxGeometry(1, 1, 1));
		box.geometry.userData.mark = 7;
		const uuid = box.geometry.uuid;
		expect(settleSlotGroups(box)).toBe(true);
		expect(box.geometry.type).toBe('BufferGeometry');
		expect(box.geometry.uuid).toBe(uuid);
		expect(box.geometry.userData.mark).toBe(7);
		expect(drawn(reload(box.toJSON()))).toBe(12);
		expect(settleSlotGroups(box)).toBe(false); // idempotent
	});

	it('settleSlotGroups leaves a single-material primitive alone', () => {
		const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
		const geometry = mesh.geometry;
		expect(settleSlotGroups(mesh)).toBe(false);
		expect(mesh.geometry).toBe(geometry);
	});
});

describe('slot groups: scenes saved broken (before the fix)', () => {
	it('heal brings every face back on slot 0 and the healed object saves correctly from then on', () => {
		const brokenFile = withAddedSlot(new THREE.BoxGeometry(1, 1, 1)).toJSON(); // what 1.74.0 wrote
		const loaded = reload(brokenFile);
		expect(drawn(loaded)).toBe(4);
		expect(healSlotGroups(loaded)).toBe(1);
		expect(drawn(loaded)).toBe(12);
		expect(loaded.geometry.groups.map((/** @type {any} */ g) => [g.start, g.count, g.materialIndex])).toEqual([[0, 36, 0]]);
		expect(loaded.geometry.type).toBe('BufferGeometry');
		expect(drawn(reload(loaded.toJSON()))).toBe(12);
	});

	it('a broken sphere (no groups at all) heals', () => {
		const loaded = reload(withAddedSlot(new THREE.SphereGeometry(1, 8, 6)).toJSON());
		expect(drawn(loaded)).toBe(0);
		healSlotGroups(loaded);
		expect(drawn(loaded)).toBe(loaded.geometry.index.count / 3);
	});

	it('an old scene that draws every face loads unchanged (6-slot box, single material, edited mesh)', () => {
		const six = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), Array.from({ length: 6 }, () => new THREE.MeshStandardMaterial()));
		const one = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
		const holder = new THREE.Group();
		holder.add(six, one);
		const loaded = reload(holder.toJSON());
		const before = JSON.stringify(loaded.toJSON());
		expect(healSlotGroups(loaded)).toBe(0);
		expect(JSON.stringify(loaded.toJSON())).toBe(before);
	});

	it('a PLAIN geometry is never second-guessed (its groups are what its author wrote)', () => {
		const flat = new THREE.BufferGeometry().copy(new THREE.BoxGeometry(1, 1, 1));
		flat.clearGroups();
		flat.addGroup(0, 36, 3); // out of range, but authored
		const mesh = new THREE.Mesh(flat, [new THREE.MeshStandardMaterial(), new THREE.MeshStandardMaterial()]);
		expect(healSlotGroups(mesh)).toBe(0);
		expect(mesh.geometry.groups[0].materialIndex).toBe(3);
	});

	it('every load path heals: parseCheckedObject (files, peers, undo, prefabs)', () => {
		const brokenFile = withAddedSlot(new THREE.BoxGeometry(1, 1, 1)).toJSON();
		const loaded = /** @type {any} */ (parseCheckedObject(JSON.parse(JSON.stringify(brokenFile)), 'file', 'test'));
		expect(drawn(loaded)).toBe(12);
	});
});
