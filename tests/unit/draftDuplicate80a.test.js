// @ts-nocheck — plain fixtures
// 80a-int: a peer's duplicate of a shared object never copies a draft inside it into a shared object.
import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
vi.mock('$lib/geometries.svelte', async () => (await import('./helpers/geometriesStub.js')).geometriesStub());
vi.mock('../../src/lib/geometries.svelte', async () => (await import('./helpers/geometriesStub.js')).geometriesStub());
const { objectsGroup } = await import('../../src/stores/sceneStore');
const { applyRemoteDuplicate } = await import('../../src/lib/objectActions.js');
const { markLocalOnly } = await import('../../src/lib/objectPermissions.js');

describe('remote duplicate and drafts', () => {
	it('the copy of a shared group leaves out the draft inside it', () => {
		const scene = new THREE.Group();
		const parent = new THREE.Group();
		parent.uuid = 'P';
		const shared = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
		shared.uuid = 'S';
		const draft = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
		draft.uuid = 'D';
		draft.name = 'secret';
		parent.add(shared, draft);
		scene.add(parent);
		markLocalOnly(draft);
		objectsGroup.set(scene);
		applyRemoteDuplicate('P', ['P2', 'S2'], 'copy', [0, 0, 0]);
		const copy = scene.getObjectByProperty('uuid', 'P2');
		expect(copy).toBeTruthy();
		expect(copy.children.map((c) => c.uuid)).toEqual(['S2']);
		expect(copy.getObjectByName('secret')).toBeUndefined();
		expect(draft.parent).toBe(parent); // ours stays where it was
		objectsGroup.set(undefined);
	});
});
