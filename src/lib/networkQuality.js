import { writable, get } from 'svelte/store';
import { peers, userdata } from '../stores/appStore';

// N3 (roadmap 7 / ship-qa D3): per-peer network-quality telemetry — a latency
// band + a "relayed" (TURN) flag. This is LOCAL, DERIVED state: it is deliberately
// NOT replicated (no $peers.send, no message type) — like themes/cameraClip prefs.
// A ~1.5s poll reads getStats() off each peer's RTCPeerConnection; a short median
// keeps the dot from flickering.

/** @type {import('svelte/store').Writable<Record<string, {rtt: number|null, relayed: boolean, level: string}>>} */
export const peerQuality = writable({});

/** @type {Record<string, number[]>} rolling RTT(ms) samples per peer */
const samples = {};
const RING = 5;
const POLL_MS = 1500;

/** Latency band for the dot. @param {number|null} ms @returns {'good'|'ok'|'bad'|'unknown'} */
export function classifyRtt(ms) {
	if (ms == null || !isFinite(ms)) return 'unknown';
	if (ms < 100) return 'good';
	if (ms < 250) return 'ok';
	return 'bad';
}

/** Band -> dot color (shared by Users popover + the Connect info drawer).
 * @param {string} level */
export function qColor(level) {
	return level === 'good' ? '#4ade80' : level === 'ok' ? '#fbbf24' : level === 'bad' ? '#f87171' : '#9ca3af';
}

/** @param {number[]} arr */
function median(arr) {
	if (!arr.length) return null;
	const s = [...arr].sort((a, b) => a - b);
	const m = Math.floor(s.length / 2);
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Fold one sample into a peer's rolling window and republish its band (testable
 * without a live connection). @param {string} peerId @param {{rtt: number|null, relayed: boolean}} sample
 */
export function updatePeerQuality(peerId, sample) {
	if (sample.rtt != null && isFinite(sample.rtt)) {
		const ring = (samples[peerId] ??= []);
		ring.push(sample.rtt);
		if (ring.length > RING) ring.shift();
	}
	const rtt = median(samples[peerId] ?? []);
	peerQuality.update((q) => ({
		...q,
		[peerId]: { rtt, relayed: !!sample.relayed, level: classifyRtt(rtt) }
	}));
}

/** Drop a peer's telemetry (called from handleDisconnected — golden rule #6). @param {string} peerId */
export function dropPeerQuality(peerId) {
	delete samples[peerId];
	peerQuality.update((q) => {
		if (!(peerId in q)) return q;
		const next = { ...q };
		delete next[peerId];
		return next;
	});
}

/** The RTCPeerConnection for a peer, from our outgoing conn or the incoming array. @param {string} peerId */
function pcFor(peerId) {
	/** @type {any} */
	const p = get(peers);
	const out = p?.connections?.[peerId];
	if (out?.peerConnection) return out.peerConnection;
	const arr = p?.peer?.connections?.[peerId];
	if (Array.isArray(arr)) return arr.find((/** @type {any} */ c) => c?.peerConnection)?.peerConnection ?? null;
	return null;
}

/**
 * Read RTT(ms) + relayed from an RTCPeerConnection's selected candidate pair.
 * @param {any} pc @returns {Promise<{rtt: number|null, relayed: boolean}>}
 */
export async function readPeerStats(pc) {
	if (!pc?.getStats) return { rtt: null, relayed: false };
	let stats;
	try {
		stats = await pc.getStats();
	} catch {
		return { rtt: null, relayed: false };
	}
	/** @type {any} */
	let pair = null;
	stats.forEach((/** @type {any} */ r) => {
		if (r.type === 'candidate-pair' && r.state === 'succeeded' && (r.nominated || r.selected)) {
			if (!pair || (r.currentRoundTripTime ?? Infinity) <= (pair.currentRoundTripTime ?? Infinity)) pair = r;
		}
	});
	if (!pair) return { rtt: null, relayed: false };
	const rtt = pair.currentRoundTripTime != null ? pair.currentRoundTripTime * 1000 : null;
	const local = pair.localCandidateId && stats.get ? stats.get(pair.localCandidateId) : null;
	const remote = pair.remoteCandidateId && stats.get ? stats.get(pair.remoteCandidateId) : null;
	const relayed = local?.candidateType === 'relay' || remote?.candidateType === 'relay';
	return { rtt, relayed };
}

/** One poll pass over the connected peers (excludes self). */
async function poll() {
	/** @type {any} */
	const p = get(peers);
	const selfId = p?.peer?.id;
	const ids = get(userdata)
		.map((/** @type {any} */ u) => u[0])
		.filter((/** @type {any} */ id) => id && id !== selfId);
	for (const id of ids) {
		const pc = pcFor(id);
		if (pc) updatePeerQuality(id, await readPeerStats(pc));
	}
}

/** @type {any} */
let timer = null;
/** Start the background poll (idempotent). Called once from App.svelte. */
export function startNetworkQuality() {
	if (timer != null || typeof setInterval === 'undefined') return;
	timer = setInterval(() => {
		poll().catch(() => {});
	}, POLL_MS);
}
