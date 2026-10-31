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
import { parkEditOverlays } from './editOverlays';
import { showToast, showLocalObjects, peers } from '../stores/appStore';
import { objectsGroup, pokeScene } from '../stores/sceneStore';

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
	// Share is the one moment a local object becomes everyone's — it must not
	// carry the mesh-edit wireframe across (editOverlays.js)
	const unpark = parkEditOverlays(object);
	try {
		/** @type {any} */
		const msg = { type: 'object', element: object.toJSON() };
		if (groupUuid) msg.groupuuid = groupUuid;
		peer?.send(msg);
	} catch (e) {
		console.warn('share failed', e);
	} finally {
		unpark();
	}
	pokeScene();
	return true;
}

/** An EDITOR moves a shared object to Local objects: it is deleted for peers and kept here,
 * marked local-only (the object list's drop-to-local; extracted in fix-batch-2 so the
 * drafts suite drives the real path) @param {any} object */
export function moveToLocalObjects(object) {
	if (!object) return;
	/** @type {any} */
	const peer = get(peers);
	try {
		peer?.send({ type: 'delete', uuid: object.uuid, peerId: peer?.peer?.id });
	} catch (e) {
		console.warn(e);
	}
	markLocalOnly(object);
}

/** Can the LOCAL user move/edit this object?
 *  - no roles plugin -> yes
 *  - viewer -> only their own local-only objects
 *  - editor / admin -> yes
 * @param {any} object */
export function canEditObject(object) {
	if (isViewer()) return isLocalOnly(object);
	// 71 TR1: narrowed by a capability record (a local object is nobody else's business)
	const ri = /** @type {any} */ (get(rolesInfo));
	if (!ri?.myCaps || isLocalOnly(object) || !object?.uuid) return true;
	return ri.sortObjects?.('edit', [object.uuid])?.ok !== false;
}

/** 71 TR1: may I, by name? No record = yes. @param {string} key a capability key */
export function hasCapability(key) {
	const caps = /** @type {any} */ (get(rolesInfo))?.myCaps;
	return !caps || (caps[key] !== false && caps[key] !== 'off');
}

let lastCapWarn = 0;
/**
 * 71 TR1: send-side gate after `gateCreationBroadcast`. The plugin sees everything leaving this page (it is
 * how an agent knows what it made) and says no to what the room would drop.
 * @param {any} data @returns {boolean} true = do not send
 */
export function gateCapabilityBroadcast(data) {
	const ri = /** @type {any} */ (get(rolesInfo));
	if (typeof ri?.onSend !== 'function') return false;
	let ok = true;
	try {
		ok = ri.onSend(data) !== false;
	} catch {
		return false;
	}
	if (ok) return false;
	const now = Date.now();
	if (now - lastCapWarn > 4000) {
		lastCapWarn = now;
		showToast("You don't have permission for that in this room, so others won't see it. Ask an admin to change your permissions.");
	}
	return true;
}

let lastReadOnlyWarn = 0;
/** throttled "you're view-only" nudge when a viewer tries to move a shared object
 * @param {string} [message] optional override for the toast text (e.g. the clear-scene gate) */
export function warnViewerReadOnly(message) {
	const now = Date.now();
	if (now - lastReadOnlyWarn < 4000) return;
	lastReadOnlyWarn = now;
	// 71 TR2: with a plugin that takes requests, the nudge is also the way to ask
	const ask = typeof (/** @type {any} */ (get(rolesInfo))?.requestEdit) === 'function';
	showToast(
		message || (ask ? "View-only — you can't move objects shared by others." : "View-only — you can't move objects shared by others. Ask an admin for edit access."),
		ask ? [{ label: 'Request edit access', action: () => requestEditAccess() }] : undefined
	);
}

