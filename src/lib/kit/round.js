// 34 R2 — kit.round: THE PHASE MACHINE every game re-built (football game.js:65, waves hud.js:139,
// 7 setgamestate + 6 hudbutton nodes per template):
//
//     menu ──start──▶ intro ──(intro s)──▶ playing ⇄ paused
//                                            │ win / lose / the clock runs out
//                                            ▼
//                                       won | lost ──(outro s)──▶ results ──start──▶ intro …
//     restart: from ANY phase straight to a fresh intro (no reset → Delay 0.2 → play chain)
//
// ONE WRITER: every transition is an op the authority applies; the intro's end, the time limit
// and the outro are DERIVED from the phase stamp and turned into ops by the authority's tick, so a
// late joiner reads the same countdown and an authority that leaves mid-intro hands the moment to
// the next one (it fires once — the sim proves it).
//
// THE GAME SINGLETON (core's gameState) is DRIVEN from here, so the K3 shell, HUD `showWhile`
// screens, perRound latches and every existing Set Game State node keep working:
//   intro/playing -> 'playing' (a fresh core round at `start`, so perRound content resets)
//   paused -> 'paused' · won/lost/results -> 'over' (outcome 'won'/'lost' + reason) · menu -> 'menu'
// and the other way: a game-state change the kit did not make (a Set Game State node, the
// shell's admin reset) is ADOPTED by the authority — playing⇄paused and back to the menu.
//
// A piece with no imports beyond its spec: the sim runs it with a fake game singleton. Its only
// side effect is that game-singleton write, made inside the authority's reducer (once per change).

import spec from './round.spec.js';

export const PHASES = ['menu', 'intro', 'playing', 'paused', 'won', 'lost', 'results'];
const RUNNING = ['intro', 'playing', 'paused'];

const initial = () => ({
	phase: 'menu',
	round: 0,
	phaseAt: 0,
	startedAt: 0,
	pausedAt: 0,
	pausedMs: 0,
	intro: 3,
	limit: 0,
	extra: 0,
	timeout: 'lose',
	outro: 2,
	outcome: ''
});

/** @param {any} v @param {number} lo @param {number} hi @param {number} d */
function num(v, lo, hi, d) {
	const n = Number(v);
	return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d;
}

/** seconds of PLAY in this round, at `now` (intro and pauses excluded) @param {any} s @param {number} now */
export function playSeconds(s, now) {
	if (!s.startedAt || !['playing', 'paused', 'won', 'lost', 'results'].includes(s.phase)) return 0;
	const end = s.phase === 'playing' ? now : s.phase === 'paused' ? s.pausedAt : s.phaseAt;
	return Math.max(0, (end - s.startedAt - s.pausedMs) / 1000);
}

/** @param {any} s @param {number} now */
export function remainingSeconds(s, now) {
	if (!s.limit) return 0;
	return Math.max(0, s.limit + s.extra - playSeconds(s, now));
}

