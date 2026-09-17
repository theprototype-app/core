import { writable, get } from 'svelte/store';

/**
 * 25-E — ONE CLOCK FOR THE SESSION (audit M8).
 *
 * Every stamp that crosses the wire was a `Date.now()` on SOME peer's machine, and every
 * receiver compared it against its OWN `Date.now()`. Two machines rarely agree: a phone
 * drifts by seconds, a locked-down laptop by minutes. So a peer whose clock ran 90 s fast
 * won every latest-wins merge for the next 90 s (its sky, its gravity, its game state
 * could not be overwritten by anybody else's LATER edit), its flow pulses arrived "from
 * the future", and every deterministic animation ran 90 s out of phase with the room.
 *
 * `sessionNow()` is the answer: the wall clock of the peer whose session we JOINED
 * (`sessionHost`), estimated NTP-style over the data channel, and our own `Date.now()`
 * while we host. It is transitive — a joiner that approves somebody else hands on the
 * clock it adopted, because a pong carries the responder's own session offset — so the
 * whole mesh keeps ONE time however it was formed. Local-only timing (a debounce, a
 * toast's life, a retry backoff) stays on `Date.now()`: only a number another machine
 * will compare needs to be on the session's clock.
 *
 * A LEAF on purpose (svelte/store only): flowRuntime, environment, gameState and a dozen
 * other stamp sites import it, several of them inside the history-cycle family, and
 * `connectionState` re-exports it so peer code reaches it where it already looks. The
 * WIRE half — the ping/pong round trip, the connect burst, the skew toast — is
 * `clockSync.js`, which needs `peers` and may therefore not be imported from here.
 *
 * The estimator itself moved here from `musicClock` (23-A2 measured it: noise floor
 * under 5 ms at true skew 0, convergence within 10 ms on an injected +300 ms). It was
 * built and then deliberately applied to NOTHING; this module is what applies it.
 */

// ---- the estimator (moved from musicClock, 23-A2) -----------------------------------
//
// NTP's four-stamp round trip, over the data channel the peers already share:
//   t0  we send `clockping`            (our clock)
//   t1  they receive it                (their clock)
//   t2  they send `clockpong`          (their clock)
//   t3  we receive it                  (our clock)
//   rtt    = (t3 - t0) - (t2 - t1)
//   offset = ((t1 - t0) + (t2 - t3)) / 2       their clock minus ours
// The error of one sample is bounded by the round trip's ASYMMETRY, at most rtt/2.

/** samples kept per peer */
export const CLOCK_RING = 12;

/** @type {Record<string, {offsets: number[], rtts: number[]}>} */
export const clockSamples = {};

/** peerId -> `{offset, rtt, samples}` — offset is THEIR RAW clock minus OURS, in ms.
 * Local, derived, never replicated (the `peerQuality` precedent).
 * @type {import('svelte/store').Writable<Record<string, {offset: number, rtt: number, samples: number}>>} */
export const peerClocks = writable({});

