// scatter-sync — WHAT THE HOST SAYS WHILE AN APPROVED JOINER'S CONN IS STILL OPENING.
//
// Approving a joiner DIALS BACK (`approveDialBack`), and that conn takes time to open: a
// few hundred ms on a fast box, 15 s measured with the CPU throttled to GitHub-runner
// speed. `broadcast` skips a conn that is not open, so every room edit made in that window
// was dropped for the joiner. Nothing else carried it either, unless the joiner's full-state
// request happened to be answered AFTER the edit — and that reply is the slow path (a 500 ms
// wait, then a GLTF of the whole scene): the four scatter suites' "B has the terrain" read
// 24.6 s on a throttled run, past their 20 s window, every time.
//
// So the host HOLDS its room-scoped broadcasts for a peer whose approval dial-back is in
// flight, and flushes them in order right after that conn's handshake — the joiner gets them
// exactly as a peer connected all along would have, and the full-state reply that follows is
// add-only by uuid, so nothing lands twice. A LEAF (no imports) so the bounds are unit-tested.
//
// BOUNDED both ways, because the full-state reply still follows and covers anything dropped
// here: past `cap` messages the whole queue is abandoned (a half queue would replay edits to
// objects whose creation was cut off), and entries older than `ttlMs` are not flushed.

export const DIAL_BACK_QUEUE_CAP = 300;
export const DIAL_BACK_QUEUE_TTL_MS = 120_000;

/**
 * @param {{cap?: number, ttlMs?: number, now?: () => number}} [opts]
 */
export function createDialBackQueue(opts = {}) {
	const cap = opts.cap ?? DIAL_BACK_QUEUE_CAP;
	const ttlMs = opts.ttlMs ?? DIAL_BACK_QUEUE_TTL_MS;
	const now = opts.now ?? (() => Date.now());
	/** @type {Map<string, {items: {at: number, payload: any}[], overflowed: boolean}>} */
	const queues = new Map();

	return {
		/** Hold one payload for `peerId`. @param {string} peerId @param {any} payload @returns {boolean} held */
		hold(peerId, payload) {
			let q = queues.get(peerId);
			if (!q) queues.set(peerId, (q = { items: [], overflowed: false }));
			if (q.overflowed) return false;
			if (q.items.length >= cap) {
				q.items = [];
				q.overflowed = true;
				return false;
			}
			q.items.push({ at: now(), payload });
			return true;
		},
		/** Everything held for `peerId`, oldest first, minus what expired; forgets the peer. @param {string} peerId */
		take(peerId) {
			const q = queues.get(peerId);
			queues.delete(peerId);
			if (!q) return [];
			const cutoff = now() - ttlMs;
			return q.items.filter((i) => i.at >= cutoff).map((i) => i.payload);
		},
		/** @param {string} peerId */
		drop(peerId) {
			queues.delete(peerId);
		},
		/** @param {string} peerId */
		size(peerId) {
			return queues.get(peerId)?.items.length ?? 0;
		},
		/** @param {string} peerId */
		overflowed(peerId) {
			return !!queues.get(peerId)?.overflowed;
		},
		clear() {
			queues.clear();
		}
	};
}
