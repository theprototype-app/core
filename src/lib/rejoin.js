// fix-agenttest 6 — A RELOAD WHILE JOINED GOES BACK TO THE SAME SESSION. A LEAF (svelte/store only).
//
// A guest that reloaded came back with a fresh peer id and no idea it had been in a session, and
// the autosave's "Restore previous session?" filled the gap: Restore loaded the guest's own copy of
// the host's scene as a SEPARATE session, which split from the room and later merged back into it.
//
// The guest now remembers `{id, host}` in sessionStorage on `pagehide` (per tab: a reload keeps it,
// a new tab does not), comes back on the SAME id and dials the host. The host re-admits an id that
// left by unloading inside REJOIN_WINDOW_MS without a new approval card (peerHandler `unloadedPeers`;
// an explicit Leave or a removal gets no grace). The restore prompt waits for the outcome
// (`rejoinOutcome`): rejoined = no prompt, there is a live session and we are in it; anything else
// (the host gone, a refusal, no answer within REJOIN_DIAL_MS) = the prompt as before, and a restore
// is then the user's own session, never merged without the connect decision.
//
// A RECORD IS NOT A PASS. The host re-admits a returning page only when it PROVES, over the new link,
// that it holds the secret the host gave it (rejoinLinks.js); the record carries that secret (`s`),
// and a host that reloads keeps its own record (`tp:hostrejoin`: its id and its guests' secrets) so it
// comes back on the same id and its guests can prove themselves to it — and it to them.

import { writable, get } from 'svelte/store';

export const REJOIN_KEY = 'tp:rejoin';
export const HOST_REJOIN_KEY = 'tp:hostrejoin';
/** how old a remembered session may be and still be rejoined (both sides use it) */
export const REJOIN_WINDOW_MS = 120000;
/** how long a rejoin dial may take before the restore prompt is offered after all */
export const REJOIN_DIAL_MS = 25000;

/** sessionStorage, guarded (a sandboxed frame throws on touch) */
const store = {
	/** @param {string} k */
	get(k) {
		try {
			return typeof sessionStorage === 'undefined' ? null : sessionStorage.getItem(k);
		} catch {
			return null;
		}
	},
	/** @param {string} k @param {string} v */
	set(k, v) {
		try {
			if (typeof sessionStorage !== 'undefined') sessionStorage.setItem(k, v);
		} catch {
			/* no storage: a reload just does not rejoin */
		}
	},
	/** @param {string} k */
	remove(k) {
		try {
			if (typeof sessionStorage !== 'undefined') sessionStorage.removeItem(k);
		} catch {
			/* nothing to clear */
		}
	}
};

const PEER_ID = /^[a-z0-9-]{3,64}$/i;
/** the shape of a secret rejoinLinks mints (32 bytes, base64) */
const SECRET = /^[A-Za-z0-9+/]{43}=$/;
/** how many guests a host record may hold (the mesh cap is far below this) */
const MAX_GUESTS = 64;

/**
 * The remembered session if it is still fresh, else null. @param {number} [now]
 * @returns {{id: string, host: string, at: number, s?: string} | null}
 */
export function peekRejoin(now = Date.now()) {
	let rec;
	try {
		rec = JSON.parse(store.get(REJOIN_KEY) ?? 'null');
	} catch {
		return null;
	}
	if (!rec || typeof rec !== 'object') return null;
	const { id, host, at } = rec;
	if (typeof id !== 'string' || typeof host !== 'string' || !PEER_ID.test(id) || !PEER_ID.test(host) || id === host) return null;
	if (!Number.isFinite(at) || now - at < 0 || now - at > REJOIN_WINDOW_MS) return null;
	return typeof rec.s === 'string' && SECRET.test(rec.s) ? { id, host, at, s: rec.s } : { id, host, at };
}

/** On pagehide: joined to `host` as a guest → remember it (with the host's secret for us, when it gave
 * one); otherwise forget any old record.
 * @param {string | null | undefined} id @param {string | null | undefined} host @param {number} [now]
 * @param {string | null} [secret] */
