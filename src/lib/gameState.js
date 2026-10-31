// 21-D6 — THE GAME SHELL: the one piece of state a game's HUD actions can target.
//
// Verified before building it: core had NO notion of a game running. `isLocked` (play mode)
// is per-viewer and unreplicated, camera preview is a per-viewer `makeDefault` swap with
// replicated PRESENCE only, and there was no active/game camera anywhere. So "press Start
// and the game begins for everyone" had nothing to write to.
//
// A replicated latest-wins SINGLETON on the `scenePost` / `sceneMusic` template — the same
// family as `environment`, `music` and `scenephysics`. `startedAt` is a synced-clock stamp
// exactly like `sceneMusic`'s, so a round timer needs no clock of its own and a late joiner
// converges mid-round.
//
// A LEAF (svelte/store only) with broadcast + history SEAMS, and this one is not a style
// choice: `flowRuntime` must read this to run the game nodes, and `history` statically
// imports `flowRuntime`. Importing history here would close
// history -> flowRuntime -> gameState -> history and TDZ-crash the SSR prerender. `gameSync`
// closes the loop instead (the hudDocs/hudSync split, one more time).
//
// WHY `vars` LIVES IN THE SAME SINGLETON: a game's variables ARE game state, they are small,
// and folding them in means ONE message, ONE latest-wins rule and ONE snapshot rather than a
// second channel that can disagree with the first about what round it is.
//
// WHAT IS DELIBERATELY NOT HERE: which camera you are looking through. That stays a LOCAL
// decision each peer makes for itself — the house rule (`nodetrigger`, and the SDK's "a
// peer's module must never move another peer's camera"). The `gamestart` node names the
// start camera in the REPLICATED graph, and every peer independently acts on it when the
// state enters `playing`, so all views converge with no new message and no forced viewpoint.

import { writable, get } from 'svelte/store';
import { sessionNow } from './sessionClock'; // 25-E: stamps another peer compares

/** The states a game moves through. `over` carries an `outcome` string, which is how
 * win/lose is expressed without a node of its own. */
export const GAME_STATES = ['menu', 'playing', 'paused', 'over'];

/**
 * @typedef {{
 *   state: string,
 *   round: number,
 *   startedAt: number,
 *   pausedAt: number,
 *   pausedMs: number,
 *   outcome: string,
 *   vars: Record<string, any>,
 *   varsAt?: Record<string, number>,
 *   changedAt: number
 * }} GameState
 */

/** @type {GameState} */
const DEFAULT = { state: 'menu', round: 0, startedAt: 0, pausedAt: 0, pausedMs: 0, outcome: '', vars: {}, changedAt: 0 };

/** @type {import('svelte/store').Writable<GameState>} */
export const gameState = writable({ ...DEFAULT });

/** @param {any} v @param {number} fallback */
function num(v, fallback) {
	const n = Number(v);
	return Number.isFinite(n) ? n : fallback;
}

/**
 * ONE normalize at every store boundary (wire, save, restore, undo). SPREADS its input so a
 * field a NEWER peer added survives our edit and rides back onto the wire.
 * @param {any} data @returns {GameState}
 */
export function normalizeGameState(data) {
	return {
		...(data ?? {}),
		// NOT clamped to GAME_STATES: a newer build's state is kept and simply matches
		// nothing here, which is a behaviour decision rather than silent data loss
		state: typeof data?.state === 'string' && data.state ? data.state : 'menu',
		round: num(data?.round, 0),
		startedAt: num(data?.startedAt, 0),
		// 21-E3: pause ACCOUNTING rides the replicated singleton, so every peer and a
		// late joiner agree on the same round clock. `pausedAt` is the live pause's
		// start stamp (0 = not paused), `pausedMs` the accumulated spans of the round.
		// Absent on an old payload = 0 = no pause ever, byte-identical.
		pausedAt: num(data?.pausedAt, 0),
		pausedMs: num(data?.pausedMs, 0),
		outcome: typeof data?.outcome === 'string' ? data.outcome : '',
		vars: data?.vars && typeof data.vars === 'object' ? { ...data.vars } : {},
		changedAt: num(data?.changedAt, 0)
	};
}

