// 93 — THE AGENT'S LEVELS ACTIONS, pure planners (game_setup {levels, portal, loading, checkpoint}; no new
// connector tool names: they are actions of 85's game_setup family). A LEAF over table.js.
import { normalizeLevelsTable, normalizeKeep, UNLOCK_RULES } from './table.js';

/** a row from an agent's shape: a string is a name @param {any} r */
function rowOf(r) {
	if (typeof r === 'string') return { name: r };
	return r && typeof r === 'object' ? r : null;
}

/**
 * Plan a set_levels call against the current table. `levels` replaces the list, `add` appends, `update`
 * patches rows by id, `remove` drops ids, `keep` / `unlock` / `loading` replace those fields, `clear`
 * removes the whole table. No field = a read.
 * @param {any} args @param {any} current the scene's table (null = none)
 * @returns {{read: true, table: any} | {table: any, changed: string[]} | {error: string}}
 */
export function planSetLevels(args, current) {
	const a = args && typeof args === 'object' ? args : {};
	const writes = ['levels', 'add', 'update', 'remove', 'keep', 'unlock', 'loading', 'clear'].filter((k) => a[k] !== undefined);
	if (!writes.length) return { read: true, table: current ?? null };
	if (a.clear === true) return { table: null, changed: ['clear'] };
	/** @type {any} */
	const draft = current ? JSON.parse(JSON.stringify(current)) : { list: [], keep: [], unlock: 'all' };
	if (a.levels !== undefined) {
		if (!Array.isArray(a.levels)) return { error: 'levels: a list of {name, scene?, spawn?, goal?} (in play order)' };
		draft.list = a.levels.map(rowOf).filter(Boolean);
	}
	if (a.add !== undefined) {
		if (!Array.isArray(a.add)) return { error: 'add: a list of {name, scene?, spawn?, goal?}' };
		draft.list = [...draft.list, ...a.add.map(rowOf).filter(Boolean)];
	}
	if (a.update !== undefined) {
		if (!Array.isArray(a.update)) return { error: 'update: a list of {id, …fields}' };
		for (const u of a.update) {
			const i = draft.list.findIndex((/** @type {any} */ r) => r.id === String(u?.id ?? ''));
			if (i < 0) return { error: 'update: no level "' + String(u?.id ?? '').slice(0, 40) + '" (ids: ' + draft.list.map((/** @type {any} */ r) => r.id).join(', ') + ')' };
			draft.list[i] = { ...draft.list[i], ...u, id: draft.list[i].id };
			for (const k of ['scene', 'spawn', 'goal']) if (u[k] === null || u[k] === '') delete draft.list[i][k];
		}
	}
	if (a.remove !== undefined) {
		const ids = (Array.isArray(a.remove) ? a.remove : [a.remove]).map(String);
		const missing = ids.filter((id) => !draft.list.some((/** @type {any} */ r) => r.id === id));
		if (missing.length) return { error: 'remove: no level ' + missing.join(', ') };
		draft.list = draft.list.filter((/** @type {any} */ r) => !ids.includes(r.id));
	}
	if (a.keep !== undefined) {
		if (!Array.isArray(a.keep)) return { error: 'keep: a list of "score", "inventory", "health" or "var:<name>"' };
		const kept = normalizeKeep(a.keep);
		const dropped = a.keep.filter((/** @type {any} */ k) => !kept.includes(String(k).trim()));
		if (dropped.length) return { error: 'keep: unknown ' + dropped.map(String).join(', ') + ' (use "score", "inventory", "health" or "var:<name>")' };
		draft.keep = kept;
	}
	if (a.unlock !== undefined) {
		if (!UNLOCK_RULES.includes(a.unlock)) return { error: 'unlock: ' + UNLOCK_RULES.join(' or ') };
		draft.unlock = a.unlock;
	}
	if (a.loading !== undefined) draft.loading = a.loading;
	const table = normalizeLevelsTable(draft);
	if (!table && draft.list.length) return { error: 'levels: every row needs a name' };
	return { table, changed: writes };
}

/** a short sentence an agent (or a voice) can say back @param {any} table */
export function describeLevels(table) {
	if (!table) return 'The scene has no levels table.';
	const rows = table.list.map((/** @type {any} */ r, /** @type {number} */ i) => i + 1 + '. ' + r.name + (r.scene ? ' (scene ' + r.scene + (r.spawn ? ', at ' + r.spawn : '') + ')' : r.spawn ? ' (at ' + r.spawn + ')' : ''));
	const keep = table.keep.length ? ' Kept across levels: ' + table.keep.map((/** @type {string} */ k) => k.replace(/^var:/, '')).join(', ') + '.' : '';
	return table.list.length + ' level' + (table.list.length === 1 ? '' : 's') + ': ' + rows.join('; ') + '.' + keep;
}
