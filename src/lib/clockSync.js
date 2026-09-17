import { get } from 'svelte/store';
import { peers, showToast } from '../stores/appStore';
import { sessionHost } from './connectionState';
import {
	recordClockSample,
	noteRemoteSessionClock,
	setClockReference,
	setClockSelf,
	sessionOffset,
	peerClocks,
	MIN_SAMPLES
} from './sessionClock';

/**
 * 25-E — THE WIRE HALF OF THE SESSION CLOCK (the round trip moved here from musicClock,
 * where 23-A2 built it; `sessionClock.js` is the leaf that turns its answers into
 * `sessionNow()`).
 *
 * Additive on the wire, both ways: a pong gains `so` (the responder's own session offset)
 * and `ref` (whose clock that is). An OLDER peer answers without them, which reads as "my
 * raw clock", exactly what it is keeping — and an older peer receiving the extra fields
 * ignores them. `clockping`/`clockpong` sit on cloudHooks' ALWAYS_ALLOWED floor: a plugin
 * gating them would silently put a viewer's every stamp out of step with the room.
 */

/** how many pings the connect burst sends, how far apart, and how long after the
 * handshake it starts. MEASURED (23-A2): samples taken during the connect storm (the
 * joiner is receiving objects, compiling shaders, first-painting) carried 100+ ms of
 * one-sided main-thread delay and pulled a 6-sample median to +427 ms on a true +300 —
 * so the burst waits for the storm to pass, and the filter discounts what it catches. */
const BURST = 6;
const BURST_GAP_MS = 250;
const BURST_DELAY_MS = 2000;
/** steady-state re-measure, so a drifting clock is tracked and storm samples age out */
const RESYNC_MS = 5000;
/** 25-E: a peer this far off our RAW clock gets one toast — the session corrects for it,
 * but a device whose date and time are wrong is wrong for every other app too */
export const SKEW_TOAST_MS = 2000;

/** @param {string} peerId @returns {any} the stable OUTGOING conn, or null */
function connFor(peerId) {
	/** @type {any} */
	const peer = get(peers);
	const conn = peer?.connections?.[peerId];
	return conn && conn.open ? conn : null;
}

/** One ping. Returns false when there is no open conn to send it on. @param {string} peerId */
export function sendClockPing(peerId) {
	const conn = connFor(peerId);
	if (!conn) return false;
	/** @type {any} */
	const peer = get(peers);
	setClockSelf(peer?.peer?.id ?? null);
	conn.send({ type: 'clockping', sender: peer.peer.id, t0: Date.now() });
	return true;
}

/**
 * Answer a ping. Stamped on receipt (t1) and again on send (t2) so the responder's
 * own processing time is subtracted out of the round trip. The four stamps stay on the
 * RAW clock — the estimate is of the machines — and `so`/`ref` say what we do with ours.
 * Replies over our stable OUTGOING conn to the sender (golden rule 9), falling back to
 * the conn it arrived on while the dance is still settling.
 * @param {any} data @param {any} [arrivedOn]
 */
export function answerClockPing(data, arrivedOn) {
	const t1 = Date.now();
	if (!data || typeof data.t0 !== 'number') return;
	/** @type {any} */
	const peer = get(peers);
	const conn = connFor(data.sender) ?? (arrivedOn && arrivedOn.open ? arrivedOn : null);
	if (!conn) return;
	conn.send({
		type: 'clockpong',
		sender: peer?.peer?.id ?? '',
		t0: data.t0,
		t1,
		t2: Date.now(),
		so: sessionOffset(),
		ref: get(sessionHost) ?? null
	});
}

/** Fold a pong into the sender's estimate. @param {any} data */
export function applyClockPong(data) {
	const t3 = Date.now();
	if (!data || typeof data.t0 !== 'number' || typeof data.t1 !== 'number' || typeof data.t2 !== 'number') return;
	if (!data.sender) return;
	const sender = String(data.sender);
	const rtt = t3 - data.t0 - (data.t2 - data.t1);
	const offset = (data.t1 - data.t0 + (data.t2 - t3)) / 2;
	// the remote clock first, so the sample that follows decides with both halves known
	noteRemoteSessionClock(sender, data.so, data.ref);
	recordClockSample(sender, offset, rtt);
	maybeWarnSkew(sender);
}

/** @type {Set<string>} peers we have already told the user about, for this tab */
const warnedSkew = new Set();

/** @param {number} ms */
function describe(ms) {
	const s = Math.round(Math.abs(ms) / 1000);
	if (s < 120) return s + ' s';
	const m = Math.round(s / 60);
	return m < 120 ? m + ' min' : Math.round(m / 60) + ' h';
}

/**
 * One toast per peer, once the estimate has something behind it. Says which way and by
 * how much, and that the session already copes — the useful act is fixing the device.
 * @param {string} peerId
 */
function maybeWarnSkew(peerId) {
	if (warnedSkew.has(peerId)) return;
	const est = get(peerClocks)[peerId];
	if (!est || est.samples < MIN_SAMPLES || Math.abs(est.offset) <= SKEW_TOAST_MS) return;
	warnedSkew.add(peerId);
	const label = String(peerId).slice(0, 6).toUpperCase();
	showToast(
		label +
			"'s clock is " +
			describe(est.offset) +
			(est.offset > 0 ? ' ahead of' : ' behind') +
			' this device. Shared timings follow the session clock, but check the date and time settings on whichever device is wrong.'
	);
}

/** @type {any} */
let resyncTimer = null;

/**
 * Start measuring a peer: one ping at once (a gross skew is corrected on its first
 * sample, before the joiner writes much), a short burst once the connect storm has
 * passed (the median needs several samples before it means anything), then a steady
 * re-measure every RESYNC_MS for as long as the conn is open. Called from
 * `sendHandshake`, the one place a conn is known to be OPEN (golden rule 2).
 * @param {string} peerId
 */
export function startClockSync(peerId) {
	if (typeof setTimeout === 'undefined') return;
	sendClockPing(peerId);
	for (let i = 0; i < BURST; i++) setTimeout(() => sendClockPing(peerId), BURST_DELAY_MS + i * BURST_GAP_MS);
	if (resyncTimer == null) {
		resyncTimer = setInterval(() => {
			/** @type {any} */
			const peer = get(peers);
			for (const id of Object.keys(peer?.connections ?? {})) sendClockPing(id);
		}, RESYNC_MS);
	}
}

/** The peer whose session we joined is the peer we keep time by. Declared last: the
 * subscribe runs synchronously at module eval (the module-level-subscribe rule) and
 * every name it reaches is an import, so nothing here can be read before it exists. */
sessionHost.subscribe((host) => setClockReference(host));
