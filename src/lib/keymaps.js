// 103 row 9 (owner, 22 Nov) — YOUR OWN KEYMAPS. A LAZY module (Settings ▸ Shortcuts ▸ Keymap loads it); nothing here
// is boot, because a saved keymap needs no boot code to stay in force: the WORKING state is always the built-in preset
// (`keymapPreset`) plus the rebinds (`shortcutOverrides`), and a saved keymap is a named copy of exactly that pair.
//
//   SAVED KEYMAP = { id, name, base, changes, at } — `base` a built-in preset id, `changes` the rebinds on top of it.
//   It stores only the CHANGES, so a shortcut added in a later release appears in it with its default.
//   `keymapsSaved` (this device, with the other settings) holds the list; `keymapActive` (shortcuts.js) the one the
//   working state belongs to, absent = a built-in preset.
//
//   DIRTY: a saved keymap is changed when the working rebinds (or the preset) differ from what it stores; a built-in
//   preset is changed when any rebind sits on it. Switching AWAY from a changed keymap to one that would replace those
//   rebinds is asked first by the caller (Save changes / Discard / Cancel); built-in -> built-in keeps carrying the
//   rebinds, exactly as #600 did, so nothing is lost there.
//
//   FILE: { format: 'theprototype-keymap', version: 1, name, base, changes } — small JSON, validated on import (size,
//   format, version, every id and key a short string, at most MAX_CHANGES rows; a newer version is refused by name).
import { writable, get } from 'svelte/store';
import { safeStorage } from './safeStorage';
import {
	shortcuts,
	shortcutOverrides,
	replaceOverrides,
	setKeymapPreset,
	keymapPreset,
	activeKeymapId,
	setActiveKeymapId
} from './shortcuts';

const SAVED_KEY = 'keymapsSaved';
export const KEYMAP_FILE_FORMAT = 'theprototype-keymap';
export const KEYMAP_FILE_VERSION = 1;
export const BUILT_IN_IDS = ['theprototype', 'blender', 'unity'];
const MAX_CHANGES = 1000;
const MAX_FILE_BYTES = 64 * 1024;
const MAX_NAME = 60;
const MAX_KEYMAPS = 50;
/** never bound by a file (shortcuts.js DENY_KEYS) */
const RESERVED = ['Escape', 'F6', 'Shift+F6'];

/** @typedef {{ id: string, name: string, base: string, changes: Record<string, string>, at: number }} SavedKeymap */

/** @param {unknown} raw @returns {Record<string, string>} */
function cleanChanges(raw) {
	/** @type {Record<string, string>} */
	const out = {};
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
	let n = 0;
	for (const [id, keys] of Object.entries(raw)) {
		if (n >= MAX_CHANGES) break;
		if (typeof id !== 'string' || id.length > 80 || !/^[\w.:-]+$/.test(id)) continue;
		if (typeof keys !== 'string' || keys.length > 40 || RESERVED.includes(keys)) continue;
		out[id] = keys;
		n++;
	}
	return out;
}

/** @param {unknown} name */
function cleanName(name) {
	return String(typeof name === 'string' ? name : '')
		.replace(/[\u0000-\u001f]+/g, ' ')
		.trim()
		.slice(0, MAX_NAME);
}

/** one stored or imported keymap, or null @param {any} raw @returns {SavedKeymap | null} */
export function normalizeKeymap(raw) {
	if (!raw || typeof raw !== 'object') return null;
	const name = cleanName(raw.name);
	if (!name) return null;
	return {
		id: typeof raw.id === 'string' && /^km-[\w-]{1,40}$/.test(raw.id) ? raw.id : newId(),
		name,
		base: BUILT_IN_IDS.includes(raw.base) ? raw.base : 'theprototype',
		changes: cleanChanges(raw.changes),
		at: Number.isFinite(raw.at) ? Number(raw.at) : Date.now()
	};
}

