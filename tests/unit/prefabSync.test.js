import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
	stampElementKeys,
	linkNode,
	linkRoot,
	linkOf,
	mergeInstance,
	overridesOf,
	unlinkPatch,
	instanceKey,
	elementKey,
	same
} from '../../src/lib/prefabSync.js';

// 37 R4: the merge behind "Update N instances". Every case builds a real prefab element
// with three (toJSON), places a real instance the way instantiatePrefab does (parse, key,
// re-uuid, link), edits it like a user would, and merges — then parses the result back,
// because an element ObjectLoader cannot read is worse than no update at all.

const P = 'prefab-1';
const loader = new THREE.ObjectLoader();

/** A table: a root group holding a red top and a blue leg, the leg holding a foot. */
function buildTable() {
	const root = new THREE.Group();
	root.name = 'Table';
	const top = new THREE.Mesh(new THREE.BoxGeometry(2, 0.1, 1), new THREE.MeshStandardMaterial({ color: 0xff0000 }));
	top.name = 'Top';
	top.position.set(0, 1, 0);
	const leg = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1, 0.1), new THREE.MeshStandardMaterial({ color: 0x0000ff }));
	leg.name = 'Leg';
	leg.position.set(0.9, 0.5, 0.4);
	const foot = new THREE.Mesh(new THREE.SphereGeometry(0.08), new THREE.MeshStandardMaterial({ color: 0x00ff00 }));
	foot.name = 'Foot';
	leg.add(foot);
	root.add(top, leg);
	return root;
}

/** toJSON reads the matrix the last RENDER composed; the app serializes after
 * updateMatrixWorld, and so do these tests @param {any} object */
const json = (object) => {
	object.updateMatrixWorld(true);
	return object.toJSON();
};
/** the library element for a tree, keyed like savePrefab does @param {any} root */
function elementOf(root) {
	return stampElementKeys(json(root), P);
}

/** place an instance exactly as instantiatePrefab does @param {any} element @param {number} rev */
function place(element, rev = 0, at = [5, 0, -3]) {
	const object = loader.parse(JSON.parse(JSON.stringify(element)));
	object.traverse((/** @type {any} */ n) => {
		linkNode(n, P);
		n.uuid = crypto.randomUUID();
	});
	linkRoot(object, P, rev);
	object.position.set(at[0], at[1], at[2]);
	object.rotation.y = 0.7;
	return object;
}

/** @param {any} object @param {string} name */
const byName = (object, name) => object.getObjectByName(name);
/** @param {any} element @param {string} name */
const nodeNamed = (element, name) => {
	/** @type {any} */
	let hit = null;
	const walk = (/** @type {any} */ n) => {
		if (n.name === name) hit = n;
		for (const c of n.children ?? []) walk(c);
	};
	walk(element.object);
	return hit;
};
/** the colour of a named mesh in a parsed element @param {any} element @param {string} name */
const colorOf = (element, name) => byName(loader.parse(element), name)?.material.color.getHex();

describe('keys', () => {
	it('stamps every element node with a unique key and drops the root link', () => {
		const el = elementOf(buildTable());
		/** @type {string[]} */
		const keys = [];
		const walk = (/** @type {any} */ n) => {
			keys.push(n.userData.prefabKey);
			for (const c of n.children ?? []) walk(c);
		};
		walk(el.object);
		expect(keys.length).toBe(4);
		expect(new Set(keys).size).toBe(4);
		expect(el.object.userData.prefab).toBeUndefined();
	});

	it('an instance carries its keys BY PREFAB and no element-side key', () => {
		const el = elementOf(buildTable());
		const inst = place(el);
		const top = byName(inst, 'Top');
		expect(instanceKey(top, P)).toBe(elementKey(nodeNamed(el, 'Top')));
		expect(top.userData.prefabKey).toBeUndefined();
		expect(linkOf(inst)).toEqual({ id: P, rev: 0 });
		// the library element's userData was not written through the parse's reference
		expect(nodeNamed(el, 'Top').userData.prefabKeys).toBeUndefined();
	});

	it('updating FROM an instance keeps the keys the instance carries', () => {
		const el = elementOf(buildTable());
		const inst = place(el);
		const again = stampElementKeys(json(inst), P);
		expect(elementKey(nodeNamed(again, 'Leg'))).toBe(elementKey(nodeNamed(el, 'Leg')));
		expect(elementKey(nodeNamed(again, 'Foot'))).toBe(elementKey(nodeNamed(el, 'Foot')));
		expect(again.object.userData.prefab).toBeUndefined();
		expect(nodeNamed(again, 'Leg').userData.prefabKeys).toBeUndefined();
	});

	it('saving an instance of Q as a NEW prefab cuts it loose from Q', () => {
		const el = elementOf(buildTable());
		const inst = place(el);
		const other = stampElementKeys(json(inst), 'prefab-2');
		// fresh keys (uuids of the instance), and no trace of P's keys
		expect(elementKey(nodeNamed(other, 'Leg'))).toBe(byName(inst, 'Leg').uuid);
		expect(nodeNamed(other, 'Leg').userData.prefabKeys).toBeUndefined();
	});

	it('a duplicated key inside an instance is re-keyed so the next element stays unique', () => {
		const el = elementOf(buildTable());
		const inst = place(el);
		const twin = byName(inst, 'Leg').clone(true); // a user duplicate: same userData
		twin.name = 'Leg2';
		inst.add(twin);
		const again = stampElementKeys(json(inst), P);
		expect(elementKey(nodeNamed(again, 'Leg2'))).not.toBe(elementKey(nodeNamed(again, 'Leg')));
	});
});

