// 102 M7: the boot-path hub — no constraint in the scene = the solver is never fetched; the first
// sighting loads it and from then on every call forwards.
import { describe, it, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import { objectsGroup } from '../../src/stores/sceneStore.js';
import { tickConstraints, markConstraintsDirty, withConstraintsPosed, loadConstraintRuntime, resetConstraintHubForTest } from '../../src/lib/rig/constraintHub.js';

beforeEach(() => resetConstraintHubForTest());

describe('constraint hub', () => {
	it('stays idle (and passes withConstraintsPosed through) in a scene without constraints', () => {
		const group = new THREE.Group();
		group.add(new THREE.Mesh());
		objectsGroup.set(/** @type {any} */ (group));
		expect(tickConstraints({ now: 1 })).toBe(0);
		expect(tickConstraints({ now: 5000 })).toBe(0);
		expect(withConstraintsPosed(() => 7)).toBe(7);
	});

	it('loads the runtime on the first sighting and then runs the constraint', async () => {
		const group = new THREE.Group();
		const looker = new THREE.Mesh();
		const target = new THREE.Mesh();
		target.position.set(3, 0, 0);
		group.add(looker, target);
		group.updateMatrixWorld(true);
		objectsGroup.set(/** @type {any} */ (group));
		tickConstraints({ now: 1 });
		looker.userData.constraints = [{ id: 'a', kind: 'lookat', target: { uuid: target.uuid } }];
		markConstraintsDirty();
		expect(tickConstraints({ now: 2 })).toBe(0); // the scan saw it and started the import
		await loadConstraintRuntime();
		expect(tickConstraints({ now: 3 })).toBe(1);
		expect(new THREE.Vector3(0, 0, 1).applyQuaternion(looker.quaternion).x).toBeCloseTo(1, 6);
	});
});
