// 64-text-int — THE OLD-SCENE SET for 1.61 (every release that adds a saved type ships one). 1.61 adds the
// 3D text record (`userData.textPath`, v2) and mcp-diorama2 adds the autosave `groups` sidecar. Scenes and
// autosaves from 1.59 / 1.60 carry neither: they must load unchanged. A record from a NEWER build keeps the
// fields this build does not know (the "made with a newer version" notice reads isNewerTextRecord).
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { normalizeTextPath, isNewerTextRecord, isTextPathObject, TEXT_PATH_VERSION } from '../../src/lib/textPathCore.js';
import { regroup, groupUuidsOf } from '../../src/lib/groupRestore.js';

/** a 1.60-shaped scene: a group of meshes + a light, no text record anywhere */
function scene160() {
	const root = new THREE.Group();
	const node = new THREE.Object3D(); // what GLTFLoader returns for an empty node (a 1.60 autosave group)
	node.name = 'Table';
	node.add(new THREE.Mesh(new THREE.BoxGeometry(1, 0.1, 1)), new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1)));
	root.add(node, new THREE.PointLight());
	return root;
}

describe('1.61 old-scene set', () => {
	it('a 1.59 / 1.60 scene has no text object and no group list: the restore changes nothing', () => {
		const root = scene160();
		const before = JSON.stringify(root.toJSON());
		root.traverse((/** @type {any} */ o) => expect(isTextPathObject(o)).toBe(false));
		expect(regroup(root, undefined)).toBe(0); // an older autosave has no `groups` sidecar
		expect(regroup(root, [])).toBe(0);
		expect(JSON.stringify(root.toJSON())).toBe(before);
	});
	it("1.61's own text record round-trips (save → load → identical)", () => {
		const rec = normalizeTextPath({ text: 'HELLO', mode: 'extruded', path: { kind: 'none' }, depth: 0.2, bevel: { size: 0.02, thickness: 0.02, segments: 3 }, font: 'serif', anchor: 'bottom-center' });
		expect(rec.v).toBe(TEXT_PATH_VERSION);
		expect(normalizeTextPath(JSON.parse(JSON.stringify(rec)))).toEqual(rec);
	});
	it('a record from a newer build keeps its unknown fields and its version through our writes', () => {
		const newer = { ...normalizeTextPath({ text: 'Hi', path: { kind: 'none' } }), v: TEXT_PATH_VERSION + 1, glow: { pulse: 2 } };
		expect(isNewerTextRecord(newer)).toBe(true);
		const back = normalizeTextPath({ ...newer, text: 'Hi there' });
		expect(back.v).toBe(TEXT_PATH_VERSION + 1);
		expect(/** @type {any} */ (back).glow).toEqual({ pulse: 2 });
		expect(back.text).toBe('Hi there');
	});
	it('a 1.61 autosave regroups its groups (the sidecar is what makes them groups again)', () => {
		const made = new THREE.Group();
		const g = new THREE.Group();
		g.add(new THREE.Mesh());
		made.add(g);
		const ids = groupUuidsOf(made);
		const root = scene160();
		const node = root.children[0];
		node.uuid = ids[0];
		expect(regroup(root, ids)).toBe(1);
		expect(/** @type {any} */ (root.children[0]).isGroup).toBe(true);
		expect(root.children[0].children.length).toBe(2);
	});
});
