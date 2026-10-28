import { get } from 'svelte/store';
import { lockedObjects, objectsGroup, TControls, selectedObject } from '../stores/sceneStore';
import { peers, userdata, showToast, closeSelectionInspector } from '../stores/appStore';
import { selectObject } from './objectActions';
import { createRequestLimiter, holdsLock, isHeld } from './lockTrust';

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

const requestLimiter = createRequestLimiter();

/**
 * Holder side: show the Approve/Deny toast. `from` is the connection the request arrived
 * on — the asker named in the payload, and the name shown, come from it, never the payload.
 * @param {any} data @param {string} from
 */
export function applyLockRequest(data, from) {
	/** @type {any} */
	const peer = get(peers);
	if (!peer || !from) return;
	// our own locks are not in the store (it holds remote locks) — we hold an
	// object when it is our current selection
	if (get(selectedObject)?.uuid !== data.uuid) return;
	if (!requestLimiter.allow(from, data.uuid, Date.now())) return;
	const objectName = get(objectsGroup)?.getObjectByProperty('uuid', data.uuid)?.name ?? 'object';
	showToast(nameOf(from) + ' asks to control "' + objectName + '"', [
		{ label: 'Approve', action: () => releaseLock(data.uuid) },
		{
			label: 'Deny',
			action: () => peer.send({ type: 'lockdenied', uuid: data.uuid, to: from })
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

/**
 * A peer let go of an object. Only the SENDER's own row is released, and our pending
 * request treats it as the answer only when the sender was the one holding it (or nobody
 * holds it any more) — a third peer's `unlock` must not hand us an object someone holds.
 * @param {any} data @param {string} from
 */
export function applyUnlock(data, from) {
	if (!from) return;
	let held = false;
	let stillHeld = false;
	lockedObjects.update((locks) => {
		held = holdsLock(locks, from, data.uuid);
		const next = locks.filter((l) => !(l[0] === from && l[1] === data.uuid));
		stillHeld = isHeld(next, data.uuid);
		return next;
	});
	if (pendingRequest === data.uuid && (held || !stillHeld)) {
		const uuid = pendingRequest;
		pendingRequest = null;
		selectObject(uuid, true); // grabs the lock for us + opens properties
		showToast('You now control the object');
	}
}

/** Only the holder can deny @param {any} data @param {string} from */
export function applyLockDenied(data, from) {
	/** @type {any} */
	const peer = get(peers);
	if (data.to !== peer?.peer?.id) return;
	if (!holdsLock(get(lockedObjects), from, data.uuid)) return;
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
				// test-health-1: mid-blip the holder's conn is down but the reconnect window still runs —
				// their lock survives until finalizeDisconnect decides (the rule checkLocks keeps, B5).
				// Without it a sweep landing inside a drop released a live peer's locks (net-drop HARD).
				return !!(conn && conn.open) || !!peer.reconnecting?.has(l[0]);
			})
		);
	}, 60000);
}
