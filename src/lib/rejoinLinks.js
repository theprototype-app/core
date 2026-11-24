// A PAGE THAT COMES BACK PROVES IT WAS HERE. A LEAF (rejoinProof + rejoin + diagnostics).
//
// Two ways back into a session skip the approval card: a guest that reloads, and every guest of a
// host that reloads. A session id is short and shown to everyone, and while a page reloads its id is
// free on the signalling server, so "the same id" proves nothing. What does: the host gives each guest
// it admits a secret of that guest's own, over that guest's own link (`rjs`), and a returning link
// opens with a challenge each way (`rjc` nonce, `rjp` answer; rejoinProof.js) before anything else
// crosses it. Until the far side has answered, the link is QUIET both ways: nothing we would send goes
// out (`pending` is read by the per-link send wrapper), nothing it sends is applied (`gate` holds it,
// in order, and replays it once the answer checks out, or drops it if it never does).
//
// The host side: a guest's secret is minted when the host first greets it (`issue`), PARKED when its
// page unloads (`unloaded`) or carried across the host's own reload (`restoreReturning`), and taken
// ONCE by the returning dial (`takeReturning`); the relink greets it again, so the secret rotates.
// A dial that cannot answer is a stranger and takes the ordinary way in. The guest side: the secret
// from its host (`setHostSecret`), offered back only to that host's id, and only by a guest — a host
// never claims. Nothing here logs, toasts or stores a secret anywhere but memory and sessionStorage
// (rejoin.js), and the diagnostics bundle redacts them (registerSecretSource).

import { mintSecret, mintNonce, isSecret, answerFor, verifyAnswer, PROOF_MS, EXCHANGE_TYPES } from './rejoinProof.js';
import { REJOIN_WINDOW_MS } from './rejoin.js';
import { registerSecretSource, log } from './diagnostics.js';

/** how long a returning dial may take, from the dial to the answer (once open, the exchange keeps what is left, at least PROOF_MS) */
export const RELINK_MS = 30000;
/** the host's wait for a returning dial to open (a newer dial from the same id replaces it; the window never grows) */
export const HOST_OPEN_MS = 60000;
/** messages a quiet link may hold before it is refused */
const HOLD_CAP = 1000;

/** @typedef {'host' | 'guest'} Role */
/** @typedef {{role: Role, secret: string, until: number, mine: string | null, answers: number, checking: boolean,
 *   trusted?: boolean, theirs?: {conn: any, n: any}, heard?: boolean,
 *   opens: (() => void)[], held: (() => void)[], conns: Set<any>, timer: any,
 *   onOk: () => void, onFail: (reason: string) => void}} Proof */

/** @param {any} conn @param {any} msg */
function sendOn(conn, msg) {
	try {
		conn?.send?.(msg);
	} catch {
		/* a link that died mid-proof fails by its close */
	}
}

/** @param {() => void} fn */
function safely(fn) {
	try {
		fn();
	} catch (e) {
		console.error('relink step threw', String(e));
	}
}

/**
 * @param {{myId: () => string, acceptSecretFrom: (peerId: string) => boolean, now?: () => number,
 *   send?: (conn: any, msg: any) => void, setTimer?: typeof setTimeout, clearTimer?: typeof clearTimeout}} deps
 */
