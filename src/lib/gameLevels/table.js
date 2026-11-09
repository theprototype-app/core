// 93 LP0 — THE LEVELS TABLE (roadmap 93, "ONE levels design"): the single source of truth for a
// game's levels — names, scene or spawn point, goals, order — and the game's keep-across-levels
// list (LP4) and loading screen (LP2). The editor panel, the Kit: Levels nodes (select / next /
// complete, 78 F19), the agent's `game_setup {levels}`, portals (LP1) and checkpoints (LP3) all
// read and write THIS table; there is no second level list anywhere.
//
// WHERE IT LIVES: the scene-settings singleton (`scenePhysics.levels`), the spawn / openingView
// precedent — saved with the scene, replicated by the existing `scenephysics` message (zero new
// wire surface), absent unless authored so every older scene stays byte-identical. Travel carries
// it into a scene that has no table of its own (gameLevels/runtime.js).
//
// A LEAF: imports nothing, so scenePhysics' normalizer, the unit layer and the exporter can all
// read it.

/** what a keep entry may name (LP4); `var:<name>` keeps one named variable */
export const KEEP_KINDS = ['score', 'inventory', 'health'];
/** the unlock rules a table may pick (the kit's) */
export const UNLOCK_RULES = ['all', 'sequential'];
/** the kit.levels definition id the scene table defines */
export const SCENE_TABLE_ID = 'scene';
/** rows kept (a table is a level list, not a database) */
export const MAX_LEVELS = 64;
/** keep entries kept */
export const MAX_KEEP = 32;

/** @param {any} v @param {number} max */
const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : typeof v === 'number' && Number.isFinite(v) ? String(v) : '');

/** a row id from a name: lowercase words joined by '-' @param {string} name */
export function slugLevelId(name) {
	return (
		String(name ?? '')
			.toLowerCase()
			.normalize('NFKD')
			.replace(/[^\w\s-]/g, '')
			.trim()
			.replace(/[\s_]+/g, '-')
			.replace(/-+/g, '-')
			.slice(0, 40) || ''
	);
}

/** a keep list, cleaned: known kinds + `var:<name>`, deduped, in order @param {any} raw */
export function normalizeKeep(raw) {
	/** @type {string[]} */
	const out = [];
	for (const item of Array.isArray(raw) ? raw : []) {
		const s = text(item, 60);
		let key = '';
		if (KEEP_KINDS.includes(s)) key = s;
		else if (/^var:/.test(s)) {
			const name = s.slice(4).trim();
			if (name && /^[\w .-]{1,48}$/.test(name)) key = 'var:' + name;
		}
		if (key && !out.includes(key)) out.push(key);
		if (out.length >= MAX_KEEP) break;
	}
	return out;
}

/**
 * ONE normalize at every boundary (wire, save, restore, the panel, the agent). Null when there
 * is no table (absent, empty, or no usable row) — "the scene has no levels".
 * Unknown top-level keys and unknown row keys are preserved (a newer build's fields ride along).
 * @param {any} raw @returns {null | {list: {id: string, name: string, scene?: string, spawn?: string, goal?: string}[], keep: string[], unlock: string, loading?: any}}
 */
export function normalizeLevelsTable(raw) {
	if (!raw || typeof raw !== 'object') return null;
	const seen = new Set();
	/** @type {any[]} */
	const list = [];
	for (const row of Array.isArray(raw.list) ? raw.list : []) {
		if (!row || typeof row !== 'object') continue;
		const name = text(row.name ?? row.label, 80);
		let id = slugLevelId(text(row.id, 40)) || slugLevelId(name);
		if (!id) continue;
		if (seen.has(id)) {
			// an explicit id twice is the author's mistake: the first wins; a derived id twice
			// (two rows named "Cave") is made unique
			if (row.id !== undefined && row.id !== null && row.id !== '') continue;
			let n = 2;
			while (seen.has(id + '-' + n)) n++;
			id = id + '-' + n;
		}
		seen.add(id);
		const scene = text(row.scene, 120);
		const spawn = text(row.spawn, 120);
		const goal = text(row.goal, 200);
		const { id: _i, name: _n, label: _l, scene: _s, spawn: _p, goal: _g, ...rest } = row;
		list.push({ ...rest, id, name: name || id, ...(scene ? { scene } : {}), ...(spawn ? { spawn } : {}), ...(goal ? { goal } : {}) });
		if (list.length >= MAX_LEVELS) break;
	}
	if (!list.length) return null;
	const { list: _list, keep: _keep, unlock: _unlock, loading: _loading, ...rest } = raw;
	const unlock = UNLOCK_RULES.includes(raw.unlock) ? raw.unlock : 'all';
	const loading = raw.loading && typeof raw.loading === 'object' ? raw.loading : null;
	return { ...rest, list, keep: normalizeKeep(raw.keep), unlock, ...(loading ? { loading } : {}) };
}

/** @param {any} table @param {string} id */
export function levelRow(table, id) {
	return table?.list?.find((/** @type {any} */ r) => r.id === String(id ?? '')) ?? null;
}

/** the row after `id` in table order, else null @param {any} table @param {string} id */
export function nextLevelId(table, id) {
	const list = table?.list ?? [];
	const i = list.findIndex((/** @type {any} */ r) => r.id === String(id ?? ''));
	return i >= 0 && i + 1 < list.length ? list[i + 1].id : null;
}

/** the first row that IS this scene (no spawn = the scene's own start) @param {any} table @param {string} sceneName */
export function rowForScene(table, sceneName) {
	const name = String(sceneName ?? '');
	if (!name) return null;
	const rows = (table?.list ?? []).filter((/** @type {any} */ r) => r.scene === name);
	return rows.find((/** @type {any} */ r) => !r.spawn) ?? rows[0] ?? null;
}

/** the kit.levels definition for a table (the kit's own define() shape) @param {any} table */
export function kitLevelsDef(table) {
	if (!table?.list?.length) return null;
	return {
		id: SCENE_TABLE_ID,
		list: table.list.map((/** @type {any} */ r) => ({ ...r, id: r.id, label: r.name })),
		unlock: table.unlock === 'sequential' ? 'sequential' : 'all'
	};
}

/** the keep list as flags @param {any} table @returns {{score: boolean, inventory: boolean, health: boolean, vars: string[]}} */
export function keepItems(table) {
	const keep = table?.keep ?? [];
	return {
		score: keep.includes('score'),
		inventory: keep.includes('inventory'),
		health: keep.includes('health'),
		vars: keep.filter((/** @type {string} */ k) => k.startsWith('var:')).map((/** @type {string} */ k) => k.slice(4))
	};
}

/** a stable short signature of the level ids in order (LP5: a save notices a changed list) @param {any} table */
export function tableSignature(table) {
	return (table?.list ?? []).map((/** @type {any} */ r) => r.id).join('|');
}
