// 38 R9 — THE PHONE BOTTOM BAR (NOTES-38 #7: "Add · Objects · Play · Explorer · More,
// customisable from day one, per device").
//
// 42 I5 — ONE LIST, PLAY INCLUDED, ARRANGED FROM MORE. The bar is an ordered list of up to
// MAX_ITEMS keys from BAR_CATALOG, and Play is one of them: it may move anywhere, or leave the bar
// (it then waits in More ▸ Windows until it is dragged back). There is no "Edit bar…" page any
// more — while More is open, every item in More and on the bar is held and dragged into, along or
// out of the bar (PhoneShell). Labels show while the bar holds LABELLED_MAX or fewer; at six or
// seven a narrow bar goes icons-only (`labelled`), each item staying at least 44 px wide.
//
// 41b H6 still holds: More may leave the bar (the ways back are a long press on any bar item and
// Play's menu), and taking it off says so ONCE (`MORE_HINT_KEY`). The bar never empties — the
// last item refuses to leave, or nothing would be left to hold.
//
// LOCAL (a fact about this device's screen): `phoneBar` in safeStorage, never replicated, saved or
// undone. The 38 R9 / 41b records (`phoneBarSlots` = up to four keys without Play, `phoneBarPlayAt`
// = the number of slots on Play's left, absent = the middle) are MIGRATED once into the one list
// and removed. Pure helpers + stores; tests/unit/phoneBar.test.js.
import { writable } from 'svelte/store';
import { safeStorage } from '../safeStorage';
import { onLayoutRestore } from '../uiLayoutsCore';

/** More ▸ Windows, in the order the sheet lists them (Play shows there only while off the bar) */
export const WINDOW_ITEMS = ['play', 'add', 'more', 'objects', 'stats', 'chat', 'explorer', 'flow', 'animation', 'scene', 'ai', 'notes', 'flowcode', 'shader', 'uv', 'hud', 'timeline', 'profiler', 'code'];
/** More ▸ Edit: the selection tools and the history, every one placeable on the bar */
export const EDIT_ITEMS = ['inspect', 'move', 'rotate', 'scale', 'undo', 'redo', 'multiselect', 'interact'];
/** More ▸ Tools & View (46 B1: + the scene budget — the toolbar chip's phone form; a folded bar has no
 * room for it by default, so it waits here and can be dragged onto the bar like any item; 50 R1: + the AR
 * table, a note where the browser has no immersive-ar) */
export const VIEW_ITEMS = ['tools', 'focus', 'budget', 'ar', 'playhere']; // 60 Q1: + Play here

/** every key the bar may hold */
export const BAR_CATALOG = [...WINDOW_ITEMS, ...EDIT_ITEMS, ...VIEW_ITEMS];
export const DEFAULT_BAR = ['add', 'objects', 'play', 'explorer', 'more'];
/** the most items the bar holds, Play counted */
export const MAX_ITEMS = 7;
/** up to this many the bar is always labelled; past it a narrow bar goes icons-only */
export const LABELLED_MAX = 5;
/** the narrowest an item may be and still carry its label (px) */
export const LABEL_MIN_W = 72;

/** safeStorage key: this device's bar (absent = the default) */
export const STORAGE_KEY = 'phoneBar';
/** the 38 R9 / 41b records the one list replaces (read once, then removed) */
export const LEGACY_SLOTS_KEY = 'phoneBarSlots';
export const LEGACY_PLAY_AT_KEY = 'phoneBarPlayAt';
/** safeStorage key: the one-time "how to get More back" notice was shown */
export const MORE_HINT_KEY = 'phoneBarMoreHint';

/**
 * A stored or edited list made safe: known keys only, no repeats, at most MAX_ITEMS. A list that is
 * not a list, or an empty one (a bar with nothing to hold cannot be got back), reads as the default.
 * @param {unknown} list @returns {string[]}
 */
export function normalizeBar(list) {
	if (!Array.isArray(list)) return [...DEFAULT_BAR];
	/** @type {string[]} */
	const out = [];
	for (const k of list) if (typeof k === 'string' && BAR_CATALOG.includes(k) && !out.includes(k)) out.push(k);
	out.splice(MAX_ITEMS);
	return out.length ? out : [...DEFAULT_BAR];
}

/** the 41b rule for where Play sat among `n` slots: the remembered place clamped, else the middle
 * (the left half takes the odd one) @param {number} n @param {number | null | undefined} playAt */
function legacyPlayIndex(n, playAt) {
	if (playAt == null || !Number.isFinite(playAt) || playAt < 0) return Math.ceil(n / 2);
	return Math.min(n, Math.round(playAt));
}

/**
 * The 38 R9 / 41b records as one list: the four-slot list (Play was never in it) with Play put back
 * where it sat. The old catalog is a subset of the new one, so nothing else changes.
 * @param {unknown} slots the parsed `phoneBarSlots` (absent = the old default)
 * @param {number | null | undefined} playAt the parsed `phoneBarPlayAt` (absent = the middle)
 * @returns {string[]}
 */
