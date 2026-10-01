// 31 (K3) — PER-GAME SETTINGS. The user, on a Quest: "I should be able to disable the
// sound/sfx/music on each game. Adjust different other settings; you pick the best ones
// that need to be usually placed in games, although all of them should be able to show
// FPS when I want to debug."
//
// Two kinds of row share ONE store and one panel:
//  · the CORE rows every game gets (CORE_SETTINGS): music on + volume, sound effects on +
//    volume, haptics, show FPS, VR turning (snap/smooth + angle), a comfort vignette and a
//    quality preset. Core's music/SFX/haptics/turning/vignette/quality read them LIVE.
//  · GAME rows a game declares itself (`api.game.addSetting`, or a flow node): "Point to
//    move stars", "Board: globe / 2D". They render under the core rows.
//
// PER GAME: a game is identified by `gameId` — the slug of the last scene FILE opened
// (a Games-tab load is a .tpscene whose session name is the game's title, so Towers is
// 'towers' however the scene is named afterwards), else the saved scene's name, else
// 'untitled'. Settings are LOCAL to this device (safeStorage), never replicated and never
// saved into a scene: turning the music off in a game is about MY ears.
//
// Keys: the core rows sit in ONE JSON key `tp:game:<id>:shell`; a game row is its own key
// `tp:game:<id>:<row id>` (so a flow node, a module and the panel all address the same
// thing). Core ids are reserved, and so is `shell`.
//
// A LEAF: svelte/store + safeStorage and nothing else — flowRuntime, moduleSDK, the audio
// leaves, vrControls and the HUD all read it, from every side of the history-cycle family.
import { writable, get } from 'svelte/store';
import { safeStorage } from './safeStorage';

/**
 * @typedef {{id: string, label: string, type: 'toggle' | 'choice' | 'range', options?: string[],
 *   optionLabels?: string[], min?: number, max?: number, step?: number, default: any,
 *   help?: string, vrOnly?: boolean, onChange?: (value: any) => void, owner?: string}} SettingRow
 */

/** The rows every game gets, in panel order. `vrOnly` rows are drawn only in a headset
 * (and in the desktop panel under a "VR" heading). @type {SettingRow[]} */
export const CORE_SETTINGS = [
	{ id: 'music', label: 'Music', type: 'toggle', default: true },
	{ id: 'musicVolume', label: 'Music volume', type: 'range', min: 0, max: 100, step: 10, default: 100 },
	{ id: 'sfx', label: 'Sound effects', type: 'toggle', default: true },
	{ id: 'sfxVolume', label: 'Effects volume', type: 'range', min: 0, max: 100, step: 10, default: 100 },
	{ id: 'haptics', label: 'Controller vibration', type: 'toggle', default: true, vrOnly: true },
	{ id: 'showFps', label: 'Show FPS', type: 'toggle', default: false },
	{
		id: 'turning',
		label: 'Turning',
		type: 'choice',
		options: ['default', 'snap', 'smooth', 'off'],
		optionLabels: ['Default', 'Snap', 'Smooth', 'Off'],
		default: 'default',
		vrOnly: true
	},
	{
		id: 'turnAngle',
		label: 'Snap angle',
		type: 'choice',
		options: ['default', '15', '30', '45', '90'],
		optionLabels: ['Default', '15°', '30°', '45°', '90°'],
		default: 'default',
		vrOnly: true
	},
	{ id: 'vignette', label: 'Comfort vignette', type: 'toggle', default: false, vrOnly: true },
	{
		id: 'quality',
		label: 'Quality',
		type: 'choice',
		options: ['auto', 'low', 'medium', 'high'],
		optionLabels: ['Auto', 'Low', 'Medium', 'High'],
		default: 'auto'
	}
];

/** ids a game row may not take (the core rows + the JSON key's own name) */
export const RESERVED_SETTING_IDS = new Set([...CORE_SETTINGS.map((r) => r.id), 'shell']);
const CORE_BY_ID = new Map(CORE_SETTINGS.map((r) => [r.id, r]));

/* ------------------------------------------------------------------ pure helpers --- */

/**
 * A scene/game name as an id: lower case, runs of anything else collapsed to '-'.
 * @param {any} name @returns {string}
 */
export function slugGameId(name) {
	const s = String(name ?? '')
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 64);
	return s || 'untitled';
}

/** @param {string} gid */
export function shellKey(gid) {
	return 'tp:game:' + slugGameId(gid) + ':shell';
}
/** @param {string} gid @param {string} id */
export function rowKey(gid, id) {
	return 'tp:game:' + slugGameId(gid) + ':' + String(id);
}

/**
 * A declared row, made safe: a known type, an id, a default of the row's own kind.
 * Returns null for a row that cannot be one (no id, a reserved id, an unknown type).
 * @param {any} row @returns {SettingRow | null}
 */