describe('merge', () => {
	it('an untouched instance takes the new prefab and keeps its placement and uuids', () => {
		const base = buildTable();
		const el = elementOf(base);
		const inst = place(el);
		// the prefab changes: the top turns yellow, the leg moves
		byName(base, 'Top').material.color.set(0xffff00);
		byName(base, 'Leg').position.x = 0.5;
		const next = stampElementKeys(json(base), P);
		const before = json(inst);
		const { element, overrides, added, removed } = mergeInstance(before, el, next, { prefabId: P, rev: 1 });
		expect(overrides).toEqual([]);
		expect(added).toBe(0);
		expect(removed).toBe(0);
		const out = loader.parse(element);
		expect(out.uuid).toBe(inst.uuid);
		expect(byName(out, 'Top').uuid).toBe(byName(inst, 'Top').uuid);
		expect(byName(out, 'Top').material.color.getHex()).toBe(0xffff00);
		expect(byName(out, 'Leg').position.x).toBeCloseTo(0.5);
		// the placement is the instance's
		expect(out.position.toArray()).toEqual([5, 0, -3]);
		expect(out.rotation.y).toBeCloseTo(0.7);
		expect(linkOf(out)).toEqual({ id: P, rev: 1 });
		// the input was not mutated
		expect(same(before, json(inst))).toBe(true);
	});

	it('keeps an override, takes everything else, and reports what it kept', () => {
		const base = buildTable();
		const el = elementOf(base);
		const inst = place(el);
		byName(inst, 'Top').material.color.set(0x123456); // the user's override (same uuid, in place)
		byName(base, 'Top').material.color.set(0xffff00); // the prefab edits both
		byName(base, 'Leg').material.color.set(0xff00ff);
		const next = stampElementKeys(json(base), P);
		const { element, overrides } = mergeInstance(json(inst), el, next, { prefabId: P, rev: 1 });
		expect(colorOf(element, 'Top')).toBe(0x123456);
		expect(colorOf(element, 'Leg')).toBe(0xff00ff);
		expect(overrides).toEqual(['Top.material']);
		// the instance's edited material shared its uuid with the prefab's different one:
		// both survive under distinct uuids
		const uuids = element.materials.map((/** @type {any} */ m) => m.uuid);
		expect(new Set(uuids).size).toBe(uuids.length);
	});

	it('an overridden material whose uuid the prefab still uses elsewhere is re-minted, not merged', () => {
		const base = buildTable();
		const el = elementOf(base);
		const inst = place(el);
		byName(inst, 'Top').material.color.set(0x123456);
		// the new revision recolours the top AND hands that same material to a new vase
		byName(base, 'Top').material.color.set(0xffff00);
		const vase = new THREE.Mesh(new THREE.BoxGeometry(), byName(base, 'Top').material);
		vase.name = 'Vase';
		base.add(vase);
		const next = stampElementKeys(json(base), P);
		const { element } = mergeInstance(json(inst), el, next, { prefabId: P, rev: 1 });
		expect(colorOf(element, 'Top')).toBe(0x123456);
		expect(colorOf(element, 'Vase')).toBe(0xffff00);
		const uuids = element.materials.map((/** @type {any} */ m) => m.uuid);
		expect(new Set(uuids).size).toBe(uuids.length);
	});

	it('reset overrides takes the prefab everywhere except the placement', () => {
		const base = buildTable();
		const el = elementOf(base);
		const inst = place(el);
		byName(inst, 'Top').material.color.set(0x123456);
		byName(inst, 'Leg').position.y = 3;
		const mine = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
		mine.name = 'Mine';
		inst.add(mine);
		const next = stampElementKeys(json(base), P);
		const { element, overrides } = mergeInstance(json(inst), el, next, { prefabId: P, rev: 1, reset: true });
		const out = loader.parse(element);
		expect(overrides).toEqual([]);
		expect(byName(out, 'Top').material.color.getHex()).toBe(0xff0000);
		expect(byName(out, 'Leg').position.y).toBeCloseTo(0.5);
		expect(byName(out, 'Mine')).toBeUndefined();
		expect(out.position.toArray()).toEqual([5, 0, -3]);
	});

	it('a child transform, a name, visibility and a userData key are overrides of their own', () => {
		const base = buildTable();
		const el = elementOf(base);
		const inst = place(el);
		byName(inst, 'Leg').position.z = 2;
		byName(inst, 'Foot').visible = false;
		byName(inst, 'Top').userData.note = 'mine';
		byName(base, 'Leg').scale.set(2, 2, 2); // the prefab changes the leg's transform too
		byName(base, 'Top').userData.note = 'theirs';
		byName(base, 'Top').userData.other = 1;
		const next = stampElementKeys(json(base), P);
		const { element, overrides } = mergeInstance(json(inst), el, next, { prefabId: P, rev: 1 });
		const out = loader.parse(element);
		expect(byName(out, 'Leg').position.z).toBeCloseTo(2);
		expect(byName(out, 'Leg').scale.x).toBeCloseTo(1); // the transform is ONE field: the override wins whole
		expect(byName(out, 'Foot').visible).toBe(false);
		expect(byName(out, 'Top').userData.note).toBe('mine');
		expect(byName(out, 'Top').userData.other).toBe(1);
		expect(overrides.sort()).toEqual(['Foot.visible', 'Leg.transform', 'Top.userData.note']);
	});

	it('the root scale is an ordinary override; position and rotation are always the placement', () => {
		const base = buildTable();
		const el = elementOf(base);
		const inst = place(el);
		base.scale.set(3, 3, 3);
		const next = stampElementKeys(json(base), P);
		let out = loader.parse(mergeInstance(json(inst), el, next, { prefabId: P, rev: 1 }).element);
		expect(out.scale.x).toBeCloseTo(3);
		inst.scale.set(0.5, 0.5, 0.5);
		const res = mergeInstance(json(inst), el, next, { prefabId: P, rev: 1 });
		out = loader.parse(res.element);
		expect(out.scale.x).toBeCloseTo(0.5);
		expect(res.overrides).toEqual(['Table.scale']);
		expect(out.position.toArray()).toEqual([5, 0, -3]);
	});

	it('adds the prefab\'s new nodes, drops the ones it removed, and keeps what the user added', () => {
		const base = buildTable();
		const el = elementOf(base);
		const inst = place(el);
		const mine = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial({ color: 0xabcdef }));
		mine.name = 'Mine';
		byName(inst, 'Top').add(mine);
		// the prefab gains a vase and loses the leg (with its foot)
		const vase = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.3), new THREE.MeshStandardMaterial());
		vase.name = 'Vase';
		base.add(vase);
		base.remove(byName(base, 'Leg'));
		const next = stampElementKeys(json(base), P);
		const { element, added, removed, kept } = mergeInstance(json(inst), el, next, { prefabId: P, rev: 1 });
		const out = loader.parse(element);
		expect(byName(out, 'Vase')).toBeTruthy();
		expect(instanceKey(byName(out, 'Vase'), P)).toBe(elementKey(nodeNamed(next, 'Vase')));
		expect(byName(out, 'Leg')).toBeUndefined();
		expect(byName(out, 'Foot')).toBeUndefined();
		expect(byName(out, 'Mine')?.parent?.name).toBe('Top');
		expect(byName(out, 'Mine').material.color.getHex()).toBe(0xabcdef);
		expect(added).toBe(1);
		expect(removed).toBe(2);
		expect(kept).toBe(1);
	});

	it('the user\'s own children of a node the prefab removed are rescued, not lost', () => {
		const base = buildTable();
		const el = elementOf(base);
		const inst = place(el);
		const mine = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
		mine.name = 'Mine';
		byName(inst, 'Leg').add(mine);
		base.remove(byName(base, 'Leg'));
		const next = stampElementKeys(json(base), P);
		const out = loader.parse(mergeInstance(json(inst), el, next, { prefabId: P, rev: 1 }).element);
		expect(byName(out, 'Mine')?.parent).toBe(out);
	});

	it('a node the user deleted stays deleted (an override), and comes back on reset', () => {
		const base = buildTable();
		const el = elementOf(base);
		const inst = place(el);
		inst.remove(byName(inst, 'Leg'));
		byName(base, 'Top').material.color.set(0xffff00);
		const next = stampElementKeys(json(base), P);
		const res = mergeInstance(json(inst), el, next, { prefabId: P, rev: 1 });
		expect(byName(loader.parse(res.element), 'Leg')).toBeUndefined();
		expect(res.overrides).toEqual(['Leg (deleted)']);
		const reset = mergeInstance(json(inst), el, next, { prefabId: P, rev: 1, reset: true });
		expect(byName(loader.parse(reset.element), 'Leg')).toBeTruthy();
	});

	it('COUNTERFACTUAL: without the keys the update cannot find a single node', () => {
		const base = buildTable();
		const el = elementOf(base);
		const inst = place(el);
		byName(base, 'Leg').material.color.set(0xff00ff);
		const next = stampElementKeys(json(base), P);
		const withKeys = mergeInstance(json(inst), el, next, { prefabId: P, rev: 1 });
		expect(colorOf(withKeys.element, 'Leg')).toBe(0xff00ff);
		const bare = json(inst);
		const strip = (/** @type {any} */ n) => {
			if (n.userData) delete n.userData.prefabKeys;
			for (const c of n.children ?? []) strip(c);
		};
		strip(bare.object);
		const res = mergeInstance(bare, el, next, { prefabId: P, rev: 1 });
		// every child reads as the user's own and every prefab node as deleted here: the
		// prefab's edit reaches nothing
		expect(colorOf(res.element, 'Leg')).toBe(0x0000ff);
		expect(res.kept).toBe(2);
	});

	it('an unknown base revision detects no overrides and takes the prefab', () => {
		const base = buildTable();
		const el = elementOf(base);
		const inst = place(el);
		byName(base, 'Top').material.color.set(0xffff00);
		const next = stampElementKeys(json(base), P);
		const res = mergeInstance(json(inst), null, next, { prefabId: P, rev: 1 });
		expect(res.overrides).toEqual([]);
		expect(colorOf(res.element, 'Top')).toBe(0xffff00);
	});

	it('a merge onto the same prefab is idempotent', () => {
		const base = buildTable();
		const el = elementOf(base);
		const inst = place(el);
		byName(inst, 'Leg').position.z = 2;
		const once = mergeInstance(json(inst), el, el, { prefabId: P, rev: 0 }).element;
		const twice = mergeInstance(once, el, el, { prefabId: P, rev: 0 }).element;
		expect(same(once.object, twice.object)).toBe(true);
	});
});

