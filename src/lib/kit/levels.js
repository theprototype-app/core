// 34 R2 — kit.levels: LEVELS, UNLOCKS, STARS AND PROGRESS — what untangle's progress.js (208 lines
// + its own localStorage), waves' session.js, three core templates' best keys and 31-towers'
// twelve levels each built for themselves.
//
//   the TABLE        code: `define({id, list, unlock?, stars?, modes?})` on every peer (the same
//                    module code runs everywhere, so every peer holds the same table)
//   CURRENT + MODE   the kit DOCUMENT (authority-written): one current level for the session
//   RESULTS          the document too (`results`, this session's best per level), so a level a
//                    peer just won counts for the authority's unlock check before any save
//   PROGRESS         per DEVICE through storage (`levels:<game id>`): every peer saves the stars
//                    it saw earned (the `completed` event reaches all of them) — "saved on this
//                    device", the 31-towers rule
//
// UNLOCKS read this device's progress merged with the session's results. The authority decides
// a `select` with ITS view; a peer whose own device holds more (a level it unlocked last week)
// still sees its picker say so, and a pick of a level only it has unlocked is refused with the
// reason — the one honest answer when two devices disagree (the 31-towers rule, made explicit).
//
// CARRY THE LEVEL ACROSS MODES (31's U6, Untangle's globe and board): progress belongs to the
// LEVEL id, never to a mode, and `setMode` keeps `current` — switching the board for the globe
// puts you in the level you had open, with everything you earned on either.
//
// THE SHELL: the table, the locks, the stars and the current level are published to the K3 pause
// menu's level picker (`api.game.levels`, through the host's `shellLevels` seam) whenever any of
// them changes; a pick there is a `select`.

import spec from './levels.spec.js';

const initial = () => ({ game: '', current: '', mode: '', results: {} });

/** @param {any} v */
const str = (v) => (v === undefined || v === null ? '' : String(v));

/** a definition's list, normalised @param {any} list */
function normalizeList(list) {
	/** @type {{id: string, label: string, data: any}[]} */
	const out = [];
	const seen = new Set();
	for (const raw of Array.isArray(list) ? list : []) {
		const id = str(raw?.id ?? (typeof raw === 'string' || typeof raw === 'number' ? raw : ''));
		if (!id || seen.has(id)) continue;
		seen.add(id);
		out.push({ id, label: str(raw?.label ?? raw?.name ?? id) || id, data: raw && typeof raw === 'object' ? raw : {} });
	}
	return out;
}

/** a progress record at the storage boundary @param {any} raw */
export function normalizeProgress(raw) {
	/** @type {Record<string, any>} */
	const levels = {};
	const src = raw?.levels && typeof raw.levels === 'object' ? raw.levels : {};
	for (const [id, row] of Object.entries(src)) {
		const r = /** @type {any} */ (row);
		const stars = Math.max(0, Math.min(5, Math.round(Number(r?.stars) || 0)));
		const time = Number(r?.time);
		const score = Number(r?.score);
		// a game's own numbers (Towers' `pieces`) ride along beside the kit's three
		/** @type {Record<string, number>} */
		const extra = {};
		if (r && typeof r === 'object')
			for (const [k, v] of Object.entries(r)) if (!['stars', 'time', 'score'].includes(k) && Number.isFinite(Number(v))) extra[k] = Number(v);
		levels[String(id)] = { ...extra, stars, time: Number.isFinite(time) && time > 0 ? time : 0, score: Number.isFinite(score) ? score : 0 };
	}
	return { levels, last: str(raw?.last), mode: str(raw?.mode) };
}

/** keep the better of two results (stars, then a faster time, then a higher score)
 * @param {any} a @param {any} b */
export function betterResult(a, b) {
	if (!a) return b;
	if (!b) return a;
	const stars = Math.max(a.stars ?? 0, b.stars ?? 0);
	const times = [a.time, b.time].filter((t) => t > 0);
	// a game's own numbers come from the better run (more stars; the newer on a tie)
	const base = (b.stars ?? 0) >= (a.stars ?? 0) ? { ...a, ...b } : { ...b, ...a };
	return { ...base, stars, time: times.length ? Math.min(...times) : 0, score: Math.max(a.score ?? 0, b.score ?? 0) };
}

/**
 * The default star rule: a win is ★, plus ★ inside the level's par time (`par.time`, seconds),
 * plus ★ at or above its par score (`par.score`) — or, with no par at all, three stars for a win.
 * @param {any} level the table row (its `data`) @param {{won: boolean, time: number, score: number}} result
 */
