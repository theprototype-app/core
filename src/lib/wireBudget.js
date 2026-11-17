// 101 F4 — PER-PEER INBOUND LIMITS at the head of the receive pipeline.
//
// Each peer gets a budget of messages per second and bytes per second. A message that arrives
// while its sender is over budget is DROPPED and counted; the person is told once (throttled per
// peer), and the link stays up — a burst is never a disconnect. The limits sit at four times or
// more the highest rate measured on the heaviest suites (asset share, mesh edits, a 500-object
// batch, a grab stream, a late join into the biggest scene); the numbers and how they were
// measured are in the 101-proto STATUS / OPEN-CORE.md.
//
// `object` messages also have a SIZE cap (an approximate serialized size, walked with an early
// exit so a huge one costs no more than the cap to measure), at four times the largest `object`
// any scene in the scenes repo or the templates produces.
//
// A LEAF (no imports): pure factory + arithmetic, unit-tested without a peer.

/**
 * The limits, set from the peaks measured on the receiving page (101-proto STATUS, per peer per 1 s
 * window): the heaviest legit load reached 534 msgs/s (500 synchronous creates + a 60 Hz grab) and
 * ~1 MB/s (a 24 MB asset share, measured in headless at ~1 fps, so low against a fast LAN); the
 * largest `object` any scenes-repo scene or template produces is ~270 KB as JSON.
 */
export const LIMITS = {
	/** messages per second per peer: ~19x the measured peak (534) */
	msgsPerSec: 10000,
	/** bytes per second per peer (reliable + fast channel wire bytes): ~60x the measured peak, above what
	 * one WebRTC data channel carries on a fast LAN, so a real transfer is never metered */
	bytesPerSec: 64 * 1024 * 1024,
	/** approximate serialized size of one `object` message: ~240x the largest scenes-repo/template object,
	 * and above a textured model at the 25 MB import cap (its images ride inside the object as data URLs) */
	objectBytes: 64 * 1024 * 1024
};

/** Messages that are never dropped for rate: a goodbye and a refusal are how a link ends cleanly. */
const EXEMPT = new Set(['disconnected', 'refuse']);

/** One-second windows. */
const WINDOW_MS = 1000;

/**
 * Approximate JSON size of a value, stopping as soon as it passes `limit` (returns a number above
 * `limit` then). Strings count their length + 2, numbers 8, booleans/null 4, typed arrays their
 * byte length, plus one per key/element for punctuation. Iterative: a deep value cannot overflow.
 * @param {unknown} value @param {number} [limit] @returns {number}
 */
export function approxSize(value, limit = Infinity) {
	let total = 0;
	/** @type {unknown[]} */
	const stack = [value];
	let steps = 0;
	while (stack.length) {
		const v = stack.pop();
		if (++steps > 50_000_000) return Infinity; // a pathological shape: treat as over any cap
		if (typeof v === 'string') total += v.length + 2;
		else if (typeof v === 'number') total += 8;
		else if (v === null || typeof v === 'boolean' || v === undefined) total += 4;
		else if (ArrayBuffer.isView(v)) total += /** @type {ArrayBufferView} */ (v).byteLength;
		else if (v instanceof ArrayBuffer) total += v.byteLength;
		else if (Array.isArray(v)) {
			total += v.length + 2;
			for (let i = v.length - 1; i >= 0; i--) stack.push(v[i]);
		} else if (typeof v === 'object') {
			for (const k in /** @type {Record<string, unknown>} */ (v)) {
				total += k.length + 4;
				stack.push(/** @type {Record<string, unknown>} */ (v)[k]);
			}
			total += 2;
		}
		if (total > limit) return total;
	}
	return total;
}

/**
 * @typedef {{start: number, msgs: number, bytes: number, dropped: number}} PeerWindow
 * @typedef {{maxMsgs: number, maxBytes: number, maxObject: number, dropped: number, droppedBytes: number, capped: number}} PeerTotals
 */