/** 71 TR2: a viewer taps Request. The plugin sends it; this says what happened. @returns {string} */
export function requestEditAccess() {
	const ri = /** @type {any} */ (get(rolesInfo));
	const result = String(ri?.requestEdit?.() ?? 'not-viewer');
	if (result === 'sent') showToast('Asked for edit access. An admin will see it.');
	else if (result === 'wait') showToast('You already asked. An admin can answer from their notifications.');
	else if (result === 'alone') showToast('Nobody here can answer yet.');
	return result;
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
	if (!data || !CREATE_TYPES.has(data.type) || (!isViewer() && hasCapability('create'))) return false;
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

/** fix-batch-2 (1.45.1): the local-only objects that are NOT inside another local-only one
 * (a local group carries its children) @returns {any[]} */
export function localOnlyRoots() {
	const group = get(objectsGroup);
	/** @type {any[]} */
	const out = [];
	/** @param {any} o */
	const walk = (o) => {
		for (const child of o?.children ?? []) {
			if (isLocalOnly(child)) out.push(child);
			else walk(child);
		}
	};
	walk(group);
	return out;
}

/** fix-batch-2 (1.45.1): lift every local-only object out of the scene tree so a published
 * or exported file carries only what peers can see; `restore()` puts each back in its slot.
 * The children arrays are spliced directly (no removed/added events — the transientObjects
 * park precedent). Every reader keyed on "is this uuid in the scene" (graph/shader pruning,
 * the thumbnail) follows for free. Pair it like `parkAnimatedAtBase`: restore in the same
 * place the park is undone (an async GLTF export restores in its callback).
 * @returns {{excluded: number, uuids: Set<string>, restore: () => void}} */
export function liftLocalObjects() {
	/** @type {{parent: any, index: number, object: any}[]} */
	const lifted = [];
	for (const object of localOnlyRoots()) {
		const parent = object.parent;
		const index = parent?.children?.indexOf(object) ?? -1;
		if (index < 0) continue;
		parent.children.splice(index, 1);
		lifted.push({ parent, index, object });
	}
	let done = false;
	/** @type {Set<string>} */
	const uuids = new Set();
	for (const { object } of lifted) object.traverse((/** @type {any} */ o) => uuids.add(o.uuid));
	return {
		excluded: lifted.length,
		uuids,
		restore: () => {
			if (done) return;
			done = true;
			for (let i = lifted.length - 1; i >= 0; i--) {
				const { parent, index, object } = lifted[i];
				parent.children.splice(index, 0, object);
			}
		}
	};
}

/** fix-batch-2: run a SYNCHRONOUS payload build with the local-only objects lifted out
 * (put back before this returns, even on a throw)
 * @template T @param {() => T} fn @returns {{result: T, excluded: number}} */
export function withoutLocalObjects(fn) {
	const lift = liftLocalObjects();
	try {
		return { result: scrubWorkspace(fn(), lift.uuids), excluded: lift.excluded };
	} finally {
		lift.restore();
	}
}

/** A session payload's `workspace` (#20 P5: where the author left off) names the SELECTION and
 * any open edit session by uuid — a lifted object must not ride along there either.
 * @template T @param {T} payload @param {Set<string>} uuids @returns {T} */
function scrubWorkspace(payload, uuids) {
	/** @type {any} */
	const p = payload;
	const ws = p?.workspace;
	if (!uuids.size || !ws || typeof ws !== 'object') return payload;
	/** @type {any} */
	const next = { ...ws };
	if (Array.isArray(ws.selection)) next.selection = ws.selection.filter((/** @type {string} */ u) => !uuids.has(u));
	if (ws.edit?.uuid && uuids.has(ws.edit.uuid)) delete next.edit;
	return /** @type {T} */ ({ ...p, workspace: next });
}

/** fix-batch-2: the one line a publish/export says when it left local objects out
 * @param {number} excluded */
export function noteLocalObjectsExcluded(excluded) {
	if (excluded > 0)
		showToast(
			excluded +
				(excluded === 1 ? ' local object was' : ' local objects were') +
				' not included — share ' +
				(excluded === 1 ? 'it' : 'them') +
				' from the object list to include ' +
				(excluded === 1 ? 'it' : 'them') +
				'.'
		);
}
