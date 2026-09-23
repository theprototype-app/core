// 30 P4 — WHAT A GAME REMEMBERS ON THIS DEVICE (roadmap 30 fork 7).
//
// Two consumers, one rule: a module's `api.storage` and the Store Value / Stored Value flow
// nodes. Both are LOCAL per device by design — a best score, unlocked levels, a "seen the
// tutorial" flag — so nothing here replicates, nothing enters a scene file and nothing is
// undone. A peer's best is theirs; the card says so ("Saved on this device only").
//
// THE KEYS ARE A CONTRACT, byte for byte, because a module that must run on an older core
// (untangle's fallback for a 1.16 client) writes the SAME key itself so its data survives
// the upgrade:
//
//     tp:mod:<moduleId>:<key>          a module's own namespace (api.storage)
//     tp:scene:<scene name>:<key>      a flow graph's namespace, per scene ('untitled'
//                                      when the scene has no name)
//
// VALUES ARE JSON. `set(key, value)` stores `JSON.stringify(value)`; `get` parses it back
// and hands the fallback over on a missing key OR a value that does not parse (a hand-edited
// entry, a truncated write), because a broken save must never crash a game's boot.
//
// THE CAP is per MODULE (256 KB), measured as the JSON text of every entry in the namespace
// plus its key — what the browser actually spends. A write that would cross it returns
// false and nothing is written; the caller hears it once per session through `onOverCap`
// (moduleSDK turns that into ONE toast), never once per frame.
//
// A DELIBERATE LEAF: it imports safeStorage (itself a leaf) and nothing else, so moduleSDK,
// flowRuntime and a unit test can all reach it. safeStorage is what makes the promise
// honest: in Safari private mode, a sandboxed frame or a full quota the write falls back to
// memory for the session instead of throwing.

import { safeStorage } from './safeStorage';

/** bytes (UTF-16 code units, i.e. JSON text length) one module may keep */
export const MODULE_STORAGE_CAP = 256 * 1024;

/** @param {string} moduleId */
export function modulePrefix(moduleId) {
	return 'tp:mod:' + String(moduleId) + ':';
}

/** @param {string|null|undefined} sceneName */
export function scenePrefix(sceneName) {
	const name = typeof sceneName === 'string' && sceneName.trim() ? sceneName.trim() : 'untitled';
	return 'tp:scene:' + name + ':';
}

/** The full key a module writes. @param {string} moduleId @param {string} key */
export function moduleStorageKey(moduleId, key) {
	return modulePrefix(moduleId) + String(key);
}

/** The full key a Store Value node writes. @param {string|null|undefined} sceneName @param {string} key */
export function sceneStorageKey(sceneName, key) {
	return scenePrefix(sceneName) + String(key);
}

/** Parsed-value cache keyed by the FULL key. Every write through this module keeps it
 * current, so a Stored Value node read every frame costs a Map lookup, not a
 * localStorage read and a JSON.parse. @type {Map<string, {text: string|null, value: any}>} */
const cache = new Map();

/** @param {string} full @returns {{text: string|null, value: any}} */
function read(full) {
	const hit = cache.get(full);
	if (hit) return hit;
	const text = safeStorage.getItem(full);
	/** @type {any} */
	let value;
	let ok = text !== null;
	if (ok) {
		try {
			value = JSON.parse(/** @type {string} */ (text));
		} catch {
			ok = false;
		}
	}
	const entry = { text: ok ? text : null, value: ok ? value : undefined };
	cache.set(full, entry);
	return entry;
}

/** Read a full key: the parsed value, or `fallback` when it is missing or unreadable.
 * @param {string} full @param {any} [fallback] */
export function readStored(full, fallback = undefined) {
	const entry = read(full);
	return entry.text === null ? fallback : entry.value;
}

/** Does a full key hold a readable value? @param {string} full */
export function hasStored(full) {
	return read(full).text !== null;
}

/** Write a full key (JSON). `undefined` removes it. Returns the JSON text written, or
 * null when the value cannot be serialized (a cycle, a BigInt).
 * @param {string} full @param {any} value @returns {string|null} */
export function writeStored(full, value) {
	if (value === undefined) {
		removeStored(full);
		return '';
	}
	/** @type {string} */
	let text;
	try {
		const out = JSON.stringify(value);
		if (typeof out !== 'string') return null; // a function, a symbol
		text = out;
	} catch {
		return null;
	}
	safeStorage.setItem(full, text);
	cache.set(full, { text, value: JSON.parse(text) });
	return text;
}

/** @param {string} full */
export function removeStored(full) {
	safeStorage.removeItem(full);
	cache.delete(full);
}

/** Every full key under a prefix. @param {string} prefix @returns {string[]} */
function fullKeysUnder(prefix) {
	return safeStorage.keys().filter((key) => key.startsWith(prefix));
}

/** The JSON bytes a namespace holds, optionally pretending one key held `replace` instead.
 * @param {string} prefix @param {string} [except] a full key to leave out */
function usedBytes(prefix, except) {
	let total = 0;
	for (const full of fullKeysUnder(prefix)) {
		if (full === except) continue;
		const text = safeStorage.getItem(full);
		if (text !== null) total += full.length + text.length;
	}
	return total;
}

/**
 * The `api.storage` object for one module.
 * @param {string} moduleId
 * @param {{cap?: number, onOverCap?: (info: {key: string, bytes: number, cap: number}) => void}} [options]
 */
export function makeModuleStorage(moduleId, options = {}) {
	const prefix = modulePrefix(moduleId);
	const cap = options.cap ?? MODULE_STORAGE_CAP;
	return {
		/** @param {string} key @param {any} [fallback] */
		get(key, fallback = undefined) {
			return readStored(prefix + String(key), fallback);
		},
		/** @param {string} key @param {any} value @returns {boolean} written */
		set(key, value) {
			const full = prefix + String(key);
			if (value === undefined) {
				removeStored(full);
				return true;
			}
			/** @type {string|undefined} */
			let text;
			try {
				text = JSON.stringify(value);
			} catch {
				return false;
			}
			if (typeof text !== 'string') return false;
			const bytes = usedBytes(prefix, full) + full.length + text.length;
			if (bytes > cap) {
				options.onOverCap?.({ key: String(key), bytes, cap });
				return false;
			}
			return writeStored(full, value) !== null;
		},
		/** @param {string} key */
		remove(key) {
			removeStored(prefix + String(key));
		},
		/** this module's keys, without the prefix, sorted @returns {string[]} */
		keys() {
			return fullKeysUnder(prefix)
				.map((full) => full.slice(prefix.length))
				.sort();
		},
		/** forget everything this module stored — the module's own reset */
		clear() {
			for (const full of fullKeysUnder(prefix)) removeStored(full);
		},
		/** how much of the cap is spent (JSON text of every entry + its key) */
		bytes() {
			return usedBytes(prefix);
		}
	};
}

/** TEST SEAM: forget the parsed-value cache (a suite that writes localStorage directly). */
export function debugResetGameStorage() {
	cache.clear();
}
