// 102 M7: the runtime's base rule — constrained poses never become authored, a foreign move is
// adopted as the new base, serializers park, a gizmo drag holds, overrides lapse, no constraints
// = nothing touched.
import { describe, it, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import { objectsGroup } from '../../src/stores/sceneStore.js';
import { runParkHooks } from '../../src/lib/parkHooks.js';
import {
	tickConstraints,
	markConstraintsDirty,
	holdConstraints,
	releaseConstraints,
	setConstraintOverride,
	resetConstraintRuntimeForTest,
	constraintRuntimeState,
	lastResults
} from '../../src/lib/rig/constraintRuntime.js';

/** a scene: a looker at the origin, a target at +x 3 */
function scene() {
	const group = new THREE.Group();
	const looker = new THREE.Mesh();
	const target = new THREE.Mesh();
	target.position.set(3, 0, 0);
	group.add(looker, target);
	group.updateMatrixWorld(true);
	objectsGroup.set(/** @type {any} */ (group));
	return { group, looker, target };
}

const fwd = (/** @type {THREE.Object3D} */ o) => new THREE.Vector3(0, 0, 1).applyQuaternion(o.quaternion);

beforeEach(() => resetConstraintRuntimeForTest());

describe('constraint runtime', () => {
	it('does nothing at all in a scene without constraints', () => {
		const { looker } = scene();
		looker.rotation.y = 0.3;
		expect(tickConstraints({ now: 1 })).toBe(0);
		expect(looker.rotation.y).toBe(0.3);
		expect(constraintRuntimeState().bases).toBe(0);
	});

	it('poses every frame from the base, never drifting, and parks the base for saves', () => {
		const { looker, target } = scene();
		looker.userData.constraints = [{ id: 'a', kind: 'lookat', weight: 0.5, target: { uuid: target.uuid } }];
		markConstraintsDirty();
		for (let i = 0; i < 5; i++) tickConstraints({ now: 10 + i });
		const half = fwd(looker);
		// weight 0.5 of a quarter turn = 45 degrees, the same after 5 frames (no compounding)
		expect(half.angleTo(new THREE.Vector3(0, 0, 1))).toBeCloseTo(Math.PI / 4, 4);
		const restore = runParkHooks();
		expect(looker.quaternion.w).toBeCloseTo(1, 9); // the authored pose while a serializer reads
		restore();
		expect(fwd(looker).angleTo(half)).toBeLessThan(1e-9);
	});

	it('adopts a foreign move as the new base', () => {
		const { looker, target } = scene();
		looker.userData.constraints = [{ id: 'a', kind: 'copy', position: [false, true, false], rotation: false, target: { uuid: target.uuid } }];
		target.position.y = 2;
		target.updateMatrixWorld(true);
		markConstraintsDirty();
		tickConstraints({ now: 1 });
		expect(looker.position.y).toBeCloseTo(2, 9);
		looker.position.x = 5; // a remote move / an undo writes the object
		tickConstraints({ now: 2 });
		expect(looker.position.x).toBe(5);
		expect(looker.position.y).toBeCloseTo(2, 9);
		const restore = runParkHooks();
		expect(looker.position.toArray()).toEqual([5, 0, 0]); // the base = the move, without the copied y
		restore();
		tickConstraints({ now: 3 });
		expect(looker.position.toArray()).toEqual([5, 2, 0]); // un-parked and posed again, base kept
		const again = runParkHooks();
		expect(looker.position.toArray()).toEqual([5, 0, 0]);
		again();
	});

	it('holds an object under the gizmo on its base', () => {
		const { looker, target } = scene();
		looker.userData.constraints = [{ id: 'a', kind: 'lookat', target: { uuid: target.uuid } }];
		markConstraintsDirty();
		tickConstraints({ now: 1 });
		expect(fwd(looker).x).toBeCloseTo(1, 6);
		holdConstraints(looker.uuid);
		tickConstraints({ now: 2 });
		expect(looker.quaternion.w).toBeCloseTo(1, 9);
		releaseConstraints(looker.uuid);
		tickConstraints({ now: 3 });
		expect(fwd(looker).x).toBeCloseTo(1, 6);
	});

	it('a flow override changes the weight until it lapses', () => {
		const { looker, target } = scene();
		looker.userData.constraints = [{ id: 'a', kind: 'lookat', weight: 1, target: { uuid: target.uuid } }];
		markConstraintsDirty();
		setConstraintOverride(looker.uuid, 'a', { weight: 0 });
		tickConstraints({ now: performance.now() });
		expect(looker.quaternion.w).toBeCloseTo(1, 9);
		tickConstraints({ now: performance.now() + 1000 });
		expect(fwd(looker).x).toBeCloseTo(1, 6);
	});

	it('removing the list puts the object back on its base', () => {
		const { looker, target } = scene();
		looker.userData.constraints = [{ id: 'a', kind: 'lookat', target: { uuid: target.uuid } }];
		markConstraintsDirty();
		tickConstraints({ now: 1 });
		delete looker.userData.constraints;
		markConstraintsDirty();
		tickConstraints({ now: 2 });
		expect(looker.quaternion.w).toBeCloseTo(1, 9);
	});

	it('evaluates a target before the object that reads it', () => {
		const { group, looker, target } = scene();
		const mover = new THREE.Mesh();
		mover.position.set(0, 0, 4);
		group.add(mover);
		group.updateMatrixWorld(true);
		// looker looks at target; target copies mover's position
		looker.userData.constraints = [{ id: 'a', kind: 'lookat', target: { uuid: target.uuid } }];
		target.userData.constraints = [{ id: 'b', kind: 'copy', rotation: false, target: { uuid: mover.uuid } }];
		markConstraintsDirty();
		tickConstraints({ now: 1 });
		expect(constraintRuntimeState().order).toEqual([target.uuid, looker.uuid]);
		expect(fwd(looker).z).toBeCloseTo(1, 6); // aimed at the target's NEW place in the same frame
		expect(lastResults.get(looker.uuid + '|a')?.ok).toBe(true);
	});

	it('drives a bone by name inside a model (two-bone IK)', () => {
		const { group, target } = scene();
		const model = new THREE.Group();
		const upper = new THREE.Bone();
		const lower = new THREE.Bone();
		const hand = new THREE.Bone();
		upper.name = 'UpperArm';
		lower.name = 'LowerArm';
		hand.name = 'Hand';
		lower.position.set(1, 0, 0);
		hand.position.set(1, 0, 0);
		upper.add(lower);
		lower.add(hand);
		model.add(upper);
		group.add(model);
		target.position.set(1, 1, 0);
		group.updateMatrixWorld(true);
		model.userData.constraints = [{ id: 'k', kind: 'ik2', bone: 'Hand', target: { uuid: target.uuid } }];
		markConstraintsDirty();
		tickConstraints({ now: 1 });
		expect(new THREE.Vector3().setFromMatrixPosition(hand.matrixWorld).distanceTo(target.position)).toBeLessThan(1e-4);
		model.userData.constraints[0].bone = 'Nope';
		model.userData.constraints = [...model.userData.constraints];
		markConstraintsDirty();
		tickConstraints({ now: 2 });
		expect(lastResults.get(model.uuid + '|k')?.reason).toBe('no such bone');
	});
});

describe('the keyable weight (prop path constraint.<id>.weight)', () => {
	it('is allowlisted narrowly and drives the runtime the same frame', async () => {
		const { resolvePath, setProp, getProp, pathsFor } = await import('../../src/lib/propTracks.js');
		const { looker, target } = scene();
		looker.userData.constraints = [{ id: 'a1', kind: 'lookat', weight: 1, target: { uuid: target.uuid } }];
		markConstraintsDirty();
		tickConstraints({ now: 1 });
		expect(resolvePath('constraint.a1.weight')).toBe('constraint.a1.weight');
		expect(resolvePath('constraint.a1.target')).toBe('');
		expect(resolvePath('constraint.../../x.weight')).toBe('');
		expect(pathsFor(looker)).toContain('constraint.a1.weight');
		expect(getProp(target, 'constraint.a1.weight')).toBeNull(); // not on an object without it
		expect(setProp(looker, 'constraint.a1.weight', 7)).toBe(true);
		expect(getProp(looker, 'constraint.a1.weight')).toBe(1); // clamped
		setProp(looker, 'constraint.a1.weight', 0);
		tickConstraints({ now: 2 });
		expect(looker.quaternion.w).toBeCloseTo(1, 9); // weight 0 read at once (a new list identity)
	});
});

describe('Bake constraints (GLTF export)', () => {
	it('keeps the constrained pose through a park only inside withConstraintsPosed', async () => {
		const { withConstraintsPosed } = await import('../../src/lib/rig/constraintRuntime.js');
		const { looker, target } = scene();
		looker.userData.constraints = [{ id: 'a', kind: 'lookat', target: { uuid: target.uuid } }];
		markConstraintsDirty();
		tickConstraints({ now: 1 });
		const posed = looker.quaternion.clone();
		const restore = withConstraintsPosed(() => runParkHooks());
		expect(looker.quaternion.angleTo(posed)).toBeLessThan(1e-9); // baked: still posed
		restore();
		const r2 = runParkHooks();
		expect(looker.quaternion.w).toBeCloseTo(1, 9); // the flag is gone again
		r2();
	});
});

describe('an open park (an async GLTF export)', () => {
	it('holds the tick on the authored pose until the serializer restores', () => {
		const { looker, target } = scene();
		looker.userData.constraints = [{ id: 'a', kind: 'lookat', target: { uuid: target.uuid } }];
		markConstraintsDirty();
		tickConstraints({ now: 1 });
		const restore = runParkHooks();
		expect(tickConstraints({ now: 2 })).toBe(0); // a frame while the exporter is still reading
		expect(looker.quaternion.w).toBeCloseTo(1, 9);
		restore();
		restore(); // a second call is harmless
		expect(tickConstraints({ now: 3 })).toBe(1);
		expect(fwd(looker).x).toBeCloseTo(1, 6);
	});
});
