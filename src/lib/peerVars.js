// 21-G4 — PEER-OWNED VARIABLES: a number that belongs to ONE player.
//
// THE GAP THIS FILLS. `gameState.vars` is the game's shared numbers — one score, one
// difficulty, one round — and there was no second kind. So "my laps", "my gems", "how
// far has each of us got" had nowhere to live, and the only thing a leaderboard could
// have been built from was a shared map that every peer writes.
//
// WHY IT IS NOT THE `playmode` MAP, which is otherwise the same shape and one module
// over. `gamePresence` DELETES a peer's row the moment they leave play — that is the
// whole point of it, absence means "in the editor". A player's lap count must survive
// their own Esc: only a DISCONNECT drops it, and the owner re-announces on reconnect
// (the `getmodulestate` reply below). Two different lifetimes cannot share one message.
//
// THE OWNERSHIP RULE, and it is the entire design: EACH PEER BROADCASTS ONLY ITS OWN
// FULL MAP, and nothing else ever writes that row. That is what makes this immune to
// the documented `setvariable` `add` race — a shared `add` is a per-peer
// read-modify-write against a latest-wins singleton, so two peers computing
// `current + 1` off skewed flow ticks both write the same number and one pickup banks
// once instead of twice (21-F3 measured gems=2 for a single click). Here there is
// exactly ONE writer per row and no other peer's write can reach it, so a lost update
// is not a race that is unlikely — it is a message that does not exist.
//
// ROUND SEMANTICS: NOTHING RESETS THESE AUTOMATICALLY, and that is deliberate.
//   * `gameState.vars` already behaves this way (21-F3's `collectibleStats` comment says
//     so out loud: "it keeps its value through a round bump — nothing resets `vars`"),
//     so per-player vars keep ONE rule for both scopes instead of inventing a second.
//   * The things people actually keep here — laps, a campaign score, a personal best —
//     outlive a round by definition. A racing game that resets laps on a new round is a
//     game DECISION, not a property of the storage.
//   * 21-F2's collectible reset does not need it: the reset is DERIVED from `perRound`
//     LATCHES against the replicated round, and `collectcount` reads those latches
//     rather than the variable, so a per-player collectible chain already reads
//     un-collected on a new round with no clear of any kind.
//   * And an automatic clear would need a WRITER and a MOMENT. Whoever bumped the round
//     would have to broadcast N clears (one per peer, which breaks the ownership rule
//     outright) and a late joiner would witness neither.
// A game that wants a reset AUTHORS one, and it is already authorable today: an
// `On Game State (playing)` node into a `Set Variable` with `scope: 'player'`, `op: 'set'`,
// `value: 0`. Every peer reaches that transition itself and each zeroes its OWN row —
// which is the ownership rule doing the work rather than a hook fighting it.
//
// A LEAF: svelte stores plus `appStore` (itself store-only). Nothing here is reachable
// from history's import subtree and nothing here registers a history kind, so
// `flowRuntime` imports it statically.

import { writable, derived, get } from 'svelte/store';
import { peers, userdata } from '../stores/appStore';

/** How many names one peer may hold. A leaderboard, not a database — and a bound is
 * what keeps a runaway graph from putting an unbounded map on the wire. */
const NAME_LIMIT = 64;

/** OUR OWN row: `name -> number`. The one map this peer writes.
 * @type {import('svelte/store').Writable<Record<string, number>>} */
export const peerVarsMine = writable({});

/** EVERY OTHER peer's row, `peerId -> {name -> number}`. Absent = that peer has never
 * set one, which reads as 0 everywhere — the `playmode` absence rule.
 * @type {import('svelte/store').Writable<Record<string, Record<string, number>>>} */
export const peerVarsRemote = writable({});

/** Our own peer id, or '' before the signaling link has one. */
function myPeerId() {
	/** @type {any} */
	const peer = get(peers);
	return String(peer?.peer?.id ?? '');
}

/** The key our own row is filed under in the merged view. `'me'` is the pre-id
 * fallback — a headless page or the moment before the peer opens — so a reader is
 * never handed a map with an empty-string key it has to special-case. */
