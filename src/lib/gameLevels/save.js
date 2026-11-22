// 93 LP5 — A GAME'S SAVED PROGRESS ON THIS DEVICE (checkpoints + the kept state), versioned. Pure: the storage
// read / write is the caller's (checkpoints.js), so the upgrade rules are testable with no browser.
//
//   the record   {v, game, level, scene, point: {kind, name, spawn}, kept: {vars, score?, own?}, at}
//   one key      per game: `tp:levels-save:<game id>` (cleared by New game)
//   upgrades     an older record is brought up to date, never crashes: known keys kept, unknown ones dropped,
//                a level the author removed falls back to the FIRST level (its checkpoint dropped), a variable
//                no longer on the keep list dropped; a record from a NEWER app is not used (and not overwritten
//                until the player saves again)
//   a size cap   SAVE_CAP bytes per game; a save over it is refused with a sentence the author can act on

export const SAVE_VERSION = 1;
export const SAVE_CAP = 256 * 1024;
export const SAVE_PREFIX = 'tp:levels-save:';

/** the storage key of a game's save @param {string} gameId */
export function saveKey(gameId) {
	return SAVE_PREFIX + (String(gameId ?? '').replace(/[^\w.-]/g, '').slice(0, 64) || 'game');
}

/** @param {any} v */
const finite3 = (v) => Array.isArray(v) && v.length === 3 && v.every((n) => Number.isFinite(Number(n)));
/** @param {any} v @param {number} max */
const text = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

/** a spawn at the boundary @param {any} s */
function spawnOf(s) {
	if (!s || !finite3(s.position)) return null;
	const yaw = Number(s.yaw);
	return { position: s.position.map(Number), yaw: Number.isFinite(yaw) ? yaw : 0 };
}

/**
 * Bring a stored record up to date against the game as it is NOW. Never throws.
 * @param {any} raw what storage held (parsed) @param {any} table the scene's Levels table (null = none)
 * @returns {{save: any | null, notes: string[]}} `save` null = nothing usable; `notes` = what was changed
 */
export function upgradeSave(raw, table) {
	/** @type {string[]} */
	const notes = [];
	if (!raw || typeof raw !== 'object') return { save: null, notes };
	const v = Number(raw.v ?? 0);
	if (v > SAVE_VERSION) return { save: null, notes: ['made by a newer version of the game'] };
	// v0 (a draft shape: {checkpoint: {...}, vars}) → v1
	const pointRaw = raw.point ?? raw.checkpoint ?? null;
	const keptRaw = raw.kept ?? (raw.vars ? { vars: raw.vars } : null);
	if (v < SAVE_VERSION) notes.push('upgraded from version ' + v);
	const ids = (table?.list ?? []).map((/** @type {any} */ r) => r.id);
	let level = text(raw.level, 60);
	/** @type {any} */
	let point = pointRaw && typeof pointRaw === 'object' ? { kind: pointRaw.kind === 'portal' ? 'portal' : 'checkpoint', name: text(pointRaw.name, 120), spawn: spawnOf(pointRaw.spawn) } : null;
	if (point && !point.spawn && !point.name) point = null;
	let scene = text(raw.scene, 120);
	if (level && ids.length && !ids.includes(level)) {
		// the author removed (or renamed) this level: start the game's first level, its checkpoint is gone
		notes.push('level "' + level + '" is gone: back to the first level');
		level = ids[0];
		const row = table.list[0];
		scene = row.scene ?? '';
		point = null;
	}
	// kept state: only what the game keeps now
	const keep = Array.isArray(table?.keep) ? table.keep : null;
	/** @type {any} */
	const kept = { vars: {} };
	const keptVars = keptRaw?.vars && typeof keptRaw.vars === 'object' ? keptRaw.vars : {};
	const names = keep
		? new Set([
				...keep.filter((/** @type {string} */ k) => k.startsWith('var:')).map((/** @type {string} */ k) => k.slice(4)),
				...(keep.includes('inventory') ? ['inventory'] : []),
				...(keep.includes('health') ? ['health'] : [])
			])
		: null;
	for (const [name, value] of Object.entries(keptVars)) {
		if (names && !names.has(name)) {
			notes.push('variable "' + name + '" is no longer kept');
			continue;
		}
		kept.vars[name] = value;
	}
	if (keptRaw?.score && (!keep || keep.includes('score'))) {
		const total = Number(keptRaw.score.total);
		/** @type {Record<string, number>} */
		const players = {};
		for (const [id, n] of Object.entries(keptRaw.score.players ?? {})) if (Number.isFinite(Number(n))) players[String(id).slice(0, 64)] = Number(n);
		kept.score = { total: Number.isFinite(total) ? total : 0, players };
	}
	if (keptRaw?.own && typeof keptRaw.own === 'object') {
		/** @type {Record<string, any>} */
		const own = {};
		for (const [k, val] of Object.entries(keptRaw.own)) if (!keep || keep.includes(k)) own[k] = val;
		if (Object.keys(own).length) kept.own = own;
	}
	return {
		save: { v: SAVE_VERSION, game: text(raw.game, 64), level, scene, point, kept, at: Number(raw.at) || 0 },
		notes
	};
}

/**
 * The bytes a record takes, and whether it may be stored. @param {any} record
 * @returns {{ok: true, json: string, bytes: number} | {ok: false, bytes: number, reason: string}}
 */
export function encodeSave(record) {
	let json = '';
	try {
		json = JSON.stringify(record);
	} catch {
		return { ok: false, bytes: 0, reason: 'The saved progress could not be written (it holds something that is not plain data).' };
	}
	const bytes = new TextEncoder().encode(json).length;
	if (bytes > SAVE_CAP)
		return {
			ok: false,
			bytes,
			reason:
				'Saved progress for this game is ' + Math.round(bytes / 1024) + ' KB, over the ' + SAVE_CAP / 1024 + ' KB a game may keep on a device, so it was not saved. Keep fewer or smaller variables across levels.'
		};
	return { ok: true, json, bytes };
}
