// 37 R1 — ONE REPLICATED BATCH FOR ONE MULTI-OBJECT EDIT.
//
// A multi-selection edit already recorded ONE undo entry (17-D1's fanOn), but it left as N
// separate messages, so a receiver could render the set half-applied between two of them
// and a dropped/reordered tail left peers disagreeing about a set the author changed in
// one gesture. While a batch is open, `PeerConnection.broadcast` hands every ROOM-SCOPED
// payload to `holdForWireBatch` instead of the wire; closing the outermost batch sends
// them as ONE `{type: 'batch', items}` envelope, which every receiver applies item by item
// through the same dispatcher (each item passes the shape table and every gate exactly as
// if it had arrived alone).
//
// THREE RULES THAT KEEP IT BYTE-SAFE:
//  * A batch of ONE is sent as the bare message — a single-object edit is byte-identical
//    to the pre-batch wire.
//  * ORDER IS KEPT. A payload that is not batchable (a pose stream, chat, a request)
//    arriving while a batch is open FLUSHES what is held first and then goes out itself,
//    so nothing overtakes an edit made before it.
//  * AN OLDER PEER NEVER SEES AN ENVELOPE. Peers advertise `wb: 1` in the `modules`
//    handshake; `broadcast` unpacks the envelope into its items for any peer that did not
//    (an unknown type is dropped by a 1.25 dispatcher, which would silently lose the edit).
//
// A ZERO-IMPORT LEAF (the wireValidate shape) so it is unit-testable without a peer.

/** the most items one envelope carries; a bigger edit is sent as several envelopes */
export const WIRE_BATCH_MAX = 500;

let depth = 0;
/** @type {any[]} */
let held = [];
/** @type {((payload: any) => void) | null} */
let sink = null;

/** Open a batch (nests: only the OUTERMOST close sends). */
export function beginWireBatch() {
	depth++;
}

/** Close a batch; the outermost close sends everything held. */
export function endWireBatch() {
	if (depth > 0) depth--;
	if (depth === 0) flushWireBatch();
}

/** Is a batch open right now? */
export function wireBatchOpen() {
	return depth > 0;
}

/**
 * Run `fn` inside a batch and always close it (a throwing applier must not leave every
 * later edit held forever). Returns what `fn` returns.
 * @template T @param {() => T} fn @returns {T}
 */
export function withWireBatch(fn) {
	beginWireBatch();
	try {
		return fn();
	} finally {
		endWireBatch();
	}
}

/**
 * The async twin, for writers that await between members (textures). Anything the app
 * sends from elsewhere while it waits is still ordered by the flush-first rule.
 * @template T @param {() => Promise<T>} fn @returns {Promise<T>}
 */
export async function withWireBatchAsync(fn) {
	beginWireBatch();
	try {
		return await fn();
	} finally {
		endWireBatch();
	}
}

/**
 * Called by `broadcast` with every outgoing payload. Returns true when the payload was
 * HELD (the caller must not send it now). `batchable` says whether this payload may ride
 * an envelope; `send` is how the envelope (or a lone held item) leaves.
 * @param {any} payload @param {boolean} batchable @param {(payload: any) => void} send
 * @returns {boolean}
 */
export function holdForWireBatch(payload, batchable, send) {
	if (depth === 0 || !payload || payload.type === 'batch') return false;
	if (!batchable) {
		// keep the order: what was edited before this message goes out before it
		flushWireBatch();
		return false;
	}
	sink = send;
	held.push(payload);
	return true;
}

/** Send whatever is held: one bare message, or envelopes of up to WIRE_BATCH_MAX. */
export function flushWireBatch() {
	const items = held;
	const send = sink;
	held = [];
	if (!items.length || !send) return;
	if (items.length === 1) {
		send(items[0]);
		return;
	}
	for (let i = 0; i < items.length; i += WIRE_BATCH_MAX) {
		const chunk = items.slice(i, i + WIRE_BATCH_MAX);
		send(chunk.length === 1 ? chunk[0] : { type: 'batch', items: chunk });
	}
}

/** test seam: drop any open batch without sending */
export function resetWireBatch() {
	depth = 0;
	held = [];
	sink = null;
}
