// 21-F3 — WHO IS PLAYING, and who may reset the game.
//
// THE GAP THIS FILLS. Play mode is `isLocked`, which is PER-VIEWER and unreplicated
// (gameState.js says so in its own opening paragraph), so nothing in the app could
// answer "is anyone actually in this game right now". Two consequences the user hit:
// the Users popover showed a peer as present with no hint that they were mid-game and
// could not be interrupted, and a game left by everybody stayed `playing` forever —
// F2's whole reset rule is derived from the round, and nothing ever ended the round.
//
// SO PRESENCE GAINS A MODE, and it is deliberately the `campreview` shape rather than a
// new concept: a tiny per-peer message, a map keyed by peer id, a reply riding the
// `getmodulestate` request that the handshake comment already calls out as "the one
// PER-PEER payload in the get* family". ADDITIVE in the strictest sense — the message is
// sent ONLY when a peer is playing, ABSENT means editor, and a peer running an older
// build simply never sends one and is read as an editor, which is what it is.
//
// WHY NOT THE `userdata` ROSTER. It is a whitelist broadcast as a WHOLE ARRAY of
// positional tuples, re-sent on approval and on every profile edit, and its applier
// merges exactly three slots. Writing a mode into it would put the entire roster on the
// wire every time somebody pressed play, and would have to teach that applier a fourth
// slot for a value that is not identity at all. Presence is presence.
//
// A LEAF as far as the history cycle is concerned: svelte stores plus gameState (itself
// a leaf) and cloudHooks/connectionState (store-only). Nothing here is reachable from
// history's import subtree, and nothing here registers a history kind.

import { writable, get } from 'svelte/store';
import { peers } from '../stores/appStore';
import { isLocked } from '../stores/sceneStore';
import { rolesInfo } from './cloudHooks';
import { sessionHost } from './connectionState';
import { gameState, resetGame } from './gameState';

/** The two modes. A third would be a protocol change, so the reader treats anything it
 * does not recognise as `editor` (the normalize-at-the-boundary rule). */
export const PLAY_MODES = ['editor', 'playing'];

/** REMOTE peers only, `peerId -> 'editor' | 'playing'`. An absent peer is an editor —
 * that is the whole compatibility story, so nothing writes 'editor' defensively.
 * @type {import('svelte/store').Writable<Record<string, string>>} */
export const peerPlayModes = writable({});

/** How long every peer must have been out of play before the game gives up on itself.
 * Ten seconds is the user's number: long enough that a reload, an Esc to check
 * something in the object list, or a peer walking through the connect dance does not
 * end a round, and short enough that the next person to open the scene finds a menu. */
export const ABANDON_MS = 10000;

/** How often the watch looks. A wall clock, not the frame loop: this must keep its
 * cadence on a backgrounded tab, which is exactly where an abandoned game is left. */
const WATCH_MS = 1000;

/** This peer's own mode, derived from the THREE-STATE play store. `null` = editor with
 * play available, `true` = playing, `false` = the transient Controls writes on exit
 * (settled back to null 2s later) — so "playing" is `=== true` and nothing else, the
 * rule flowRuntime's `gamePlayActive` states one domain over. */
export function myPlayMode() {
	return get(isLocked) === true ? 'playing' : 'editor';
}

/** @param {string} peerId @returns {string} */
export function playModeOf(peerId) {
	return get(peerPlayModes)[peerId] === 'playing' ? 'playing' : 'editor';
}

/** Is anybody in this session — me included — actually in play mode right now? */
export function anyonePlaying() {
	if (myPlayMode() === 'playing') return true;
	const open = livePeers();
	return open.some((id) => playModeOf(id) === 'playing');
}

/** The peers we hold an OPEN connection to. Never the `userdata` roster, which is
 * populated optimistically at DIAL time and would count a peer that never arrived (the
 * documented phantom-peer trap). @returns {string[]} */
function livePeers() {
	/** @type {any} */
	const peer = get(peers);
	const open = peer?.openedPeers;
	return open ? [...open] : [];
}

