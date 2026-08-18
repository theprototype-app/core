// A2 — replication + history for HUD documents.
//
// Lives apart from `hudDocs.js` on purpose (the shaderGraph/shaderSync split): that module
// owns the DATA and exposes broadcast/history SEAMS, so it imports neither `peers` nor
// `history` and stays a leaf. This one closes the loop. It is also the module whose BODY
// calls registerHistoryKind, which must never be reachable from history's own import
// subtree (the flowGraphs / joints / shaderSync rule).
//
// GOLDEN RULE 8 — the decision that matters: the authored DOCUMENT is
// authoritative-per-edit, latest-wins on `changedAt`. The RUNTIME half is DETERMINISTIC
// and never replicated: an element's live text comes from the already-replicated flow
// graph, so every peer computes the same string, and a button press rides the existing
// `nodetrigger` path. THIS BATCH ADDS ZERO NEW RUNTIME MESSAGE TYPES.
//
// WHOLE-DOC rather than per-element: a gesture already collapses to one broadcast, the
// shader graph doc is bigger and rides whole, and per-element would need its own ordering,
// latest-wins-per-element and delete tombstones. The one real cost is two authors dragging
// different elements at once — the same tradeoff shaderGraph and annotations already ship,
// with `at` reserved on each element so the upgrade is additive.
//
// No `handleDisconnected` cleanup: documents are SCENE data, not per-peer state.

import { get } from 'svelte/store';
import { peers } from '../stores/appStore';
import { registerHistoryKind, recordEntry } from './history';
import {
	hudDocs,
	hudDocOf,
	setHudDocFor,
	normalizeHudDoc,
	registerHudBroadcast,
	registerHudHistory
} from './hudDocs';

/** @param {any} doc */
function wireDoc(doc) {
	// send the NORMALIZED doc, so a peer on an older build gets every field it knows and
	// nothing it cannot parse — and a field a newer peer added rides through untouched
	return doc ? normalizeHudDoc(doc) : null;
}

// ---- outbound -------------------------------------------------------------------

/** @param {string} key @param {any} doc */
function broadcast(key, doc) {
	/** @type {any} */
	const peer = get(peers);
	if (!peer) return;
	if (doc) peer.send({ type: 'hud', key, doc: wireDoc(doc) });
	else peer.send({ type: 'huddelete', key, changedAt: Date.now() });
}

/**
 * Full-state reply for a late joiner (golden rule 3). Retry until the conn is OPEN —
 * peerjs silently DROPS anything sent before that (golden rule 2, the sendNodes pattern).
 * @param {string} peerId @param {number} [tries]
 */
export function sendHuds(peerId, tries = 0) {
	/** @type {any} */
	const peer = get(peers);
	const conn = peer?.peer?.connections?.[peerId]?.[0] ?? peer?.connections?.[peerId];
	if (!conn) return;
	if (!conn.open) {
		if (tries < 40) setTimeout(() => sendHuds(peerId, tries + 1), 250);
		return;
	}
	/** @type {Record<string, any>} */
	const all = get(hudDocs);
	/** @type {Record<string, any>} */
	const huds = {};
	for (const [key, doc] of Object.entries(all)) huds[key] = wireDoc(doc);
	conn.send({ type: 'huds', huds });
}

// ---- inbound --------------------------------------------------------------------

/**
 * One document from a peer. Latest-wins on `changedAt`, so two authors converge instead
 * of ping-ponging (golden rule 7).
 * @param {any} data
 */
export function applyRemoteHud(data) {
	const key = data?.key;
	if (!key || !data?.doc) return;
	const incoming = normalizeHudDoc(data.doc);
	const mine = hudDocOf(key);
	// refuse only a STRICTLY older document. A DataConnection is ORDERED, so an equal
	// stamp means "arrived later, same millisecond" and must be accepted — refusing it
	// killed every write of a fast gesture after the first in the shader round.
	if (mine && (mine.changedAt ?? 0) > (incoming.changedAt ?? 0)) return;
	// silent: a receiver must not re-broadcast, and a remote edit is not OUR undo step
	setHudDocFor(key, incoming, { silent: true, stamp: incoming.changedAt });
}

/** @param {any} data */
export function applyRemoteHudDelete(data) {
	const key = data?.key;
	if (!key) return;
	const mine = hudDocOf(key);
	if (mine && (mine.changedAt ?? 0) > (data?.changedAt ?? 0)) return;
	setHudDocFor(key, null, { silent: true });
}

/** The whole map, from a `gethuds` reply. @param {any} data */
export function applyRemoteHuds(data) {
	const huds = data?.huds;
	if (!huds || typeof huds !== 'object') return;
	for (const [key, doc] of Object.entries(huds)) applyRemoteHud({ key, doc });
}

// ---- history --------------------------------------------------------------------

// A drag writes many times a second; ONE undo step should cover the whole gesture (the
// `anim` / `shadergraph` precedent).
/** @type {Map<string, any>} */
const gestures = new Map();

/** @param {string} key */
export function beginHudGesture(key) {
	if (!gestures.has(key)) gestures.set(key, hudDocOf(key));
}

/** @param {string} key */
export function endHudGesture(key) {
	if (!gestures.has(key)) return;
	const before = gestures.get(key);
	gestures.delete(key);
	const after = hudDocOf(key);
	if (JSON.stringify(before) === JSON.stringify(after)) return;
	recordEntry({ kind: 'hud', key, before, after });
	// the gesture suppressed the per-write broadcast, so send the settled doc ONCE
	broadcast(key, after);
}

/** Is a gesture open? (tests/debug) @param {string} key */
export function hudGestureActive(key) {
	return gestures.has(key);
}

registerHistoryKind('hud', (/** @type {any} */ entry, /** @type {any} */ state) => {
	// `state` IS the doc history handed us (applyState passes entry.before or
	// entry.after), so the direction is an IDENTITY comparison — the idiom every other
	// kind uses (scenePost's 'look', animationPreview's 'anim', flowGraphs'
	// 'flowgraph'). Reading a `state.present` flag that does not exist makes REDO
	// restore `before` as well, so undo works and redo silently does nothing.
	const doc = state === entry.before ? entry.before : entry.after;
	// goes through the SINGLE write path, so an undo replicates exactly like an edit.
	// History mutes its own recording while applying, so this cannot re-record; the
	// broadcast is deliberate (the joints precedent).
	setHudDocFor(entry.key, doc ?? null);
	return true;
});

// ---- wiring ---------------------------------------------------------------------

/** @type {(()=>void)[]} */
let disposers = [];

/** Install the seams. Idempotent. */
export function startHudSync() {
	if (disposers.length) return;
	disposers.push(
		registerHudBroadcast((key, doc) => {
			// inside a gesture the broadcast is deferred to endHudGesture — ONE message per
			// drag, not one per pointermove
			if (gestures.has(key)) return;
			broadcast(key, doc);
		})
	);
	disposers.push(
		registerHudHistory((key, before, after) => {
			// inside a gesture the entry is deferred to endHudGesture
			if (gestures.has(key)) return;
			if (JSON.stringify(before) === JSON.stringify(after)) return;
			recordEntry({ kind: 'hud', key, before, after });
		})
	);
}

/** Test seam. */
export function stopHudSync() {
	for (const dispose of disposers) dispose();
	disposers = [];
	gestures.clear();
}

/** test/debug view */
export function hudSyncDebug() {
	return { wired: disposers.length > 0, gestures: [...gestures.keys()] };
}