export function rememberRejoin(id, host, now = Date.now(), secret = null) {
	if (id && host && id !== host) store.set(REJOIN_KEY, JSON.stringify(secret && SECRET.test(secret) ? { id, host, at: now, s: secret } : { id, host, at: now }));
	else store.remove(REJOIN_KEY);
}

/** On pagehide while hosting: our id and each admitted guest's secret, or nothing (no guest holds one).
 * @param {string | null | undefined} id @param {Record<string, {s: string, role?: string}>} guests @param {number} [now] */
export function rememberHostRejoin(id, guests, now = Date.now()) {
	/** @type {Record<string, {s: string, role?: string}>} */
	const keep = {};
	let n = 0;
	for (const [g, v] of Object.entries(guests ?? {})) {
		if (n >= MAX_GUESTS || !PEER_ID.test(g) || g === id || !v || typeof v.s !== 'string' || !SECRET.test(v.s)) continue;
		keep[g] = v.role === 'edit' || v.role === 'view' ? { s: v.s, role: v.role } : { s: v.s };
		n++;
	}
	if (id && PEER_ID.test(id) && n) store.set(HOST_REJOIN_KEY, JSON.stringify({ id, at: now, guests: keep }));
	else store.remove(HOST_REJOIN_KEY);
}

/** The host record, ONCE per page and only while fresh. @param {number} [now]
 * @returns {{id: string, at: number, guests: Record<string, {s: string, role?: string}>} | null} */
export function takeHostRejoin(now = Date.now()) {
	let rec;
	try {
		rec = JSON.parse(store.get(HOST_REJOIN_KEY) ?? 'null');
	} catch {
		rec = null;
	}
	store.remove(HOST_REJOIN_KEY);
	if (!rec || typeof rec !== 'object' || typeof rec.id !== 'string' || !PEER_ID.test(rec.id)) return null;
	if (!Number.isFinite(rec.at) || now - rec.at < 0 || now - rec.at > REJOIN_WINDOW_MS) return null;
	if (!rec.guests || typeof rec.guests !== 'object' || Array.isArray(rec.guests)) return null;
	/** @type {Record<string, {s: string, role?: string}>} */
	const guests = {};
	let n = 0;
	for (const [g, v] of Object.entries(rec.guests)) {
		if (n >= MAX_GUESTS || !PEER_ID.test(g) || g === rec.id || !v || typeof v !== 'object' || typeof v.s !== 'string' || !SECRET.test(v.s)) continue;
		guests[g] = v.role === 'edit' || v.role === 'view' ? { s: v.s, role: v.role } : { s: v.s };
		n++;
	}
	return n ? { id: rec.id, at: rec.at, guests } : null;
}

/** Leave, a removal, the window running out: no record of either kind survives. */
export function forgetRejoinRecords() {
	store.remove(REJOIN_KEY);
	store.remove(HOST_REJOIN_KEY);
}

/** 'none' (nothing to rejoin) | 'pending' (dialling) | 'joined' | 'failed' */
export const rejoinState = writable(peekRejoin() ? 'pending' : 'none');

/** The record to rejoin with, ONCE per page (the next pagehide writes a new one). */
export function takeRejoin() {
	const rec = peekRejoin();
	store.remove(REJOIN_KEY);
	if (!rec) {
		if (get(rejoinState) === 'pending') rejoinState.set('none');
		return null;
	}
	rejoinState.set('pending');
	return rec;
}

/** @param {'joined' | 'failed'} outcome */
export function settleRejoin(outcome) {
	if (get(rejoinState) === 'pending') rejoinState.set(outcome);
}

/** Resolves with the outcome once nothing is pending (`none` straight away when there is no record). */
export function rejoinOutcome() {
	return new Promise((resolve) => {
		/** @type {(() => void) | undefined} */
		let off;
		let done = false;
		off = rejoinState.subscribe((v) => {
			if (v === 'pending' || done) return;
			done = true;
			queueMicrotask(() => off?.());
			resolve(v);
		});
	});
}