// ---- outbound -------------------------------------------------------------------

/** What we last put on the wire, so a three-state shuffle (`true -> false -> null`) is
 * ONE message and not two. It starts at 'editor' — which is where every session starts
 * — so the subscribe's immediate first callback publishes NOTHING: absent already means
 * editor, and announcing it would put a message on the wire at boot for every peer in
 * the app's overwhelmingly common state. @type {string} */
let sentMode = 'editor';

/** @param {string} mode */
function broadcast(mode) {
	/** @type {any} */
	const peer = get(peers);
	if (!peer?.peer?.id) return;
	// 21-F4: the condition verdicts ride the SAME message, additively — absent when the
	// map is empty, so an F3-only peer's messages are byte-identical and an F3-only
	// READER simply ignores a field it never looks at.
	const conds = mode === 'playing' && Object.keys(myConds).length ? { conds: { ...myConds } } : {};
	peer.send({ type: 'playmode', peerId: peer.peer.id, mode, ...conds });
}

/** Publish our mode when it CHANGES. @param {boolean} [force] send even if unchanged */
export function publishPlayMode(force = false) {
	const mode = myPlayMode();
	if (!force && mode === sentMode) return false;
	sentMode = mode;
	broadcast(mode);
	return true;
}

/**
 * Tell a newly connected peer what we are doing — but only while PLAYING, because
 * absent already means editor and an unconditional reply would put a message on the
 * wire for the overwhelmingly common case that carries no information. Rides
 * `getmodulestate`, beside `sendCameraPreviewState`.
 */
export function sendPlayModeState() {
	if (myPlayMode() === 'playing') broadcast('playing');
}

// ---- inbound --------------------------------------------------------------------

/** @param {any} data */
export function applyRemotePlayMode(data) {
	if (!data?.peerId) return false;
	const mode = data.mode === 'playing' ? 'playing' : 'editor';
	peerPlayModes.update((map) => {
		// 'editor' is the ABSENCE, so record it by DELETING — that keeps one
		// representation of "not playing" instead of two that can disagree
		if (mode === 'editor') {
			if (!(data.peerId in map)) return map;
			const next = { ...map };
			delete next[data.peerId];
			return next;
		}
		return { ...map, [data.peerId]: mode };
	});
	// 21-F4: the per-node condition verdicts, keyed by peer. Leaving play drops them —
	// a peer who is not playing has no verdicts, the same absence rule as the mode.
	peerPlayConds.update((map) => {
		if (mode === 'editor') {
			if (!(data.peerId in map)) return map;
			const next = { ...map };
			delete next[data.peerId];
			return next;
		}
		return { ...map, [data.peerId]: { ...(data.conds ?? {}) } };
	});
	return true;
}

/** A peer left. @param {string} peerId */
export function dropPeerPlayMode(peerId) {
	peerPlayModes.update((map) => {
		if (!(peerId in map)) return map;
		const next = { ...map };
		delete next[peerId];
		return next;
	});
	peerPlayConds.update((map) => {
		if (!(peerId in map)) return map;
		const next = { ...map };
		delete next[peerId];
		return next;
	});
}

// ---- 21-F4: per-node CONDITION verdicts (the `allplayers` node) -------------------
//
// "All peers in play satisfy a wired condition" needs each player's OWN answer on the
// wire — a flow VALUE is never sent (golden rule 8), but a player's verdict about
// THEMSELVES ("I am at the portal") is presence, not a value: it rides the same
// `playmode` message additively, latest-wins per peer, dropped with the mode. Every
// peer then derives "everyone is ready" from the same replicated map and fires the
// node LOCALLY (the ongamestate pattern) — no new message type, nothing to converge.

/** REMOTE peers' verdicts, `peerId -> {nodeId -> boolean}`. Absent peer = not playing.
 * @type {import('svelte/store').Writable<Record<string, Record<string, boolean>>>} */
export const peerPlayConds = writable({});

/** OUR verdicts, `nodeId -> boolean` — module-local, broadcast with the mode.
 * @type {Record<string, boolean>} */
let myConds = {};

