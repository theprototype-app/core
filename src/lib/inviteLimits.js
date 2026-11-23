// 71 AS4 — AGENT INVITE AND JOIN LIMITS, the PURE half (imports only inviteCore, itself pure).
//
// Invites shipped (55 A4) with no limit anywhere: a host could mint any number of live links,
// and a dial carrying a bad or replayed proof fell back to the ordinary approval card. That
// card queue is capped at 12 (connectionState MAX_PENDING_APPROVALS) and the cap drops the
// OLDEST card first, so thirty junk invite dials in a minute pushed a real joiner's card out
// of the host's view before the host had read it (roadmap 71 finding A4). Four counters fix it:
//
//   MINTING (host side, `mintVerdict`): at most 20 LIVE invites (usable right now), and at most
//     10 minted in any 10 minutes. The second one counts MINTS, not records, because a record
//     can be forgotten from Users and a count of records would let mint-forget-mint walk past it.
//   FAILED PROOFS (`createJoinGate`): every invite dial that does not check out is counted, and
//     NONE of them becomes an approval card any more — they collapse into one "N failed invite
//     joins" row of their own (peerHandler + Toasts / VRPeerApprove), so the 12-card cap is
//     only ever spent on real requests. More than 10 in a minute PAUSES invite joins for 60 s:
//     every invite dial, good or bad, is told "paused" (an answer the joiner shows, with its
//     reason) and the host sees ONE toast. Approval cards keep working through a pause.
//   RE-JOINS (`createJoinGate().rejoin`): one invite letting the same peer back in again and
//     again (a reload loop, a script) is a token bucket per invite + peer — two quick re-joins
//     are free (a dropped link and a reload both look like this), then one per 30 s.
//
// The numbers are fork F4 ("as written"); they live in ONE object so a test and the copy can
// read them. Everything is per device (the host's), like the invites themselves.
import { inviteState } from './inviteCore.js';

export const INVITE_LIMITS = Object.freeze({
	/** invites usable right now, per host device */
	liveMax: 20,
	/** invites minted per window */
	mintMax: 10,
	mintWindowMs: 10 * 60_000,
	/** failed invite proofs per window before invite joins pause */
	failMax: 10,
	failWindowMs: 60_000,
	pauseMs: 60_000,
	/** re-joins on one invite by one peer: a burst, then one per gap */
	rejoinBurst: 2,
	rejoinGapMs: 30_000,
	/** failed dials the collapsed row keeps for Review (the count goes on past it) */
	failedKeep: 12
});

/** @param {import('./inviteCore.js').InviteRecord[]} records @param {number} [now] */
export function liveInvites(records, now = Date.now()) {
	return (records ?? []).filter((r) => r && inviteState(r, now) === 'active').length;
}

/** @param {number} ms */
const minutes = (ms) => Math.max(1, Math.ceil(ms / 60_000));

/**
 * May this host mint one more invite? `mints` = when each earlier invite was minted (any order).
 * @param {import('./inviteCore.js').InviteRecord[]} records @param {number[]} mints @param {number} [now]
 * @returns {{ ok: true } | { ok: false, reason: 'live' | 'rate', message: string, retryInMs?: number }}
 */
export function mintVerdict(records, mints, now = Date.now()) {
	const L = INVITE_LIMITS;
	if (liveInvites(records, now) >= L.liveMax)
		return {
			ok: false,
			reason: 'live',
			message: 'You already have ' + L.liveMax + ' invite links that still work. Revoke one in Users ▸ Invites before making another.'
		};
	const recent = (mints ?? []).filter((t) => Number.isFinite(t) && now - t < L.mintWindowMs && t <= now).sort((a, b) => a - b);
	if (recent.length >= L.mintMax) {
		const retryInMs = recent[recent.length - L.mintMax] + L.mintWindowMs - now;
		return {
			ok: false,
			reason: 'rate',
			message: 'You made ' + L.mintMax + ' invite links in the last ' + minutes(L.mintWindowMs) + ' minutes. Try again in ' + minutes(retryInMs) + (minutes(retryInMs) === 1 ? ' minute.' : ' minutes.'),
			retryInMs
		};
	}
	return { ok: true };
}

/** the mint log kept for `mintVerdict`: only what the window can still see @param {number[]} mints @param {number} [now] */
export const pruneMints = (mints, now = Date.now()) => (Array.isArray(mints) ? mints : []).filter((t) => Number.isFinite(t) && now - t < INVITE_LIMITS.mintWindowMs && t <= now);

/**
 * @typedef {{ peerId: string, reason: string, kind?: string, at: number }} FailedDial
 * @typedef {{ count: number, rows: FailedDial[], pausedUntil: number, since: number }} FailedSummary
 */

/**
 * The host's join gate for one session: failed proofs, the pause, and re-join pacing.
 * State in a closure, the clock passed in, so the unit layer drives it with no timers.
 */
