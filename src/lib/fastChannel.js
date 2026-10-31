// 60 Q2 — THE FAST MOVEMENT CHANNEL.
//
// Every message used to ride ONE PeerJS DataConnection per peer, which is ordered and reliable.
// That is what an edit needs and the opposite of what a pose stream needs: on a lossy link one
// lost packet holds back EVERYTHING behind it until SCTP retransmits it (head-of-line blocking),
// so an avatar that is sent 20 times a second freezes for a retransmit timeout and then jumps
// through a burst of poses that were all stale by the time they arrived.
//
// So each pair of peers opens a SECOND channel on the RTCPeerConnection they already share,
// `{ordered: false, maxRetransmits: 0}`: a lost pose is simply gone, and the next one (50 ms
// later) replaces it. Only latest-wins pose messages go there — avatars (`camera`), VR hands
// (`vrhands`) and the STREAMED `move`s of a drag, a held object or a physics body. Everything
// else — every edit, every committed move, every request — stays on the reliable channel.
//
// FOUR RULES:
//  * A NEGOTIATED channel (`negotiated: true, id: FAST_CHANNEL_ID`) on the PeerJS connection's
//    own RTCPeerConnection: no extra signaling, no second ICE run, no renegotiation (an SCTP
//    association that exists takes more streams without one). Both sides must create it, so it
//    is created only after the OTHER side said it can (`fc: 1` in the `modules` handshake, then
//    a `fastchan` hello down the same conn so both ends pick the same RTCPeerConnection).
//  * GRACEFUL FALLBACK: a peer that never said `fc: 1` (an older build), a channel that is not
//    open yet, a message too big for one unreliable datagram — all go down the reliable conn
//    exactly as before. The wire to an older peer is byte-identical except one additive field.
//  * SEQUENCE NUMBERS: every pose message carries `ps`, one monotonic counter per sender. A
//    receiver keeps the newest `ps` per (sender, key) and drops anything older — so an
//    unordered datagram never moves an avatar backwards, and a late streamed `move` never
//    overwrites the committed (reliable, newer) one that ended the drag.
//  * A TRAILING KEYFRAME: the LAST pose of a stream may be the one that is lost, and nothing
//    would ever correct it (a camera that stopped moving stops sending). So when a key goes
//    quiet after a fast send, its last payload is re-sent once on the reliable channel with
//    the SAME `ps` — dropped as a duplicate where the datagram arrived, applied where it didn't.
//
// Kill switch: `safeStorage.fastChannel = 'off'` (the e2e's "before" and "older build").
import { safeStorage } from './safeStorage';

/** the SCTP stream id both ends give the negotiated channel (PeerJS's own channel is 0 or 1) */
export const FAST_CHANNEL_ID = 7;
export const FAST_CHANNEL_LABEL = 'tp-fast';
/** above this a message goes reliable: one unreliable message should fit a few datagrams, and a
 * lost fragment loses the whole message */
export const FAST_MAX_BYTES = 12000;
/** past this many queued bytes a pose is SKIPPED, not queued: behind a backlog it would only arrive
 * stale, and the next pose (or the trailing keyframe) replaces it anyway */
export const FAST_MAX_BUFFERED = 256 * 1024;
/** how long a key must be quiet before its trailing keyframe goes out */
export const KEYFRAME_MS = 250;

/** The pose types and how each is keyed: a camera/hands stream per sender, a move per object. */
export const POSE_TYPES = new Set(['camera', 'vrhands', 'move']);

/** @param {any} payload @returns {string | null} */
export function poseKey(payload) {
	const type = payload?.type;
	if (type === 'camera' || type === 'vrhands') return type;
	if (type === 'move' && typeof payload.uuid === 'string') return 'move:' + payload.uuid;
	return null;
}

/** Is the channel allowed on this device? @returns {boolean} */
export function fastChannelEnabled() {
	try {
		return safeStorage.getItem('fastChannel') !== 'off';
	} catch {
		return true;
	}
}