export function defaultStars(level, result) {
	if (!result.won) return 0;
	const par = level?.data?.par ?? level?.par;
	if (!par || (par.time == null && par.score == null)) return 3;
	let stars = 1;
	if (par.time == null || (result.time > 0 && result.time <= Number(par.time))) stars++;
	if (par.score == null || result.score >= Number(par.score)) stars++;
	return stars;
}

/**
 * Is `levelId` unlocked? `rule`: 'all' | 'sequential' (default: a STAR on the level before, the
 * Towers chain) | a function `(levelId, progress, list) => boolean`.
 * @param {{id: string}[]} list @param {any} progress normalised @param {string} levelId @param {any} rule
 */
export function isUnlockedBy(list, progress, levelId, rule) {
	const index = list.findIndex((l) => l.id === levelId);
	if (index < 0) return false;
	if (typeof rule === 'function') {
		try {
			return !!rule(levelId, progress, list);
		} catch {
			return false;
		}
	}
	if (rule === 'all' || index === 0) return true;
	return (progress.levels[list[index - 1].id]?.stars ?? 0) > 0;
}

export default {
	spec,
	initial,
	/** @param {any} raw */
	normalize(raw) {
		/** @type {Record<string, any>} */
		const results = {};
		for (const [id, row] of Object.entries(raw?.results && typeof raw.results === 'object' ? raw.results : {}))
			results[String(id)] = normalizeProgress({ levels: { x: row } }).levels.x;
		return { game: str(raw?.game), current: str(raw?.current), mode: str(raw?.mode), results };
	},
	ops: {
		/** @param {any} s @param {any[]} args @param {any} ctx */
		select(s, [level, gameId], ctx) {
			const def = defOf(ctx, gameId || s.game);
			if (!def) return { result: { ok: false, reason: 'no levels are defined' } };
			const id = str(level);
			if (!def.list.some((/** @type {any} */ l) => l.id === id)) return { result: { ok: false, reason: 'no level ' + id } };
			if (!isUnlockedBy(def.list, merged(ctx, def, s), id, def.unlock)) return { result: { ok: false, reason: 'Level ' + labelOf(def, id) + ' is locked' } };
			if (s.current === id && s.game === def.id) return { result: { ok: true } };
			return { slice: { ...s, game: def.id, current: id, results: s.game === def.id ? s.results : {} }, events: [['selected', { game: def.id, level: id }]] };
		},
		/** @param {any} s @param {any[]} _a @param {any} ctx */
		next(s, _a, ctx) {
			const def = defOf(ctx, s.game);
			if (!def) return { result: { ok: false, reason: 'no levels are defined' } };
			const index = def.list.findIndex((/** @type {any} */ l) => l.id === s.current);
			const next = def.list[index + 1];
			if (!next) return { result: { ok: false, reason: 'that was the last level' } };
			if (!isUnlockedBy(def.list, merged(ctx, def, s), next.id, def.unlock)) return { result: { ok: false, reason: 'Level ' + next.label + ' is locked' } };
			return { slice: { ...s, current: next.id }, events: [['selected', { game: def.id, level: next.id }]] };
		},
		/** @param {any} s @param {any[]} args @param {any} ctx */
		complete(s, [won, score, time, level, detail], ctx) {
			const def = defOf(ctx, s.game);
			if (!def) return { result: { ok: false, reason: 'no levels are defined' } };
			const id = str(level) || s.current;
			const row = def.list.find((/** @type {any} */ l) => l.id === id);
			if (!row) return { result: { ok: false, reason: 'no current level' } };
			const before = merged(ctx, def, s);
			// the time defaults to the kit round's play clock when the round runs it
			let seconds = Number(time) || 0;
			if (!seconds) seconds = ctx.kit?.()?.impls?.round?.elapsed?.() ?? 0;
			// `detail`: a game's own numbers (Towers' pieces) for its star rule and its saved row
			/** @type {Record<string, number>} */
			const extra = {};
			for (const [k, v] of Object.entries(detail && typeof detail === 'object' ? detail : {}))
				if (!['won', 'stars', 'time', 'score'].includes(k) && Number.isFinite(Number(v))) extra[k] = Number(v);
			const result = { ...extra, won: !!won, time: seconds, score: Number(score) || 0 };
			let stars = 0;
			try {
				stars = Math.max(0, Math.min(5, Math.round(Number((def.stars ?? defaultStars)(row, result)) || 0)));
			} catch {
				stars = result.won ? 1 : 0;
			}
			const entry = { ...extra, stars, time: result.won ? result.time : 0, score: result.score };
			const merge = def.merge ?? betterResult;
			const best = merge(s.results[id] ?? before.levels[id], entry);
			const results = { ...s.results, [id]: merge(s.results[id], entry) };
			const after = { ...before, levels: { ...before.levels, [id]: best } };
			/** @type {[string, any][]} */
			const events = [['completed', { game: def.id, level: id, won: result.won, stars, time: entry.time, score: entry.score, entry, best }]];
			for (const l of def.list)
				if (!isUnlockedBy(def.list, before, l.id, def.unlock) && isUnlockedBy(def.list, after, l.id, def.unlock))
					events.push(['unlockedNext', { game: def.id, level: l.id }]);
			return { slice: { ...s, results }, events, result: { ok: true, stars, best } };
		},
		/** @param {any} s @param {any[]} args */
		setMode(s, [mode]) {
			const m = str(mode).slice(0, 40);
			return m === s.mode ? { result: { ok: true } } : { slice: { ...s, mode: m } };
		}
	},
	/** @param {any} ctx */
	make(ctx) {
		/** game id -> definition (LOCAL: code) @type {Map<string, any>} */
		const defs = (ctx.local.defs ??= new Map());
		const s = () => ctx.slice() ?? initial();
		/** the definition in play: the document's game, else the newest defined */
		const active = () => defs.get(s().game) ?? [...defs.values()].at(-1) ?? null;
		/** this device's progress for a game @param {any} def */
		const progressOf = (def) => readProgress(ctx, def);
		const view = () => {
			const def = active();
			return def ? merged(ctx, def, s()) : normalizeProgress(null);
		};
		/** publish the table to the K3 shell's picker (the host seam; absent in the sim) */
		const publish = () => {
			const def = active();
			const shell = ctx.local.shell;
			if (!def || typeof shell !== 'function') return;
			const progress = view();
			const list = def.list.map((/** @type {any} */ l) => ({
				id: l.id,
				label: l.label,
				locked: !isUnlockedBy(def.list, progress, l.id, def.unlock),
				stars: progress.levels[l.id]?.stars ?? 0
			}));
			const current = s().game === def.id && s().current ? s().current : undefined;
			// every kit change lands here (a score, a pickup): publish only when the picker changes
			const key = JSON.stringify([list, current]);
			if (key === def.shellKey) return;
			def.shellKey = key;
			try {
				const off = shell({ list, current, onPick: (/** @type {string} */ id) => ctx.request('select', [id, def.id]) }, def.owner ?? '');
				if (typeof off === 'function') def.shellOff = off;
			} catch (error) {
				console.warn('kit.levels: the level picker failed', error);
			}
		};
		// every peer saves what it saw earned, and remembers where it was (resume + modes)
		ctx.on('completed', (/** @type {any} */ p) => {
			const def = defs.get(p?.game);
			if (!def || (!ctx.storage && !def.store)) return;
			const progress = progressOf(def);
			progress.levels[p.level] = (def.merge ?? betterResult)(progress.levels[p.level], p.entry ?? { stars: p.stars, time: p.time, score: p.score });
			writeProgress(ctx, def, progress);
		});
		ctx.on('selected', (/** @type {any} */ p) => {
			const def = defs.get(p?.game);
			if (!def || (!ctx.storage && !def.store)) return;
			const progress = progressOf(def);
			writeProgress(ctx, def, { ...progress, last: p.level, mode: s().mode });
		});
		ctx.onChange(() => publish());
		return {
			/** @param {string} level */
			select: (level) => ctx.request('select', [str(level), active()?.id ?? '']),
			next: () => ctx.request('next', []),
			/** @param {boolean} [won] @param {number} [score] @param {number} [time] @param {string} [level]
			 * @param {Record<string, number>} [detail] the game's own numbers (its star rule + saved row) */
			complete: (won = true, score = 0, time = 0, level = '', detail = {}) => ctx.request('complete', [won, score, time, level, detail]),
			/** @param {string} mode */
			setMode: (mode) => ctx.request('setMode', [mode]),
			current: () => s().current,
			currentLabel: () => {
				const def = active();
				return def ? labelOf(def, s().current) : '';
			},
			index: () => {
				const def = active();
				return def ? def.list.findIndex((/** @type {any} */ l) => l.id === s().current) + 1 : 0;
			},
			/** @param {string} level */
			starsOf: (level) => view().levels[str(level)]?.stars ?? 0,
			/** @param {string} level */
			unlocked: (level) => {
				const def = active();
				return !!def && isUnlockedBy(def.list, view(), str(level), def.unlock);
			},
			totalStars: () => Object.values(view().levels).reduce((a, r) => a + (r.stars ?? 0), 0),
			mode: () => s().mode,
			on: ctx.on,
			tracked: { define: 1 },
			extra: {
				/**
				 * The game's level table (the same code on every peer): `{id, list: [{id, label,
				 * par?: {time?, score?}, …}], unlock?: 'sequential' | 'all' | fn, stars?: fn(level,
				 * {won, time, score}) -> 0..5, modes?: string[]}`. Re-callable (a newer table
				 * replaces). Publishes the picker. Returns off.
				 * @param {any} def @param {string} [owner] the module that owns it (the shell's scope)
				 */
				define(def, owner = '') {
					const id = str(def?.id);
					const list = normalizeList(def?.list);
					if (!id || !list.length) return () => {};
					const prev = defs.get(id);
					prev?.shellOff?.();
					/** @type {any} */
					const entry = {
						id,
						list,
						unlock: def.unlock ?? 'sequential',
						stars: typeof def.stars === 'function' ? def.stars : null,
						modes: Array.isArray(def.modes) ? def.modes.map(str) : [],
						owner: def.owner ?? owner,
						// the game's OWN save (Towers keeps `tp:mod:towers:progress`, so every player
						// keeps the stars they earned before the port): {get() -> raw, set(progress)}
						store: def.store && typeof def.store.get === 'function' && typeof def.store.set === 'function' ? def.store : null,
						// how a new result folds into a saved row (default betterResult)
						merge: typeof def.merge === 'function' ? def.merge : null
					};
					defs.set(id, entry);
					publish();
					return () => {
						if (defs.get(id) !== entry) return;
						defs.delete(id);
						entry.shellOff?.();
					};
				},
				/** the level row (with its own data) @param {string} [level] the current when absent */
				level: (level) => active()?.list.find((/** @type {any} */ l) => l.id === str(level ?? s().current)) ?? null,
				/** the whole table as this device sees it: `[{id, label, locked, stars, best}]` */
				table: () => {
					const def = active();
					if (!def) return [];
					const progress = view();
					return def.list.map((/** @type {any} */ l) => ({
						id: l.id,
						label: l.label,
						locked: !isUnlockedBy(def.list, progress, l.id, def.unlock),
						stars: progress.levels[l.id]?.stars ?? 0,
						best: progress.levels[l.id] ?? null
					}));
				},
				/** where this device left off (resume a game) */
				resumeLevel: () => {
					const def = active();
					return def ? progressOf(def).last || '' : '';
				},
				/** forget this device's progress for the active game (a "reset progress" button) */
				resetProgress: () => {
					const def = active();
					if (def) writeProgress(ctx, def, normalizeProgress(null));
					if (def) def.shellKey = null;
					publish();
				},
				/** the app's seam to the K3 shell picker: `fn(spec, owner) -> off` @param {any} fn */
				attachShell(fn) {
					ctx.local.shell = fn;
					for (const def of defs.values()) def.shellKey = null;
					publish();
				},
				progress: () => view(),
				/** re-publish the picker (the game changed its saved progress behind the kit's back) */
				refresh: () => {
					for (const def of defs.values()) def.shellKey = null;
					publish();
				}
			}
		};
	}
};

