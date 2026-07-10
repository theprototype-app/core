import { get } from 'svelte/store';
import { lockedObjects, objectsGroup, TControls, selectedObject } from '../stores/sceneStore';
import { peers, userdata, showToast, closeSelectionInspector } from '../stores/appStore';
import { selectObject } from './objectActions';

// Lock visibility + polite takeover: request control of a locked object, the
// holder gets an Approve/Deny toast; approving releases (new `unlock` message)
// and the requester auto-selects. Locks of dead connections sweep every 60s.

/** Display name for a peer id @param {string} peerId */
export function nameOf(peerId) {
	const users = get(userdata) ?? [];
	const row = users.find((u) => u[0] === peerId);
	return (row && row[1]) || peerId;
}

/** Stable per-peer color (same scheme as pings/cursors) @param {string} peerId */
export function peerColor(peerId) {
	let hash = 0;
	for (let i = 0; i < (peerId ?? '').length; i++) hash = (hash * 31 + peerId.charCodeAt(i)) >>> 0;
	return `hsl(${hash % 360}, 80%, 60%)`;
}

/** @type {string | null} uuid we asked to control */
let pendingRequest = null;

/** @param {string} uuid */
export function requestControl(uuid) {
	/** @type {any} */
	const peer = get(peers);
	if (!peer) return;
	pendingRequest = uuid;
	peer.send({ type: 'lockrequest', uuid: uuid, from: peer.peer.id, name: nameOf(peer.peer.id) });
	showToast('Asked to take control…');
}

/** Holder side: show the Approve/Deny toast @param {any} data */
export function applyLockRequest(data) {
	/** @type {any} */
	const peer = get(peers);
	if (!peer) return;
	// our own locks are not in the store (it holds remote locks) — we hold an
	// object when it is our current selection
	if (get(selectedObject)?.uuid !== data.uuid) return;
	const objectName = get(objectsGroup)?.getObjectByProperty('uuid', data.uuid)?.name ?? 'object';
	showToast((data.name || data.from) + ' asks to control "' + objectName + '"', [
		{ label: 'Approve', action: () => releaseLock(data.uuid) },
		{
			label: 'Deny',
			action: () => peer.send({ type: 'lockdenied', uuid: data.uuid, to: data.from })
		}
	]);
}

/** Give up our own lock on an object and tell everyone @param {string} uuid */
export function releaseLock(uuid) {
	/** @type {any} */
	const peer = get(peers);
	if (!peer) return;
	if (get(selectedObject)?.uuid === uuid) {
		get(TControls)?.detach();
		closeSelectionInspector();
	}
	lockedObjects.update((locks) => locks.filter((l) => !(l[0] === peer.peer.id && l[1] === uuid)));
	peer.send({ type: 'unlock', peerId: peer.peer.id, uuid: uuid });
}

/** @param {any} data */
export function applyUnlock(data) {
	lockedObjects.update((locks) =>
		locks.filter((l) => !(l[0] === data.peerId && l[1] === data.uuid))
	);
	if (pendingRequest === data.uuid) {
		const uuid = pendingRequest;
		pendingRequest = null;
		selectObject(uuid, true); // grabs the lock for us + opens properties
		showToast('You now control the object');
	}
}

/** @param {any} data */
export function applyLockDenied(data) {
	/** @type {any} */
	const peer = get(peers);
	if (data.to !== peer?.peer?.id) return;
	if (pendingRequest === data.uuid) pendingRequest = null;
	showToast('Control request denied');
}

let sweepStarted = false;

/** Drop locks whose peer connection is gone (safety net beyond checkLocks) */
export function startLockSweep() {
	if (sweepStarted || typeof window === 'undefined') return;
	sweepStarted = true;
	setInterval(() => {
		/** @type {any} */
		const peer = get(peers);
		if (!peer) return;
		lockedObjects.update((locks) =>
			locks.filter((l) => {
				if (l[0] === peer.peer.id) return true;
				const conn = peer.connections[l[0]];
				return !!(conn && conn.open);
			})
		);
	}, 60000);
}
