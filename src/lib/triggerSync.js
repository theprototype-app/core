// DEVX #18 — A HANDSHAKE REPLY FOR THE FLOW TRIGGER LOG.
//
// THE BUG, as the collectible module filed it: a peer that joins mid-round sees every
// collected object back on the table, doors re-opened, one-shot events re-armed. Every
// stateful flow node derives from `flowTriggers` (nodeId -> {count, lastT}) — a Latch's
// set/reset, a Once's spent flag, a Counter's value, `random`'s reroll seed, a module's
// `ctx.trigger` — and `sendHandshake` requested full state for objects, nodes,
// annotations, module state, node defs, anim, HUDs, HUD values, post, shaders and the
// project, but nothing at all for the log. `nodesync`'s hash compare covers the GRAPH,
// not the log. So a joiner started with an empty map and every round-scoped read
// answered "never happened".
//
// The gameSync / hudSync shape: the DATA lives in the leaf store, the wire lives out
// here. Unlike those two this module registers NO history kind — the log is runtime
// state, not authored state, so it is not on any undo stack and is in no save file
// either (a `.tpscene` carries the graph; a reload starts a fresh round).
//
// WHY THIS IS SAFE TO SEND AT ALL, which is the whole design: the log is DERIVED state
// under golden rule 8 — every peer computes its stateful nodes from stamps every peer
// already has. Sending it is therefore not a second source of truth, it is catching a
// joiner up on the stamps it was not in the room for. What must never happen is those
// stamps being ACTED on, which is `flowRuntime`'s history epoch (`markTriggerHistory`):
// arriving history changes what nodes READ and fires nothing.
//
// NO `handleDisconnected` CLEANUP, and that is a decision rather than an omission: the
// log is keyed by NODE, not by peer. A pulse is a fact about the graph — whoever clicked
// the gem, it is collected — so a peer leaving drops nothing here. (Per-peer state that
// does get dropped lives in `peerVars` and `gamePresence`; the contrast is the point.)

import { get } from 'svelte/store';
import { peers } from '../stores/appStore';
import { flowTriggers, allNodes } from '../stores/flowStore';
import { markTriggerHistory } from './flowRuntime';

// ---- outbound -------------------------------------------------------------------

/**
 * The log, pruned to nodes that still EXIST in some graph.
 *
 * Two reasons, one of them load-bearing. A stamp for a node nobody has is unusable —
 * `applyNodeTrigger` never prunes, so the log accumulates the ids of every node ever
 * deleted — and pruning bounds the payload by the GRAPH rather than by session history.
 * The second: after a share-or-stash STASH our graphs are cleared while the log is not,
 * so the prune is also what stops us answering with the ids of a scene we just stashed.
 *
 * SIZE (golden rule 6, which says big numeric payloads must ride as raw bytes): an entry
 * is one string key and two numbers, and there is at most one per STATEFUL node, so a
 * heavy game graph is tens to low hundreds of them — a couple of hundred entries is
 * ~11 KB of JSON. The `nodes` reply that travels beside it carries whole node objects
 * with their `data` and is an order of magnitude bigger, as a plain object too. The raw-
 * bytes rule exists for the ~40k-element arrays that overflow binarypack's per-element
 * recursion (meshgeo); nothing here is in that league. A graph big enough to matter would
 * have failed to replicate its own nodes first.
 */
export function triggerLogPayload() {
	const live = new Set(allNodes().map((/** @type {any} */ node) => node.id));
	/** @type {Record<string, {count: number, lastT: number}>} */
	const triggers = {};
	for (const [id, entry] of Object.entries(get(flowTriggers) ?? {})) {
		if (!live.has(id)) continue;
		if (typeof entry?.lastT !== 'number') continue;
		triggers[id] = { count: Number(entry.count) || 0, lastT: entry.lastT };
	}
	return { type: 'triggers', triggers };
}

