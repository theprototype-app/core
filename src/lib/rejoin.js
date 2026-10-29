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

import { writable, get } from 'svelte/store';

export const REJOIN_KEY = 'tp:rejoin';
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

/**
 * The remembered session if it is still fresh, else null. @param {number} [now]
 * @returns {{id: string, host: string, at: number} | null}
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
	return { id, host, at };
}

/** On pagehide: joined to `host` as a guest → remember it; otherwise forget any old record.
 * @param {string | null | undefined} id @param {string | null | undefined} host @param {number} [now] */
export function rememberRejoin(id, host, now = Date.now()) {
	if (id && host && id !== host) store.set(REJOIN_KEY, JSON.stringify({ id, host, at: now }));
	else store.remove(REJOIN_KEY);
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
