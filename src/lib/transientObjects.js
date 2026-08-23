// 21-B B7 — TRANSIENT OBJECTS: scene content that exists only while the world runs.
//
// A spawner makes real, replicated objects, and every one of them would otherwise be
// permanent: recorded in the undo stack, written into every .tpscene, carried by every
// autosave and inherited by every late joiner. Forty crates from one key press is then
// forty objects a user has to delete by hand, and a crash mid-run leaves them in the
// snapshot for good.
//
// `userData.transient` is the whole mechanism. It rides toJSON and GLTF extras exactly
// like `__uuid` and `__localOnly`, so nothing new has to carry it — but the flag alone is
// not enough, because "which paths does per-object state travel on" has FOUR answers in
// this codebase and they do not share a serializer: the wire, sessions/.tpscene, autosave
// and undo. This module is the one place that answers all four for this flag:
//
//   the wire       — the initiator broadcasts `duplicate` with `transient: true` and the
//                    applier stamps it (additive: an older peer ignores the field and
//                    keeps an ordinary copy, which is the honest degradation — it will
//                    simply outlive the run on that peer)
//   sessions       — `buildSessionPayload` filters them out of `objects`
//   autosave       — `parkTransientObjects` DETACHES them for the duration of the GLTF
//                    export (the parkAnimatedAtBase ritual: a hide would rely on
//                    GLTFExporter's onlyVisible default, and a local hide is a delete for
//                    every late joiner — the documented trap, backwards)
//   undo           — the creator passes `history: false`; nothing here is recorded, and
//                    `removeTransientObjects` deliberately does NOT record either
//
// A LEAF on purpose (svelte/store + the two stores): sessions, autosave and physics all
// reach it, and any of those edges through objectActions/history would be a cycle.

import { get } from 'svelte/store';
import { objectsGroup } from '../stores/sceneStore';
import { peers } from '../stores/appStore';

/** @param {any} object */
export function isTransient(object) {
	return !!object?.userData?.transient;
}

/** Stamp an object (and, for a group, only the root — the flag is about the whole
 * object's lifetime, and the tree travels with its root). @param {any} object */
export function markTransient(object) {
	if (object) object.userData.transient = true;
}

/** Every transient object currently in the scene, oldest-first in child order.
 * @param {any=} group defaults to the live objectsGroup @returns {any[]} */
export function transientObjects(group) {
	const root = group ?? get(objectsGroup);
	return (root?.children ?? []).filter((/** @type {any} */ child) => isTransient(child));
}

/** @param {any=} group */
export function transientUuids(group) {
	return transientObjects(group).map((object) => object.uuid);
}

/**
 * DETACH every transient object for the duration of a serialization, returning the
 * restore. The autosave path exports the whole group in one GLTF pass, so there is no
 * per-child filter to hook — this is the parkAnimatedAtBase shape, and like it the
 * restore MUST run in a `finally`.
 * @param {any=} group @returns {() => void}
 */
export function parkTransientObjects(group) {
	const root = group ?? get(objectsGroup);
	const parked = transientObjects(root);
	parked.forEach((object) => root.remove(object));
	return () => parked.forEach((object) => root.add(object));
}

/**
 * Remove every transient object from the scene and tell peers. NO history entry and no
 * `notifyExternalMove`: the objects were never recorded as created, so recording their
 * deletion would put half a lifecycle on the undo stack — one Ctrl+Z would then resurrect
 * forty crates that no longer have bodies.
 *
 * The `delete` message is the ordinary one, so a peer needs to know nothing about
 * transience to drop its copy — which is also what covers an older peer that ignored the
 * flag on the way in.
 * @returns {string[]} the uuids removed
 */
export function removeTransientObjects() {
	const doomed = transientObjects();
	if (!doomed.length) return [];
	const uuids = doomed.map((object) => object.uuid);
	uuids.forEach((uuid) => removeTransientObject(uuid, false));
	objectsGroup.update((value) => value);
	return uuids;
}

/**
 * Remove ONE transient object — the recycling half (a spawner at its cap drops its
 * oldest). Refuses anything not marked transient: this path records no history, so
 * pointing it at real scene content would delete something with no way back.
 * @param {string} uuid @param {boolean=} poke false while sweeping a batch
 */
export function removeTransientObject(uuid, poke = true) {
	const group = get(objectsGroup);
	const object = group?.getObjectByProperty('uuid', uuid);
	if (!object || !isTransient(object)) return false;
	/** @type {any} */
	const peer = get(peers);
	object.parent?.remove(object);
	if (peer) peer.send({ type: 'delete', uuid, peerId: peer.peer.id });
	if (poke) objectsGroup.update((value) => value);
	return true;
}

/** test/debug view */
export function transientDebug() {
	return { alive: transientUuids() };
}