/**
 * Full-state reply for a late joiner (golden rule 3). Retries until the conn is OPEN —
 * peerjs silently DROPS anything sent before that (golden rule 2, the sendNodes /
 * sendHuds pattern).
 *
 * An EMPTY log is still sent: it is a legitimate answer ("nothing has fired here"), and
 * the joiner's epoch is set by the reply arriving, not by its contents.
 * @param {string} peerId @param {number} [tries]
 */
export function sendTriggers(peerId, tries = 0) {
	/** @type {any} */
	const peer = get(peers);
	const conn = peer?.peer?.connections?.[peerId]?.[0] ?? peer?.connections?.[peerId];
	if (!conn) return;
	if (!conn.open) {
		if (tries < 40) setTimeout(() => sendTriggers(peerId, tries + 1), 250);
		return;
	}
	conn.send(triggerLogPayload());
}

// ---- inbound --------------------------------------------------------------------

/**
 * THE MERGE RULE: per node, the WHOLE entry with the newer `lastT` wins.
 *
 * It has to be a merge and not a replace, twice over: a joiner may already hold entries
 * for its own clicks between dialling and the reply landing, and two peers that have both
 * been running hold genuinely different logs (a perPlayer pulse never leaves its peer by
 * design, so divergence is not even an error condition here).
 *
 * WHY THE COUNT TRAVELS WITH THE STAMP rather than being merged on its own. The count
 * means something different in each node it serves, and taking it from whichever side
 * owns the newer stamp is the right answer in all of them:
 *
 *   · a Counter re-stamps `lastT` on EVERY bump, so a newer stamp IS the more advanced
 *     count — the two fields cannot disagree about which is further along.
 *   · a Latch's set/reset CLEARS the count to 0 and lives entirely off the stamp, so the
 *     count is not state there and copying it costs nothing.
 *   · a Once holds 0-or-1, written at the same instant as its stamp.
 *   · `random`'s reroll seed reads `lastT` and deliberately ignores the count (a count
 *     cannot converge for a late joiner; a stamp can — the documented rule this whole
 *     reply is an application of).
 *
 * WHAT STAYS APPROXIMATE, and it is exactly one thing: a Latch's TOGGLE parity is an
 * accumulated count with no stamp of its own per flip, so a joiner adopting the sender's
 * parity is adopting a number it could not have derived. That is already the documented
 * behaviour of the toggle branch in `applyNodeTrigger` ("a late joiner is exact for
 * set/reset and can differ in toggle parity until the next set/reset re-bases it"), and
 * this reply makes it strictly better than the empty log it replaces. A game that needs
 * exactness uses set/reset, which the collectible recipe does.
 *
 * A TIE keeps ours. There is no ordering argument to make — this is a snapshot, not a
 * stream of edits — so the stable choice is to leave a same-instant entry alone rather
 * than let the arrival order of two replies decide it.
 * @param {any} data
 */
export function applyRemoteTriggers(data) {
	const incoming = data?.triggers;
	if (!incoming || typeof incoming !== 'object') return 0;
	let merged = 0;
	flowTriggers.update((map) => {
		const next = { ...map };
		for (const [id, entry] of Object.entries(incoming)) {
			const lastT = /** @type {any} */ (entry)?.lastT;
			if (typeof lastT !== 'number') continue;
			const held = next[id];
			if (held && typeof held.lastT === 'number' && held.lastT >= lastT) continue;
			next[id] = { count: Number(/** @type {any} */ (entry).count) || 0, lastT };
			merged++;
		}
		return next;
	});
	// AFTER the merge, so the epoch can never sit in front of state that has not landed
	// yet. It is the arrival that matters, not the size of the payload: an empty reply
	// still says "everything older than now was somebody else's pulse", which closes the
	// loaded-the-scene-then-dialled hole (see flowRuntime's epoch comment).
	markTriggerHistory();
	return merged;
}

/** test/debug view */
export function triggerSyncDebug() {
	const payload = triggerLogPayload();
	return { entries: Object.keys(payload.triggers).length, bytes: JSON.stringify(payload).length };
}