/**
 * The per-peer meter. `admit` is called once per incoming message at the pipeline head and
 * answers whether it may go on; `noteBytes` is fed the wire size of what arrived (it may lag the
 * message by one chunk, which is noise against the limits).
 * @param {{now?: () => number, limits?: Partial<typeof LIMITS>, onDrop?: (peerId: string, reason: 'msgs' | 'bytes' | 'object') => void}} [opts]
 */
export function createInboundBudget(opts = {}) {
	const now = opts.now ?? (() => Date.now());
	const limits = { ...LIMITS, ...(opts.limits ?? {}) };
	/** @type {Map<string, PeerWindow>} */
	const windows = new Map();
	/** @type {Map<string, PeerTotals>} */
	const totals = new Map();

	/** @param {string} peerId */
	const totalsOf = (peerId) => {
		let t = totals.get(peerId);
		if (!t) totals.set(peerId, (t = { maxMsgs: 0, maxBytes: 0, maxObject: 0, dropped: 0, droppedBytes: 0, capped: 0 }));
		return t;
	};
	/** @param {string} peerId */
	const windowOf = (peerId) => {
		const t = now();
		let w = windows.get(peerId);
		if (!w || t - w.start >= WINDOW_MS) {
			w = { start: t, msgs: 0, bytes: 0, dropped: 0 };
			windows.set(peerId, w);
		}
		return w;
	};

	return {
		limits,
		/** @param {string} peerId @param {number} n wire bytes that arrived from this peer */
		noteBytes(peerId, n) {
			if (!(n > 0)) return;
			const w = windowOf(peerId);
			w.bytes += n;
			const t = totalsOf(peerId);
			if (w.bytes > t.maxBytes) t.maxBytes = w.bytes;
		},
		/**
		 * @param {string} peerId @param {any} data the decoded message
		 * @returns {boolean} false = drop it (already counted)
		 */
		admit(peerId, data) {
			const type = data && typeof data === 'object' ? data.type : undefined;
			const w = windowOf(peerId);
			const t = totalsOf(peerId);
			w.msgs++;
			if (w.msgs > t.maxMsgs) t.maxMsgs = w.msgs;
			if (typeof type === 'string' && EXEMPT.has(type)) return true;
			/** @type {'msgs' | 'bytes' | 'object' | null} */
			let reason = w.msgs > limits.msgsPerSec ? 'msgs' : w.bytes > limits.bytesPerSec ? 'bytes' : null;
			if (!reason && type === 'object') {
				const size = approxSize(data, limits.objectBytes);
				if (size > t.maxObject && size <= limits.objectBytes) t.maxObject = size;
				if (size > limits.objectBytes) {
					reason = 'object';
					t.capped++;
				}
			}
			if (!reason) return true;
			w.dropped++;
			t.dropped++;
			opts.onDrop?.(peerId, reason);
			return false;
		},
		/** the highest per-second rates seen, per peer and overall (the STATUS measurement) */
		peaks() {
			/** @type {Record<string, PeerTotals>} */
			const perPeer = {};
			let maxMsgs = 0;
			let maxBytes = 0;
			let maxObject = 0;
			let dropped = 0;
			for (const [id, t] of totals) {
				perPeer[id] = { ...t };
				maxMsgs = Math.max(maxMsgs, t.maxMsgs);
				maxBytes = Math.max(maxBytes, t.maxBytes);
				maxObject = Math.max(maxObject, t.maxObject);
				dropped += t.dropped;
			}
			return { maxMsgs, maxBytes, maxObject, dropped, perPeer };
		},
		/** @param {string} peerId @returns {number} messages dropped from this peer */
		dropped(peerId) {
			return totals.get(peerId)?.dropped ?? 0;
		},
		/** a departed peer (golden rule 3) — its peaks are kept for the measurement @param {string} peerId */
		forget(peerId) {
			windows.delete(peerId);
		},
		reset() {
			windows.clear();
			totals.clear();
		}
	};
}
