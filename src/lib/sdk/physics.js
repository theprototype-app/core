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
			 * space. @param {string} kind @param {string} a @param {string} b
			 * @param {string=} axis @param {any=} motor */
			createJoint: (kind, a, b, axis, motor) =>
				jointsRef?.createJoint(kind, a, b, axis ?? 'x', motor) ?? null
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
	'physics.joints': 'read',
	'physics.running': 'read',
	'physics.set': 'content',
	'physics.createJoint': 'content'
};