/** @param {number[]} arr */
function median(arr) {
	const s = [...arr].sort((a, b) => a - b);
	const m = Math.floor(s.length / 2);
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * The estimate from a ring of samples: the MEDIAN OFFSET OF THE LOWEST-RTT HALF.
 *
 * A sample's error is its round trip's asymmetry, and asymmetry comes from queueing —
 * a packet that waited (in the network, or on a busy main thread before the handler
 * ran) is late on ONE leg. The samples with the shortest round trips waited the least,
 * so NTP's clock filter keeps the minimum-delay sample; taking the median of the best
 * half keeps that bias-rejection while still outvoting a single odd reading. Pure.
 * @param {{offsets: number[], rtts: number[]}} ring
 */
export function estimateFromSamples(ring) {
	const n = ring.offsets.length;
	if (!n) return null;
	const order = ring.rtts.map((rtt, i) => i).sort((a, b) => ring.rtts[a] - ring.rtts[b]);
	const best = order.slice(0, Math.max(1, Math.ceil(n / 2)));
	return {
		offset: median(best.map((i) => ring.offsets[i])),
		rtt: median(best.map((i) => ring.rtts[i])),
		samples: n
	};
}

/**
 * Fold one measurement into a peer's ring and republish the median — and, when that
 * peer is the one we keep time by, re-decide the session offset. Pure enough to test
 * without a connection. @param {string} peerId @param {number} offset @param {number} rtt
 */
export function recordClockSample(peerId, offset, rtt) {
	if (!Number.isFinite(offset) || !Number.isFinite(rtt) || rtt < 0) return;
	const ring = (clockSamples[peerId] ??= { offsets: [], rtts: [] });
	ring.offsets.push(offset);
	ring.rtts.push(rtt);
	while (ring.offsets.length > CLOCK_RING) {
		ring.offsets.shift();
		ring.rtts.shift();
	}
	const estimate = estimateFromSamples(ring);
	if (estimate) peerClocks.update((map) => ({ ...map, [peerId]: estimate }));
	if (peerId === reference) reconsider();
}

/** The estimated RAW offset of a peer's clock from ours (ms, theirs minus ours), or
 * null before the first sample lands. @param {string} peerId */
export function peerClockOffset(peerId) {
	return get(peerClocks)[peerId]?.offset ?? null;
}

/**
 * A stamp taken on `peerId`'s RAW clock, expressed on OURS. Kept for the colocated
 * music case (musicClock's header); session stamps need no correction at all, which is
 * the point of `sessionNow`. Unknown peer = unchanged.
 * @param {string} peerId @param {number} wallMs
 */
export function correctRemoteStamp(peerId, wallMs) {
	const offset = peerClockOffset(peerId);
	return offset == null ? wallMs : wallMs - offset;
}

/**
 * Drop a peer's samples (handleDisconnected — golden rule 3). The SESSION OFFSET is kept
 * even when the departing peer was our reference: everybody still here keeps time by the
 * same clock, and snapping back to our own would put every stamp we write from now on
 * out of step with theirs. Only leaving the session resets it.
 * @param {string} peerId
 */
export function dropPeerClock(peerId) {
	delete clockSamples[peerId];
	delete remoteSession[peerId];
	peerClocks.update((map) => {
		if (!(peerId in map)) return map;
		const next = { ...map };
		delete next[peerId];
		return next;
	});
}

// ---- the session clock ---------------------------------------------------------------

/** Below this, a better estimate is noise and the clock is left alone: every adoption
 * is a small JUMP in every stamp and every flow `time`, and the estimator's own noise
 * floor on a real network is several milliseconds. */
export const ADOPT_THRESHOLD_MS = 50;
/** A gross skew is corrected on the FIRST sample (storm samples carry ~100 ms of error,
 * which is nothing against 90 s); a small one waits for the filter to have something to
 * filter. */
export const GROSS_SKEW_MS = 1000;
export const MIN_SAMPLES = 3;

/** ms to add to our `Date.now()` to read the session's clock */
let offset = 0;
/** the peer we keep time by — `sessionHost`, null while we host */
/** @type {string | null} */
let reference = null;
/** what each peer's pong said about ITS session clock: `{so, ref}` — `so` is the offset
 * it adds to its own Date.now, `ref` whose clock that is (the loop guard)
 * @type {Record<string, {so: number, ref: string | null}>} */
const remoteSession = {};
/** our own peer id, for the loop guard — handed in by the wire half */
/** @type {string | null} */
let myId = null;

/**
 * What the session clock is doing, for the Statistics/diagnostics surfaces and suites.
 * @type {import('svelte/store').Writable<{offset: number, reference: string|null, adoptedAt: number, adoptions: number}>}
 */
export const sessionClock = writable({ offset: 0, reference: null, adoptedAt: 0, adoptions: 0 });

/**
 * THE session time, in epoch milliseconds. Use it for every stamp another peer will
 * compare (a latest-wins `changedAt`, a trigger pulse, a game's `startedAt`) and for every
 * clock two peers must agree on (the synced flow `time`, the musical transport).
 * @returns {number}
 */
export function sessionNow() {
	return Date.now() + offset;
}

/** The current session offset in ms (session minus our raw clock). */
export function sessionOffset() {
	return offset;
}

/** @param {string | null} id */
export function setClockSelf(id) {
	myId = id || null;
}

/**
 * Keep time by `peerId` (the session host), or by ourselves with null. A NEW reference
 * with no estimate yet leaves the current offset in place until its first sample lands;
 * null does NOT reset the offset (see `dropPeerClock`) — `resetSessionClock` does.
 * @param {string | null} peerId
 */
export function setClockReference(peerId) {
	const next = peerId || null;
	if (next === reference) return;
	reference = next;
	publish();
	reconsider();
}

/**
 * A pong told us about the responder's own session clock. Folded in only when that peer
 * is our reference. @param {string} peerId @param {any} so @param {any} ref
 */
export function noteRemoteSessionClock(peerId, so, ref) {
	if (typeof so !== 'number' || !Number.isFinite(so)) return; // an older peer: raw clock
	remoteSession[peerId] = { so, ref: typeof ref === 'string' && ref ? ref : null };
	if (peerId === reference) reconsider();
}

/**
 * The offset the session clock SHOULD have right now, or null when there is no
 * trustworthy answer yet. Pure over the module's state; exported for the suites.
 * @returns {number | null}
 */
export function targetOffset() {
	if (!reference) return null;
	const est = get(peerClocks)[reference];
	if (!est) return null;
	const remote = remoteSession[reference];
	// THE LOOP GUARD: a reference that keeps time by US would hand our own clock back
	// with its estimation error added, and two peers doing that to each other random-walk
	// forever. Its RAW clock is still a better answer than nothing, so use that alone.
	const so = remote && remote.ref !== myId ? remote.so : 0;
	const target = est.offset + so;
	if (est.samples < MIN_SAMPLES && Math.abs(target - offset) < GROSS_SKEW_MS) return null;
	return target;
}

/** @type {Set<(deltaMs: number) => void>} */
const jumpListeners = new Set();

/**
 * Be told when the session clock JUMPS, with the jump in ms (new minus old).
 *
 * Anything that recorded a session time as a LOCAL cutoff needs this. The case that forced
 * it: a joiner's handshake lands the trigger log and the graph BEFORE the first pong, so
 * flowRuntime records its history epoch and every action node's first-seen time on the
 * joiner's OWN clock — and when that clock is then corrected by -90 s, every live pulse
 * reads as 90 s older than the node that would act on it and is refused for a minute and
 * a half. Shifting the cutoffs by the jump keeps them meaning what they meant.
 * @param {(deltaMs: number) => void} fn @returns {() => void}
 */
export function onSessionClockJump(fn) {
	jumpListeners.add(fn);
	return () => jumpListeners.delete(fn);
}

/** @param {number} next */
function jumpTo(next) {
	const delta = next - offset;
	offset = next;
	const s = get(sessionClock);
	sessionClock.set({ offset, reference, adoptedAt: Date.now(), adoptions: s.adoptions + 1 });
	for (const fn of jumpListeners) {
		try {
			fn(delta);
		} catch (error) {
			console.warn('[sessionClock] a jump listener threw', error);
		}
	}
}

function reconsider() {
	const target = targetOffset();
	if (target == null) return;
	if (Math.abs(target - offset) < ADOPT_THRESHOLD_MS) return;
	jumpTo(Math.round(target));
}

function publish() {
	const s = get(sessionClock);
	if (s.reference === reference && s.offset === offset) return;
	sessionClock.set({ ...s, offset, reference });
}

/** Leaving the session: our own clock is the only one left. Samples are per-peer and
 * are dropped by their own teardown, so this only resets the session half. */
export function resetSessionClock() {
	reference = null;
	for (const k of Object.keys(remoteSession)) delete remoteSession[k];
	if (offset !== 0) jumpTo(0);
	sessionClock.set({ ...get(sessionClock), offset: 0, reference: null, adoptedAt: 0 });
}

/** Everything a suite wants in one read. */
export function sessionClockDebug() {
	return {
		now: sessionNow(),
		offset,
		reference,
		myId,
		target: targetOffset(),
		remote: JSON.parse(JSON.stringify(remoteSession)),
		peers: JSON.parse(JSON.stringify(get(peerClocks))),
		samples: JSON.parse(JSON.stringify(clockSamples)),
		state: get(sessionClock)
	};
}