// ---- the seams gameSync fills ---------------------------------------------------
/** @type {((next: GameState) => void)|null} */
let broadcastHook = null;
/** @type {((before: GameState, after: GameState) => void)|null} */
let historyHook = null;

/** @param {(next: GameState) => void} fn */
export function registerGameBroadcast(fn) {
	broadcastHook = fn;
	return () => {
		if (broadcastHook === fn) broadcastHook = null;
	};
}

/** @param {(before: GameState, after: GameState) => void} fn */
export function registerGameHistory(fn) {
	historyHook = fn;
	return () => {
		if (historyHook === fn) historyHook = null;
	};
}

/**
 * THE ONE way the game state changes. Every caller — a node, the applier, undo, a restore —
 * comes through here, so the four never drift.
 * @param {Partial<GameState>} patch
 * @param {{silent?: boolean, stamp?: number, varsAt?: Record<string, number>}} [opts] `silent` skips history + broadcast
 *   (the applier path: a receiver must never re-broadcast, golden rule 1)
 * @returns {GameState}
 */
export function commitGameState(patch, opts = {}) {
	const before = get(gameState);
	// MONOTONIC. A trigger can fire several times inside one millisecond (a burst of
	// pulses, an undo right after an edit), and a latest-wins guard drops every write that
	// shares a stamp with the one before it — measured in the shader round.
	const after = normalizeGameState({
		...before,
		...patch,
		changedAt: opts.stamp ?? Math.max(sessionNow(), (before.changedAt ?? 0) + 1)
	});
	after.varsAt = opts.varsAt ?? stampVars(before, after);
	gameState.set(after);
	if (!opts.silent) {
		if (historyHook) historyHook(before, after);
		if (broadcastHook) broadcastHook(after);
	}
	return after;
}

/**
 * Move to a state. Entering `playing` re-stamps `startedAt` and bumps the round, which is
 * what makes a round timer and "how long have we been playing" derivable by every peer from
 * the same number — the sceneMusic transport shape.
 * @param {string} state @param {{outcome?: string, round?: number}} [opts]
 */
export function setGameState(state, opts = {}) {
	const before = get(gameState);
	const entering = state !== before.state;
	/** @type {Partial<GameState>} */
	const patch = { state, outcome: opts.outcome ?? (state === 'over' ? before.outcome : '') };
	if (state === 'playing' && entering) {
		// resuming FROM a pause keeps the round and its startedAt; a fresh start (from
		// menu/over) re-stamps and bumps the round. The pause span is banked either way.
		if (before.state === 'paused') {
			patch.pausedMs = before.pausedMs + (before.pausedAt ? sessionNow() - before.pausedAt : 0);
			patch.pausedAt = 0;
		} else {
			patch.startedAt = sessionNow();
			patch.round = opts.round ?? before.round + 1;
			patch.pausedAt = 0;
			patch.pausedMs = 0;
		}
	}
	if (state === 'paused' && entering) patch.pausedAt = sessionNow();
	if (state !== 'paused' && state !== 'playing' && entering) {
		// leaving the round entirely closes any live pause span
		patch.pausedAt = 0;
	}
	return commitGameState(patch);
}

/** Seconds since the current round started, off the shared stamp so every peer agrees.
 * 0 when nothing has started. */
export function gameElapsed() {
	// 21-E3: paused time does not count. The banked spans plus the LIVE span (a pause
	// still open) both come off, so a timer HUD freezes while paused instead of
	// counting through - which it measurably did.
	const { startedAt, pausedAt, pausedMs } = get(gameState);
	if (!startedAt) return 0;
	const live = pausedAt ? sessionNow() - pausedAt : 0;
	return Math.max(0, (sessionNow() - startedAt - pausedMs - live) / 1000);
}

// ---- 21-F2: what "a round" means to everything derived from it -------------------

/**
 * Has this scene's game shell ever been USED? A scene that never presses Start sits in
 * the DEFAULT `menu` with round 0 forever, and 21-E8's collectibles worked there on play
 * mode alone — so both rules below defer entirely to play mode until a round exists.
 * @param {GameState} g
 */
function shellInUse(g) {
	return (g.round ?? 0) > 0 || (g.startedAt ?? 0) > 0;
}

