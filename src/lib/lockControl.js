import { get, writable } from 'svelte/store';
import { lockedObjects, objectsGroup, TControls, selectedObject, selectedObjects } from '../stores/sceneStore';
import { peers, showToast, closeSelectionInspector } from '../stores/appStore';
import { selectObject, applySelectionSet, deselectObject } from './objectActions';
import { startLockIdle } from './lockIdle';
import { registerLockModeHooks, clearEditTimers, resetLockMode, lockOnEdit, lockMode } from './lockMode';
import { sessionHost } from './connectionState';
import { createRequestLimiter, holdsLock, isHeld, holderOf, gatedUuid, lockGateVerdict } from './lockTrust';
import { myLocks, myClaim, dropMyLocks, heldByMe, holderNow, nameOf, lockedView } from './lockHeld';
import { lockGeometry } from './geometries.svelte';

// Lock visibility + polite takeover: request control of a locked object, the
// holder gets an Approve/Deny toast; approving releases (new `unlock` message)
// and the requester auto-selects. Locks of dead connections sweep every 60s.

/** Display name for a peer id (lives in the lockHeld leaf; re-exported for every caller) */
export { nameOf };

/** Stable per-peer color (same scheme as pings/cursors) @param {string} peerId */
export function peerColor(peerId) {
	let hash = 0;
	for (let i = 0; i < (peerId ?? '').length; i++) hash = (hash * 31 + peerId.charCodeAt(i)) >>> 0;
	return `hsl(${hash % 360}, 80%, 60%)`;
}

/** @type {string | null} uuid we asked to control */
let pendingRequest = null;
/** 80a K1: the same, for the held-object banner ("Asked…") */
export const controlAsked = writable(/** @type {string | null} */ (null));

/** @param {string} uuid */
export function requestControl(uuid) {
	/** @type {any} */
	const peer = get(peers);
	if (!peer) return;
	pendingRequest = uuid;
	controlAsked.set(uuid);
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
	// our own locks are not in the store (it holds remote locks): lockHeld has them, and the
	// request is ours to answer only while our claim is the one that holds (80a K3)
	if (!heldByMe(data.uuid)) return;
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
	dropMyLocks([uuid]);
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
	// 80a K15: in "Lock only while editing" a VIEW of an object whose holder stopped editing becomes
	// a selection again, so the gizmo is there for the next edit
	if (held && !stillHeld && lockOnEdit() && get(lockedView) === data.uuid && pendingRequest !== data.uuid) {
		selectObject(data.uuid);
	}
	if (pendingRequest === data.uuid && (held || !stillHeld)) {
		const uuid = pendingRequest;
		pendingRequest = null;
		controlAsked.set(null);
		selectObject(/** @type {string} */ (uuid), true); // grabs the lock for us + opens properties
		showToast('You now control the object');
	}
}

