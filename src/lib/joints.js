// @ts-ignore - no bundled three type declarations (project-wide)
import * as THREE from 'three';
import { writable, get } from 'svelte/store';
import { objectsGroup } from '../stores/sceneStore';
import { peers, showToast } from '../stores/appStore';
import { registerHistoryKind, recordEntry } from './history';
import { originWorld } from './objectOrigin';

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
 *   motor?: {vel?: number, maxForce?: number, pos?: number, stiffness?: number, damping?: number},
 *   limits?: number[], contacts?: boolean, sparks?: boolean}} JointDef */
// 37-fx additions, all optional (absent = the 1.25 joint, byte-identical): `limits` [min, max]
// radians on a revolute, `contacts: false` stops the two bodies colliding with each other (a
// steering knuckle sits inside its wheel), `motor.pos` (+stiffness/damping) drives a revolute
// to an ANGLE instead of a speed, `sparks: false` keeps a break quiet.

/**
 * The 37-fx options a caller may put on a joint, validated (anything else is dropped).
 * @param {any} opts @returns {{limits?: number[], contacts?: boolean, sparks?: boolean}}
 */
export function jointOptions(opts) {
	/** @type {{limits?: number[], contacts?: boolean, sparks?: boolean}} */
	const out = {};
	if (!opts || typeof opts !== 'object') return out;
	const l = opts.limits;
	if (Array.isArray(l) && l.length === 2 && l.every((n) => Number.isFinite(n)) && l[0] <= l[1]) out.limits = [l[0], l[1]];
	if (opts.contacts === false) out.contacts = false;
	if (opts.sparks === false) out.sparks = false;
	return out;
}

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

/** 37-fx: who hears a joint LEAVE (physics: drop the live joint, spark a mid-run break).
 * A var, not a const: physics registers from a microtask, but a cycle must never TDZ this. */
// eslint-disable-next-line no-var
var removedListeners = new Set();

/** Hear every joint removal (local delete, a peer's jointdelete, undo/redo).
 * @param {(joint: JointDef) => void} fn @returns {() => void} off */
export function onJointRemoved(fn) {
	removedListeners.add(fn);
	return () => removedListeners.delete(fn);
}

/** @param {string} id */
function removeLocal(id) {
	const gone = get(sceneJoints).find((j) => j.id === id);
	sceneJoints.update((list) => list.filter((j) => j.id !== id));
	if (!gone) return;
	for (const fn of removedListeners) {
		try {
			fn(gone);
		} catch (error) {
			console.warn('joint removal listener failed', error);
		}
	}
}

/**
 * Create a joint between two objects at their CURRENT relative pose and
 * replicate it. Weld anchor = the midpoint between the two origins; hinge
 * anchor = B's origin (put the wheel where it should spin, then hinge) with
 * the axis = A's chosen LOCAL axis at the current pose.
 * @param {'fixed'|'revolute'} kind @param {string} aUuid @param {string} bUuid
 * @param {'x'|'y'|'z'=} axis @param {JointDef['motor']=} motor
 * @param {{limits?: number[], contacts?: boolean, sparks?: boolean}=} opts 37-fx (jointOptions)
 * @returns {JointDef | null}
 */
export function createJoint(kind, aUuid, bUuid, axis, motor, opts) {
	const a = objectOf(aUuid);
	const b = objectOf(bUuid);
	if (!a || !b || aUuid === bUuid) {
		showToast('Select two objects to attach');
		return null;
	}
	a.updateWorldMatrix(true, false);
	b.updateWorldMatrix(true, false);
	// 17-D: anchor on each object's ORIGIN when it has one. That is the whole
	// point of placing an origin at a hinge: "put the pivot on the hinge, then
	// hinge it" now does what it says. Objects without an origin behave as before
	// (originWorld falls back to the world position).
	const aPos = originWorld(a, new THREE.Vector3());
	const bPos = originWorld(b, new THREE.Vector3());
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
		...(motor ? { motor } : {}),
		...(kind === 'revolute' ? jointOptions(opts) : jointOptions({ sparks: opts?.sparks }))
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

/**
 * 37-fx: duplicate parity — clone every joint whose BOTH ends were duplicated, onto the
 * copies (uuids remapped; anchors are object-local, so they carry as they are). A joint with
 * only one end in the set stays where it is: the copy is a free object, as before. Each clone
 * is a normal jointcreate + 'joint' history entry, recorded AFTER the objects' create entries,
 * so one undo walk removes the joints first and the objects after.
 * @param {Record<string, string>} uuidMap old uuid -> new uuid @returns {number} joints cloned
 */
export function copyJointsWithin(uuidMap) {
	if (!uuidMap || typeof uuidMap !== 'object') return 0;
	const inside = get(sceneJoints).filter((j) => uuidMap[j.a] && uuidMap[j.b]);
	/** @type {any} */
	const peer = get(peers);
	for (const source of inside) {
		/** @type {JointDef} */
		const joint = {
			...structuredClone(source),
			id: crypto.randomUUID().slice(0, 8),
			a: uuidMap[source.a],
			b: uuidMap[source.b]
		};
		upsertLocal(joint);
		recordEntry({ kind: 'joint', joint, before: { present: false }, after: { present: true } });
		if (peer) peer.send({ type: 'jointcreate', joint });
	}
	return inside.length;
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
