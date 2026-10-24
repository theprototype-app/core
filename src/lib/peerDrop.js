// F-3 (roadmap 55 "Fixes for 54", test flight T5): a peer that vanished without a goodbye
// (a killed process, a crashed tab) must leave Users within seconds, and a leave must never
// surface as a raw "Connection error". Imports NOTHING: the rules are numbers and a set, so
// they are unit-testable with no peer; peerHandler owns the timers and the conns.
//
// Three facts the fix rests on (peerjs 1.5.5, Chromium):
//  - a peer that dies without closing its SCTP association leaves our data channel "open":
//    ICE goes `disconnected` after a few silent seconds and may sit there for 30 s or more
//    before `failed` (or never), so the conn's 'close' never fires and the row is a ghost.
//  - a dial to an id the signaling server no longer holds answers EXPIRE -> a PEER-level
//    `peer-unavailable` error, and the conn it named stays un-open (peerjs does not close
//    it), so the reconnect loop waited out the 10 s dial grace per try, toasting each time.
//  - candidates/descriptions arriving for a connection we just closed fail as a PEER-level
//    `webrtc` error, which the catch-all turned into "Connection error: webrtc".

/** how long ICE may sit in `disconnected` before we treat the link as dropped. Chromium
 * recovers a lossy-but-alive link well inside this; a dropped one goes to the reconnect
 * window (the B5 path), so a live peer is redialled, never lost. */
export const ICE_DROP_GRACE_MS = 4000;

/** how often a live link's ICE stats are read, and how long its consent checks may go
 * unanswered before the link counts as dead. libwebrtc pings a writable pair every ≤ 2.5 s, so
 * 7 s is two to three missed answers; ICE's own `disconnected` took ~15 s to show here (two
 * Chromium peers, one renderer crashed) and `failed` 30 s+ or never. */
export const LINK_POLL_MS = 2000;
export const LINK_SILENT_MS = 7000;

/**
 * Read the selected candidate pair's consent counters out of an RTCStatsReport-like map.
 * @param {Iterable<any> | {forEach: Function} | null | undefined} report
 * @returns {{ requestsSent: number, responsesReceived: number } | null}
 */
export function consentCounters(report) {
	if (!report) return null;
	/** @type {any[]} */
	const rows = [];
	if (typeof (/** @type {any} */ (report).forEach) === 'function') /** @type {any} */ (report).forEach((/** @type {any} */ r) => rows.push(r));
	else for (const r of /** @type {Iterable<any>} */ (report)) rows.push(r);
	const transport = rows.find((r) => r?.type === 'transport' && r.selectedCandidatePairId);
	const pair =
		(transport && rows.find((r) => r?.id === transport.selectedCandidatePairId)) ||
		rows.find((r) => r?.type === 'candidate-pair' && (r.selected || (r.nominated && r.state === 'succeeded')));
	if (!pair || !Number.isFinite(pair.requestsSent) || !Number.isFinite(pair.responsesReceived)) return null;
	return { requestsSent: pair.requestsSent, responsesReceived: pair.responsesReceived };
}

/**
 * One poll of the silence watch. `state` carries the last answer count and when it last
 * moved; a link is SILENT when we kept asking (requestsSent moved) and nothing answered for
 * LINK_SILENT_MS. No counters (stats unsupported, no selected pair yet) = never silent.
 * @param {{ responses: number, requests: number, at: number } | null} state
 * @param {{ requestsSent: number, responsesReceived: number } | null} counters
 * @param {number} now
 * @returns {{ state: { responses: number, requests: number, at: number } | null, silent: boolean }}
 */
export function linkSilence(state, counters, now) {
	if (!counters) return { state, silent: false };
	if (!state || counters.responsesReceived !== state.responses) {
		return { state: { responses: counters.responsesReceived, requests: counters.requestsSent, at: now }, silent: false };
	}
	const asked = counters.requestsSent > state.requests;
	return { state, silent: asked && now - state.at >= LINK_SILENT_MS };
}

/** "this id is not on the signaling server" answers, while redialling a dropped peer,
 * before we stop waiting for them. The server answers a dial to an unknown id only when the
 * offer EXPIRES (~5 s, peerjs-server `expire_timeout`), so answers are slow: a channel that
 * CLOSED (a wifi hop, a lid) takes three — a signaling blip on their side heals inside that —
 * while a link we closed for SILENCE (ICE quiet past the grace: nothing has come from them
 * for 10 s already) takes one. Measured on two Chromium peers, one renderer crashed: the
 * three-answer rule could not land inside the 15.5 s reconnect window at all. */
export const UNAVAILABLE_STRIKES = 3;

/** @param {boolean} silent was the link closed for ICE silence? @returns {number} */
export function strikesNeeded(silent) {
	return silent ? 1 : UNAVAILABLE_STRIKES;
}

/** after a leave, a drop or a redial, peer-level noise for this long is a symptom of
 * that, never news. */
export const LEAVE_QUIET_MS = 20000;

const QUIET_TYPES = new Set(['webrtc', 'disconnected', 'negotiation-failed', 'connection-closed']);

/**
 * Should a peer-level error of `type` stay off the screen? Only the leave/drop symptoms,
 * and only while a leave or a redial is in flight (or just was).
 * @param {string} type peerjs error type
 * @param {{ lastLeaveAt: number, reconnecting: number, now: number }} ctx
 */
export function quietPeerError(type, { lastLeaveAt, reconnecting, now }) {
	if (!QUIET_TYPES.has(type)) return false;
	return reconnecting > 0 || now - lastLeaveAt < LEAVE_QUIET_MS;
}

/**
 * Pull the peer id out of a peerjs `peer-unavailable` message
 * ("Could not connect to peer abc12"). The id is the LAST word: the first-match regex this
 * replaces answered "Could" for every message, so the request it meant to end never ended.
 * @param {unknown} message
 */
export function unavailablePeerId(message) {
	return String(message ?? '').match(/peer\s+([0-9a-z][0-9a-z_-]{2,})\s*$/i)?.[1] ?? '';
}
