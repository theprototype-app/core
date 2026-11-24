// 80a K3: what WE hold, and since when. A leaf (stores + the session clock + the pure lock rules),
// so every place that takes a lock (selection, Edit Mesh, an import, a /command) builds its `lock`
// message here and the selection code, the gate and the handshake all read one set.
//
// `lockedObjects` (sceneStore) holds OTHER peers' rows; our own claims live here with the moment we
// took each object (`sessionNow`, so peers compare one clock). A `lock` message replaces the
// sender's whole set, so it always carries every uuid we hold, each with its stamp (`ats`, parallel
// to `uuids`; older peers read `uuid`/`uuids` and ignore the rest).
import { writable, get } from 'svelte/store';
import { lockedObjects } from '../stores/sceneStore';
import { peers, userdata } from '../stores/appStore';
import { sessionNow } from './sessionClock';
import { holderOf, LOCK_ROWS_PER_PEER, LOCK_RACE_MS } from './lockTrust';

/** @type {import('svelte/store').Writable<Map<string, number>>} uuid -> when we took it */
export const myLocks = writable(new Map());

/** Display name for a peer id @param {string} peerId */
export function nameOf(peerId) {
	/** @type {any[]} */
	const users = get(userdata) ?? [];
	const row = users.find((u) => u[0] === peerId);
	// 78 PL34: a roster row with no name is "Guest" (or "AI agent"), never a raw id
	return (row && row[1]) || (row ? (row[6]?.kind === 'agent' ? 'AI agent' : 'Guest') : peerId);
}

/** @returns {string | null} */
function selfId() {
	/** @type {any} */
	const peer = get(peers);
	return peer?.peer?.id ?? null;
}

/**
 * Hold exactly `uuids` from now on: an object we already hold keeps its stamp, a new one is
 * stamped now. Returns the stamps in the same order.
 * @param {string[]} uuids @returns {number[]}
 */
export function claimLocks(uuids) {
	const before = get(myLocks);
	/** @type {Map<string, number>} */
	const next = new Map();
	const now = sessionNow();
	for (const u of uuids) if (typeof u === 'string' && u && !next.has(u)) next.set(u, before.get(u) ?? now);
	myLocks.set(next);
	for (const u of next.keys()) if (!before.has(u)) touchMyLock(u);
	for (const u of [...lastTouch.keys()]) if (!next.has(u)) lastTouch.delete(u);
	return [...next.values()];
}

/** Let go of some objects (or all of them) @param {string[]} [uuids] */
export function dropMyLocks(uuids) {
	const before = get(myLocks);
	if (!uuids) {
		if (before.size) myLocks.set(new Map());
		lastTouch.clear();
		return;
	}
	if (!uuids.some((u) => before.has(u))) return;
	const next = new Map(before);
	for (const u of uuids) (next.delete(u), lastTouch.delete(u));
	myLocks.set(next);
}

/**
 * The `lock` message for holding exactly `uuids` (claims them as a side effect). `uuid` is the
 * primary (the last entry), the field every peer has always read.
 * @param {string[]} uuids @param {string} [peerId]
 */
export function lockMessage(uuids, peerId = selfId() ?? '') {
	// a selection bigger than one lock set holds its last LOCK_ROWS_PER_PEER objects (receivers refuse a bigger set)
	const clean = uuids.filter((u) => typeof u === 'string' && u).slice(-LOCK_ROWS_PER_PEER);
	const ats = claimLocks(clean);
	return { type: 'lock', uuid: clean[clean.length - 1], uuids: [...get(myLocks).keys()], ats, peerId };
}

/** our claim on `uuid` in the shape the lock rules take @param {string} uuid @returns {{self: string, at: number} | null} */
export function myClaim(uuid) {
	const at = get(myLocks).get(uuid);
	const self = selfId();
	return at === undefined || !self ? null : { self, at };
}

/** our rows for a `locked` table (handshake, room arrival) @returns {[string, string, number][]} */
export function myLockRows() {
	const self = selfId();
	if (!self) return [];
	return [...get(myLocks)].map(([u, at]) => [self, u, at]);
}

/** Who holds `uuid` right now, us included (null = nobody) @param {string} uuid */
export function holderNow(uuid) {
	return holderOf(get(lockedObjects), uuid, myClaim(uuid));
}

/** Is `uuid` held by somebody other than us? (a losing claim of another peer's does not count) @param {string} uuid */
export function heldByOther(uuid) {
	const h = holderNow(uuid);
	return !!h && h !== selfId();
}

/** Do we hold `uuid` (our claim wins)? @param {string} uuid */
export function heldByMe(uuid) {
	const h = holderNow(uuid);
	return !!h && h === selfId();
}

