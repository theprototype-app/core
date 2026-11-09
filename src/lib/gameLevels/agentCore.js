// 93 — THE AGENT'S LEVELS ACTIONS, pure planners (game_setup {levels, portal, loading, checkpoint}; no new
// connector tool names: they are actions of 85's game_setup family). A LEAF over table.js.
import { normalizeLevelsTable, normalizeKeep, UNLOCK_RULES } from './table.js';
import { normalizeLoading, LOADING_PRESETS } from './loadingConfig.js';
import { PORTAL_TRANSITIONS, BACK_TARGET as BACK } from './objects.js';

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
		const missing = ids.filter((/** @type {string} */ id) => !draft.list.some((/** @type {any} */ r) => r.id === id));
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

// ── game_setup {portal, checkpoint, loading} ────────────────────────────────────────────────────────────────

/** @param {any} v */
const triple = (v) => Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && Number.isFinite(n));

/**
 * The record half of a set_portal call: what to write on the portal (`patch`) and the checks against the
 * Levels table. A target is ONE of: `level` (a table row id or name), `back: true` (where the player came
 * from), or `scene` and / or `spawn` (a project scene, an object name to arrive at).
 * @param {any} args @param {any} table the scene's Levels table (null = none)
 * @returns {{patch: any, warnings: string[]} | {error: string}}
 */
export function planPortalRecord(args, table) {
	const a = args && typeof args === 'object' ? args : {};
	/** @type {any} */
	const patch = {};
	/** @type {string[]} */
	const warnings = [];
	if (a.back === true) {
		if (a.level !== undefined || a.scene !== undefined) return { error: 'back: true goes back where the player came from; drop level / scene' };
		Object.assign(patch, { level: BACK, scene: null, spawn: null });
	} else if (a.level !== undefined && a.level !== null && a.level !== '') {
		const want = String(a.level).trim();
		const rows = table?.list ?? [];
		const row = rows.find((/** @type {any} */ r) => r.id === want) ?? rows.find((/** @type {any} */ r) => String(r.name).toLowerCase() === want.toLowerCase());
		if (!rows.length) return { error: 'level: the scene has no Levels table yet (set_levels first), or give scene / spawn instead' };
		if (!row) return { error: 'level: no level "' + want.slice(0, 40) + '" (levels: ' + rows.map((/** @type {any} */ r) => r.id).join(', ') + ')' };
		patch.level = row.id;
		if (a.scene === undefined) patch.scene = null;
	} else if (a.level === null || a.level === '') patch.level = null;
	if (a.scene !== undefined) patch.scene = a.scene === null ? null : String(a.scene).trim().slice(0, 120) || null;
	if (a.spawn !== undefined) patch.spawn = a.spawn === null ? null : String(a.spawn).trim().slice(0, 120) || null;
	if (patch.level && patch.level !== BACK && patch.scene) return { error: 'give level OR scene: a level already names its scene in the Levels table' };
	if (a.transition !== undefined) {
		if (!PORTAL_TRANSITIONS.includes(a.transition)) return { error: 'transition: ' + PORTAL_TRANSITIONS.join(' | ') };
		patch.transition = a.transition;
	}
	if (a.show !== undefined) patch.show = a.show !== false;
	if (a.loading !== undefined) {
		if (a.loading === null) patch.loading = null;
		else if (typeof a.loading !== 'object') return { error: 'loading: {preset, background, image, logo, tips, title} or null' };
		else patch.loading = normalizeLoading(a.loading);
	}
	return { patch, warnings };
}

/**
 * The record half of a set_checkpoint call. @param {any} args
 * @returns {{patch: any} | {error: string}}
 */
export function planCheckpointRecord(args) {
	const a = args && typeof args === 'object' ? args : {};
	/** @type {any} */
	const patch = {};
	if (a.label !== undefined) patch.label = a.label === null ? null : String(a.label).trim().slice(0, 60) || null;
	if (a.show !== undefined) patch.show = a.show !== false;
	return { patch };
}

/**
 * Where a NEW portal / checkpoint goes: `position` [x, y, z] of its base, or `at` (the create_objects
 * placement words, e.g. {ping: "latest"}); `facing` / `yaw` turn it (its arrow points -Z at yaw 0).
 * @param {any} args @returns {{spec: any} | {error: string}}
 */
export function planLevelObjectPlace(args) {
	const a = args && typeof args === 'object' ? args : {};
	if (a.position === undefined && a.at === undefined) return { error: 'position: [x, y, z] of its base (or at: {ping: "latest"})' };
	if (a.position !== undefined && !triple(a.position)) return { error: 'position: three numbers [x, y, z]' };
	/** @type {any} */
	const spec = {};
	if (a.position !== undefined) spec.position = a.position;
	if (a.at !== undefined) spec.at = a.at;
	if (a.yaw !== undefined) {
		if (typeof a.yaw !== 'number' || !Number.isFinite(a.yaw)) return { error: 'yaw: radians (0 = the arrow points -Z)' };
		spec.rotation = [0, a.yaw, 0];
	}
	if (a.face_user !== undefined) spec.face_user = a.face_user;
	if (a.name !== undefined) spec.name = String(a.name).slice(0, 120);
	return { spec };
}

/**
 * set_loading: the Levels table's loading screen (every level change; a portal can carry its own).
 * @param {any} args @param {any} table @returns {{table: any} | {error: string}}
 */
export function planLoading(args, table) {
	const a = args && typeof args === 'object' ? args : {};
	if (!table) return { error: 'the loading screen belongs to the Levels table: set_levels first (or give one portal its own: set_portal {loading})' };
	if (a.clear === true) {
		const { loading: _l, ...rest } = table;
		return { table: rest };
	}
	if (a.preset !== undefined && !LOADING_PRESETS.includes(a.preset)) return { error: 'preset: ' + LOADING_PRESETS.join(' | ') };
	if (a.tips !== undefined && !Array.isArray(a.tips)) return { error: 'tips: a list of short lines' };
	const merged = { ...(table.loading ?? {}), ...a };
	delete merged.clear;
	return { table: normalizeLevelsTable({ ...table, loading: merged }) };
}

/** say back a portal record @param {any} rec @param {any} table */
export function describePortal(rec, table) {
	if (!rec) return 'Not a portal.';
	const row = rec.level && rec.level !== BACK ? (table?.list ?? []).find((/** @type {any} */ r) => r.id === rec.level) : null;
	const where =
		rec.level === BACK ? 'back where the player came from' : row ? 'level ' + row.name : rec.scene ? 'scene ' + rec.scene + (rec.spawn ? ' at ' + rec.spawn : '') : rec.spawn ? 'the ' + rec.spawn + ' spot' : '';
	return where ? 'Walking through it goes to ' + where + ' (' + rec.transition + (rec.show ? '' : ', invisible in Play') + ').' : 'It goes nowhere yet: give it a level, a scene or a spawn.';
}