/**
 * 21-F2: is a ROUND underway right now? `paused` counts — pause is a shared game RULE
 * (21-E3) and the world holds its state through it — and a shell nobody has started
 * answers true, which is what keeps a Start-button-less scene behaving as it did.
 */
export function roundUnderway() {
	const g = get(gameState);
	if (!shellInUse(g)) return true;
	return g.state === 'playing' || g.state === 'paused';
}

/**
 * 21-F2 THE RESET RULE, DERIVED rather than wired. A round-scoped node (a collectible's
 * Latch and Once) treats every trigger stamp OLDER than this as never having happened:
 *
 *   null       no cutoff — the shell is not in use, so nothing is round-scoped
 *   a stamp    the current round's `startedAt`: a NEW round un-collects everything
 *   Infinity   menu / over — we are not in a round at all, so nothing before now counts.
 *              That is the "reset on return to menu" half of the same one rule.
 *
 * WHY DERIVED, and not a hidden reset edge or an imperative clear: both of those need
 * SOMEBODY to run them, so whoever pressed Start would have to broadcast a reset and a
 * late joiner would witness nothing at all. This reads the replicated singleton every
 * peer already agrees on, which means two peers cannot disagree and a joiner is right on
 * arrival. It also keeps latch/once PURE (E4): they gain one more replicated INPUT, not
 * a state of their own.
 * @returns {number|null} an epoch ms stamp, `Infinity`, or null
 */
export function roundCutoff() {
	const g = get(gameState);
	if (!shellInUse(g)) return null;
	if (g.state === 'playing' || g.state === 'paused') return g.startedAt || null;
	return Infinity;
}

/** @param {string} name @param {any} value */
export function setGameVar(name, value) {
	if (!name) return get(gameState);
	return commitGameState({ vars: { ...get(gameState).vars, [name]: value } });
}

/**
 * fix-agenttest 10: ONE WRITE PER EVENT for a SHARED Set Variable. Every peer runs the node from
 * the same replicated stamp, and each used to compute from its OWN current value and write the
 * whole singleton: a peer whose tick ran after another's write had landed counted the click
 * again ("add 1" ended at 2-3, and a toggle built as Set NOT Get flipped twice and cancelled out).
 * Now one peer — the authority — applies each event once, keyed by `rid` (the node id + the
 * stamp, which every peer derives the same way), and the write replicates as the ordinary
 * `game` message. The last GAMEVAR_RID_WINDOW rids are remembered.
 */
export const GAMEVAR_RID_WINDOW = 128;
/** @type {string[]} */
const appliedVarOps = [];

/**
 * Apply `{rid, name, op, value}` unless this rid was applied already. `op` add/subtract works
 * on this peer's current value; `set` writes `value`. Returns whether it wrote.
 * @param {{rid: string, name: string, op?: string, value?: any}} req
 */
export function applyGameVarOp(req) {
	if (!req || typeof req.rid !== 'string' || !req.rid || !req.name) return false;
	if (appliedVarOps.includes(req.rid)) return false;
	appliedVarOps.push(req.rid);
	if (appliedVarOps.length > GAMEVAR_RID_WINDOW) appliedVarOps.shift();
	const v = Number(req.value) || 0;
	const current = Number(get(gameState).vars?.[req.name]) || 0;
	setGameVar(req.name, req.op === 'add' ? current + v : req.op === 'subtract' ? current - v : v);
	return true;
}

/**
 * fix-agenttest 10: EACH VARIABLE CARRIES ITS OWN STAMP (`varsAt`). The singleton is latest-wins
 * whole, and every peer runs Set Game State from the same click: a peer that wrote `playing` a
 * moment after the authority's `score + 5` carried its own, older score with a NEWER stamp, and
 * the add was lost on every peer (measured in game-state). Now a write re-stamps only the
 * variables it changed (a removal leaves its stamp behind as a tombstone), and a receiver keeps,
 * per variable, the side with the newer stamp. A state with no `varsAt` at all (an older peer, a
 * restore) stamps every variable, present or absent, with its `changedAt` — exactly the
 * whole-singleton rule this replaces.
 * @param {any} state @param {string} name @returns {number} -1 = this side never had it
 */