export const LOCAL_KEY = 'me';

/**
 * EVERY peer's rows, ours included, keyed by peer id. This is what a leaderboard, a
 * `sum`/`max` read and the debug element all consume, so there is one merge and not
 * three. `peers` is a dependency because our own KEY changes when the peer id arrives
 * (the store ticks on every open/close).
 * @type {import('svelte/store').Readable<Record<string, Record<string, number>>>}
 */
export const peerVarsAll = derived([peerVarsMine, peerVarsRemote, peers], ([mine, remote, _peer]) => {
	void _peer;
	const id = myPeerId() || LOCAL_KEY;
	return { ...remote, [id]: { ...mine } };
});

/** One row, coerced. Non-numbers are DROPPED rather than zeroed: a value we cannot
 * read is not a score of nothing, and keeping the key would put a lie in every sum.
 * @param {any} vars @returns {Record<string, number>} */
export function normalizePeerVars(vars) {
	/** @type {Record<string, number>} */
	const out = {};
	if (!vars || typeof vars !== 'object') return out;
	let count = 0;
	for (const key of Object.keys(vars)) {
		if (count >= NAME_LIMIT) break;
		const name = String(key).trim();
		if (!name) continue;
		const n = Number(vars[key]);
		if (!Number.isFinite(n)) continue;
		out[name] = n;
		count++;
	}
	return out;
}

// ---- outbound ---------------------------------------------------------------------

/** Monotonic per-message stamp. A gesture can write several times inside one
 * millisecond (the documented latest-wins trap), so it bumps past the previous value
 * rather than trusting the clock. */
let sentAt = 0;
/** what we last put on the wire, so an unchanged map sends nothing @type {string} */
let sentJson = '';

/** Put our whole row on the wire. Whole-map rather than per-name: a row is at most a
 * handful of small numbers, one message keeps ONE latest-wins rule, and a per-name
 * protocol would need its own ordering and tombstones for nothing. */
export function broadcastPeerVars(force = false) {
	const vars = get(peerVarsMine);
	const json = JSON.stringify(vars);
	if (!force && json === sentJson) return false;
	sentJson = json;
	/** @type {any} */
	const peer = get(peers);
	const id = peer?.peer?.id;
	if (!id) return false;
	sentAt = Math.max(Date.now(), sentAt + 1);
	peer.send({ type: 'peervars', peerId: id, vars: { ...vars }, at: sentAt });
	return true;
}

/**
 * Tell a newly connected peer what we hold — the late-joiner reply, riding the
 * `getmodulestate` request beside `sendPlayModeState()`. SILENT when our row is empty,
 * because absence already means "nothing", and an unconditional reply would put a
 * message on the wire for every peer in a scene that has no per-player variable at all.
 */
export function sendPeerVarsState() {
	if (!Object.keys(get(peerVarsMine)).length) return false;
	return broadcastPeerVars(true);
}

/** Write ONE of our own names and announce it. The only write path — everything else
 * (the `setvariable` node's `player` scope, a module, a test) comes through here, so
 * the store and the wire cannot drift. @param {string} name @param {any} value */
export function setPeerVar(name, value) {
	const key = String(name ?? '').trim();
	if (!key) return get(peerVarsMine);
	const n = Number(value);
	if (!Number.isFinite(n)) return get(peerVarsMine);
	peerVarsMine.update((held) => {
		if (held[key] === n) return held;
		if (!(key in held) && Object.keys(held).length >= NAME_LIMIT) return held;
		return { ...held, [key]: n };
	});
	broadcastPeerVars();
	return get(peerVarsMine);
}

/** @param {string} name @param {number} delta */
export function addPeerVar(name, delta) {
	return setPeerVar(name, myPeerVar(name, 0) + (Number(delta) || 0));
}

// ---- inbound ----------------------------------------------------------------------

/** the newest stamp we have accepted per sender, so a reordered message cannot
 * resurrect an older row @type {Map<string, number>} */
const seenAt = new Map();