describe('nesting and unlinking', () => {
	it('an instance of another prefab nested inside keeps its own link through an update', () => {
		const chair = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
		chair.name = 'Chair';
		// the inner instance as it would sit in the scene: root link + its own keys
		chair.userData = { prefab: { id: 'chair', rev: 4 }, prefabKeys: { chair: 'c-root' } };
		const base = buildTable();
		base.add(chair);
		const el = elementOf(base);
		expect(nodeNamed(el, 'Chair').userData.prefab).toEqual({ id: 'chair', rev: 4 });
		const inst = place(el);
		const next = stampElementKeys(json(base), P);
		const out = loader.parse(mergeInstance(json(inst), el, next, { prefabId: P, rev: 1 }).element);
		const c = byName(out, 'Chair');
		expect(c.userData.prefab).toEqual({ id: 'chair', rev: 4 });
		expect(c.userData.prefabKeys.chair).toBe('c-root');
		expect(c.userData.prefabKeys[P]).toBe(elementKey(nodeNamed(el, 'Chair')));
	});

	it('unlink drops the root link and every key for that prefab only', () => {
		const el = elementOf(buildTable());
		const inst = place(el);
		byName(inst, 'Leg').userData.prefabKeys.other = 'x';
		const patch = unlinkPatch(inst, P);
		expect(patch[inst.uuid].prefab).toBeUndefined();
		expect(patch[byName(inst, 'Top').uuid].prefabKeys).toBeUndefined();
		expect(patch[byName(inst, 'Leg').uuid].prefabKeys).toEqual({ other: 'x' });
	});
});

describe('overridesOf', () => {
	it('lists what an instance changed, and nothing for a pristine one', () => {
		const el = elementOf(buildTable());
		const inst = place(el);
		expect(overridesOf(json(inst), el, P)).toEqual([]);
		byName(inst, 'Foot').visible = false;
		byName(inst, 'Top').material.color.set(0x111111);
		expect(overridesOf(json(inst), el, P).sort()).toEqual(['Foot.visible', 'Top.material']);
	});
});