export default {
	spec,
	initial,
	/** @param {any} raw */
	normalize(raw) {
		const d = initial();
		return {
			...d,
			...(raw ?? {}),
			phase: PHASES.includes(raw?.phase) ? raw.phase : 'menu',
			round: num(raw?.round, 0, 1e9, 0),
			phaseAt: num(raw?.phaseAt, 0, Infinity, 0),
			startedAt: num(raw?.startedAt, 0, Infinity, 0),
			pausedAt: num(raw?.pausedAt, 0, Infinity, 0),
			pausedMs: num(raw?.pausedMs, 0, Infinity, 0),
			intro: num(raw?.intro, 0, 30, d.intro),
			limit: num(raw?.limit, 0, 3600, 0),
			extra: num(raw?.extra, 0, 36000, 0),
			timeout: raw?.timeout === 'win' ? 'win' : 'lose',
			outro: num(raw?.outro, 0, 30, d.outro),
			outcome: typeof raw?.outcome === 'string' ? raw.outcome.slice(0, 120) : ''
		};
	},
	ops: {
		/** @param {any} s @param {any[]} args */
		configure(s, [intro, limit, timeout, outro]) {
			const next = {
				...s,
				intro: num(intro, 0, 30, s.intro),
				limit: num(limit, 0, 3600, s.limit),
				timeout: timeout === 'win' ? 'win' : timeout === 'lose' ? 'lose' : s.timeout,
				outro: num(outro, 0, 30, s.outro)
			};
			return JSON.stringify(next) === JSON.stringify(s) ? { result: { ok: true } } : { slice: next };
		},
		/** @param {any} s @param {any[]} _a @param {any} ctx */
		start(s, _a, ctx) {
			if (RUNNING.includes(s.phase)) return { result: { ok: false, reason: 'a round is already running' } };
			return begin(s, ctx);
		},
		/** @param {any} s @param {any[]} _a @param {any} ctx */
		restart(s, _a, ctx) {
			return begin(s, ctx);
		},
		/** @param {any} s @param {any[]} _a @param {any} ctx */
		go(s, _a, ctx) {
			if (s.phase !== 'intro') return { result: { ok: false, reason: 'not in the intro' } };
			const now = ctx.now();
			return { slice: { ...s, phase: 'playing', phaseAt: now, startedAt: now, pausedAt: 0, pausedMs: 0 }, events: [['go', { round: s.round }]] };
		},
		/** @param {any} s @param {any[]} args @param {any} ctx */
		pause(s, [fromGame], ctx) {
			if (s.phase !== 'playing') return { result: { ok: false, reason: 'not playing' } };
			const now = ctx.now();
			if (!fromGame) writeGame(ctx, () => ctx.game?.set?.('paused'));
			return { slice: { ...s, phase: 'paused', pausedAt: now }, events: [['paused', { round: s.round }]] };
		},
		/** @param {any} s @param {any[]} args @param {any} ctx */
		resume(s, [fromGame], ctx) {
			if (s.phase !== 'paused') return { result: { ok: false, reason: 'not paused' } };
			const now = ctx.now();
			if (!fromGame) writeGame(ctx, () => ctx.game?.set?.('playing'));
			return {
				slice: { ...s, phase: 'playing', pausedMs: s.pausedMs + Math.max(0, now - s.pausedAt), pausedAt: 0 },
				events: [['resumed', { round: s.round }]]
			};
		},
		/** @param {any} s @param {any[]} args @param {any} ctx */
		win(s, [reason], ctx) {
			return end(s, 'won', reason, ctx);
		},
		/** @param {any} s @param {any[]} args @param {any} ctx */
		lose(s, [reason], ctx) {
			return end(s, 'lost', reason, ctx);
		},
		/** @param {any} s @param {any[]} args */
		extend(s, [seconds]) {
			if (!RUNNING.includes(s.phase)) return { result: { ok: false, reason: 'no round is running' } };
			const add = num(seconds, 0, 600, 0);
			return add ? { slice: { ...s, extra: s.extra + add } } : { result: { ok: true } };
		},
		/** @param {any} s @param {any[]} _a @param {any} ctx */
		results(s, _a, ctx) {
			if (s.phase !== 'won' && s.phase !== 'lost') return undefined;
			return { slice: { ...s, phase: 'results', phaseAt: ctx.now() }, events: [['results', { round: s.round, outcome: s.outcome, won: s.phase === 'won' }]] };
		},
		/** @param {any} s @param {any[]} args @param {any} ctx */
		toMenu(s, [fromGame], ctx) {
			if (s.phase === 'menu') return { result: { ok: true } };
			if (!fromGame) writeGame(ctx, () => ctx.game?.set?.('menu', { outcome: '' }));
			return { slice: { ...s, phase: 'menu', phaseAt: ctx.now(), pausedAt: 0 }, events: [['menu', { round: s.round }]] };
		}
	},
	/** the authority's clock: due moments become ops, and a game-state change the kit did not
	 * make is adopted @param {any} s @param {any} ctx */
	tick(s, ctx) {
		const now = ctx.now();
		const local = ctx.local;
		// adopt what somebody else did to core's game singleton
		const g = ctx.game?.get?.();
		if (g && g.changedAt !== local.gameSeen) {
			const ours = local.gameWritten != null && g.changedAt === local.gameWritten;
			local.gameSeen = g.changedAt;
			if (!ours && local.gameSeenOnce) {
				if (g.state === 'paused' && s.phase === 'playing') return [['pause', [true]]];
				if (g.state === 'playing' && s.phase === 'paused') return [['resume', [true]]];
				if (g.state === 'menu' && s.phase !== 'menu') return [['toMenu', [true]]];
			}
			local.gameSeenOnce = true;
		}
		if (s.phase === 'intro' && now - s.phaseAt >= s.intro * 1000) return [['go', []]];
		if (s.phase === 'playing' && s.limit && remainingSeconds(s, now) <= 0)
			return [[s.timeout === 'win' ? 'win' : 'lose', ['time']]];
		if ((s.phase === 'won' || s.phase === 'lost') && now - s.phaseAt >= s.outro * 1000) return [['results', []]];
		return null;
	},
	/** @param {any} ctx */
	make(ctx) {
		const s = () => ctx.slice() ?? initial();
		return {
			/** @param {number} [intro] @param {number} [limit] @param {string} [timeout] @param {number} [outro] */
			configure: (intro, limit, timeout, outro) => ctx.request('configure', [intro, limit, timeout, outro]),
			start: () => ctx.request('start', []),
			restart: () => ctx.request('restart', []),
			pause: () => ctx.request('pause', []),
			resume: () => ctx.request('resume', []),
			/** @param {string} [reason] */
			win: (reason = '') => ctx.request('win', [reason]),
			/** @param {string} [reason] */
			lose: (reason = '') => ctx.request('lose', [reason]),
			/** @param {number} seconds */
			extend: (seconds) => ctx.request('extend', [seconds]),
			toMenu: () => ctx.request('toMenu', []),
			phase: () => s().phase,
			playing: () => s().phase === 'playing',
			elapsed: () => playSeconds(s(), ctx.now()),
			remaining: () => remainingSeconds(s(), ctx.now()),
			countdown: () => (s().phase === 'intro' ? Math.max(0, Math.ceil(s().intro - (ctx.now() - s().phaseAt) / 1000)) : 0),
			number: () => s().round,
			outcome: () => s().outcome,
			on: ctx.on,
			extra: {
				/** the whole round state (read-only copy) */
				state: () => ({ ...s() }),
				/** is a round underway (intro, playing or paused)? */
				running: () => RUNNING.includes(s().phase)
			}
		};
	}
};

