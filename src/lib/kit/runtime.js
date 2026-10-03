// 34 R2 (T3) — THE KIT IN THE APP: core.js's host, bound to the live session.
//
//   clock      sessionNow() — the session's synced clock, so a stamp means the same moment on
//              every peer (25-E; every wire stamp uses it)
//   wire       the mesh broadcast (`peers.send`), and `receiveKitMessage` from the dispatcher;
//              a joiner gets `kitPayload()` in the handshake (the gameStatePayload shape)
//   authority  kit/authority.js over the OPEN connections, no session host, and the physics
//              initiator — the same peer 31-towers and football already pick (initiator, else
//              the lowest id), so a game ported to the kit keeps its authority (QUESTIONS #1)
//   storage    gameStorage under `tp:kit:<key>` (safeStorage; LOCAL, never replicated)
//   game       core's game singleton (gameState.js), which the K3 shell, HUD showWhile screens
//              and every Set Game State node already read — kit.round DRIVES it
//   emit       an event the authority witnessed pulses the matching `kit-<piece>-<event>`
//              nodes ONCE, replicated (fireModuleTrigger)
//
// One kit per app (the game singleton's lifetime). Reached from flowRuntime / moduleSDK /
// peerHandler through PRIMED dynamic imports where a static edge would close a cycle; this file
// itself imports only leaves.

import { get } from 'svelte/store';
import { peers, userdata } from '../../stores/appStore';
import { sessionNow } from '../sessionClock';
import { readStored, writeStored } from '../gameStorage';
import { gameState, setGameState, commitGameState } from '../gameState';
import { pickAuthority } from './authority.js';
import { createKit, KIT_DOC, KIT_REQ } from './core.js';
import { KIT_PIECES } from './index.js';
import { kitNodeType } from './spec.js';

export { KIT_DOC, KIT_REQ };

/** physics + flowRuntime, primed (both sit in history's import family) */
/** @type {any} */ let physicsRef = null;
/** @type {any} */ let flowRef = null;
export function primeKitRuntime() {
	import('../physics').then((m) => (physicsRef = m)).catch(() => {});
	import('../flowRuntime').then((m) => (flowRef = m)).catch(() => {});
	// the K3 pause menu's Restart restarts a kit round (a game using kit.round needs no hook of
	// its own); a game that never started one is left alone. Dynamic: gameShell reaches
	// playSettings, which reads this file.
	import('../gameShell')
		.then((m) => {
			if (restartHooked) return;
			restartHooked = true;
			m.onGameRestart(() => {
				if (kit.impls.round?.number?.() > 0) kit.impls.round.restart();
			}, '');
			// kit.levels publishes its table to the shell's level picker (desktop + the VR board)
			kit.impls.levels?.extra?.attachShell?.((/** @type {any} */ spec, /** @type {string} */ owner) => m.setGameLevels(spec, owner));
		})
		.catch(() => {});
}
let restartHooked = false;

const me = () => /** @type {any} */ (get(peers))?.peer?.id ?? null;
/** the peers whose data channel is OPEN (never the dial-time roster — the userdata trap) */
const openPeers = () => [.../** @type {any} */ (get(peers))?.openedPeers ?? []].map(String);
const initiator = () => {
	if (!physicsRef) return null;
	if (get(physicsRef.simulating)) return me();
	const remote = get(physicsRef.remoteSimulating);
	return remote ? String(remote) : null;
};

/** who decides, as this peer sees it */
export function kitAuthorityId() {
	return pickAuthority({ me: me(), peers: openPeers(), host: null, initiator: initiator() });
}

/** @type {import('./core.js').KitHost} */
const host = {
	me,
	now: sessionNow,
	send(msg) {
		/** @type {any} */
		const peer = get(peers);
		if (peer) peer.send(msg);
	},
	isAuthority() {
		const id = me();
		return !id || kitAuthorityId() === id;
	},
	authorityId: () => kitAuthorityId(),
	// the roster's nickname (slot 1 of a userdata row), else the id — what api.peerNames reads
	nameOf: (id) => {
		const row = (/** @type {any[]} */ (get(userdata)) ?? []).find((r) => r?.[0] === id);
		return (row && typeof row[1] === 'string' && row[1]) || id;
	},
	storage: {
		get: (key, fallback = null) => readStored('tp:kit:' + key, fallback),
		set: (key, value) => writeStored('tp:kit:' + key, value) !== null
	},
	game: {
		get: () => get(gameState),
		set: (state, opts) => setGameState(state, opts),
		// a FRESH round even while playing: the one thing setGameState will not do (entering
		// playing from playing is a no-op), which is why Restart used to be reset -> Delay -> play
		restart: (opts = {}) =>
			commitGameState({
				state: 'playing',
				outcome: '',
				startedAt: sessionNow(),
				round: (get(gameState).round ?? 0) + 1,
				pausedAt: 0,
				pausedMs: 0,
				...(opts.vars ? { vars: opts.vars } : {})
			})
	},
	emit(piece, event, _payload, opts) {
		const type = kitNodeType(piece, event);
		// a LOCAL event keeps its pulse in this peer's trigger log (the perPlayer rule)
		const fireOpts = opts?.local ? { replicate: false } : undefined;
		if (flowRef) flowRef.fireModuleTrigger(type, undefined, fireOpts);
		else import('../flowRuntime').then((m) => m.fireModuleTrigger(type, undefined, fireOpts)).catch(() => {});
	}
};

/** THE kit of this app */
export const kit = createKit(host, KIT_PIECES);

/** a `kit` / `kitreq` (or a piece's own) message from a peer (already through wireValidate)
 * @param {any} data @param {string | null} [from] the sending peer's id */
export function receiveKitMessage(data, from = null) {
	return kit.receive(data, from);
}

/** the handshake push (no events: arriving history fires nothing) */
export function kitPayload() {
	return kit.snapshot();
}

/** per frame (flowRuntime's tick) */
export function tickKit() {
	kit.tick();
}

/** a scene clear / load: the next game starts from nothing (local; every peer clears too) */
export function resetKit() {
	kit.reset();
}

/** 34 R2: the grab question every grab path asks (kit.rules.checkGrab): reach + vetoes.
 * @param {any} req @returns {{ok: boolean, reason?: string, distance: number} | null} */
export function kitCheckGrab(req) {
	return kit.impls.rules?.extra?.checkGrab?.(req) ?? null;
}

/** 34 R2: the rules resolvePlaySettings lays OVER the scene's play block: `{reach, jump,
 * bounds}`, null = the kit sets none */
export function kitPlayRules() {
	return kit.impls.rules?.extra?.current?.() ?? { reach: null, jump: null, bounds: null };
}

/** the debug hook / suites */
export function kitDebug() {
	return { doc: kit.doc(), stats: { ...kit.stats }, pending: kit.pending.size, authority: kitAuthorityId(), me: me() };
}