/**
 * Record this player's verdict for one allplayers node, broadcasting on CHANGE only
 * (the sentMode rule, per node). flowRuntime calls this every tick; the wire sees an
 * edge, not a stream.
 * @param {string} nodeId @param {boolean} verdict
 */
export function publishPlayCondition(nodeId, verdict) {
	const held = myConds[nodeId];
	if (held === verdict) return false;
	myConds[nodeId] = verdict;
	if (myPlayMode() === 'playing') broadcast('playing');
	return true;
}

/** Forget verdicts for nodes that no longer exist (the actionSeenAt sweep, one map
 * over). @param {Set<string>} liveIds */
export function sweepPlayConditions(liveIds) {
	for (const id of Object.keys(myConds)) if (!liveIds.has(id)) delete myConds[id];
}

/**
 * ARE ALL PLAYERS READY? True only when somebody is actually playing, and every playing
 * peer — me included when I am one — answers true for this node. An editor peer is not
 * a player and does not count (fork 4's presence rule): a spectator in the editor must
 * not hold four players at a portal forever.
 * @param {string} nodeId @param {boolean} myVerdict this peer's own answer
 */
export function allPlayersSatisfied(nodeId, myVerdict) {
	const conds = get(peerPlayConds);
	const modes = get(peerPlayModes);
	let players = 0;
	if (myPlayMode() === 'playing') {
		players++;
		if (!myVerdict) return false;
	}
	for (const id of livePeers()) {
		if (modes[id] !== 'playing') continue;
		players++;
		if (conds[id]?.[nodeId] !== true) return false;
	}
	return players > 0;
}

// ---- THE ABANDON WATCH ----------------------------------------------------------
//
// "The game resets only when everyone has left play, or an admin resets it" (the locked
// fork). The first half is this, and it has three parts that each exist for a reason.
//
// 1. IT ARMS ONLY ONCE SOMEBODY HAS PLAYED. You cannot LEAVE what you never entered: a
//    Start button pressed from the editor puts the shell in `playing` with nobody in
//    play mode, and an unarmed watch would then end that round ten seconds later, before
//    the first player had walked to their keyboard. So the round has to have been
//    witnessed with a real player in it, and the latch is per ROUND (a new round re-arms
//    from scratch, which is also what a Restart wants).
// 2. IT MEASURES THE LAST MOMENT ANYONE WAS PLAYING, not a per-peer stopwatch. One
//    number is enough, it needs no bookkeeping when a peer joins or leaves mid-round,
//    and a peer we have merely not heard from cannot shorten it — the clock only ever
//    moves FORWARD, on evidence that somebody IS playing.
// 3. ONLY THE HOST WRITES. Every peer computes the same verdict from replicated state,
//    so every peer would write it, and N writes is N `changedAt` bumps for one event —
//    the symmetric-pull problem golden rule 7 names. `sessionHost === null` means "we
//    approved them, nobody approved us", which is exactly one peer in a session and is
//    also true when you are alone (the right answer: there is nobody else to defer to).
//    The one gap is a session whose host has LEFT — handleDisconnected nulls
//    `sessionHost`, so two survivors can both qualify — and the re-read below closes it
//    in practice: the write is idempotent, latest-wins, and the second peer's next tick
//    sees `menu` and stands down.

/** the last moment (ms) anyone was observed in play mode */
let lastPlayingAt = 0;
/** the round we have seen a real player in; null = this round is not armed */
let armedRound = /** @type {number|null} */ (null);
/** how many times THIS peer has written the abandon reset — the suite's "exactly one
 * peer wrote it" assertion reads this, since a latest-wins singleton cannot show who
 * bumped it */
let abandonWrites = 0;
/** @type {any} */ let watchTimer = null;

/** Are we the peer that speaks for the session? See rule 3 above. */
export function isSessionWriter() {
	return get(sessionHost) === null;
}

/**
 * One pass of the watch. Exported so a suite can drive it deterministically instead of
 * waiting on an interval (and so the interval itself stays a one-liner).
 * @param {number} [now]
 * @returns {'idle'|'armed'|'waiting'|'reset'|'notwriter'}
 */