/** @param {any} ctx @param {string} gameId */
function defOf(ctx, gameId) {
	/** @type {Map<string, any>} */
	const defs = ctx.local.defs ?? new Map();
	return defs.get(gameId) ?? [...defs.values()].at(-1) ?? null;
}

/** @param {any} def @param {string} id */
function labelOf(def, id) {
	return def.list.find((/** @type {any} */ l) => l.id === id)?.label ?? id;
}

/** this device's saved progress for a definition (its own store, else `levels:<id>`)
 * @param {any} ctx @param {any} def */
function readProgress(ctx, def) {
	try {
		return normalizeProgress(def.store ? def.store.get() : ctx.storage?.get?.('levels:' + def.id, null));
	} catch {
		return normalizeProgress(null);
	}
}

/** @param {any} ctx @param {any} def @param {any} progress */
function writeProgress(ctx, def, progress) {
	try {
		if (def.store) def.store.set(progress);
		else ctx.storage?.set?.('levels:' + def.id, progress);
	} catch (error) {
		console.warn('kit.levels: saving progress failed', error);
	}
}

/** this device's progress merged with the session's results @param {any} ctx @param {any} def @param {any} s */
function merged(ctx, def, s) {
	const progress = readProgress(ctx, def);
	if (s.game === def.id)
		for (const [id, row] of Object.entries(s.results ?? {})) progress.levels[id] = (def.merge ?? betterResult)(progress.levels[id], row);
	return progress;
}