/** @param {any} data @returns {boolean} */
export function applyRemotePeerVars(data) {
	const id = String(data?.peerId ?? '');
	if (!id) return false;
	// STRICTLY older only: an equal stamp arrived later over an ordered DataConnection,
	// so it is the newer document (the shader/hudDocs monotonic-stamp rule)
	const at = Number(data?.at);
	if (Number.isFinite(at)) {
		const held = seenAt.get(id);
		if (held !== undefined && at < held) return false;
		seenAt.set(id, at);
	}
	const vars = normalizePeerVars(data?.vars);
	peerVarsRemote.update((map) => {
		// an EMPTY row is recorded by DELETING, so "holds nothing" has one representation
		if (!Object.keys(vars).length) {
			if (!(id in map)) return map;
			const next = { ...map };
			delete next[id];
			return next;
		}
		return { ...map, [id]: vars };
	});
	return true;
}

/** A peer left for good. Their row goes with them — a scoreboard must not keep a ghost
 * in it — and their stamp memory too, so a RECONNECT (which re-announces from
 * `getmodulestate`) is accepted whatever its clock says. @param {string} peerId */
export function dropPeerVars(peerId) {
	const id = String(peerId ?? '');
	seenAt.delete(id);
	peerVarsRemote.update((map) => {
		if (!(id in map)) return map;
		const next = { ...map };
		delete next[id];
		return next;
	});
}

// ---- reading ----------------------------------------------------------------------

/** @param {string} name @param {number} [fallback] */
export function myPeerVar(name, fallback = 0) {
	const v = get(peerVarsMine)[String(name ?? '').trim()];
	return v === undefined ? fallback : v;
}

/** @param {string} peerId @param {string} name @param {number} [fallback] */
export function peerVarOf(peerId, name, fallback = 0) {
	const all = get(peerVarsAll);
	const key = String(peerId ?? '');
	const row = all[key] ?? (key === myPeerId() || key === LOCAL_KEY ? get(peerVarsMine) : undefined);
	const v = row?.[String(name ?? '').trim()];
	return v === undefined ? fallback : v;
}

/** @param {string} name */
export function peerVarSum(name) {
	const key = String(name ?? '').trim();
	let total = 0;
	for (const row of Object.values(get(peerVarsAll))) total += Number(row?.[key] ?? 0) || 0;
	return total;
}

/** The highest value anybody holds — "who is winning", as a number. 0 when nobody has
 * one, which is the same answer as everybody holding 0. @param {string} name */
export function peerVarMax(name) {
	const key = String(name ?? '').trim();
	let best = 0;
	let any = false;
	for (const row of Object.values(get(peerVarsAll))) {
		const v = row?.[key];
		if (v === undefined) continue;
		if (!any || v > best) best = v;
		any = true;
	}
	return any ? best : 0;
}

/** Every name anybody holds, sorted — the debug element and any future picker. */
export function peerVarNames() {
	/** @type {Set<string>} */
	const names = new Set();
	for (const row of Object.values(get(peerVarsAll))) for (const key of Object.keys(row ?? {})) names.add(key);
	return [...names].sort();
}

/**
 * THE LEADERBOARD, derived. One row per peer in the ROSTER — names come from the
 * already-replicated `userdata` (moduleSDK's `peerNames()` reads the same slots), and
 * the values from the already-replicated per-peer rows, so a scoreboard needs NOTHING
 * on the wire of its own: every peer computes the identical list (golden rule 8).
 *
 * A peer in the roster with no row scores 0 rather than being omitted — a scoreboard
 * that hides the person on nothing is a scoreboard that looks broken to them.
 * @param {string} name
 * @param {{order?: 'desc'|'asc'}} [opts]
 * @returns {{id: string, name: string, value: number, me: boolean, rank: number}[]}
 */
