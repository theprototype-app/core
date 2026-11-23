// 92 (GC5) — THREE NAMED SAVE SLOTS per game, on top of 78/93's saved progress (gameLevels/save.js:
// the level, the checkpoint, the kept state). A LAZY chunk: the pause menu, the title screen and
// checkpoints.js reach it through a dynamic import.
//
//   keys      `tp:levels-save:<game>:s1..s3` — the SAME record save.js writes (so its upgrade rules,
//             its 256 KB cap and its "newer version" verdict apply to every slot), plus a light `slot`
//             block: {name, level label, a small thumbnail, the app version}
//   the old   the single key `tp:levels-save:<game>` (exports, 1.62+) shows as slot 1 "Saved progress"
//   save      while slot 1 is empty, loads like a slot, and is MOVED into slot 1 by the first slot-1
//             write (removed only after that write landed) — an old player's progress is never lost
//   newer     a record from a newer app is listed, not loadable ("Made with a newer version"), and
//             overwriting it asks first
//   where     safeStorage (localStorage; memory in a private window): exports AND editor Play once the
//             author switched slots on. Cloud saves when signed in = a provider seam
//             (cloudHooks.gameSaves), absent = this device only (QUESTIONS-92-menus Q4)
//   game id   an export's permanent game id, else its bundle id, else the game's id (gameSettings)
import { get } from 'svelte/store';
import { safeStorage } from './safeStorage';
import { SAVE_SLOTS } from './gameMenusCore.js';
import { saveKey, upgradeSave, encodeSave, SAVE_VERSION } from './gameLevels/save.js';
import { activeSlot } from './gameMenus';
import { exportConfig } from './export/exportBoot.js';
import { currentGameId } from './gameSettings';
import { sceneLevelsTable } from './gameLevels/runtime.js';
import { hasKeepList } from './gameLevels/keep.js';
import { gameState } from './gameState';
import { APP_VERSION } from './version.js';
import { globalRenderer, globalScene, globalCamera } from '../stores/sceneStore';

/** a thumbnail is at most this wide (px) and this many characters of data URL */
export const THUMB_W = 160;
export const THUMB_MAX = 24 * 1024;

/** the game whose slots these are */
export function slotGameId() {
	return String(exportConfig?.gameId || exportConfig?.id || currentGameId() || 'game');
}
/** @param {number} n @param {string} [game] */
export function slotKey(n, game = slotGameId()) {
	return saveKey(game) + ':s' + clampSlot(n);
}
/** @param {any} n */
export function clampSlot(n) {
	return Math.min(SAVE_SLOTS, Math.max(1, Math.round(Number(n) || 1)));
}

/**
 * @typedef {{n: number, empty: boolean, legacy?: boolean, newer?: boolean, broken?: boolean, name: string,
 *   at: number, level: string, levelLabel: string, thumb: string, app: string, notes: string[]}} SlotView
 */

/** a level's words for the slot card @param {string} id */
function levelLabelOf(id) {
	const row = (sceneLevelsTable()?.list ?? []).find((/** @type {any} */ r) => r.id === id);
	return String(row?.name ?? row?.label ?? id ?? '').slice(0, 60);
}

/** @param {any} raw the parsed stored record @param {number} n @param {boolean} legacy @returns {SlotView} */
export function slotViewOf(raw, n, legacy = false) {
	if (!raw || typeof raw !== 'object') return { n, empty: true, name: 'Empty slot', at: 0, level: '', levelLabel: '', thumb: '', app: '', notes: [] };
	const meta = raw.slot && typeof raw.slot === 'object' ? raw.slot : {};
	const newer = Number(raw.v ?? 0) > SAVE_VERSION;
	const { save, notes } = newer ? { save: null, notes: ['made by a newer version of the game'] } : upgradeSave(raw, sceneLevelsTable());
	const level = String(save?.level ?? raw.level ?? '');
	return {
		n,
		empty: false,
		...(legacy ? { legacy: true } : {}),
		...(newer ? { newer: true } : {}),
		...(!newer && !save ? { broken: true } : {}),
		name: String(meta.name || (legacy ? 'Saved progress' : 'Slot ' + n)).slice(0, 40),
		at: Number(raw.at) || 0,
		level,
		levelLabel: String(meta.levelLabel || levelLabelOf(level) || '').slice(0, 60),
		thumb: typeof meta.thumb === 'string' && meta.thumb.startsWith('data:image/') && meta.thumb.length <= THUMB_MAX ? meta.thumb : '',
		app: String(meta.app ?? '').slice(0, 24),
		notes
	};
}

/** @param {string} key */
function readJson(key) {
	const text = safeStorage.getItem(key);
	if (!text) return null;
	try {
		return JSON.parse(text);
	} catch {
		return { v: 0, broken: true };
	}
}

/** The three slots as the menus draw them. @returns {SlotView[]} */
export function listSlots() {
	const game = slotGameId();
	/** @type {SlotView[]} */
	const out = [];
	for (let n = 1; n <= SAVE_SLOTS; n++) {
		let raw = readJson(slotKey(n, game));
		let legacy = false;
		if (!raw && n === 1) {
			// the one save every game had before slots: slot 1 until slot 1 is written
			raw = readJson(saveKey(game));
			legacy = !!raw;
		}
		out.push(slotViewOf(raw, n, legacy));
	}
	return out;
}

/** the newest loadable slot (Continue), or null */
export function newestSlot() {
	const usable = listSlots().filter((s) => !s.empty && !s.newer && !s.broken);
	usable.sort((a, b) => b.at - a.at || a.n - b.n);
	return usable[0] ?? null;
}