/** Only the holder can deny @param {any} data @param {string} from */
export function applyLockDenied(data, from) {
	/** @type {any} */
	const peer = get(peers);
	if (data.to !== peer?.peer?.id) return;
	if (!holdsLock(get(lockedObjects), from, data.uuid)) return;
	if (pendingRequest === data.uuid) (pendingRequest = null), controlAsked.set(null);
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

// ---------------------------------------------------------------------------------------------
// 80a K3: a peer's lock set, two peers taking one object at once, and the receiving-side gate.

/** an object's display name @param {string} uuid */
function objectName(uuid) {
	return get(objectsGroup)?.getObjectByProperty('uuid', uuid)?.name || 'object';
}

/**
 * A peer's `lock` set arrived (from = the connection). Its rows are stored with their stamps; any
 * object we claimed that the peer took FIRST (earlier stamp, then the lower id: every peer works
 * out the same answer) is let go here: out of our selection, and a word to say why.
 * @param {any} data @param {string} from
 */
export function applyRemoteLock(data, from) {
	if (!from) return;
	lockGeometry(data.uuid, from, data.uuids, data.ats);
	yieldLostLocks(from);
}

/**
 * Our claims that lost to another peer's: drop them, take them out of the selection and say who
 * has them. `by` names the peer whose message decided it (for the toast).
 * @param {string} [by]
 */
export function yieldLostLocks(by) {
	/** @type {any} */
	const peer = get(peers);
	const self = peer?.peer?.id;
	if (!self) return;
	const table = get(lockedObjects);
	/** @type {string[]} */
	const lost = [];
	for (const [uuid, at] of get(myLocks)) {
		const holder = holderOf(table, uuid, { self, at });
		if (holder && holder !== self) lost.push(uuid);
	}
	if (!lost.length) return;
	dropMyLocks(lost);
	const current = get(selectedObjects);
	if (current.some((u) => lost.includes(u))) applySelectionSet(current.filter((u) => !lost.includes(u)));
	const who = holderOf(table, lost[0]) ?? by ?? '';
	showToast(nameOf(who) + ' took "' + objectName(lost[0]) + '" first');
}

/** @type {Map<string, {replays: (() => void)[], timer: any}>} from + '\n' + uuid -> edits waiting */
const parked = new Map();
/** how long an edit from a peer that is taking an object over may wait for the hand-over */
export const LOCK_PARK_MS = 1500;
const PARK_MAX = 240;

/** @param {string} from @param {string} uuid @param {() => void} replay */
function park(from, uuid, replay) {
	const key = from + '\n' + uuid;
	let entry = parked.get(key);
	if (!entry) {
		entry = { replays: [], timer: setTimeout(() => parked.delete(key), LOCK_PARK_MS) };
		parked.set(key, entry);
	}
	if (entry.replays.length < PARK_MAX) entry.replays.push(replay);
}

// every change of the table (a lock, an unlock, a peer gone, the sweep) may finish a hand-over;
// the flush runs after the message that changed it, never inside its applier
let flushQueued = false;
lockedObjects.subscribe(() => {
	if (!parked.size || flushQueued) return;
	flushQueued = true;
	queueMicrotask(() => {
		flushQueued = false;
		flushParked();
	});
});

/** Apply, in order, the parked edits of every peer that now holds its object. */
export function flushParked() {
	if (!parked.size) return;
	for (const [key, entry] of [...parked]) {
		const [from, uuid] = key.split('\n');
		const holder = holderNow(uuid);
		if (holder && holder !== from) continue;
		parked.delete(key);
		clearTimeout(entry.timer);
		for (const replay of entry.replays) {
			try {
				replay();
			} catch {
				/* one bad edit must not strand the rest */
			}
		}
	}
}

/** a peer left: its parked edits go with it @param {string} peerId */
export function dropPeerLockState(peerId) {
	for (const [key, entry] of parked) if (key.startsWith(peerId + '\n')) (clearTimeout(entry.timer), parked.delete(key));
	for (const key of rejectAt.keys()) if (key.startsWith(peerId + '\n')) rejectAt.delete(key);
	for (const [key, t] of healTimers) if (key.startsWith(peerId + '\n')) (clearTimeout(t), healTimers.delete(key));
}

/** @type {Map<string, number>} from + uuid -> when we last told that peer no */
const rejectAt = new Map();
/** @type {Map<string, any>} from + uuid -> the pending heal */
const healTimers = new Map();
/** one `lockreject` per peer and object in this window; the heal goes this long after the last refused edit */
export const LOCK_REJECT_GAP_MS = 500;
export const LOCK_HEAL_MS = 300;

/**
 * THE RECEIVING-SIDE GATE (80a K3). An edit of an object somebody else holds is not applied. When
 * WE hold it we answer: `lockreject` (so the sender lets go of it) and, once its stream stops, the
 * object as it is here (`heal`), which undoes the edit on the sender. A third peer's object is the
 * holder's to answer for; an edit from a peer whose claim is still waiting for a hand-over is held
 * a moment (`park`) and applied once that peer holds the object.
 * @param {string} from the connection it came on
 * @param {any} data the message
 * @param {{runtime: boolean, replay: () => void, heal: (peerId: string, uuid: string, flow: boolean) => void}} hooks
 * @returns {boolean} true = apply it
 */
export function gateLockedEdit(from, data, { runtime, replay, heal }) {
	const uuid = gatedUuid(data);
	if (!uuid) return true;
	/** @type {any} */
	const peer = get(peers);
	const verdict = lockGateVerdict({ data, from, selfId: peer?.peer?.id, table: get(lockedObjects), mine: myClaim(uuid), runtime });
	if (verdict === 'apply') return true;
	if (verdict === 'park') park(from, uuid, replay);
	else if (verdict === 'reject') {
		const key = from + '\n' + uuid;
		const now = Date.now();
		const conn = peer?.connections?.[from];
		if (conn?.open && now - (rejectAt.get(key) ?? -Infinity) >= LOCK_REJECT_GAP_MS) {
			rejectAt.set(key, now);
			conn.send({ type: 'lockreject', uuid, edit: data.type });
		}
		clearTimeout(healTimers.get(key));
		const flow = LOCK_FLOW_TYPES.has(data.type);
		healTimers.set(
			key,
			setTimeout(() => {
				healTimers.delete(key);
				heal(from, uuid, flow);
			}, LOCK_HEAL_MS)
		);
	}
	return false;
}

/** flow edits: their heal is the flow documents, not the object */
const LOCK_FLOW_TYPES = new Set(['graphcreate', 'graphdelete', 'nodecreate', 'nodemove', 'nodedata', 'nodedelete', 'edgecreate', 'edgedelete']);

/** @type {Map<string, number>} uuid -> last "your change was undone" toast */
const rejectToastAt = new Map();

/**
 * Our edit was refused. Only the peer that HOLDS the object may say so (a `lockreject` from anybody
 * else does nothing); we let go of it, and the object as the holder has it is on its way.
 * @param {any} data @param {string} from
 */
export function applyLockReject(data, from) {
	if (!from || typeof data?.uuid !== 'string') return;
	// counting OUR claim too: in a crossed race both sides reject the other's first edit, and only
	// the one whose claim really wins may make us let go
	if (holderOf(get(lockedObjects), data.uuid, myClaim(data.uuid)) !== from) return;
	if (myClaim(data.uuid)) dropMyLocks([data.uuid]);
	const current = get(selectedObjects);
	if (current.includes(data.uuid)) applySelectionSet(current.filter((u) => u !== data.uuid));
	const now = Date.now();
	if (now - (rejectToastAt.get(data.uuid) ?? -Infinity) < 3000) return;
	rejectToastAt.set(data.uuid, now);
	showToast(nameOf(from) + ' is editing "' + objectName(data.uuid) + '", so your change was not kept');
}

// ---------------------------------------------------------------------------------------------
// 80a K6: letting go on purpose (Release, idle expiry, a healed connection).

/**
 * Let go of `uuids`: out of the selection (which re-sends our lock set) and an `unlock` for any we
 * hold outside it (an Edit Mesh session, a view).
 * @param {string[]} uuids
 */
export function letGoOf(uuids) {
	const drop = new Set(uuids);
	if (!drop.size) return;
	const current = get(selectedObjects);
	const rest = current.filter((u) => !drop.has(u));
	if (rest.length !== current.length) {
		if (rest.length) applySelectionSet(rest);
		else deselectObject();
	}
	for (const u of drop) if (get(myLocks).has(u)) releaseLock(u);
}

/**
 * A dropped connection to `peerId` came back (fix4-net's heal paths all end in sendHandshake with
 * `heal`). Neither side knows which of us was offline, and a claim kept across the drop keeps its
 * old stamp, which would win the tie-break against someone who took the object meanwhile. So both
 * sides forget the healed peer's rows and let go of what they hold, BEFORE the heal handshake goes
 * out (it then carries an empty held set). QUESTIONS-80a-locks Q2.
 * @param {string} peerId
 */
export function releaseOnHeal(peerId) {
	lockedObjects.update((locks) => {
		const next = locks.filter((l) => l[0] !== peerId);
		return next.length === locks.length ? locks : next;
	});
	dropPeerLockState(peerId);
	const mine = [...get(myLocks).keys()];
	if (!mine.length) return;
	letGoOf(mine);
	showToast(
		'Connection to ' + nameOf(peerId) + ' came back: you let go of ' + (mine.length === 1 ? '"' + objectName(mine[0]) + '"' : mine.length + ' objects') + ', select again to keep editing'
	);
}

/**
 * 80a K15: an edit lock's 3 s are up: let go, and keep the selection (no gizmo detach, no panel close).
 * @param {string} uuid
 */
export function releaseEditLock(uuid) {
	/** @type {any} */
	const peer = get(peers);
	dropMyLocks([uuid]);
	if (peer?.peer?.id) peer.send({ type: 'unlock', peerId: peer.peer.id, uuid });
}

/**
 * 80a K15: the room's mode changed. To "only while editing": let go of every selection lock (keep
 * the selection). Back to "while selected": take what is selected.
 * @param {'select' | 'edit'} mode
 */
function lockModeChanged(mode) {
	clearEditTimers();
	if (mode === 'edit') {
		for (const u of [...get(myLocks).keys()]) releaseEditLock(u);
	} else {
		const sel = get(selectedObjects);
		if (sel.length) applySelectionSet(sel);
	}
	// a reset (we left, a new host) says nothing; a change somebody made does
	if (get(lockMode).at) showToast(mode === 'edit' ? 'This room locks an object only while someone is editing it' : 'This room locks an object while someone has it selected');
}

let idleStarted = false;
/** start the idle expiry once (peerHandler's constructor) */
export function startLockLifecycle() {
	if (idleStarted) return;
	idleStarted = true;
	registerLockModeHooks({ changed: lockModeChanged });
	// a different host (or none: we left) means a different room: its mode comes with its handshake
	let lastHost = /** @type {any} */ (undefined);
	sessionHost.subscribe((hostId) => {
		if (lastHost !== undefined && hostId !== lastHost) resetLockMode();
		lastHost = hostId;
	});
	startLockIdle({
		say: (text, actions) => showToast(text, actions),
		letGo: letGoOf,
		nameOf: objectName,
		alone: () => {
			/** @type {any} */
			const p = get(peers);
			return !Object.values(p?.connections ?? {}).some((c) => /** @type {any} */ (c)?.open);
		}
	});
}
