import * as THREE from 'three';
import { writable, get } from 'svelte/store';
import { objectsGroup } from '../stores/sceneStore';
import { peers, showToast } from '../stores/appStore';
import { registerHistoryKind, recordEntry } from './history';

// Physics joints (P-B): a REPLICATED list of joint definitions between object
// pairs (the annotations pattern — a joint references two uuids, so it can't
// live on either object's userData without asymmetric death on delete).
// Anchors/axis are captured in each object's LOCAL space at attach time, so a
// weld holds the attach pose and defs survive the pair moving around between
// simulations. The sim (physics.js) builds rapier impulse joints from these at
// startSimulation; `motor` on a revolute drives it (setJointMotor, initiator-
// only). Replication: jointcreate/jointdelete apply-local + send; late joiners
// pull via getjoints -> joints (sendAnnotations retry pattern); deleting an
// object cascades jointdelete at the SENDER (receivers just apply each one).

/** @typedef {{id: string, a: string, b: string, kind: 'fixed'|'revolute',
 *   anchorA: number[], anchorB: number[], axisA?: number[],
 *   motor?: {vel: number, maxForce: number}}} JointDef */

/** @type {import('svelte/store').Writable<JointDef[]>} */
export const sceneJoints = writable([]);

/** @param {string} uuid */
function objectOf(uuid) {
	return get(objectsGroup)?.getObjectByProperty('uuid', uuid) ?? null;
}

/** Insert/replace locally (no replication, no history). @param {JointDef} joint */
function upsertLocal(joint) {
	sceneJoints.update((list) => {
		const index = list.findIndex((j) => j.id === joint.id);
		if (index >= 0) {
			const next = [...list];
			next[index] = joint;
			return next;
		}
		return [...list, joint];
	});
}

/** @param {string} id */
function removeLocal(id) {
	sceneJoints.update((list) => list.filter((j) => j.id !== id));
}

/**
 * Create a joint between two objects at their CURRENT relative pose and
 * replicate it. Weld anchor = the midpoint between the two origins; hinge
 * anchor = B's origin (put the wheel where it should spin, then hinge) with
 * the axis = A's chosen LOCAL axis at the current pose.
 * @param {'fixed'|'revolute'} kind @param {string} aUuid @param {string} bUuid
 * @param {'x'|'y'|'z'=} axis @param {{vel: number, maxForce: number}=} motor
 * @returns {JointDef | null}
 */
export function createJoint(kind, aUuid, bUuid, axis, motor) {
	const a = objectOf(aUuid);
	const b = objectOf(bUuid);
	if (!a || !b || aUuid === bUuid) {
		showToast('Select two objects to attach');
		return null;
	}
	a.updateWorldMatrix(true, false);
	b.updateWorldMatrix(true, false);
	const aPos = a.getWorldPosition(new THREE.Vector3());
	const bPos = b.getWorldPosition(new THREE.Vector3());
	const anchorWorld = kind === 'revolute' ? bPos.clone() : aPos.clone().lerp(bPos, 0.5);
	/** @type {JointDef} */
	const joint = {
		id: crypto.randomUUID().slice(0, 8),
		a: aUuid,
		b: bUuid,
		kind,
		anchorA: a.worldToLocal(anchorWorld.clone()).toArray(),
		anchorB: b.worldToLocal(anchorWorld.clone()).toArray(),
		...(kind === 'revolute'
			? { axisA: axis === 'x' ? [1, 0, 0] : axis === 'z' ? [0, 0, 1] : [0, 1, 0] }
			: {}),
		...(motor ? { motor } : {})
	};
	upsertLocal(joint);
	recordEntry({ kind: 'joint', joint, before: { present: false }, after: { present: true } });
	/** @type {any} */
	const peer = get(peers);
	if (peer) peer.send({ type: 'jointcreate', joint });
	return joint;
}

/** Delete one joint (replicated + undoable). @param {string} id */
export function deleteJoint(id) {
	const joint = get(sceneJoints).find((j) => j.id === id);
	if (!joint) return;
	removeLocal(id);
	recordEntry({ kind: 'joint', joint, before: { present: true }, after: { present: false } });
	/** @type {any} */
	const peer = get(peers);
	if (peer) peer.send({ type: 'jointdelete', id });
}

/** Every joint touching any of these objects. @param {string[]} uuids */
export function jointsFor(uuids) {
	return get(sceneJoints).filter((j) => uuids.includes(j.a) || uuids.includes(j.b));
}

/** Detach = delete every joint touching the given objects (menu action).
 * @param {string[]} uuids @returns {number} */
export function detachJoints(uuids) {
	const hits = jointsFor(uuids);
	hits.forEach((j) => deleteJoint(j.id));
	return hits.length;
}

/** SENDER-side cascade when objects are deleted: each jointdelete replicates,
 * receivers only apply (golden rule 1). @param {string[]} uuids */
export function cascadeJointDeletes(uuids) {
	jointsFor(uuids).forEach((j) => deleteJoint(j.id));
}

// ---- receive side -----------------------------------------------------------

/** @param {any} data */
export function applyJointCreate(data) {
	if (data?.joint?.id) upsertLocal(data.joint);
}

/** @param {any} data */
export function applyJointDelete(data) {
	if (data?.id) removeLocal(data.id);
}

/** Merge a late-joiner snapshot by id. @param {any[]} list */
export function applyJointsSnapshot(list) {
	if (!Array.isArray(list)) return;
	list.forEach((joint) => joint?.id && upsertLocal(joint));
}

/** Full-state reply on handshake (sendAnnotations retry pattern). @param {string} peerId */
export function sendJoints(peerId, attempt = 0) {
	/** @type {any} */
	const peer = get(peers);
	if (!peer) return;
	const list = get(sceneJoints);
	if (list.length === 0) return;
	const conn = peer.connections[peerId];
	if (!conn || !conn.open) {
		if (attempt < 20) setTimeout(() => sendJoints(peerId, attempt + 1), 500);
		return;
	}
	conn.send({ type: 'joints', joints: list });
}

// ---- persistence (sessions/.tpscene) ---------------------------------------

export function jointsSnapshot() {
	return get(sceneJoints);
}

/** @param {any[]} list */
export function jointsRestore(list) {
	sceneJoints.set(Array.isArray(list) ? list : []);
}

// ---- undo/redo --------------------------------------------------------------

// presence-style entries (mirrors create/delete): replaying re-applies locally
// AND replicates, so peers follow the undo like any other edit
registerHistoryKind('joint', (entry, state) => {
	/** @type {any} */
	const peer = get(peers);
	if (state.present) {
		upsertLocal(entry.joint);
		if (peer) peer.send({ type: 'jointcreate', joint: entry.joint });
	} else {
		removeLocal(entry.joint.id);
		if (peer) peer.send({ type: 'jointdelete', id: entry.joint.id });
	}
	return true;
});
