// Module SDK — api.physics (initiator-only mutations, golden rule 8).
// One slice of the api object makeApi() assembles (sdk/index.js, the ONE table).

import { get } from 'svelte/store';
import { physicsRef, jointsRef, physicsApi } from './refs.js';

/** @param {import('./context.js').SdkContext} ctx */
export function sdkPhysics(ctx) {
	return {
		/**
		 * Physics access (P-A/P-B). All mutations are INITIATOR-ONLY (the peer
		 * that started the simulation steps the world — golden rule 8): forward
		 * inputs to the initiator via api.send and let IT call these.
		 */
		physics: {
			/** true while THIS peer runs the simulation */
			simulating: () => physicsApi()?.isInitiator() ?? false,
			isInitiator: () => physicsApi()?.isInitiator() ?? false,
			/** push a dynamic body @param {string} uuid @param {number[]} impulse */
			applyImpulse: (uuid, impulse) => physicsApi()?.applyImpulse(uuid, impulse) ?? false,
			/** spin a dynamic body (C2) @param {string} uuid @param {number[]} torque world-space */
			applyTorqueImpulse: (uuid, torque) =>
				physicsApi()?.applyTorqueImpulse(uuid, torque) ?? false,
			/** drive a revolute joint's motor (P-B) @param {string} jointId @param {number} vel @param {number=} maxForce */
			setJointMotor: (jointId, vel, maxForce) =>
				physicsApi()?.setJointMotor(jointId, vel, maxForce) ?? false,
			/** 37-fx: drive a revolute joint to an ANGLE (radians; a steering knuckle)
			 * @param {string} jointId @param {number} angle @param {number=} stiffness @param {number=} damping */
			setJointMotorPosition: (jointId, angle, stiffness, damping) =>
				physicsApi()?.setJointMotorPosition?.(jointId, angle, stiffness, damping) ?? false,
			/** 37-fx: the rapier module core runs (rapier3d-compat, already initialised), for a
			 * world of the module's OWN — local, never synced; free it in api.onUnload.
			 * @returns {Promise<any>} */
			rapier: () => physicsApi()?.rapierModule?.() ?? Promise.resolve(null),
			/** the replicated joint defs @returns {Promise<any[]>} */
			joints: () => import('../joints').then((m) => m.jointsSnapshot()),
			/** Is a simulation running anywhere in the session (ours or a peer's)?
			 * Gate driving/behaviour on this, not on isInitiator. */
			running: () =>
				physicsRef ? !!get(physicsRef.simulating) || !!get(physicsRef.remoteSimulating) : false,
			/** Replicated physics parameters — the shared setPhysicsFor write path
			 * (history entry + objectParameters + live collider rebuild).
			 * @param {string} uuid @param {any} patch */
			set: (uuid, patch) => physicsApi()?.setPhysicsFor(uuid, patch),
			/** Replicated joint (P-B): 'weld' | 'revolute', anchored in OBJECT-local
			 * space. 37-fx: `motor` may be `{pos, stiffness, damping}` (an angle motor), and
			 * `opts` `{limits: [min, max] radians, contacts: false, sparks: false}`.
			 * @param {string} kind @param {string} a @param {string} b
			 * @param {string=} axis @param {any=} motor @param {any=} opts */
			createJoint: (kind, a, b, axis, motor, opts) =>
				jointsRef?.createJoint(kind, a, b, axis ?? 'x', motor, opts) ?? null
		}
	};
}

/** 34 R6 (T2): what each member does to the module's lifecycle — see SURFACE_KINDS in
 * sdk/lifecycle.js. tests/unit/moduleLifecycle.test.js holds every 'registers' member to a
 * teardown path; a member missing here fails it. */
sdkPhysics.surface = {
	'physics.simulating': 'read',
	'physics.isInitiator': 'read',
	'physics.applyImpulse': 'action',
	'physics.applyTorqueImpulse': 'action',
	'physics.setJointMotor': 'action',
	'physics.setJointMotorPosition': 'action',
	'physics.joints': 'read',
	'physics.rapier': 'read',
	'physics.running': 'read',
	'physics.set': 'content',
	'physics.createJoint': 'content'
};