// ---------------------------------------------------------------------------------------------
// 80a K4: a held object's FLOW opens view-only. The flow editor follows the selection, and a held
// object cannot join a selection, so selecting one makes a locked VIEW (objectActions' locked branch):
// `lockedView` publishes it, and the editor shows that object's flow read-only instead of the scene.

/** @type {import('svelte/store').Writable<string | null>} the held object being VIEWED, if any */
export const lockedView = writable(/** @type {string | null} */ (null));

/** Another peer holding the object whose flow `graphId` is (null for the scene graph, or nobody) @param {string | null | undefined} graphId */
export function flowHolderOf(graphId) {
	if (!graphId || graphId === 'scene') return null;
	const h = holderNow(graphId);
	return h && h !== selfId() ? h : null;
}

/** @type {Map<string, number>} graphId -> last "is editing this flow" toast */
const flowToastAt = new Map();

/**
 * A local edit of the flow `graphId` is about to happen: refuse it while another peer holds the object
 * (and say so, at most every 2 s). Every flow-editing path that is not a node card calls this.
 * @param {string | null | undefined} graphId @param {(who: string) => void} [say] the toast
 * @returns {boolean} true = blocked
 */
export function flowEditBlocked(graphId, say) {
	const holder = flowHolderOf(graphId);
	if (!holder) return false;
	const now = Date.now();
	if (say && now - (flowToastAt.get(String(graphId)) ?? -Infinity) > 2000) {
		flowToastAt.set(String(graphId), now);
		say(holder);
	}
	return true;
}

// ---------------------------------------------------------------------------------------------
// 80a K6: an object we hold and stopped editing is let go after a while (lockIdle.js). "Editing" is
// any edit of it we SEND (the gated message types, the K3 gate's own list) or taking it; Keep
// holding restarts the count. Local clock: this is a fact about this tab, never on the wire.

/** @type {Map<string, number>} uuid -> when we last edited or took it (Date.now) */
const lastTouch = new Map();

/** We edited (or kept) `uuid` now @param {string} uuid */
export function touchMyLock(uuid) {
	if (get(myLocks).has(uuid)) lastTouch.set(uuid, Date.now());
}

/** How long since we last edited each object we hold @param {number} [now] @returns {[string, number][]} */
export function myLockIdle(now = Date.now()) {
	return [...get(myLocks).keys()].map((u) => [u, now - (lastTouch.get(u) ?? now)]);
}

// ---------------------------------------------------------------------------------------------
// 80a K6: a link that drops and comes back keeps every lock on both sides, and each side re-sends
// its set in the heal handshake. Claims either side made while the link was down arrive late, so for
// a short while after the heal a claim from that peer may be dated back to the last message we heard
// from it (not just LOCK_RACE_MS): a link delivers in order, so anything it sent before that message
// has arrived, and both sides then compare the real stamps of what was lost and agree on one holder.

/** how far back a claim from a link that just came back may be dated at most (the reconnect window) */
export const LOCK_HEAL_BACKDATE_MS = 16000;
/** that allowance lasts this long after the heal (the heal handshake's lock set lands well inside it) */
export const LOCK_HEAL_FLOOR_MS = 10000;
/** @type {Map<string, number>} peer -> session-clock moment of the last message from it */
const heardAt = new Map();
/** @type {Map<string, {heard: number | null, until: number}>} peer -> the heal allowance */
const healFloor = new Map();

/** @param {Map<string, any>} map */
const trim = (map) => {
	if (map.size > 256) map.delete(/** @type {string} */ (map.keys().next().value));
};

/** A message from `peerId` arrived @param {string} peerId @param {number} [now] */
export function noteHeard(peerId, now = sessionNow()) {
	heardAt.set(peerId, now);
	trim(heardAt);
}

/** The link to `peerId` came back (a heal handshake) @param {string} peerId @param {number} [now] */
export function noteLinkHealed(peerId, now = sessionNow()) {
	const cur = healFloor.get(peerId);
	// a second heal path for the same drop keeps the first one's moment (the handshake has been heard since)
	if (cur && now <= cur.until) {
		cur.until = now + LOCK_HEAL_FLOOR_MS;
		return;
	}
	healFloor.delete(peerId);
	healFloor.set(peerId, { heard: heardAt.get(peerId) ?? null, until: now + LOCK_HEAL_FLOOR_MS });
	trim(healFloor);
}

/** The peer is gone for good @param {string} peerId */
export function forgetLink(peerId) {
	heardAt.delete(peerId);
	healFloor.delete(peerId);
}

/**
 * How far back a contested claim from `peerId` may be dated (lockTrust.claimStamp's floor).
 * @param {string} peerId @param {number} now session clock
 */
export function raceFloor(peerId, now) {
	const s = healFloor.get(peerId);
	if (!s || now > s.until) return now - LOCK_RACE_MS;
	return Math.max(s.heard ?? -Infinity, now - LOCK_HEAL_BACKDATE_MS) - LOCK_RACE_MS;
}