export function tickAbandonWatch(now = Date.now()) {
	const game = get(gameState);
	if (game.state !== 'playing') {
		// nothing to abandon; forget the arming so the NEXT round starts clean
		armedRound = null;
		return 'idle';
	}
	if (anyonePlaying()) {
		lastPlayingAt = now;
		armedRound = game.round;
		return 'armed';
	}
	// a round nobody has entered yet is not an abandoned round
	if (armedRound !== game.round) return 'idle';
	if (now - lastPlayingAt < ABANDON_MS) return 'waiting';
	if (!isSessionWriter()) return 'notwriter';
	// re-read through the single write path: `resetGame` is what the admin button calls,
	// so the two ways a game ends up back at its menu are literally one function
	armedRound = null;
	abandonWrites++;
	resetGame();
	return 'reset';
}

// ---- the admin reset ------------------------------------------------------------

/**
 * MAY THIS PEER RESET THE GAME? INERT without a cloud plugin, the objectPermissions
 * precedent: with no `rolesInfo` published there are no roles to enforce, so the answer
 * falls back to the session rule — the host, or anybody who is alone. With a plugin it
 * is admins only, and a viewer or an editor is told why rather than silently ignored.
 */
export function canResetGame() {
	const roles = /** @type {any} */ (get(rolesInfo));
	if (roles) return !!roles.amAdmin;
	if (!livePeers().length) return true; // nobody to disagree with
	return isSessionWriter();
}

/**
 * A `$derived` cannot see a `get()`, and the comma-operator workaround fails
 * svelte-check ("Left side of comma operator is unused"). The documented cure is to pass
 * the stores as UNUSED ARGUMENTS to a small helper, which is reactive, typechecks, and
 * says why in the parameter names.
 * @param {any} _roles @param {any} _host @param {any} _peers
 */
export function resetAllowed(_roles, _host, _peers) {
	return canResetGame();
}

/**
 * The admin/host reset, shared by the Users popover entry and the `reset` flag on Set
 * Game State — so the button and the node cannot drift.
 * @returns {{ok: boolean, reason?: string}}
 */
export function requestResetGame() {
	if (!canResetGame())
		return {
			ok: false,
			reason: get(rolesInfo) ? 'Only an admin can reset the game.' : 'Only the session host can reset the game.'
		};
	resetGame();
	return { ok: true };
}

// ---- wiring ---------------------------------------------------------------------

/** @type {(()=>void)[]} */
let disposers = [];

/** Install the presence broadcast + the abandon watch. Idempotent. */
export function startGamePresence() {
	if (disposers.length) return;
	// the subscribe lives HERE and not at module scope: a module-level subscribe runs
	// its callback SYNCHRONOUSLY at module eval, and anything it reads that is declared
	// below TDZ-crashes the SSR prerender (the documented meshEdit/faceEdit trap)
	disposers.push(isLocked.subscribe(() => publishPlayMode()));
	watchTimer = setInterval(() => tickAbandonWatch(), WATCH_MS);
	disposers.push(() => {
		clearInterval(watchTimer);
		watchTimer = null;
	});
}

/** Test seam. */
export function stopGamePresence() {
	for (const dispose of disposers) dispose();
	disposers = [];
}

/** Test/debug view — `abandonWrites` is the only way to tell WHICH peer wrote a
 * latest-wins singleton. */
export function gamePresenceDebug() {
	return {
		wired: disposers.length > 0,
		mine: myPlayMode(),
		sentMode,
		peers: { ...get(peerPlayModes) },
		anyonePlaying: anyonePlaying(),
		armedRound,
		lastPlayingAt,
		abandonWrites,
		isSessionWriter: isSessionWriter(),
		canReset: canResetGame()
	};
}

/** Test seam: forget the watch's memory without touching the wire. */
export function resetGamePresence() {
	peerPlayModes.set({});
	sentMode = 'editor';
	lastPlayingAt = 0;
	armedRound = null;
	abandonWrites = 0;
}