/** the first empty slot (New game), or null when all three hold a save */
export function firstEmptySlot() {
	return listSlots().find((s) => s.empty)?.n ?? null;
}

/** a small picture of the game right now (null in VR / with no renderer) */
export function captureSlotThumb() {
	try {
		const r = /** @type {any} */ (get(globalRenderer));
		const scene = get(globalScene);
		const cam = get(globalCamera);
		if (!r || !scene || !cam || r.xr?.isPresenting || typeof document === 'undefined') return '';
		r.render(scene, cam);
		const src = r.domElement;
		const scale = Math.min(1, THUMB_W / (src.width || THUMB_W));
		const c = document.createElement('canvas');
		c.width = Math.max(1, Math.round((src.width || THUMB_W) * scale));
		c.height = Math.max(1, Math.round((src.height || 90) * scale));
		const ctx = c.getContext('2d');
		if (!ctx) return '';
		ctx.drawImage(src, 0, 0, c.width, c.height);
		const url = c.toDataURL('image/jpeg', 0.55);
		return url.length <= THUMB_MAX ? url : '';
	} catch {
		return '';
	}
}

/**
 * Write slot `n` from the game as it is now. `auto` = a checkpoint's save into the slot in use (keeps
 * the slot's name and picture unless it has none). Returns {ok, reason?}.
 * @param {number} n @param {{auto?: boolean, name?: string, record?: any, thumb?: string}} [opts]
 */
export async function writeSlot(n, opts = {}) {
	const slot = clampSlot(n);
	const game = slotGameId();
	const cp = await import('./gameLevels/checkpoints.js');
	const record = opts.record ?? (await cp.buildSave());
	// a game with no keep list keeps EVERYTHING (keep.js's own rule: no list = the whole game state carries),
	// so a slot of such a game holds all its variables — a manual Save game means "save my game"
	if (!opts.record && !hasKeepList(sceneLevelsTable())) record.kept = { ...(record.kept ?? {}), vars: { ...(get(gameState)?.vars ?? {}) } };
	const before = readJson(slotKey(slot, game));
	const prevMeta = before?.slot && typeof before.slot === 'object' ? before.slot : {};
	const thumb = opts.thumb ?? (opts.auto && prevMeta.thumb ? prevMeta.thumb : captureSlotThumb());
	const full = {
		...record,
		slot: {
			name: String(opts.name || prevMeta.name || 'Slot ' + slot).slice(0, 40),
			levelLabel: levelLabelOf(record.level),
			...(thumb ? { thumb } : {}),
			app: APP_VERSION
		}
	};
	const enc = encodeSave(full);
	if (!enc.ok) {
		// over the cap with the picture: try once without it before refusing
		const bare = encodeSave({ ...full, slot: { ...full.slot, thumb: undefined } });
		if (!bare.ok) return { ok: false, reason: enc.reason };
		safeStorage.setItem(slotKey(slot, game), bare.json);
	} else safeStorage.setItem(slotKey(slot, game), enc.json);
	// the old single save moves into slot 1 by this write: only now is it safe to remove
	if (slot === 1 && safeStorage.getItem(slotKey(1, game))) safeStorage.removeItem(saveKey(game));
	activeSlot.set(slot);
	debug.writes.push(slot);
	return { ok: true };
}

/** @param {number} n */
export function deleteSlot(n) {
	const slot = clampSlot(n);
	const game = slotGameId();
	safeStorage.removeItem(slotKey(slot, game));
	// slot 1 showing the old single save: deleting it deletes that save
	if (slot === 1) safeStorage.removeItem(saveKey(game));
	if (get(activeSlot) === slot) activeSlot.set(null);
	return true;
}

/**
 * Load slot `n`: the level, the kept state, the checkpoint (checkpoints.resumeSavedGame on this record).
 * A newer-version or unreadable record is refused with the reason. @param {number} n
 * @returns {Promise<{ok: boolean, reason?: string, notes?: string[]}>}
 */
export async function loadSlot(n) {
	const slot = clampSlot(n);
	const game = slotGameId();
	let raw = readJson(slotKey(slot, game));
	if (!raw && slot === 1) raw = readJson(saveKey(game));
	if (!raw) return { ok: false, reason: 'That slot is empty.' };
	if (Number(raw.v ?? 0) > SAVE_VERSION) return { ok: false, reason: 'This save was made with a newer version of the game. Update to load it.' };
	const cp = await import('./gameLevels/checkpoints.js');
	const done = await cp.resumeSavedGame({ record: raw });
	if (!done.resumed) return { ok: false, reason: 'This save could not be read.', notes: done.notes };
	activeSlot.set(slot);
	debug.loads.push(slot);
	return { ok: true, notes: done.notes };
}

/**
 * Start a new game in slot `n` (the title screen's New game / Play): the game starts over (checkpoints'
 * newGame), then the slot is written at the start, so Continue finds it. @param {number} n
 */
export async function newGameInSlot(n) {
	const slot = clampSlot(n);
	const cp = await import('./gameLevels/checkpoints.js');
	activeSlot.set(slot);
	try {
		await cp.newGame();
	} catch (error) {
		// a game whose reset fails still gets its slot (the player chose to start here)
		console.warn('save slots: new game', error);
	}
	return writeSlot(slot, { name: 'Slot ' + slot });
}

/** @type {{writes: number[], loads: number[]}} */
const debug = { writes: [], loads: [] };
/** the suites' view */
export function saveSlotsDebug() {
	return { game: slotGameId(), active: get(activeSlot), slots: listSlots(), writes: [...debug.writes], loads: [...debug.loads] };
}
