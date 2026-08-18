// 21-D6 — replication + history for the game state.
//
// The `hudSync` / `shaderSync` split, for the reason spelled out in `gameState.js`: that
// module must stay importable from `flowRuntime`, and `history` statically imports
// `flowRuntime`, so the history registration has to live out here. This is also the module
// whose BODY calls registerHistoryKind, which must never be reachable from history's own
// import subtree (the flowGraphs / joints / shaderSync / hudSync rule).
//
// A latest-wins SINGLETON, so this is the `scenephysics`/`music` shape rather than the
// keyed-document one: one message, one stamp, no per-key map.

import { get } from 'svelte/store';
import { peers } from '../stores/appStore';
import { registerHistoryKind, recordEntry } from './history';
import {
	gameState,
	normalizeGameState,
	commitGameState,
	registerGameBroadcast,
	registerGameHistory
} from './gameState';

// ---- outbound ------------------------------------------------------------------

/** @param {any} next */
function broadcast(next) {
	/** @type {any} */
	const peer = get(peers);
	if (peer) peer.send({ type: 'game', ...normalizeGameState(next) });
}

/** Handshake payload (singleton push, like environmentState / scenePhysicsState). */
export function gameStatePayload() {
	return { type: 'game', ...normalizeGameState(get(gameState)) };
}

/**
 * Full-state reply for a late joiner. Retries until the conn is OPEN — peerjs silently drops
 * anything sent before that (golden rule 2, the sendScenePost pattern).
 * @param {string} peerId @param {number} [attempt]
 */
export function sendGameState(peerId, attempt = 0) {
	/** @type {any} */
	const peer = get(peers);
	const conn = peer?.peer?.connections?.[peerId]?.[0] ?? peer?.connections?.[peerId];
	if (!conn) return;
	if (!conn.open) {
		if (attempt < 40) setTimeout(() => sendGameState(peerId, attempt + 1), 250);
		return;
	}
	conn.send(gameStatePayload());
}

// ---- inbound -------------------------------------------------------------------

/**
 * Newest change wins (the environment / scenePhysics pattern). Refuses only a STRICTLY older
 * state: a DataConnection is ordered, so an EQUAL stamp arrived later and must be accepted.
 * @param {any} data
 */
export function applyRemoteGameState(data) {
	if (!data) return false;
	const incoming = normalizeGameState(data);
	if (incoming.changedAt < (get(gameState).changedAt ?? 0)) return false;
	// silent: a receiver must never re-broadcast, and a remote change is not OUR undo step
	commitGameState(incoming, { silent: true, stamp: incoming.changedAt });
	return true;
}

// ---- history -------------------------------------------------------------------

registerHistoryKind('game', (/** @type {any} */ entry, /** @type {any} */ state) => {
	// `state` IS the value history hands us (applyState passes entry.before or entry.after),
	// so the direction is an IDENTITY comparison — the idiom every other kind uses, and the
	// one shaderSync got wrong (it read a `state.present` flag that does not exist, so redo
	// silently restored `before`).
	const target = state === entry.before ? entry.before : entry.after;
	// through the single write path, so an undo replicates exactly like an edit
	commitGameState(normalizeGameState(target), { stamp: Date.now() });
	return true;
});

// ---- wiring --------------------------------------------------------------------

/** @type {(()=>void)[]} */
let disposers = [];

/** Install the seams. Idempotent. */
export function startGameSync() {
	if (disposers.length) return;
	disposers.push(registerGameBroadcast(broadcast));
	disposers.push(
		registerGameHistory((before, after) => {
			if (JSON.stringify(before) === JSON.stringify(after)) return;
			recordEntry({ kind: 'game', before, after });
		})
	);
}

/** Test seam. */
export function stopGameSync() {
	for (const dispose of disposers) dispose();
	disposers = [];
}

/** test/debug view */
export function gameSyncDebug() {
	return { wired: disposers.length > 0 };
}