export function createRelinks(deps) {
	const now = deps.now ?? (() => Date.now());
	const send = deps.send ?? sendOn;
	const setTimer = deps.setTimer ?? setTimeout;
	const clearTimer = deps.clearTimer ?? clearTimeout;

	/** host: guests we greeted -> their secret (+ the role an invite gave them) @type {Map<string, {s: string, role?: string}>} */
	const issued = new Map();
	/** host: guests whose page unloaded, or that were ours before OUR reload @type {Map<string, {s: string, role?: string, at: number}>} */
	const parked = new Map();
	/** guest: host id -> the secret it gave us @type {Map<string, string>} */
	const fromHost = new Map();
	/** links proving themselves @type {Map<string, Proof>} */
	const proofs = new Map();
	/** host: a secret a returning dial took and has not proven yet @type {Map<string, {s: string, role?: string, at: number}>} */
	const taken = new Map();

	const unregister = registerSecretSource(() => [
		...[...issued.values()].map((v) => v.s),
		...[...parked.values()].map((v) => v.s),
		...[...taken.values()].map((v) => v.s),
		...fromHost.values(),
		...[...proofs.values()].map((p) => p.secret)
	]);

	const prune = () => {
		const t = now();
		for (const [id, v] of parked) if (t - v.at > REJOIN_WINDOW_MS || t < v.at) parked.delete(id);
	};

	/** @param {string} peerId @param {boolean} ok @param {string} reason */
	const settle = (peerId, ok, reason) => {
		const st = proofs.get(peerId);
		if (!st) return;
		proofs.delete(peerId);
		clearTimer(st.timer);
		// the outcome and why, never anything the exchange carried
		log(ok ? 'info' : 'warn', 'net', ok ? 'returning link checked' : 'returning link not checked', { peer: peerId, as: st.role, why: reason || undefined, links: st.conns.size, asked: !!st.mine, answers: st.answers });
		if (!ok) {
			safely(() => st.onFail(reason));
			return;
		}
		safely(st.onOk);
		for (const fn of st.opens) safely(fn);
		for (const fn of st.held) safely(fn);
	};

	/** @param {string} peerId @param {Proof} st @param {number} ms */
	const arm = (peerId, st, ms) => {
		clearTimer(st.timer);
		st.timer = setTimer(() => {
			// nothing ever opened: the far side was not reached; opened but not a word of the exchange from it: 'silent'
			// (a page still too busy to answer). Neither is a failed check; a 'timeout' is one that started and did not end.
			// A guest whose host DID prove itself but whose challenge never arrived ('unasked') has sent nothing and
			// was not refused: that is not a failed check either (the next dial asks again)
			if (proofs.get(peerId) === st) settle(peerId, false, !st.conns.size ? 'unreached' : st.trusted && !st.theirs ? 'unasked' : st.heard ? 'timeout' : 'silent');
		}, ms);
	};

	/** Answer `peerId`'s challenge on `conn`. A guest's answer is the last step: once it is sent the link is checked.
	 * @param {string} peerId @param {Proof} st @param {any} conn @param {any} n */
	const answer = (peerId, st, conn, n) => {
		void answerFor(st.secret, st.role, deps.myId(), peerId, n).then((m) => {
			if (proofs.get(peerId) !== st) return;
			if (!m) return settle(peerId, false, 'answer');
			send(conn, { type: 'rjp', m });
			if (st.role === 'guest') settle(peerId, true, '');
		});
	};

	return {
		// ---- the host's secrets ----
		/** Greet an admitted guest with a fresh secret of its own, over its link. @param {string} peerId @param {any} conn @param {string} [role] */
		issue(peerId, conn, role) {
			const s = mintSecret();
			issued.set(peerId, role ? { s, role } : { s });
			parked.delete(peerId);
			send(conn, { type: 'rjs', s });
		},
		/** @param {string} peerId */
		hasIssued: (peerId) => issued.has(peerId),
		/** the guests holding a secret of ours (ids only) */
		holders: () => [...issued.keys(), ...parked.keys()],
		/** A guest's page unloaded: its secret waits out the window for its return. @param {string} peerId */
		unloaded(peerId) {
			const v = issued.get(peerId);
			issued.delete(peerId);
			if (v) parked.set(peerId, { ...v, at: now() });
			prune();
		},
		/** Our own reload: the guests we had, from the host record. @param {Record<string, {s: string, role?: string}>} guests @param {number} at */
		restoreReturning(guests, at) {
			for (const [g, v] of Object.entries(guests ?? {})) if (isSecret(v?.s)) parked.set(g, v.role ? { s: v.s, role: v.role, at } : { s: v.s, at });
			prune();
		},
		/** Is anyone still due back from before our reload or theirs. */
		hasReturning() {
			prune();
			return parked.size > 0;
		},
		/** The secret a returning dial must prove, taken ONCE (a second dial is a stranger). A guest whose
		 * goodbye never reached us still holds its greeting's secret (its link is in the reconnect window).
		 * @param {string} peerId */
		takeReturning(peerId) {
			prune();
			const p = parked.get(peerId);
			const v = p ?? issued.get(peerId);
			parked.delete(peerId);
			issued.delete(peerId);
			if (!v) return null;
			const out = v.role ? { s: v.s, role: v.role } : { s: v.s };
			taken.set(peerId, { ...out, at: p?.at ?? now() });
			return out;
		},
		/** A dial that could NOT prove it does not use up the real guest's way back: its secret goes
		 * back where it was, with the time it had (never a longer window), unless a newer one exists.
		 * `restore` false = the dial proved it, the secret is spent. @param {string} peerId @param {boolean} [restore] */
		putBack(peerId, restore = true) {
			const v = taken.get(peerId);
			taken.delete(peerId);
			if (!restore || !v || issued.has(peerId) || parked.has(peerId)) return;
			parked.set(peerId, v);
			prune();
		},
		/** What our pagehide keeps while hosting: the guests among `peerIds` that hold a secret. @param {Iterable<string>} peerIds */
		hostRecord(peerIds) {
			/** @type {Record<string, {s: string, role?: string}>} */
			const out = {};
			for (const id of peerIds) {
				const v = issued.get(id);
				if (v) out[id] = v.role ? { s: v.s, role: v.role } : { s: v.s };
			}
			return out;
		},

		// ---- the guest's secret ----
		/** @param {string} host @param {unknown} s */
		setHostSecret(host, s) {
			if (typeof host === 'string' && isSecret(s)) fromHost.set(host, /** @type {string} */ (s));
		},
		/** @param {string | null | undefined} host @returns {string | null} */
		hostSecret: (host) => (host ? fromHost.get(host) ?? null : null),

		/** A removal, a goodbye that was not a reload, the window ending: every secret for that peer goes. @param {string} peerId */
		forget(peerId) {
			issued.delete(peerId);
			parked.delete(peerId);
			taken.delete(peerId);
			fromHost.delete(peerId);
			const st = proofs.get(peerId);
			if (st) {
				proofs.delete(peerId);
				clearTimer(st.timer);
			}
		},
		/** Drop the proof under way to `peerId` (its dial found nobody), keeping the secrets. @param {string} peerId */
		cancel(peerId) {
			const st = proofs.get(peerId);
			if (!st) return;
			proofs.delete(peerId);
			clearTimer(st.timer);
		},
		/** Leaving the session: nothing survives (no callbacks run). */
		reset() {
			issued.clear();
			parked.clear();
			taken.clear();
			fromHost.clear();
			for (const st of proofs.values()) clearTimer(st.timer);
			proofs.clear();
		},

		// ---- the proof on a returning link ----
		/**
		 * A returning link to `peerId` must prove itself. `role` is OURS. @param {string} peerId @param {Role} role
		 * @param {string} secret @param {{onOk: () => void, onFail: (reason: string) => void}} cb
		 * @param {number} [ms] how long the link may take (RELINK_MS); once open, the exchange keeps what is left of it, at
		 *   least PROOF_MS (a host page that just booted can be slow to answer: that is not a failed check)
		 */
		begin(peerId, role, secret, cb, ms = RELINK_MS) {
			const old = proofs.get(peerId);
			if (old) clearTimer(old.timer);
			const limit = Math.max(1000, ms);
			/** @type {Proof} */
			const st = { role, secret, until: now() + limit, mine: null, answers: 0, checking: false, opens: [], held: [], conns: new Set(), timer: null, onOk: cb.onOk, onFail: cb.onFail };
			proofs.set(peerId, st);
			arm(peerId, st, limit);
		},
		/** A newer returning dial from `peerId` replaces the one we (the host) still check: that one fails
		 * ('replaced', so it goes the stranger's way and its secret is put back first). @param {string} peerId */
		supersede(peerId) {
			if (proofs.get(peerId)?.role === 'host') settle(peerId, false, 'replaced');
		},
		/** Is the link to `peerId` still quiet (nothing out but the exchange, nothing in applied). @param {string} peerId */
		pending: (peerId) => proofs.has(peerId),
		/** Do our dials to `peerId` say they come back (the guest's half). @param {string} peerId */
		claiming: (peerId) => proofs.get(peerId)?.role === 'guest',
		/** A link to `peerId` opened: challenge it, and run `fn` (what the open would do) once it answered. @param {any} conn @param {() => void} fn */
		opened(conn, fn) {
			const peerId = conn?.peer;
			const st = proofs.get(peerId);
			if (!st) {
				fn();
				return;
			}
			st.opens.push(fn);
			st.conns.add(conn);
			if (st.mine) return;
			st.mine = mintNonce();
			send(conn, { type: 'rjc', n: st.mine });
			arm(peerId, st, Math.max(PROOF_MS, st.until - now()));
		},
		/** A link of a proving peer closed before it answered. @param {any} conn */
		closed(conn) {
			const st = proofs.get(conn?.peer);
			if (st && st.conns.has(conn)) settle(conn.peer, false, 'closed');
		},
		/**
		 * The receive head. true = consumed here (the exchange, a secret, or held while the link is quiet).
		 * @param {any} conn @param {any} data @param {() => void} replay the rest of the receive chain
		 */
		gate(conn, data, replay) {
			const peerId = conn?.peer;
			const type = data?.type;
			const st = proofs.get(peerId);
			if (EXCHANGE_TYPES.has(type)) {
				if (!st) return true; // nobody asked: not an oracle for anyone
				st.heard = true;
				if (type === 'rjc') {
					if (st.answers >= 2) return true;
					st.answers++;
					// a returning GUEST sends nothing, not even its own answer, until the host has proved itself:
					// the challenge waits, and is answered (then the link is checked) once the host's answer verified
					if (st.role === 'guest' && !st.trusted) {
						st.theirs = { conn, n: data.n };
						return true;
					}
					answer(peerId, st, conn, data.n);
					return true;
				}
				// rjp: exactly one answer to our one challenge
				if (!st.mine || st.checking) {
					settle(peerId, false, 'early');
					return true;
				}
				st.checking = true;
				const asked = st;
				void verifyAnswer(st.secret, st.role === 'host' ? 'guest' : 'host', peerId, deps.myId(), st.mine, data.m).then((ok) => {
					if (proofs.get(peerId) !== asked) return;
					if (!ok || st.role === 'host') return settle(peerId, ok, ok ? '' : 'proof');
					// the guest: the host proved itself; now our answer (at once, or when its challenge comes)
					st.trusted = true;
					if (st.theirs) answer(peerId, st, st.theirs.conn, st.theirs.n);
				});
				return true;
			}
			if (type === 'rjs') {
				const take = () => {
					if (deps.acceptSecretFrom(peerId)) fromHost.set(peerId, data.s);
				};
				if (!isSecret(data?.s)) return true;
				if (st) st.held.push(take);
				else take();
				return true;
			}
			if (!st) return false;
			if (st.held.length >= HOLD_CAP) settle(peerId, false, 'flood');
			else st.held.push(replay);
			return true;
		},
		/** test seam: how many links are proving themselves */
		proving: () => proofs.size,
		dispose: unregister
	};
}