export function migrateLegacy(slots, playAt) {
	/** @type {string[]} */
	const four = [];
	const src = Array.isArray(slots) ? slots : ['add', 'objects', 'explorer', 'more'];
	for (const k of src) if (typeof k === 'string' && k !== 'play' && BAR_CATALOG.includes(k) && !four.includes(k)) four.push(k);
	four.splice(4);
	const at = legacyPlayIndex(four.length, playAt);
	return normalizeBar([...four.slice(0, at), 'play', ...four.slice(at)]);
}

/**
 * Put `key` at `at` — a drop. `at` counts the OTHER items (the list with `key` taken out), so a
 * drag along the bar and a drag in from More read the same index. A new item on a full bar is
 * refused (the list comes back unchanged with `refused: 'full'`).
 * @param {string[]} list @param {string} key @param {number} at
 * @returns {{list: string[], refused?: 'full' | 'unknown'}}
 */
export function placeItem(list, key, at) {
	if (!BAR_CATALOG.includes(key)) return { list, refused: 'unknown' };
	const others = list.filter((k) => k !== key);
	if (!list.includes(key) && list.length >= MAX_ITEMS) return { list, refused: 'full' };
	const i = Math.max(0, Math.min(others.length, Math.round(Number.isFinite(at) ? at : others.length)));
	return { list: [...others.slice(0, i), key, ...others.slice(i)] };
}

/**
 * Take `key` off the bar — a drag out into More. The last item stays (`refused: 'last'`).
 * @param {string[]} list @param {string} key @returns {{list: string[], refused?: 'last'}}
 */
export function removeItem(list, key) {
	if (!list.includes(key)) return { list };
	if (list.length <= 1) return { list, refused: 'last' };
	return { list: list.filter((k) => k !== key) };
}

/**
 * Play's (or any item's) Move left (-1) / Move right (+1): one place along the bar; unchanged at
 * an end or when the item is not on it.
 * @param {string[]} list @param {string} key @param {-1 | 1} dir @returns {string[]}
 */
export function moveItem(list, key, dir) {
	const i = list.indexOf(key);
	const j = i + dir;
	if (i < 0 || j < 0 || j >= list.length) return list;
	const next = [...list];
	next[i] = list[j];
	next[j] = key;
	return next;
}

/** does a bar of `n` items in `width` px keep its labels? (≤ LABELLED_MAX always; past it only when
 *  each item still has LABEL_MIN_W — an unfolded phone or a tablet stays labelled at seven)
 * @param {number} n @param {number} width */
export function labelled(n, width) {
	return n <= LABELLED_MAX || (width > 0 && width / Math.max(1, n) >= LABEL_MIN_W);
}

/** @param {string} key */
function readJson(key) {
	const raw = safeStorage.getItem(key);
	if (raw == null) return undefined;
	try {
		return JSON.parse(raw);
	} catch {
		return undefined;
	}
}

/** this device's stored bar, migrating the 41b records on first read @returns {string[]} */
export function loadBar() {
	try {
		const stored = readJson(STORAGE_KEY);
		if (stored !== undefined) return normalizeBar(stored);
		const slots = readJson(LEGACY_SLOTS_KEY);
		const rawAt = safeStorage.getItem(LEGACY_PLAY_AT_KEY);
		if (slots === undefined && rawAt == null) return [...DEFAULT_BAR];
		const at = rawAt == null ? null : parseInt(rawAt);
		const list = migrateLegacy(slots, Number.isFinite(at) ? at : null);
		save(list);
		return list;
	} catch {
		return [...DEFAULT_BAR];
	}
}

/** @param {string[]} list */
function save(list) {
	try {
		if (list.join() === DEFAULT_BAR.join()) safeStorage.removeItem(STORAGE_KEY);
		else safeStorage.setItem(STORAGE_KEY, JSON.stringify(list));
		safeStorage.removeItem(LEGACY_SLOTS_KEY);
		safeStorage.removeItem(LEGACY_PLAY_AT_KEY);
	} catch {
		// private mode: the bar still changes for this session
	}
}

/** this device's bar (read once, written through) */
export const phoneBar = writable(typeof localStorage === 'undefined' ? [...DEFAULT_BAR] : loadBar());

/** @param {string[]} list */
export function setBar(list) {
	const next = normalizeBar(list);
	phoneBar.set(next);
	save(next);
}

// 42 I8: a workspace layout carries the phone bar (its `phone` chrome profile: STORAGE_KEY, listed
// in uiLayoutsCore's CHROME_KEYS with phonePrefs' three switches) — re-read it when one is applied
if (typeof localStorage !== 'undefined') onLayoutRestore(() => phoneBar.set(loadBar()));