// Seeded from the clock (x100) so a RELOADED sender (same peer id, fresh counter) still starts
// above everything its previous page sent — up to 100k pose messages a second before it could
// outrun the clock. Receivers also forget a peer on disconnect.
let seq = Date.now() * 100;
/** @returns {number} */
export function nextPoseSeq() {
	return ++seq;
}

/**
 * Give a pose payload its `ps` (once — a keyframe re-send keeps the original). Non-pose
 * payloads come back untouched. Returns the SAME object, stamped.
 * @param {any} payload @returns {any}
 */
export function stampPose(payload) {
	if (
		payload &&
		typeof payload === 'object' &&
		POSE_TYPES.has(payload.type) &&
		!Number.isFinite(payload.ps)
	)
		payload.ps = nextPoseSeq();
	return payload;
}

/** @type {((peerId: string, payload: any, via: 'fast' | 'reliable') => void) | null} */
let poseTap = null;
/**
 * A MEASUREMENT seam (the loss e2e): `fn` sees every pose that passed the stale filter, i.e.
 * every pose the app applies, with the channel it came on. Null (the default) costs one check.
 * @param {((peerId: string, payload: any, via: 'fast' | 'reliable') => void) | null} fn
 */
export function setPoseTap(fn) {
	poseTap = typeof fn === 'function' ? fn : null;
}
/** @param {string} peerId @param {any} payload @param {'fast' | 'reliable'} via */
export function tapPose(peerId, payload, via) {
	if (poseTap && poseKey(payload) !== null) poseTap(peerId, payload, via);
}

/**
 * The receive-side stale filter. `accept` answers false for a pose older than (or equal to)
 * the newest already applied from that sender for that key. A payload with no `ps` (an older
 * build) is always accepted — and records nothing.
 */
export function createStaleFilter() {
	/** `${peer}|${key}` -> newest ps @type {Map<string, number>} */
	const newest = new Map();
	const stats = { accepted: 0, stale: 0 };
	return {
		stats,
		/** @param {string} peerId @param {any} payload @returns {boolean} */
		accept(peerId, payload) {
			const ps = payload?.ps;
			if (!Number.isFinite(ps)) return true;
			const key = poseKey(payload);
			if (!key) return true;
			const id = peerId + '|' + key;
			const last = newest.get(id);
			if (last !== undefined && ps <= last) {
				stats.stale++;
				return false;
			}
			newest.set(id, ps);
			stats.accepted++;
			return true;
		},
		/** @param {string} peerId */
		dropPeer(peerId) {
			const prefix = peerId + '|';
			for (const id of [...newest.keys()]) if (id.startsWith(prefix)) newest.delete(id);
		},
		clear() {
			newest.clear();
		},
		size: () => newest.size
	};
}

/**
 * The trailing keyframes. `noteFast` (re)arms a key's timer with its newest payload and the
 * peers that got it unreliably; `noteReliable` disarms it (a reliable send of the same key
 * supersedes it). When a timer fires, `resend(payload, peerIds)` sends it on the reliable path.
 * @param {(payload: any, peerIds: string[]) => void} resend
 * @param {{delay?: number, setTimer?: (fn: () => void, ms: number) => any, clearTimer?: (t: any) => void}} [opts]
 */
