// @ts-nocheck — fixture geometry built ad hoc (the checkJs rule for test fixtures)
// 102-boot-diet-2 (phase 2) — faceEdit.js left both boots. What stays on the boot must work WITHOUT it:
//   1. a peer's / an undo's `meshgeo` applies with faceEdit never imported (meshGeoApply.js), in order, synchronously;
//   2. the shared prefs still fire meshEdit's registered rebuild (faceEditState.js);
//   3. the loader: no module until something loads it, withFaceEdit is SYNCHRONOUS once loaded, and a direct
//      `import('faceEdit')` (the debug hook, agent tools) is adopted, so the viewport's accessor sees that session;
//   4. the boot half is the SAME store instances faceEdit re-exports (agent tools / e2e read `fe.faceEditObject`).
// Counterfactual: on v1.78.0 meshGeoApply / faceEditState / faceEditLazy do not exist (every import here fails).
import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';

vi.mock('$lib/objectActions', () => ({ selectObject: () => {}, deselectObject: () => {}, moveObjectToGroup: () => {}, duplicateObject: () => null }));
vi.mock('$lib/physics', () => ({ setPhysicsFor: () => {}, physicsShapeChanged: () => {} }));
vi.mock('$lib/geometries.svelte', async () => (await import('./helpers/geometriesStub.js')).geometriesStub());

const { objectsGroup } = await import('../../src/stores/sceneStore');
const lazy = await import('../../src/lib/faceEditLazy.js');
const state = await import('../../src/lib/faceEditState.js');
const { applyMeshGeo } = await import('../../src/lib/meshGeoApply.js');

/** a two-triangle quad, non-indexed */
function quad() {
	const g = new THREE.BufferGeometry();
	g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 1, 0]), 3));
	g.computeVertexNormals();
	return g;
}

describe('faceEdit on demand (102-boot-diet-2)', () => {
	const group = new THREE.Group();
	objectsGroup.set(group);
	const mesh = new THREE.Mesh(quad(), new THREE.MeshStandardMaterial());
	group.add(mesh);

	it('1. a meshgeo applies with the face editor never loaded', () => {
		expect(lazy.faceEditNow()).toBe(null);
		const next = [0, 0, 0, 2, 0, 0, 2, 2, 0, 0, 0, 0, 2, 2, 0, 0, 2, 0];
		applyMeshGeo(mesh.uuid, new Float32Array(next).buffer);
		expect(Array.from(mesh.geometry.attributes.position.array)).toEqual(next);
		expect(mesh.geometry.attributes.normal).toBeTruthy();
		expect(mesh.userData.faceEdited).toBe(true);
		// two swaps in a row land in order (nothing deferred)
		const third = next.map((v) => v * 3);
		applyMeshGeo(mesh.uuid, third);
		expect(Array.from(mesh.geometry.attributes.position.array)).toEqual(third);
		expect(lazy.faceEditNow()).toBe(null);
	});

	it('2. the wire prefs fire the vertex rebuild with the face editor not loaded', () => {
		const rebuild = vi.fn();
		state.registerVertexWireRebuild(rebuild);
		const was = state.editHooks.gizmoPrefListeners.length;
		const listener = vi.fn();
		state.registerGizmoPrefListener(listener);
		state.meshEditTriWire.set(true);
		expect(rebuild).toHaveBeenCalledTimes(1);
		state.faceGizmoSpace.set('world');
		expect(listener).toHaveBeenCalledTimes(1);
		state.meshEditTriWire.set(false);
		state.faceGizmoSpace.set('local');
		state.editHooks.gizmoPrefListeners.length = was;
		expect(lazy.faceEditNow()).toBe(null);
	});

	it('3. the loader: a direct import is adopted, and withFaceEdit is synchronous once loaded', async () => {
		// the debug hook / agent tools import the module directly, not through the loader
		const fe = await import('../../src/lib/faceEdit.js');
		expect(lazy.faceEditNow()).toBe(fe);
		let ran = false;
		const out = lazy.withFaceEdit((m) => {
			ran = true;
			return m === fe;
		});
		expect(ran).toBe(true); // same tick: not a Promise
		expect(out).toBe(true);
		expect(await lazy.loadFaceEdit()).toBe(fe);
	});

	it('4. faceEdit re-exports the boot half as the same instances', async () => {
		const fe = await import('../../src/lib/faceEdit.js');
		for (const name of ['faceEditObject', 'faceEditOp', 'faceEditSelectedTris', 'meshEditHotkeys', 'meshGizmoEnabled', 'vrFaceCap', 'knifePreview', 'lookupEditable', 'registerEditProxy', 'triangleCount'])
			expect(fe[name], name).toBe(state[name]);
		expect(fe.applyMeshGeo).toBe(applyMeshGeo);
		expect(fe.VR_FACE_CAP).toBe(state.VR_FACE_CAP);
	});
});
