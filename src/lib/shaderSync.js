// Replication + history for shader graph documents (plan SH2).
//
// Lives apart from `shaderGraph.js` on purpose: that module owns the DATA and exposes
// broadcast/history SEAMS, so it imports neither `peers` nor `history` and stays a leaf.
// This one closes the loop. It is also the module whose BODY calls registerHistoryKind,
// which must never be reachable from history's own import subtree (the flowGraphs/joints
// rule) — nothing in that subtree imports shaderSync.
//
// Model: graphs are keyed documents, so this follows `animdata`'s latest-wins-PER-KEY
// shape rather than the scenePhysics singleton. A receiver applies and NEVER
// re-broadcasts (golden rule 1); a late joiner pulls the whole map (golden rule 3).

import { get } from 'svelte/store';
import { peers } from '../stores/appStore';
import { registerHistoryKind, recordEntry } from './history';
import {
	shaderGraphs,
	shaderGraphOf,
	setShaderGraphFor,
	normalizeShaderGraph,
	registerShaderBroadcast,
	registerShaderHistory
} from './shaderGraph';

/** @param {any} doc @returns {any} */
function wireDoc(doc) {
	// send the normalized doc, so a peer on an older build still gets every field it
	// knows and nothing it cannot parse
	return doc ? normalizeShaderGraph(doc) : null;
}

// ---- outbound -------------------------------------------------------------------

/** @param {string} key @param {any} doc */
function broadcast(key, doc) {
	/** @type {any} */
	const peer = get(peers);
	if (!peer) return;
	if (doc) peer.send({ type: 'shadergraph', key, doc: wireDoc(doc) });
	else peer.send({ type: 'shadergraphdelete', key, changedAt: Date.now() });
}

/**
 * Full-state reply for a late joiner. Retry until the conn is open — peerjs silently
 * DROPS anything sent before that (golden rule 2, the sendNodes pattern).
 * @param {string} peerId @param {number} [tries]
 */
export function sendShaderGraphs(peerId, tries = 0) {
	/** @type {any} */
	const peer = get(peers);
	const conn = peer?.peer?.connections?.[peerId]?.[0] ?? peer?.connections?.[peerId];
	if (!conn) return;
	if (!conn.open) {
		if (tries < 40) setTimeout(() => sendShaderGraphs(peerId, tries + 1), 250);
		return;
	}
	/** @type {Record<string, any>} */
	const all = get(shaderGraphs);
	/** @type {Record<string, any>} */
	const graphs = {};
	for (const [key, doc] of Object.entries(all)) graphs[key] = wireDoc(doc);
	conn.send({ type: 'shadergraphs', graphs });
}

// ---- inbound --------------------------------------------------------------------

/**
 * One document from a peer. Latest-wins on `changedAt`, so two peers editing the same
 * graph converge instead of ping-ponging (golden rule 7).
 * @param {any} data
 */
export function applyRemoteShaderGraph(data) {
	const key = data?.key;
	if (!key || !data?.doc) return;
	const incoming = normalizeShaderGraph(data.doc);
	const mine = shaderGraphOf(key);
	// refuse only a STRICTLY older document. A DataConnection is ordered, so an equal
	// stamp means "arrived later, same millisecond" and must be accepted — refusing it
	// dropped every write of a fast gesture after the first.
	if (mine && (mine.changedAt ?? 0) > (incoming.changedAt ?? 0)) return;
	// silent: a receiver must not re-broadcast, and a remote edit is not OUR undo step
	setShaderGraphFor(key, incoming, { silent: true, stamp: incoming.changedAt });
}

/** @param {any} data */
export function applyRemoteShaderGraphDelete(data) {
	const key = data?.key;
	if (!key) return;
	const mine = shaderGraphOf(key);
	if (mine && (mine.changedAt ?? 0) > (data?.changedAt ?? 0)) return;
	setShaderGraphFor(key, null, { silent: true });
}

/** The whole map, from a `getshadergraphs` reply. @param {any} data */
export function applyRemoteShaderGraphs(data) {
	const graphs = data?.graphs;
	if (!graphs || typeof graphs !== 'object') return;
	for (const [key, doc] of Object.entries(graphs))
		applyRemoteShaderGraph({ key, doc });
}

// ---- history --------------------------------------------------------------------

// A drag writes many times a second; ONE undo step should cover the whole gesture (the
// `anim` precedent with beginAnimGesture/endAnimGesture).
/** @type {Map<string, any>} */
const gestures = new Map();

/** @param {string} key */
export function beginShaderGesture(key) {
	if (!gestures.has(key)) gestures.set(key, shaderGraphOf(key));
}

/** @param {string} key */
export function endShaderGesture(key) {
	if (!gestures.has(key)) return;
	const before = gestures.get(key);
	gestures.delete(key);
	const after = shaderGraphOf(key);
	if (JSON.stringify(before) === JSON.stringify(after)) return;
	recordEntry({ kind: 'shadergraph', key, before, after });
}

/** Is a gesture open for this key? (tests/debug) @param {string} key */
export function shaderGestureActive(key) {
	return gestures.has(key);
}

registerHistoryKind('shadergraph', (/** @type {any} */ entry, /** @type {any} */ state) => {
	const doc = state.present ? entry.after : entry.before;
	// goes through the SINGLE write path, so undo replicates and recompiles exactly like
	// an edit does. History mutes its own recording while applying, so this cannot
	// re-record; the broadcast is deliberate (the joints precedent).
	setShaderGraphFor(entry.key, doc ?? null);
	return true;
});

// ---- wiring ---------------------------------------------------------------------

/** @type {(()=>void)[]} */
let disposers = [];

/** Install the seams. Idempotent. */
export function startShaderSync() {
	if (disposers.length) return;
	disposers.push(registerShaderBroadcast(broadcast));
	disposers.push(
		registerShaderHistory((key, before, after) => {
			// inside a gesture the entry is deferred to endShaderGesture
			if (gestures.has(key)) return;
			if (JSON.stringify(before) === JSON.stringify(after)) return;
			recordEntry({ kind: 'shadergraph', key, before, after });
		})
	);
}

/** Test seam. */
export function stopShaderSync() {
	for (const dispose of disposers) dispose();
	disposers = [];
	gestures.clear();
}

/** test/debug view */
export function shaderSyncDebug() {
	return { wired: disposers.length > 0, gestures: [...gestures.keys()] };
}
