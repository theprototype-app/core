// Viewer object-permissions (roadmap: viewer-object-permissions). Only meaningful
// when the cloud plugin publishes roles via `rolesInfo` — without a plugin there are
// no roles and everyone is treated as an editor (zero gating, byte-unchanged OSS).
//
// Rules:
//  - editor / admin (or no roles plugin): may edit anything.
//  - viewer: may only move/edit objects THEY created locally (marked `__localOnly`,
//    never broadcast). Everything shared by other peers is read-only for them.
import { get } from 'svelte/store';
import { rolesInfo } from './cloudHooks';
import { showToast, showLocalObjects, peers } from '../stores/appStore';
import { objectsGroup } from '../stores/sceneStore';

/** broadcast message `type`s that CREATE a scene object (peerHandler send-gate) */
const CREATE_TYPES = new Set(['create', 'light', 'group', 'object', 'objectfile', 'duplicate']);

/** the local user's role, or null when there is no roles plugin */
export function localRole() {
	return get(rolesInfo)?.myRole || null;
}
export function isViewer() {
	return localRole() === 'viewer';
}

/** an object this viewer created locally (kept out of replication)
 * @param {any} object */
export function isLocalOnly(object) {
	return !!object?.userData?.__localOnly;
}
/** mark an object as local-only (viewer WIP that never reaches peers) — also reveals
 * the "Local objects" section (auto-enable on the first one)
 * @param {any} object */
export function markLocalOnly(object) {
	if (object && object.userData) {
		object.userData.__localOnly = true;
		showLocalObjects.set(true);
	}
}
/** clear the flag when the object is shared (promoted user hits Share)
 * @param {any} object */
export function clearLocalOnly(object) {
	if (object?.userData) delete object.userData.__localOnly;
}

/** Promote a local-only object to a SHARED one: re-parent into `groupUuid` when given
 * (so its toJSON carries the group-local transform), clear the `__localOnly` flag,
 * broadcast it to peers, and poke the object list. No-op for viewers. This is the ONE
 * path that actually replicates a local object — a bare `group` reparent references a
 * uuid peers never received, so it silently does nothing on their side.
 * @param {any} object
 * @param {string|null} [groupUuid]
 * @returns {boolean} true when the object was shared */
export function shareObject(object, groupUuid = null) {
	if (!object || isViewer()) return false;
	const group = get(objectsGroup);
	if (groupUuid) {
		const dest = group?.getObjectByProperty('uuid', groupUuid);
		if (dest && dest.type === 'Group' && object.parent !== dest) dest.attach(object);
	}
	clearLocalOnly(object);
	/** @type {any} */
	const peer = get(peers);
	try {
		/** @type {any} */
		const msg = { type: 'object', element: object.toJSON() };
		if (groupUuid) msg.groupuuid = groupUuid;
		peer?.send(msg);
	} catch (e) {
		console.warn('share failed', e);
	}
	objectsGroup.update((v) => v);
	return true;
}

/** Can the LOCAL user move/edit this object?
 *  - no roles plugin -> yes
 *  - viewer -> only their own local-only objects
 *  - editor / admin -> yes
 * @param {any} object */
export function canEditObject(object) {
	if (!isViewer()) return true;
	return isLocalOnly(object);
}

let lastReadOnlyWarn = 0;
/** throttled "you're view-only" nudge when a viewer tries to move a shared object */
export function warnViewerReadOnly() {
	const now = Date.now();
	if (now - lastReadOnlyWarn < 4000) return;
	lastReadOnlyWarn = now;
	showToast("View-only — you can't move objects shared by others. Ask an admin for edit access.");
}

let lastLocalWarn = 0;
/** throttled notice when a viewer creates something (it stays on their machine) */
export function warnViewerLocalCreate() {
	const now = Date.now();
	if (now - lastLocalWarn < 4000) return;
	lastLocalWarn = now;
	showToast('Created locally only — you are view-only, so peers will not see this. Share it from the object list once you have edit access.');
}

/** Send-side gate (called from PeerConnection.send). If the local user is a VIEWER
 * and `data` is an object-CREATION broadcast, mark the created object(s) `__localOnly`
 * + warn, and return true so the caller SKIPS the broadcast (peers drop it anyway via
 * the receive-side capability gate). Returns false for everyone else / non-creations. */
export function gateCreationBroadcast(/** @type {any} */ data) {
	if (!data || !CREATE_TYPES.has(data.type) || !isViewer()) return false;
	const group = get(objectsGroup);
	/** @type {any[]} */
	const ids = [];
	if (data.uuid) ids.push(data.uuid);
	if (Array.isArray(data.uuids)) ids.push(...data.uuids);
	if (data.element?.object?.uuid) ids.push(data.element.object.uuid);
	for (const id of ids) {
		const o = group?.getObjectByProperty('uuid', id);
		if (o) markLocalOnly(o);
	}
	// no per-creation toast — the "Local objects" section (auto-shown on the first one)
	// is the indicator.
	return true;
}