function newId() {
	return 'km-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

/** @returns {SavedKeymap[]} */
function load() {
	try {
		const raw = safeStorage.getItem(SAVED_KEY);
		const list = raw ? JSON.parse(raw) : [];
		if (!Array.isArray(list)) return [];
		const seen = new Set();
		/** @type {SavedKeymap[]} */
		const out = [];
		for (const item of list) {
			const k = normalizeKeymap(item);
			if (k && !seen.has(k.id)) {
				seen.add(k.id);
				out.push(k);
			}
		}
		return out.slice(0, MAX_KEYMAPS);
	} catch {
		return [];
	}
}

/** the saved keymaps @type {import('svelte/store').Writable<SavedKeymap[]>} */
export const savedKeymaps = writable(load());

/** @param {SavedKeymap[]} list */
function persist(list) {
	savedKeymaps.set(list);
	try {
		if (list.length) safeStorage.setItem(SAVED_KEY, JSON.stringify(list));
		else safeStorage.removeItem(SAVED_KEY);
	} catch {
		/* private mode: this session only */
	}
}

/** @param {Record<string, string>} a @param {Record<string, string>} b */
export function sameChanges(a, b) {
	const ka = Object.keys(a);
	if (ka.length !== Object.keys(b).length) return false;
	return ka.every((k) => b[k] === a[k]);
}

/** the saved keymap the working state belongs to (null = a built-in preset; an id that is gone = a built-in too)
 * @returns {SavedKeymap | null} */
export function activeKeymap() {
	const id = get(activeKeymapId);
	return (id && get(savedKeymaps).find((k) => k.id === id)) || null;
}

/** rebinds that point at a row this build has (a module's row that is not loaded still counts: it is the person's) */
function workingChanges() {
	return shortcutOverrides();
}

/** Is the active keymap changed since it was saved (or, for a built-in preset, does any rebind sit on it)? */
export function keymapDirty() {
	const k = activeKeymap();
	const changes = workingChanges();
	if (!k) return Object.keys(changes).length > 0;
	return k.base !== get(keymapPreset) || !sameChanges(k.changes, changes);
}

/** How many shortcuts the active keymap has changed from its base preset (what "Reset this keymap" undoes) */
export function changedFromBaseCount() {
	return Object.keys(workingChanges()).length;
}

/** How many shortcuts differ from what the active SAVED keymap stored ("N changed since you saved it"); on a built-in
 *  preset it is the rebinds on it. A base that moved counts as one change more (the whole preset differs). */
export function changedSinceSavedCount() {
	const k = activeKeymap();
	const changes = workingChanges();
	if (!k) return Object.keys(changes).length;
	const ids = new Set([...Object.keys(k.changes), ...Object.keys(changes)]);
	let n = 0;
	for (const id of ids) if (k.changes[id] !== changes[id]) n++;
	return n + (k.base !== get(keymapPreset) ? 1 : 0);
}

/** @param {string} wanted @param {string} [exceptId] */
export function uniqueName(wanted, exceptId) {
	const base = cleanName(wanted) || 'My keymap';
	const taken = new Set(get(savedKeymaps).filter((k) => k.id !== exceptId).map((k) => k.name.toLowerCase()));
	if (!taken.has(base.toLowerCase())) return base;
	for (let i = 2; i < 1000; i++) {
		const name = `${base.slice(0, MAX_NAME - 5)} (${i})`;
		if (!taken.has(name.toLowerCase())) return name;
	}
	return base;
}

/** "Save current as…": a new saved keymap from the working state, which it then belongs to @param {string} name
 * @returns {SavedKeymap | null} */
export function saveCurrentAs(name) {
	const list = get(savedKeymaps);
	if (list.length >= MAX_KEYMAPS) return null;
	const k = { id: newId(), name: uniqueName(name), base: get(keymapPreset), changes: { ...workingChanges() }, at: Date.now() };
	persist([...list, k]);
	setActiveKeymapId(k.id);
	return k;
}

/** "Save changes": the working state into the active saved keymap */
export function saveChanges() {
	const k = activeKeymap();
	if (!k) return false;
	persist(get(savedKeymaps).map((x) => (x.id === k.id ? { ...x, base: get(keymapPreset), changes: { ...workingChanges() }, at: Date.now() } : x)));
	return true;
}

/** "Discard": back to what the active keymap stores (a built-in preset: no rebinds) */
export async function discardChanges() {
	const k = activeKeymap();
	if (!k) return replaceOverrides({});
	if (k.base !== get(keymapPreset)) await setKeymapPreset(k.base);
	replaceOverrides(k.changes);
}

/**
 * Would switching to `target` replace the working rebinds (so a changed keymap must be asked about first)?
 * @param {string} target 'preset:<id>' or a saved keymap id
 */
export function switchDropsChanges(target) {
	if (!keymapDirty()) return false;
	// built-in -> built-in carries the rebinds along (#600)
	return !!activeKeymap() || !target.startsWith('preset:');
}

/** Put a keymap in force. The caller has already asked about unsaved changes. @param {string} target */
export async function switchKeymap(target) {
	if (target.startsWith('preset:')) {
		const id = target.slice(7);
		if (!BUILT_IN_IDS.includes(id)) return;
		const fromSaved = !!activeKeymap();
		await setKeymapPreset(id);
		// a saved keymap's rebinds are ITS OWN: leaving it for a built-in preset starts from that preset's keys
		if (fromSaved) replaceOverrides({});
		setActiveKeymapId(null);
		return;
	}
	const k = get(savedKeymaps).find((x) => x.id === target);
	if (!k) return;
	await setKeymapPreset(k.base);
	replaceOverrides(k.changes);
	setActiveKeymapId(k.id);
}

/** @param {string} id @param {string} name */
export function renameKeymap(id, name) {
	const clean = cleanName(name);
	if (!clean) return false;
	persist(get(savedKeymaps).map((k) => (k.id === id ? { ...k, name: uniqueName(clean, id) } : k)));
	return true;
}

/** a copy beside it (not switched to) @param {string} id @returns {SavedKeymap | null} */
export function duplicateKeymap(id) {
	const list = get(savedKeymaps);
	const k = list.find((x) => x.id === id);
	if (!k || list.length >= MAX_KEYMAPS) return null;
	const copy = { ...k, id: newId(), name: uniqueName(k.name + ' copy'), changes: { ...k.changes }, at: Date.now() };
	persist([...list, copy]);
	return copy;
}

/** Delete a saved keymap. The working state stays as it is (deleting the active one leaves its keys in force on its
 * base preset, shown as changed there — nothing moves under the person's hands). @param {string} id */
export function deleteKeymap(id) {
	persist(get(savedKeymaps).filter((k) => k.id !== id));
	if (get(activeKeymapId) === id) setActiveKeymapId(null);
}

/* -------------------------------------------------------------- export / import -- */

/** the file for a saved keymap, or for the working state @param {SavedKeymap | null} k @param {string} [name] */
export function keymapFile(k, name = 'My keymap') {
	return {
		format: KEYMAP_FILE_FORMAT,
		version: KEYMAP_FILE_VERSION,
		name: k ? k.name : cleanName(name) || 'My keymap',
		base: k ? k.base : get(keymapPreset),
		changes: k ? { ...k.changes } : { ...workingChanges() }
	};
}

/** @param {string} name */
export function keymapFileName(name) {
	const slug = String(name || 'keymap')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
	return (slug || 'keymap') + '.keymap.json';
}

/** download a keymap as its small JSON file @param {SavedKeymap | null} k @param {string} [name] */
export function exportKeymap(k, name) {
	const file = keymapFile(k, name);
	const blob = new Blob([JSON.stringify(file, null, 2) + '\n'], { type: 'application/json' });
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = keymapFileName(file.name);
	document.body.appendChild(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
	return file;
}

/**
 * Read a keymap file. @param {string} text
 * @returns {{ ok: true, keymap: SavedKeymap, skipped: number, unknown: number } | { ok: false, reason: string }}
 */
export function parseKeymapFile(text) {
	if (typeof text !== 'string' || !text.trim()) return { ok: false, reason: 'The file is empty' };
	if (text.length > MAX_FILE_BYTES) return { ok: false, reason: 'The file is too big for a keymap' };
	/** @type {any} */
	let raw;
	try {
		raw = JSON.parse(text);
	} catch {
		return { ok: false, reason: 'The file is not a keymap (it is not JSON)' };
	}
	if (!raw || typeof raw !== 'object' || raw.format !== KEYMAP_FILE_FORMAT) return { ok: false, reason: 'The file is not a ThePrototype keymap' };
	const version = Number(raw.version);
	if (!Number.isInteger(version) || version < 1) return { ok: false, reason: 'The keymap file has no version' };
	if (version > KEYMAP_FILE_VERSION) return { ok: false, reason: 'This keymap was made with a newer version of ThePrototype' };
	const keymap = normalizeKeymap({ name: raw.name || 'Imported keymap', base: raw.base, changes: raw.changes });
	if (!keymap) return { ok: false, reason: 'The keymap file has no name' };
	const given = raw.changes && typeof raw.changes === 'object' ? Object.keys(raw.changes).length : 0;
	const known = new Set(shortcuts.map((s) => s.id));
	return {
		ok: true,
		keymap,
		skipped: Math.max(0, given - Object.keys(keymap.changes).length),
		// rows this build does not have (a module that is not loaded, a newer release): kept, they do nothing here
		unknown: Object.keys(keymap.changes).filter((id) => !known.has(id)).length
	};
}

/** add an imported keymap to the saved list (not switched to) @param {string} text */
export function importKeymap(text) {
	const r = parseKeymapFile(text);
	if (!r.ok) return r;
	const list = get(savedKeymaps);
	if (list.length >= MAX_KEYMAPS) return { ok: false, reason: `You have ${MAX_KEYMAPS} keymaps already` };
	const k = { ...r.keymap, id: newId(), name: uniqueName(r.keymap.name), at: Date.now() };
	persist([...list, k]);
	return { ...r, keymap: k };
}

/* ---------------------------------------------------------------- 103 row 10 -- */

/** "Reset this keymap": every shortcut back to the keymap's base preset — and, for a saved keymap, the saved copy too
 * (it is that keymap being reset). The confirm says how many change. */
export function resetKeymapToBase() {
	replaceOverrides({});
	const k = activeKeymap();
	if (k) persist(get(savedKeymaps).map((x) => (x.id === k.id ? { ...x, base: get(keymapPreset), changes: {}, at: Date.now() } : x)));
}
