// 34 R2 / proposal B5 — THE HEADLESS LOGIC SIM.
//
// N fake peers, a fake clock and an in-memory wire, no WebGL, no browser: game rules are proven
// here in milliseconds instead of in e2e minutes (proposal §1.2: ~85 % of all tool time was e2e
// runs or waiting on them). Each peer runs the REAL kit (src/lib/kit) over a host built from:
//
//   · the clock     one session clock the whole sim shares (`sim.now()`), advanced by
//                   `sim.advance(ms)` in frame steps — every peer ticks every step;
//   · the wire      `send` puts a structuredClone of the message on every OTHER connected
//                   peer's queue after `latency` ms; delivery runs it through the app's real
//                   `validateWireMessage` first, and a refused message FAILS the sim (a shape
//                   the app would drop is a bug in the sender, not a rule to prove);
//   · authority     the app's own `pickAuthority` over who this peer can see, the session host
//                   and the physics initiator — so "the host leaves mid-round" is `sim.leave`;
//   · storage       a per-peer Map (safeStorage's JSON semantics: values are copied);
//   · the game      a per-peer fake of core's game singleton (gameState.js's transitions:
//                   entering `playing` from menu/over bumps the round and re-stamps
//                   `startedAt`, pause banks its span), replicated as `{type: 'game'}`
//                   latest-wins on `changedAt` exactly like gameSync.
//
// A peer that JOINS gets the handshake the app sends: every connected peer's kit snapshot and
// game state (`sim.join`). Partitions (`sim.partition`) drop messages between two groups.

import { createKit } from '../../../src/lib/kit/core.js';
import { KIT_PIECES } from '../../../src/lib/kit/index.js';
import { pickAuthority } from '../../../src/lib/kit/authority.js';
import { validateWireMessage } from '../../../src/lib/wireValidate.js';

/** one frame of the sim, ms */
export const FRAME_MS = 16;

/**
 * A fake of core's game singleton (gameState.js) on the sim clock.
 * @param {() => number} now @param {(msg: any) => void} send
 */
export function makeFakeGame(now, send) {
	let g = { state: 'menu', round: 0, startedAt: 0, pausedAt: 0, pausedMs: 0, outcome: '', vars: {}, changedAt: 0 };
	/** @param {any} patch */
	const commit = (patch) => {
		g = { ...g, ...patch, changedAt: Math.max(now(), g.changedAt + 1) };
		send({ type: 'game', ...g });
		return g;
	};
	return {
		get: () => g,
		/** gameState.setGameState's transitions @param {string} state @param {{outcome?: string, round?: number}} [opts] */
		set(state, opts = {}) {
			const entering = state !== g.state;
			/** @type {any} */
			const patch = { state, outcome: opts.outcome ?? (state === 'over' ? g.outcome : '') };
			if (state === 'playing' && entering) {
				if (g.state === 'paused') {
					patch.pausedMs = g.pausedMs + (g.pausedAt ? now() - g.pausedAt : 0);
					patch.pausedAt = 0;
				} else {
					patch.startedAt = now();
					patch.round = opts.round ?? g.round + 1;
					patch.pausedAt = 0;
					patch.pausedMs = 0;
				}
			}
			if (state === 'paused' && entering) patch.pausedAt = now();
			if (state !== 'paused' && state !== 'playing' && entering) patch.pausedAt = 0;
			return commit(patch);
		},
		/** a fresh round even while playing (what kit.round.restart needs from core) */
		restart() {
			return commit({ state: 'playing', outcome: '', startedAt: now(), round: g.round + 1, pausedAt: 0, pausedMs: 0 });
		},
		/** gameSync.applyRemoteGameState @param {any} data */
		receive(data) {
			if ((data.changedAt ?? 0) < g.changedAt) return false;
			const { type, ...rest } = data;
			g = { ...g, ...rest };
			return true;
		}
	};
}

/** @param {() => number} now */
function makeStorage(now) {
	/** @type {Map<string, string>} */
	const map = new Map();
	return {
		map,
		/** @param {string} key @param {any} [fallback] */
		get(key, fallback = null) {
			const raw = map.get(key);
			if (raw === undefined) return fallback;
			try {
				return JSON.parse(raw);
			} catch {
				return fallback;
			}
		},
		/** @param {string} key @param {any} value */
		set(key, value) {
			map.set(key, JSON.stringify(value));
			return true;
		},
		/** @param {string} key */
		remove(key) {
			map.delete(key);
		},
		now
	};
}

/**
 * @param {{peers?: string[], latency?: number, host?: string | null, initiator?: string | null,
 *   pieces?: any[], rules?: any, onPeer?: (p: any, sim: any) => void}} [opts]
 *   `onPeer`: called for every peer as it is added — a test layer (34-behaviours' behaviourSim)
 *   hangs `p.extra = {receive(msg, from) -> handled, tick(), snapshot() -> msgs}` on it
 */
