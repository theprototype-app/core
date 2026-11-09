// 93 LP4 — STATE CARRIED ACROSS LEVELS: the game's keep list (score, inventory, health, named variables),
// chosen per GAME in the Levels table, captured before a level change / at a checkpoint and put back after.
//
//   score        the kit score (shared total + per-player rows); with it kept, the kit score's per-round
//                auto reset is switched off for the session, so a new level's round does not zero it
//   inventory    the named variable `inventory`, plus any module that registers 'inventory' here
//                (roadmap 61's inventory kit plugs in through registerKeptState)
//   health       the named variable `health`, plus a registered 'health'
//   var:<name>   one named variable (the game shell's shared `vars`)
//
// No keep list = today's behaviour (21-F fork 3): the whole game state carries on travel. A keep list =
// ONLY what it names carries; New game resets exactly the kept items.
import { keepItems } from './table.js';

/** @typedef {{capture: () => any, restore: (value: any) => void, reset?: () => void}} KeptState */
/** name -> a module's own kept state @type {Map<string, KeptState>} */
const registry = new Map();

/**
 * A module's own state to keep across levels under a keep-list name ('inventory', 'health' or its own
 * 'var:<name>'). Returns off. @param {string} name @param {KeptState} state
 */
export function registerKeptState(name, state) {
	registry.set(String(name), state);
	return () => {
		if (registry.get(String(name)) === state) registry.delete(String(name));
	};
}

/** the variable names a table keeps (`inventory` / `health` toggles keep those variables) @param {any} table */
export function keptVarNames(table) {
	const k = keepItems(table);
	return [...new Set([...k.vars, ...(k.inventory ? ['inventory'] : []), ...(k.health ? ['health'] : [])])];
}

/**
 * New game: the game's variables without the kept ones (they start over), or null when none of them is set
 * (nothing to write). Pure. @param {Record<string, any>} vars @param {any} table
 */
export function withoutKeptVars(vars, table) {
	const names = keptVarNames(table).filter((n) => Object.prototype.hasOwnProperty.call(vars ?? {}, n));
	if (!names.length) return null;
	const out = { ...vars };
	for (const n of names) delete out[n];
	return out;
}

/** does the table carry a keep list at all? @param {any} table */
export function hasKeepList(table) {
	return !!table?.keep?.length;
}

/**
 * Capture the kept state now. Pure over its inputs: `vars` (the game shell's) and `score` (the kit score
 * slice, or null). @param {any} table @param {{vars?: Record<string, any>, score?: any}} now
 * @returns {{vars: Record<string, any>, score?: {total: number, players: Record<string, number>}, own?: Record<string, any>}}
 */
export function captureKept(table, now) {
	const k = keepItems(table);
	/** @type {Record<string, any>} */
	const vars = {};
	for (const name of keptVarNames(table)) if (now.vars && name in now.vars) vars[name] = now.vars[name];
	/** @type {any} */
	const out = { vars };
	if (k.score && now.score) out.score = { total: Number(now.score.total) || 0, players: { ...(now.score.players ?? {}) } };
	/** @type {Record<string, any>} */
	const own = {};
	for (const key of table?.keep ?? []) {
		const r = registry.get(key);
		if (!r) continue;
		try {
			own[key] = r.capture();
		} catch (error) {
			console.warn('keep: capturing ' + key + ' failed', error);
		}
	}
	if (Object.keys(own).length) out.own = own;
	return out;
}

/** the registered states' restore (module-owned kept state) @param {any} kept */
export function restoreOwnKept(kept) {
	for (const [key, value] of Object.entries(kept?.own ?? {})) {
		const r = registry.get(key);
		try {
			r?.restore(value);
		} catch (error) {
			console.warn('keep: restoring ' + key + ' failed', error);
		}
	}
}

/** New game: every registered kept state resets @param {any} table */
export function resetOwnKept(table) {
	for (const key of table?.keep ?? []) {
		try {
			registry.get(key)?.reset?.();
		} catch {}
	}
}

/**
 * The game state a hop carries under a keep list: the kept variables only (everything else starts fresh
 * in the next level). No keep list = the state unchanged. Pure.
 * @param {any} game @param {any} table
 */
export function shapeCarriedGame(game, table) {
	if (!hasKeepList(table)) return game;
	const names = keptVarNames(table);
	/** @type {Record<string, any>} */
	const vars = {};
	for (const name of names) if (game?.vars && name in game.vars) vars[name] = game.vars[name];
	const { varsAt: _a, varOps: _o, ...rest } = game ?? {};
	return { ...rest, vars };
}
