// 34 R2 — kit.score: THE SCORE, ONCE — what five games each built (and `setvariable add`, a
// per-peer read-modify-write that could bank one pickup twice, could not do safely).
//
//   total + per-player rows   the kit DOCUMENT: the authority adds, so a point is counted once
//                             however many peers saw the pulse (the stamp-derived request id)
//   who scored                the requesting peer, unless a player is named. A per-player pulse
//                             (a perPlayer On Click) is asked only by its player, so it credits
//                             them; a SHARED pulse is asked by every peer and credits whichever
//                             request the authority applied — name the player, or use a per-player
//                             trigger, when it matters who it was.
//   best                      per DEVICE (storage `score:<game>[:<level>]`), checked when a kit
//                             round ends: each device that beat its own best hears `newBest`
//   a new round               zeroes the scores by itself (the authority's tick sees the kit
//                             round number move) — `autoReset: false` in configure() opts out
//
// Results and leaderboards are READS: rows sorted by score, ties by id (deterministic on every
// peer), with the roster's names through the host's `nameOf` seam.

import spec from './score.spec.js';

const initial = () => ({ total: 0, players: {}, round: 0, autoReset: true });

/** @param {any} v @param {number} d */
const num = (v, d) => {
	const n = Number(v);
	return Number.isFinite(n) ? Math.max(-1e9, Math.min(1e9, n)) : d;
};

/** sorted rows (score desc, id asc) @param {Record<string, number>} players */
export function rankRows(players) {
	return Object.entries(players ?? {})
		.map(([id, score]) => ({ id, score: Number(score) || 0 }))
		.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export default {
	spec,
	initial,
	/** @param {any} raw */
	normalize(raw) {
		/** @type {Record<string, number>} */
		const players = {};
		for (const [id, v] of Object.entries(raw?.players && typeof raw.players === 'object' ? raw.players : {})) players[String(id).slice(0, 64)] = num(v, 0);
		return { total: num(raw?.total, 0), players, round: num(raw?.round, 0), autoReset: raw?.autoReset !== false };
	},
	ops: {
		/** @param {any} s @param {any[]} args @param {any} ctx */
		add(s, [amount, player], ctx) {
			// a point scored in the same frame a new round began counts in the NEW round
			const round = ctx.read('round')?.round ?? 0;
			if (s.autoReset && round && round !== s.round) s = { ...s, total: 0, players: {}, round };
			const n = num(amount, 0);
			if (!n) return { slice: s, result: { ok: true, total: s.total } };
			const who = String(player || ctx.from || '').slice(0, 64);
			const players = who ? { ...s.players, [who]: (s.players[who] ?? 0) + n } : s.players;
			const total = s.total + n;
			return { slice: { ...s, total, players }, events: [['scored', { amount: n, player: who, total, playerScore: who ? players[who] : 0 }]], result: { ok: true, total } };
		},
		/** @param {any} s @param {any[]} args */
		set(s, [amount, player]) {
			const n = num(amount, 0);
			const who = String(player || '').slice(0, 64);
			if (!who) return n === s.total ? { result: { ok: true } } : { slice: { ...s, total: n } };
			return s.players[who] === n ? { result: { ok: true } } : { slice: { ...s, players: { ...s.players, [who]: n } } };
		},
		/** @param {any} s @param {any[]} args */
		reset(s, [round]) {
			const r = round == null ? s.round : num(round, s.round);
			if (!s.total && !Object.keys(s.players).length && r === s.round) return { result: { ok: true } };
			return { slice: { ...s, total: 0, players: {}, round: r } };
		},
		/** @param {any} s @param {any[]} args */
		configure(s, [autoReset]) {
			const a = autoReset !== false;
			return a === s.autoReset ? { result: { ok: true } } : { slice: { ...s, autoReset: a } };
		}
	},
	/** a new kit round zeroes the scores (authority) @param {any} s @param {any} ctx */
	tick(s, ctx) {
		const round = ctx.read('round')?.round ?? 0;
		if (s.autoReset && round && round !== s.round) return [['reset', [round]]];
		return null;
	},
	/** @param {any} ctx */
	make(ctx) {
		const s = () => ctx.slice() ?? initial();
		/** the device-best key: the kit levels' game (+ level) when they are in use @returns {string} */
		const bestKey = () => {
			const lv = ctx.read('levels');
			const game = ctx.local.game || lv?.game || 'default';
			return 'score:' + game + (lv?.current ? ':' + lv.current : '');
		};
		const best = () => Number(ctx.storage?.get?.(bestKey(), 0)) || 0;
		// a kit round ending: every device checks its own best (and says so, locally)
		const onEnd = () => {
			if (!ctx.storage) return;
			const total = s().total;
			if (total > best()) {
				ctx.storage.set(bestKey(), total);
				ctx.emitLocal('newBest', { best: total });
			}
		};
		// listeners on the kit itself (the round piece's events), set up once
		if (!ctx.local.wired) {
			ctx.local.wired = true;
			const kit = ctx.kit?.();
			kit?.on?.('round.won', onEnd);
			kit?.on?.('round.lost', onEnd);
		}
		const nameOf = (/** @type {string} */ id) => (ctx.nameOf ? ctx.nameOf(id) : id);
		const rows = () =>
			rankRows(s().players).map((row, i) => ({ ...row, rank: i + 1, label: nameOf(row.id), me: row.id === ctx.me() }));
		return {
			/** @param {number} [amount] @param {string} [player] */
			add: (amount = 1, player = '') => ctx.request('add', [amount, player]),
			/** @param {number} amount @param {string} [player] */
			set: (amount, player = '') => ctx.request('set', [amount, player]),
			reset: () => ctx.request('reset', []),
			total: () => s().total,
			mine: () => s().players[ctx.me() ?? ''] ?? 0,
			best,
			leader: () => {
				const top = rows()[0];
				return top ? top.label : '';
			},
			on: ctx.on,
			extra: {
				/** one player's score @param {string} id */
				of: (id) => s().players[String(id)] ?? 0,
				/** the leaderboard: `[{id, label, score, rank, me}]`, best first @param {number} [n] */
				leaderboard: (n = 10) => rows().slice(0, Math.max(0, n)),
				/** what a results screen shows */
				results: () => ({ total: s().total, best: best(), players: rows() }),
				/** `{autoReset: false}`: keep scores across rounds (a match of several rounds) @param {any} opts */
				configure: (opts) => ctx.request('configure', [opts?.autoReset]),
				/** name the game the device best is filed under (default: the kit levels' game) @param {string} id */
				useGame: (id) => {
					ctx.local.game = String(id ?? '');
				}
			}
		};
	}
};