export function createJoinGate() {
	const L = INVITE_LIMITS;
	/** failure moments inside the window @type {number[]} */
	let fails = [];
	/** what the collapsed row shows @type {FailedSummary} */
	let summary = { count: 0, rows: [], pausedUntil: 0, since: 0 };
	/** re-join buckets, `<inviteId>:<peerId>` -> {tokens, at} @type {Map<string, {tokens: number, at: number}>} */
	const buckets = new Map();

	/** @param {number} now */
	const paused = (now) => now < summary.pausedUntil;

	return {
		/** is an invite dial arriving now refused for the pause? @param {number} [now] */
		paused: (now = Date.now()) => paused(now),
		/** ms left of the pause (0 = none) @param {number} [now] */
		pauseLeft: (now = Date.now()) => Math.max(0, summary.pausedUntil - now),

		/**
		 * One invite dial that did not check out. `justPaused` is true exactly once per pause:
		 * the dial that tipped it (the host's one toast).
		 * @param {string} peerId @param {string} reason @param {{ kind?: string }} [who] @param {number} [now]
		 * @returns {{ justPaused: boolean, paused: boolean, inWindow: number }}
		 */
		fail(peerId, reason, who = {}, now = Date.now()) {
			const wasPaused = paused(now);
			// a dial during a pause was already answered by the pause: it shows in the row but does not count
			// toward the NEXT window (measured: counting it re-armed the pause the moment it ended, on the first
			// two ordinary failures after it)
			if (!wasPaused) {
				fails = fails.filter((t) => now - t < L.failWindowMs);
				fails.push(now);
			}
			const id = String(peerId || '').toLowerCase();
			// one row per peer: a re-dial refreshes its row instead of taking another slot
			const rows = summary.rows.filter((r) => r.peerId !== id);
			rows.push({ peerId: id, reason: String(reason || 'unknown'), at: now, ...(who.kind === 'agent' ? { kind: 'agent' } : {}) });
			while (rows.length > L.failedKeep) rows.shift();
			const tip = !wasPaused && fails.length > L.failMax;
			const inWindow = fails.length;
			if (tip) fails = []; // a pause starts a fresh window
			summary = {
				count: summary.count + 1,
				rows,
				since: summary.since || now,
				pausedUntil: tip ? now + L.pauseMs : summary.pausedUntil
			};
			return { justPaused: tip, paused: tip || wasPaused, inWindow };
		},

		/**
		 * A VALID invite brought `peerId` back again (`checkInvite` said `again`). The first
		 * `rejoinBurst` are free; after that one per `rejoinGapMs`.
		 * @param {string} inviteId @param {string} peerId @param {number} [now]
		 * @returns {{ ok: true } | { ok: false, retryInMs: number }}
		 */
		rejoin(inviteId, peerId, now = Date.now()) {
			const key = String(inviteId) + ':' + String(peerId || '').toLowerCase();
			const b = buckets.get(key) ?? { tokens: L.rejoinBurst, at: now };
			const tokens = Math.min(L.rejoinBurst, b.tokens + Math.max(0, now - b.at) / L.rejoinGapMs);
			if (tokens < 1) {
				buckets.set(key, { tokens, at: now });
				return { ok: false, retryInMs: Math.ceil((1 - tokens) * L.rejoinGapMs) };
			}
			buckets.set(key, { tokens: tokens - 1, at: now });
			if (buckets.size > 256) buckets.delete(buckets.keys().next().value ?? '');
			return { ok: true };
		},

		/** @returns {FailedSummary} a copy for the store */
		summary: () => ({ ...summary, rows: summary.rows.map((r) => ({ ...r })) }),
		/** the host approved or dismissed one row @param {string} peerId */
		forget(peerId) {
			const id = String(peerId || '').toLowerCase();
			summary = { ...summary, rows: summary.rows.filter((r) => r.peerId !== id) };
		},
		/** Dismiss: the row goes; a running pause stays (it is a protection, not a notice) */
		dismiss() {
			summary = { count: 0, rows: [], pausedUntil: summary.pausedUntil, since: 0 };
		},
		/** the host's "Resume now" */
		resume() {
			fails = [];
			summary = { ...summary, pausedUntil: 0 };
		},
		/** leaving the session */
		reset() {
			fails = [];
			summary = { count: 0, rows: [], pausedUntil: 0, since: 0 };
			buckets.clear();
		}
	};
}

/** the collapsed row's line @param {number} n */
export const failedRowText = (n) => (n === 1 ? '1 failed invite join' : n + ' failed invite joins');

/** the host's one toast when a pause starts @param {number} n failures in the window */
export const pauseToastText = (n) =>
	'Invite joins are paused for ' + Math.round(INVITE_LIMITS.pauseMs / 1000) + ' s: ' + n + ' invite joins failed in the last minute. Approval cards still work.';

/**
 * What the JOINER shows for a refusal that carries `why` (additive dial metadata; an older
 * build reads the plain `denied`). Null = not one of ours, use the ordinary line.
 * @param {any} why @param {string} host the host's short id
 */
export function joinWhyText(why, host) {
	if (why === 'invite-paused') return host + ' has paused invite joins for a minute after too many failed tries. Try again shortly.';
	if (why === 'invite-slow') return 'You rejoined ' + host + "'s session several times in a row. Wait half a minute, then try again.";
	return null;
}
