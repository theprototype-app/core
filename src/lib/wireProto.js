// 101 F1 — THE SESSION PROTOCOL NUMBER, and what a link does when two ends disagree on it.
//
// Every dial carries `proto` (an integer) and `caps` (a plain object of capability flags) in its
// metadata, and the `modules` handshake message carries the same two fields. A build that sends
// no `proto` speaks protocol 1 (every release up to 1.65). Two ends with the same number behave
// exactly as before; two ends with different numbers never exchange scene data: the LOWER one is
// told to reload, the HIGHER one shows the other as "needs to reload".
//
// WIRE_PROTO goes up only when a release changes the meaning of a message in a way an older
// build would apply wrongly. Additive fields and new message types do NOT bump it (an older build
// counts and drops a type it does not know, which is safe) — they become a `caps` flag instead.
//
// A LEAF (svelte/store + safeStorage only), so peerHandler, the People list and tests can all
// import it without closing a module cycle.
import { writable, get } from 'svelte/store';
import { safeStorage } from './safeStorage';

/** what a peer that says nothing speaks (every build up to 1.65) */
export const PROTO_ABSENT = 1;

/** test hook: `localStorage.debugWireProto = '2'` (honoured only beside `debugStores`) makes this page speak another
 * protocol from boot, so the refusal path can be proven while production stays on 1 */
function bootProto() {
	try {
		if (!safeStorage.getItem('debugStores')) return 1;
		const raw = Number(safeStorage.getItem('debugWireProto'));
		return Number.isInteger(raw) && raw >= 1 && raw <= 1000 ? raw : 1;
	} catch {
		return 1;
	}
}

/** The protocol this build speaks. A live binding: importers read the current value. */
export let WIRE_PROTO = bootProto();

/** Test hook only (debugHooks): speak another protocol on links made FROM NOW ON — links already
 * agreed keep their verdict. @param {number} n */
export function setWireProtoForTest(n) {
	if (Number.isInteger(n) && n >= 1 && n <= 1000) WIRE_PROTO = n;
	return WIRE_PROTO;
}

/**
 * The protocol a peer said, as a number. Absent = PROTO_ABSENT; anything that is not a positive
 * integer is NaN, which compares unequal to everything — on doubt, the link is refused.
 * @param {unknown} v @returns {number}
 */
export function protoOf(v) {
	if (v === undefined || v === null) return PROTO_ABSENT;
	return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 1000 ? v : NaN;
}

/**
 * The verdict for a link: 'ok' (same protocol), 'stale' (theirs is higher: WE must reload) or
 * 'older' (theirs is lower or unreadable: THEY must reload). @param {number} theirs @param {number} [mine]
 * @returns {'ok' | 'stale' | 'older'}
 */
export function protoVerdict(theirs, mine = WIRE_PROTO) {
	if (theirs === mine) return 'ok';
	return theirs > mine ? 'stale' : 'older';
}

/**
 * The capability flags this build advertises. `wb` (batch envelopes) and `fc` (the fast movement
 * channel) are the two that already exist as top-level `modules` fields, `dev` says the `modules`
 * message carries a device row. New flags are added here and documented in OPEN-CORE.md.
 * @param {{fc?: boolean}} [opts] @returns {Record<string, number>}
 */
export function myCaps(opts = {}) {
	/** @type {Record<string, number>} */
	const caps = { wb: 1, dev: 1 };
	if (opts.fc) caps.fc = 1;
	return caps;
}

/** A peer's caps as a plain object of flags (anything else = none). @param {unknown} v @returns {Record<string, any>} */
export function capsOf(v) {
	if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
	/** @type {Record<string, any>} */
	const out = {};
	for (const [k, val] of Object.entries(v).slice(0, 64)) if (typeof k === 'string' && k.length <= 32) out[k] = val;
	return out;
}

/** The refusal message: `need` is the refuser's own protocol. @returns {{type: 'refuse', reason: 'proto', need: number}} */
export function refuseMessage() {
	return { type: 'refuse', reason: 'proto', need: WIRE_PROTO };
}

/** @param {any} data @returns {boolean} a well-formed `refuse` */
export function isRefuseMessage(data) {
	return !!data && data.type === 'refuse' && data.reason === 'proto' && Number.isInteger(data.need) && data.need >= 1;
}

/**
 * Peers on an OLDER protocol that this page refused — the People list's "needs to reload" rows.
 * Newest first, bounded. LOCAL, never replicated.
 * @type {import('svelte/store').Writable<{peerId: string, name: string, theirs: number, at: number}[]>}
 */
export const olderPeers = writable([]);

/** @param {string} peerId @param {string} name @param {number} theirs */
export function noteOlderPeer(peerId, name, theirs) {
	const rest = get(olderPeers).filter((r) => r.peerId !== peerId);
	olderPeers.set([{ peerId, name, theirs, at: Date.now() }, ...rest].slice(0, 8));
}

/** A peer came back on our protocol, or left for good. @param {string} peerId */
export function clearOlderPeer(peerId) {
	const rows = get(olderPeers);
	if (rows.some((r) => r.peerId === peerId)) olderPeers.set(rows.filter((r) => r.peerId !== peerId));
}

/** Set once this page has been told to reload (the notice shows once per page). */
export const staleNotice = writable(/** @type {{peerId: string, theirs: number, at: number} | null} */ (null));

/** Leaving the session: nothing here outlives it. */
export function resetWireProto() {
	olderPeers.set([]);
}