export function normalizeSettingRow(row) {
	if (!row || typeof row !== 'object') return null;
	const id = String(row.id ?? '').trim();
	if (!id || id.length > 64) return null;
	const type = row.type === 'choice' || row.type === 'range' ? row.type : row.type === 'toggle' || row.type === undefined ? 'toggle' : null;
	if (!type) return null;
	/** @type {SettingRow} */
	const out = { id, label: String(row.label ?? id).slice(0, 80), type, default: undefined };
	if (type === 'choice') {
		const options = Array.isArray(row.options) ? row.options.map((/** @type {any} */ o) => String(o)).filter(Boolean).slice(0, 12) : [];
		if (!options.length) return null;
		out.options = options;
		if (Array.isArray(row.optionLabels)) out.optionLabels = options.map((/** @type {string} */ o, /** @type {number} */ i) => String(row.optionLabels[i] ?? o));
	}
	if (type === 'range') {
		const min = Number.isFinite(Number(row.min)) ? Number(row.min) : 0;
		const max = Number.isFinite(Number(row.max)) ? Number(row.max) : 100;
		out.min = Math.min(min, max);
		out.max = Math.max(min, max);
		const step = Number(row.step);
		out.step = Number.isFinite(step) && step > 0 ? step : (out.max - out.min) / 10 || 1;
	}
	out.default = coerceSettingValue(out, row.default, true);
	if (typeof row.onChange === 'function') out.onChange = row.onChange;
	if (row.help) out.help = String(row.help).slice(0, 200);
	if (row.vrOnly) out.vrOnly = true;
	return out;
}

/**
 * A value of the row's own kind: a toggle is a boolean, a choice one of its options, a
 * range a number clamped into [min, max]. Anything else answers the default (or, while
 * the default itself is being coerced, the kind's own zero).
 * @param {SettingRow} row @param {any} value @param {boolean} [forDefault]
 */
export function coerceSettingValue(row, value, forDefault = false) {
	const fallback = forDefault
		? row.type === 'toggle'
			? false
			: row.type === 'choice'
				? (row.options ?? [])[0]
				: Number(row.min ?? 0)
		: row.default;
	if (row.type === 'toggle') {
		if (typeof value === 'boolean') return value;
		if (value === 'true' || value === 1) return true;
		if (value === 'false' || value === 0) return false;
		return fallback;
	}
	if (row.type === 'choice') {
		const s = value === undefined || value === null ? '' : String(value);
		return (row.options ?? []).includes(s) ? s : fallback;
	}
	const n = typeof value === 'number' ? value : value === '' || value === null || value === undefined ? NaN : Number(value);
	if (!Number.isFinite(n)) return fallback;
	return Math.min(Number(row.max ?? 100), Math.max(Number(row.min ?? 0), n));
}

/** The core rows' values for a stored JSON object, every key coerced. @param {any} raw */
export function coreValuesFrom(raw) {
	/** @type {Record<string, any>} */
	const out = {};
	for (const row of CORE_SETTINGS) out[row.id] = coerceSettingValue(row, raw?.[row.id]);
	return out;
}

/* ------------------------------------------------------------------ the game id ---- */

/** the last scene file opened (its session name) and the saved scene's name */
const idSources = { file: /** @type {string | null} */ (null), level: /** @type {string | null} */ (null), forced: /** @type {string | null} */ (null) };

/** Which game this is. @type {import('svelte/store').Writable<string>} */
export const gameId = writable('untitled');

function resolveId() {
	const next = slugGameId(idSources.forced || idSources.file || idSources.level || '');
	if (next !== get(gameId)) {
		gameId.set(next);
		reload();
	}
}

/** sessions.applySession: a scene FILE was opened under this name @param {any} name */
export function noteSceneFileName(name) {
	idSources.file = name ? String(name) : null;
	resolveId();
}
/** the saved scene's name changed (levels.currentLevel) @param {any} name */
export function noteSceneLevelName(name) {
	idSources.level = name ? String(name) : null;
	resolveId();
}
/** a test (or a module that knows better) pins the id; null releases @param {string | null} id */
export function forceGameId(id) {
	idSources.forced = id ? String(id) : null;
	resolveId();
}
/** @returns {string} */
export function currentGameId() {
	return get(gameId);
}

/* ------------------------------------------------------------- rows and values ---- */

/** The game rows declared right now (api.game.addSetting, flow nodes). @type {import('svelte/store').Writable<SettingRow[]>} */
export const gameSettingRows = writable([]);

/** Every value for the current game, core + game rows. A store a $derived can depend on.
 * @type {import('svelte/store').Writable<Record<string, any>>} */
export const gameSettingValues = writable(coreValuesFrom(null));

/** @param {string} raw */
function parseJson(raw) {
	try {
		return raw ? JSON.parse(raw) : null;
	} catch {
		return null;
	}
}

/** read one game row's stored value @param {SettingRow} row */
function readRow(row) {
	const raw = safeStorage.getItem(rowKey(get(gameId), row.id));
	return coerceSettingValue(row, raw === null ? undefined : parseJson(raw));
}

/** re-read every value (the game changed, or a row appeared) */
function reload() {
	const gid = get(gameId);
	const values = coreValuesFrom(parseJson(safeStorage.getItem(shellKey(gid)) ?? ''));
	for (const row of get(gameSettingRows)) values[row.id] = readRow(row);
	gameSettingValues.set(values);
}

