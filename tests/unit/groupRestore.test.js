// @ts-nocheck — scene fixtures built ad hoc
// mcp-diorama2 item 1: a group survives the autosave's glTF round trip (GLTFLoader builds an empty node as a plain
// Object3D, so after "Session restored" every group read as Object3D and its parts reported no parent).
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { groupUuidsOf, regroup } from '../../src/lib/groupRestore.js';
import { checkParent } from '../../src/lib/ai/parentTarget.js';

/** a fox: root group → head group → two eyes; a crystal group at the root */
function fox() {
	const root = new THREE.Group();
	const fox = new THREE.Group();
	fox.name = 'fox';
	fox.position.set(1, 2, 3);
	const head = new THREE.Group();
	head.name = 'head';
	head.rotation.y = 0.5;
	for (const n of ['eye_l', 'eye_r']) {
		const eye = new THREE.Mesh(new THREE.SphereGeometry(0.05), new THREE.MeshStandardMaterial());
		eye.name = n;
		head.add(eye);
	}
	fox.add(head);
	const crystals = new THREE.Group();
	crystals.name = 'crystals';
	crystals.userData.note = 'kept';
	const c0 = new THREE.Mesh(new THREE.OctahedronGeometry(0.2), new THREE.MeshStandardMaterial());
	c0.name = 'crystal_0';
	crystals.add(c0);
	root.add(fox, crystals);
	return root;
}

/** what the autosave's glTF round trip hands back (GLTFLoader: an empty node = a plain Object3D; the uuids put
 * back from userData.__uuid). The real round trip is measured by the e2e agent-diorama2 §1. */
function roundTrip(root) {
	const copy = (o) => {
		const n = o.isMesh ? new THREE.Mesh(o.geometry, o.material) : new THREE.Object3D();
		n.uuid = o.uuid;
		n.name = o.name;
		n.position.copy(o.position);
		n.quaternion.copy(o.quaternion);
		n.scale.copy(o.scale);
		n.userData = { ...o.userData };
		for (const c of o.children) n.add(copy(c));
		return n;
	};
	return copy(root);
}

describe('groupRestore', () => {
	it('regroup rebuilds the listed nodes as THREE.Group with uuid, name, pose, userData and children', async () => {
		const src = fox();
		const uuids = groupUuidsOf(src);
		expect(uuids.length).toBe(3);
		const want = Object.fromEntries(['fox', 'head', 'crystals', 'eye_l', 'crystal_0'].map((n) => [n, src.getObjectByName(n).uuid]));
		const back = roundTrip(src);
		expect(regroup(back, uuids)).toBe(3);
		for (const n of ['fox', 'head', 'crystals']) {
			const g = back.getObjectByName(n);
			expect(g.type).toBe('Group');
			expect(g.uuid).toBe(want[n]);
		}
		expect(back.getObjectByName('fox').position.toArray()).toEqual([1, 2, 3]);
		expect(back.getObjectByName('head').rotation.y).toBeCloseTo(0.5, 6);
		expect(back.getObjectByName('crystals').userData.note).toBe('kept');
		// the parts keep their parents (eye_l / crystal_0 in the report)
		expect(back.getObjectByName('eye_l').parent.uuid).toBe(want.head);
		expect(back.getObjectByName('eye_l').parent.type).toBe('Group');
		expect(back.getObjectByName('crystal_0').parent.uuid).toBe(want.crystals);
		expect(back.getObjectByName('head').parent.uuid).toBe(want.fox);
		// order in the parent is kept
		expect(back.children.map((c) => c.name)).toEqual(['fox', 'crystals']);
	});

	it('an older snapshot (no list) changes nothing; meshes are never turned into groups', async () => {
		const back = roundTrip(fox());
		expect(regroup(back, undefined)).toBe(0);
		expect(regroup(back, [back.getObjectByName('eye_l').uuid])).toBe(0);
		expect(back.getObjectByName('eye_l').isMesh).toBe(true);
	});

	it('the agent parent rule: any container is a parent, a light / camera / nothing is an error', () => {
		const root = new THREE.Group();
		const plain = new THREE.Object3D();
		root.add(plain);
		expect(checkParent(plain, root)).toEqual({ parent: plain, group: false });
		expect('error' in checkParent(undefined, root)).toBe(true);
		expect('error' in checkParent(root, root)).toBe(true);
		expect(checkParent(new THREE.SpotLight(), root).error).toMatch(/light/);
		expect(checkParent(new THREE.PerspectiveCamera(), root).error).toMatch(/camera/);
	});
});