export function leaderboardRows(name, opts = {}) {
	const key = String(name ?? '').trim();
	const all = get(peerVarsAll);
	const myId = myPeerId();
	/** @type {any[]} */
	const roster = /** @type {any} */ (get(userdata)) ?? [];
	/** @type {{id: string, name: string, value: number, me: boolean, rank: number}[]} */
	const rows = [];
	/** @type {Set<string>} */
	const placed = new Set();
	for (const entry of roster) {
		const id = String(entry?.[0] ?? '');
		if (!id || placed.has(id)) continue;
		placed.add(id);
		const me = id === myId;
		const row = me ? get(peerVarsMine) : all[id];
		rows.push({
			id,
			name: String(entry?.[1] ?? '') || (me ? 'Me' : 'peer ' + id.slice(0, 4)),
			value: Number(row?.[key] ?? 0) || 0,
			me,
			rank: 0
		});
	}
	// ...and anybody holding a value who is not in the roster (a row that arrived before
	// the roster did, which is the ordinary late-joiner race)
	for (const id of Object.keys(all)) {
		if (placed.has(id)) continue;
		const value = Number(all[id]?.[key] ?? 0) || 0;
		if (!value && id !== LOCAL_KEY) continue;
		if (id === LOCAL_KEY && (myId || placed.has(myId))) continue;
		placed.add(id);
		rows.push({ id, name: id === LOCAL_KEY ? 'Me' : 'peer ' + id.slice(0, 4), value, me: id === LOCAL_KEY, rank: 0 });
	}
	const dir = opts.order === 'asc' ? 1 : -1;
	// id as the tie-break, so two peers on the same score are in the SAME order on both
	// screens — a scoreboard that reshuffles per viewer is a scoreboard nobody trusts
	rows.sort((a, b) => (a.value === b.value ? (a.id < b.id ? -1 : 1) : (a.value - b.value) * dir));
	rows.forEach((row, i) => (row.rank = i + 1));
	return rows;
}

/**
 * The leaderboard as the STRINGS a HUD List holds. `{name}` / `{v}` / `{rank}` are the
 * tokens, so the format is authored on the node rather than hardcoded here.
 * @param {string} name
 * @param {{order?: 'desc'|'asc', format?: string, decimals?: number, limit?: number}} [opts]
 * @returns {string[]}
 */
export function leaderboardText(name, opts = {}) {
	const format = String(opts.format ?? '{name} — {v}');
	const decimals = Math.max(0, Math.min(3, Math.round(Number(opts.decimals) || 0)));
	const limit = Math.max(1, Math.min(NAME_LIMIT, Math.round(Number(opts.limit) || 20)));
	return leaderboardRows(name, opts)
		.slice(0, limit)
		.map((row) =>
			format
				.split('{name}')
				.join(row.name)
				.split('{v}')
				.join(row.value.toFixed(decimals))
				.split('{rank}')
				.join(String(row.rank))
		);
}

// ---- lifecycle --------------------------------------------------------------------

/**
 * Forget everything, ours included, and re-announce an EMPTY row so peers drop ours too
 * — silence would leave our last score standing on every other screen.
 *
 * DELIBERATELY NOT WIRED INTO A SCENE LOAD, unlike `hudValues`, which a load clears
 * because a menu's slider positions belong to the game you just left. A per-player
 * number is the opposite: 21-F4 travel exists so a CAMPAIGN can hop between scenes
 * carrying its state, and wiping laps or a personal best at every hop would be the
 * automatic reset this module's header argues against, arriving through a side door.
 * A game that wants the clear authors it (a `scope: 'player'` Set Variable), and this
 * is the explicit seam for a suite or a module that means it.
 */
export function clearPeerVars(announce = true) {
	peerVarsMine.set({});
	peerVarsRemote.set({});
	seenAt.clear();
	if (announce) {
		/** @type {any} */
		const peer = get(peers);
		const id = peer?.peer?.id;
		if (id) {
			sentJson = '{}';
			sentAt = Math.max(Date.now(), sentAt + 1);
			peer.send({ type: 'peervars', peerId: id, vars: {}, at: sentAt });
			return;
		}
	}
	sentJson = '';
}

/** Test/debug view. */
export function peerVarsDebug() {
	return {
		mine: { ...get(peerVarsMine) },
		remote: JSON.parse(JSON.stringify(get(peerVarsRemote))),
		all: JSON.parse(JSON.stringify(get(peerVarsAll))),
		myId: myPeerId(),
		names: peerVarNames(),
		sentJson,
		sentAt
	};
}