function varStamp(state, name) {
	if (!state?.varsAt || typeof state.varsAt !== 'object') return Number(state?.changedAt) || 0;
	const at = Number(state.varsAt[name]);
	if (Number.isFinite(at)) return at;
	return Object.prototype.hasOwnProperty.call(state.vars ?? {}, name) ? Number(state.changedAt) || 0 : -1;
}

/** the stamps after a local write: changed, new or removed names take the write's stamp
 * @param {GameState} before @param {GameState} after @returns {Record<string, number>} */
function stampVars(before, after) {
	/** @type {Record<string, number>} */
	const at = {};
	const had = before.vars ?? {};
	for (const name of new Set([...Object.keys(had), ...Object.keys(after.vars), ...Object.keys(before.varsAt ?? {})])) {
		const inBefore = Object.prototype.hasOwnProperty.call(had, name);
		const inAfter = Object.prototype.hasOwnProperty.call(after.vars, name);
		if (inBefore !== inAfter || (inAfter && !Object.is(had[name], after.vars[name]))) at[name] = after.changedAt;
		else if (varStamp(before, name) >= 0) at[name] = varStamp(before, name);
	}
	return at;
}

/**
 * Merge an arriving game state into ours: the singleton fields follow the newer `changedAt`
 * (equal = theirs: the conn is ordered), each variable follows its own newer stamp (equal =
 * theirs). Returns null when nothing changes — an older state with no newer variable is refused.
 * @param {GameState} local @param {any} data @returns {GameState|null}
 */
export function mergeGameState(local, data) {
	const incoming = normalizeGameState(data);
	const theirs = incoming.changedAt >= (local.changedAt ?? 0);
	/** @type {Record<string, any>} */ const vars = {};
	/** @type {Record<string, number>} */ const varsAt = {};
	const names = new Set([...Object.keys(local.vars ?? {}), ...Object.keys(local.varsAt ?? {}), ...Object.keys(incoming.vars), ...Object.keys(incoming.varsAt ?? {})]);
	for (const name of names) {
		const inAt = varStamp(incoming, name);
		const loAt = varStamp(local, name);
		const winner = inAt >= loAt ? incoming : local;
		if (Object.prototype.hasOwnProperty.call(winner.vars ?? {}, name)) vars[name] = winner.vars[name];
		if (Math.max(inAt, loAt) >= 0) varsAt[name] = Math.max(inAt, loAt);
	}
	const base = theirs ? incoming : local;
	if (!theirs && JSON.stringify(vars) === JSON.stringify(local.vars ?? {})) return null;
	return { ...base, vars, varsAt, changedAt: base.changedAt };
}

/** @param {string} name @param {any} [fallback] */
export function gameVar(name, fallback = 0) {
	const v = get(gameState).vars?.[name];
	return v === undefined ? fallback : v;
}

/** Back to the start, for a Restart button. Keeps the round count, which is what makes
 * "round 3" meaningful across a session. */
export function resetGame() {
	return commitGameState({ state: 'menu', startedAt: 0, outcome: '' });
}

// ---- persistence: null when DEFAULT, so a scene with no game saves unchanged ----

/** @returns {any|null} */
export function gameStateSnapshot() {
	const s = get(gameState);
	const pristine =
		s.state === 'menu' && s.round === 0 && s.startedAt === 0 && !s.outcome && !Object.keys(s.vars).length;
	return pristine ? null : { state: s.state, round: s.round, startedAt: s.startedAt, outcome: s.outcome, vars: s.vars, changedAt: s.changedAt };
}

/**
 * A restore is an AUTHORITATIVE LOCAL WRITE and must beat the file's stale `changedAt`, so
 * it stamps fresh. `replicate` exists because loading a scene into a live room brings its
 * game with it (the jointsRestore / scenePostRestore precedent).
 * @param {any} payload @param {boolean} [replicate]
 */
export function gameStateRestore(payload, replicate = false) {
	if (!payload) {
		// a scene with no game field resets, or the previous scene's round would leak in
		gameState.set({ ...DEFAULT, changedAt: sessionNow() });
		if (replicate && broadcastHook) broadcastHook(get(gameState));
		return;
	}
	commitGameState(normalizeGameState(payload), { silent: !replicate, stamp: sessionNow() });
}

/** Test/serializer seam. */
export function clearGameState() {
	gameState.set({ ...DEFAULT });
}