export function createKeyframer(resend, opts = {}) {
	const delay = opts.delay ?? KEYFRAME_MS;
	const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
	const clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t));
	/** key -> {timer, payload, peers} @type {Map<string, {timer: any, payload: any, peers: Set<string>}>} */
	const pending = new Map();
	const stats = { armed: 0, sent: 0 };
	return {
		stats,
		/** @param {string} key @param {any} payload @param {Iterable<string>} peerIds */
		noteFast(key, payload, peerIds) {
			const held = pending.get(key);
			if (held) clearTimer(held.timer);
			const peers = new Set(peerIds);
			const entry = { payload, peers, timer: null };
			entry.timer = setTimer(() => {
				if (pending.get(key) !== entry) return;
				pending.delete(key);
				stats.sent++;
				resend(entry.payload, [...entry.peers]);
			}, delay);
			pending.set(key, entry);
			stats.armed++;
		},
		/** @param {string} key */
		noteReliable(key) {
			const held = pending.get(key);
			if (!held) return;
			clearTimer(held.timer);
			pending.delete(key);
		},
		/** a peer left: it needs no keyframes @param {string} peerId */
		dropPeer(peerId) {
			for (const entry of pending.values()) entry.peers.delete(peerId);
		},
		clear() {
			for (const entry of pending.values()) clearTimer(entry.timer);
			pending.clear();
		},
		size: () => pending.size
	};
}

/**
 * The channels themselves, one per peer. `open(peerId, conn, onMessage)` creates the negotiated
 * channel on `conn.peerConnection` (idempotent per RTCPeerConnection; a newer conn replaces an
 * older one's channel). `trySend` answers false whenever the reliable path must carry it.
 */
export function createFastLinks() {
	/** peerId -> {dc, pc} @type {Map<string, {dc: any, pc: any}>} */
	const links = new Map();
	const stats = { opened: 0, sent: 0, received: 0, tooBig: 0, congested: 0, sendErrors: 0, parseErrors: 0 };
	/** @param {string} peerId */
	function close(peerId) {
		const link = links.get(peerId);
		if (!link) return;
		links.delete(peerId);
		try {
			link.dc.close();
		} catch {}
	}
	return {
		stats,
		/**
		 * @param {string} peerId @param {any} conn a PeerJS DataConnection
		 * @param {(data: any, via: 'fast') => void} onMessage @returns {boolean} true when a channel exists now
		 */
		open(peerId, conn, onMessage) {
			const pc = conn?.peerConnection;
			if (!pc || typeof pc.createDataChannel !== 'function') return false;
			const held = links.get(peerId);
			if (held && held.pc === pc && held.dc.readyState !== 'closed') return true;
			if (held) close(peerId);
			let dc;
			try {
				dc = pc.createDataChannel(FAST_CHANNEL_LABEL, {
					ordered: false,
					maxRetransmits: 0,
					negotiated: true,
					id: FAST_CHANNEL_ID
				});
			} catch {
				return false;
			}
			const link = { dc, pc };
			links.set(peerId, link);
			dc.onopen = () => {
				stats.opened++;
			};
			dc.onclose = () => {
				if (links.get(peerId) === link) links.delete(peerId);
			};
			dc.onmessage = (/** @type {MessageEvent} */ e) => {
				if (typeof e.data !== 'string') return;
				let data;
				try {
					data = JSON.parse(e.data);
				} catch {
					stats.parseErrors++;
					return;
				}
				stats.received++;
				onMessage(data, 'fast');
			};
			return true;
		},
		/** @param {string} peerId @returns {boolean} */
		isOpen(peerId) {
			return links.get(peerId)?.dc.readyState === 'open';
		},
		/** @param {string} peerId @param {string} text an already-serialized payload @returns {boolean} */
		trySend(peerId, text) {
			const link = links.get(peerId);
			if (!link || link.dc.readyState !== 'open') return false;
			if (text.length > FAST_MAX_BYTES) {
				stats.tooBig++;
				return false;
			}
			// a backlog: skip this pose (it counts as sent unreliably — a datagram lost early)
			if (link.dc.bufferedAmount > FAST_MAX_BUFFERED) {
				stats.congested++;
				return true;
			}
			try {
				link.dc.send(text);
				stats.sent++;
				return true;
			} catch {
				stats.sendErrors++;
				return false;
			}
		},
		close,
		closeAll() {
			for (const peerId of [...links.keys()]) close(peerId);
		},
		peers: () => [...links.keys()]
	};
}