export function createSim(opts = {}) {
	let clock = 1_000_000; // session ms; non-zero so "never" (0) is distinguishable
	const now = () => clock;
	const latency = opts.latency ?? 30;
	const pieces = opts.pieces ?? KIT_PIECES;
	/** @type {Map<string, any>} */
	const peers = new Map();
	/** messages in flight @type {{at: number, from: string, to: string, msg: any}[]} */
	let queue = [];
	/** every message the wire carried (for assertions) @type {{at: number, from: string, to: string, msg: any}[]} */
	const log = [];
	/** groups that cannot hear each other @type {Set<string>[] | null} */
	let partition = null;
	const sim = {
		host: opts.host ?? null,
		initiator: opts.initiator ?? null,
		now,
		peers,
		log,
		/** messages the app's validator refused (must stay empty) @type {any[]} */
		refused: /** @type {any[]} */ ([]),
		/** @param {string} id */
		peer: (id) => peers.get(id),
		/** add a peer (not yet connected to anyone — `join` connects it) @param {string} id */
		add(id) {
			/** @type {any} */
			const p = { id, connected: new Set(), kit: null, game: null, storage: makeStorage(now), received: 0 };
			/** @param {any} msg */
			const send = (msg) => {
				for (const to of p.connected) {
					if (partition && !partition.some((g) => g.has(id) && g.has(to))) continue;
					const entry = { at: clock + latency, from: id, to, msg: structuredClone(msg) };
					queue.push(entry);
					log.push(entry);
				}
			};
			p.game = makeFakeGame(now, send);
			p.kit = createKit(
				{
					me: () => id,
					clock: { now },
					send,
					isAuthority: () => pickAuthority({ me: id, peers: [...p.connected], host: sim.host, initiator: sim.initiator }) === id,
					authorityId: () => pickAuthority({ me: id, peers: [...p.connected], host: sim.host, initiator: sim.initiator }),
					storage: p.storage,
					game: p.game,
					rules: opts.rules ?? null,
					emit: (piece, event, payload, o) => (p.emitted ??= []).push({ piece, event, payload, at: clock, ...(o?.local ? { local: true } : {}) })
				},
				pieces
			);
			p.send = send;
			peers.set(id, p);
			opts.onPeer?.(p, sim);
			return p;
		},
		/**
		 * Connect `id` to every peer already present and run the handshake both ways: each side
		 * pushes its kit snapshot and its game state (the app's sendHandshake order).
		 * @param {string} id
		 */
		join(id) {
			const p = peers.get(id) ?? sim.add(id);
			for (const other of peers.values()) {
				if (other.id === id) continue;
				other.connected.add(id);
				p.connected.add(other.id);
			}
			for (const other of peers.values()) {
				if (other.id === id) continue;
				for (const msg of other.kit.snapshots()) queue.push({ at: clock + latency, from: other.id, to: id, msg });
				queue.push({ at: clock + latency, from: other.id, to: id, msg: { type: 'game', ...other.game.get() } });
				for (const msg of other.extra?.snapshot?.() ?? []) queue.push({ at: clock + latency, from: other.id, to: id, msg });
				for (const msg of p.kit.snapshots()) queue.push({ at: clock + latency, from: id, to: other.id, msg });
				queue.push({ at: clock + latency, from: id, to: other.id, msg: { type: 'game', ...p.game.get() } });
				for (const msg of p.extra?.snapshot?.() ?? []) queue.push({ at: clock + latency, from: id, to: other.id, msg });
			}
			return p;
		},
		/** the peer drops off the mesh (closes every connection; its in-flight messages are lost)
		 * @param {string} id */
		leave(id) {
			for (const other of peers.values()) other.connected.delete(id);
			queue = queue.filter((m) => m.from !== id && m.to !== id);
			peers.delete(id);
		},
		/** only peers in the same group hear each other (null heals) @param {string[][] | null} groups */
		partition(groups) {
			partition = groups ? groups.map((g) => new Set(g)) : null;
		},
		/** deliver everything due by now */
		deliver() {
			let guard = 0;
			while (guard++ < 10_000) {
				const due = queue.filter((m) => m.at <= clock).sort((a, b) => a.at - b.at);
				if (!due.length) return;
				queue = queue.filter((m) => m.at > clock);
				for (const m of due) {
					const to = peers.get(m.to);
					if (!to) continue;
					if (!validateWireMessage(m.msg)) {
						sim.refused.push(m);
						throw new Error('wireValidate refused a ' + m.msg?.type + ' from ' + m.from + ': ' + JSON.stringify(m.msg).slice(0, 300));
					}
					to.received++;
					if (to.extra?.receive?.(m.msg, m.from)) continue;
					if (m.msg.type === 'game') to.game.receive(m.msg);
					else to.kit.receive(m.msg, m.from);
				}
			}
		},
		/** one frame: deliver, then every peer ticks @param {number} [ms] */
		step(ms = FRAME_MS) {
			clock += ms;
			sim.deliver();
			for (const p of [...peers.values()]) {
				p.kit.tick();
				p.extra?.tick?.();
			}
			sim.deliver();
		},
		/** run the sim forward @param {number} ms @param {number} [frame] */
		advance(ms, frame = FRAME_MS) {
			const end = clock + ms;
			while (clock < end) sim.step(Math.min(frame, end - clock));
		},
		/** advance until every message is delivered (and a frame after) */
		settle(max = 5000) {
			let t = 0;
			do {
				sim.step();
				t += FRAME_MS;
			} while (queue.length && t < max);
			sim.step();
		},
		/** who each peer believes is the authority */
		authorities: () => [...peers.values()].map((p) => pickAuthority({ me: p.id, peers: [...p.connected], host: sim.host, initiator: sim.initiator })),
		/** messages of a type on the wire so far @param {string} type */
		sent: (type) => log.filter((m) => m.msg.type === type)
	};
	for (const id of opts.peers ?? ['a', 'b']) sim.add(id);
	for (const id of opts.peers ?? ['a', 'b']) sim.join(id);
	sim.settle();
	return sim;
}

/** every peer's view of one slice, for "all peers agree" assertions @param {any} sim @param {string} piece */
export function slicesOf(sim, piece) {
	return [...sim.peers.values()].map((p) => JSON.stringify(p.kit.slice(piece)));
}

/** do all peers hold the same document? @param {any} sim */
export function agree(sim) {
	const docs = [...sim.peers.values()].map((p) => JSON.stringify(p.kit.doc().slices));
	return docs.every((d) => d === docs[0]);
}