/** the row for an id (core first, then game rows) @param {string} id @returns {SettingRow | null} */
export function settingRow(id) {
	return CORE_BY_ID.get(id) ?? get(gameSettingRows).find((r) => r.id === id) ?? null;
}

/**
 * The current value of a row — core or game — falling back to its default, or undefined
 * for an id nobody declared.
 * @param {string} id
 */
export function gameSettingValue(id) {
	const values = get(gameSettingValues);
	if (id in values) return values[id];
	const row = settingRow(id);
	return row ? row.default : undefined;
}

/**
 * Write a row's value for the current game (coerced, persisted, published; the row's own
 * onChange hears it). Returns the value stored, or undefined for an unknown id.
 * @param {string} id @param {any} value
 */
export function setGameSetting(id, value) {
	const row = settingRow(id);
	if (!row) return undefined;
	const next = coerceSettingValue(row, value);
	const gid = get(gameId);
	const values = { ...get(gameSettingValues), [id]: next };
	if (CORE_BY_ID.has(id)) {
		/** @type {Record<string, any>} */
		const core = {};
		for (const r of CORE_SETTINGS) core[r.id] = values[r.id];
		safeStorage.setItem(shellKey(gid), JSON.stringify(core));
	} else safeStorage.setItem(rowKey(gid, id), JSON.stringify(next));
	gameSettingValues.set(values);
	if (row.onChange) {
		try {
			row.onChange(next);
		} catch {
			/* a game's callback throwing must not break the panel */
		}
	}
	return next;
}

/** Put every core row back to its default for this game. */
export function resetCoreSettings() {
	safeStorage.removeItem(shellKey(get(gameId)));
	reload();
}

/**
 * Declare a game row. A second declaration of the same id REPLACES the first (a module
 * re-registering after a reload, a node edited) — and `off()` only removes the row it
 * added. Returns off, or null when the row is refused (reserved id, bad shape).
 * @param {any} row @param {string} [owner]
 * @returns {(() => void) | null}
 */
export function registerGameSetting(row, owner = '') {
	const clean = normalizeSettingRow(row);
	if (!clean || RESERVED_SETTING_IDS.has(clean.id)) return null;
	clean.owner = String(owner || '');
	gameSettingRows.update((rows) => [...rows.filter((r) => r.id !== clean.id), clean]);
	gameSettingValues.update((values) => ({ ...values, [clean.id]: readRow(clean) }));
	return () => {
		gameSettingRows.update((rows) => rows.filter((r) => r !== clean));
		gameSettingValues.update((values) => {
			if (get(gameSettingRows).some((r) => r.id === clean.id)) return values;
			const { [clean.id]: _gone, ...rest } = values;
			return rest;
		});
	};
}

/** Drop every row an owner declared (a module disabled, a graph replaced). @param {string} owner */
export function unregisterGameSettingsOf(owner) {
	const gone = get(gameSettingRows).filter((r) => r.owner === owner).map((r) => r.id);
	if (!gone.length) return;
	gameSettingRows.update((rows) => rows.filter((r) => r.owner !== owner));
	reload();
}

/* ------------------------------------------------------- what core reads, live ---- */

/** 0..1 — the per-game multiplier on the device's "Game sounds" volume (0 when off) */
export function sfxLevel() {
	const v = get(gameSettingValues);
	return v.sfx === false ? 0 : Math.min(1, Math.max(0, Number(v.sfxVolume ?? 100) / 100));
}
/** 0..1 — the per-game multiplier on the device's "Music" volume (0 when off) */
export function musicLevel() {
	const v = get(gameSettingValues);
	return v.music === false ? 0 : Math.min(1, Math.max(0, Number(v.musicVolume ?? 100) / 100));
}
/** controller vibration allowed in this game? */
export function hapticsAllowed() {
	return get(gameSettingValues).haptics !== false;
}

/**
 * The VR turning this game asks for, resolved against the device's own snap angle
 * (`deviceAngle`, degrees, 0 = snap turning off): {mode: 'snap'|'smooth'|'off', angle}.
 * Pure over (values, deviceAngle); exported for the suites.
 * @param {Record<string, any>} values @param {number} deviceAngle
 */
export function resolveTurning(values, deviceAngle) {
	const dev = Number(deviceAngle) || 0;
	const choice = String(values?.turning ?? 'default');
	const angle = values?.turnAngle && values.turnAngle !== 'default' ? Number(values.turnAngle) : dev || 45;
	if (choice === 'off') return { mode: 'off', angle: 0 };
	if (choice === 'smooth') return { mode: 'smooth', angle };
	if (choice === 'snap') return { mode: 'snap', angle };
	// device default: the device's own snap setting (0 = off), unless the game picked an angle
	if (!dev && (!values?.turnAngle || values.turnAngle === 'default')) return { mode: 'off', angle: 0 };
	return { mode: 'snap', angle };
}

/** Test seam: forget every row and source, back to 'untitled' defaults. */
export function debugResetGameSettings() {
	idSources.file = idSources.level = idSources.forced = null;
	gameSettingRows.set([]);
	gameId.set('untitled');
	reload();
}