/** a fresh round: the intro (or straight into play), a new core round @param {any} s @param {any} ctx */
function begin(s, ctx) {
	const now = ctx.now();
	const round = s.round + 1;
	writeGame(ctx, () => (ctx.game?.restart ? ctx.game.restart() : ctx.game?.set?.('playing')));
	const intro = s.intro > 0;
	return {
		slice: { ...s, phase: intro ? 'intro' : 'playing', round, phaseAt: now, startedAt: intro ? 0 : now, pausedAt: 0, pausedMs: 0, extra: 0, outcome: '' },
		events: intro ? [['started', { round }]] : [['started', { round }], ['go', { round }]]
	};
}

/** @param {any} s @param {'won'|'lost'} phase @param {any} reason @param {any} ctx */
function end(s, phase, reason, ctx) {
	if (s.phase !== 'playing' && s.phase !== 'paused' && s.phase !== 'intro') return { result: { ok: false, reason: 'no round is running' } };
	const now = ctx.now();
	const why = typeof reason === 'string' ? reason.slice(0, 120) : '';
	// a pause still open is banked first, so the round's play time stops where it was
	const pausedMs = s.phase === 'paused' ? s.pausedMs + Math.max(0, now - s.pausedAt) : s.pausedMs;
	writeGame(ctx, () => ctx.game?.set?.('over', { outcome: phase === 'won' ? 'won' : 'lost' }));
	const next = { ...s, phase, phaseAt: now, pausedAt: 0, pausedMs, outcome: why || phase };
	return {
		slice: next,
		events: [[phase, { round: s.round, reason: why, seconds: playSeconds(next, now) }]]
	};
}

/** write core's game singleton and remember the stamp, so the tick knows it was ours
 * @param {any} ctx @param {() => any} write */
function writeGame(ctx, write) {
	const after = write();
	if (after && typeof after === 'object' && 'changedAt' in after) ctx.local.gameWritten = after.changedAt;
}
