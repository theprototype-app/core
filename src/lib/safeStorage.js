// 27-H (hardening audit M4) — LOCAL STORAGE THAT CANNOT TAKE A SUBSCRIBER DOWN WITH IT.
//
// THE FINDING: ~500 bare `localStorage` calls across ~90 files, and `setItem` THROWS
// synchronously in Safari private mode and whenever the origin's quota is full. Most of
// these sit inside `$effect`s and store subscribers, so the throw does not merely fail to
// persist a setting — it kills that subscriber for the rest of the session, and the UI it
// drives stops updating. "The theme picker stopped working" is what that looks like from
// the outside, and nothing in it points at storage.
//
// Reading is not safe either, which is less well known: in a sandboxed iframe, and under
// some enterprise policies, merely TOUCHING `window.localStorage` throws SecurityError —
// so even `typeof localStorage === 'undefined'` guards, which this codebase has a hundred
// of, do not cover it. Every access here goes through one try/catch.
//
// THE FALLBACK IS PER-KEY, and that is what makes the promise honest. A setting whose
// write failed is remembered in memory, so it still APPLIES for this session and reads
// back as what you set; it simply does not survive a reload. That is the degradation a
// user can live with. A successful write drops the key from memory again, because
// localStorage is then the truth and a stale shadow would outvote it.
//
// A DELIBERATE LEAF: this module imports NOTHING. It is reached from stores, from
// components, from the diagnostics layer's own neighbours and from modules on every side
// of the history-cycle family, so any import at all here is a future cycle. It is also
// what lets the unit layer test it with no browser.

/** keys whose real write failed, or everything when storage is unreachable @type {Map<string, string>} */
const memory = new Map();
/** how many writes have fallen back — read by the diagnostics section and the suite */
let failures = 0;
/** @type {string | null} the last failure's name, so a report can say WHICH kind it was */
let lastError = null;

/**
 * The backing store, or null when it is unreachable. The property access itself is inside
 * the try: that is the SecurityError case above, and it is the one every `typeof` guard
 * in this codebase misses.
 * @returns {Storage | null}
 */
function backing() {
	try {
		return typeof localStorage === 'undefined' ? null : localStorage;
	} catch {
		return null;
	}
}

/** @param {any} error */
function noteFailure(error) {
	failures++;
	lastError = String(error?.name || error || 'unknown');
}

/**
 * Read a key. Memory first, because a key is only in memory when its real write FAILED,
 * and the value you just set is the one you expect to read back.
 * @param {string} key @returns {string | null}
 */
export function getItem(key) {
	if (memory.has(key)) return /** @type {string} */ (memory.get(key));
	try {
		return backing()?.getItem(key) ?? null;
	} catch (error) {
		noteFailure(error);
		return null;
	}
}

/**
 * Write a key. NEVER throws — that is the entire point — and returns whether it reached
 * real storage, for the rare caller that wants to say so.
 * @param {string} key @param {any} value @returns {boolean}
 */
export function setItem(key, value) {
	const text = String(value);
	const store = backing();
	if (store) {
		try {
			store.setItem(key, text);
			// the real store is the truth again; a leftover shadow would outvote it
			memory.delete(key);
			return true;
		} catch (error) {
			noteFailure(error);
		}
	}
	memory.set(key, text);
	return false;
}

/** @param {string} key */
export function removeItem(key) {
	memory.delete(key);
	try {
		backing()?.removeItem(key);
	} catch (error) {
		noteFailure(error);
	}
}

/**
 * Every stored key, real and fallen-back (the "reset my window layout" sweep needs it).
 *
 * Enumerated through `length` + `key(i)` rather than `Object.keys`, which is what the
 * call site this replaces used: `Object.keys` happens to work on the real `Storage`
 * exotic object and returns METHOD NAMES on anything that merely implements the
 * interface, so the standards-defined enumeration is both more correct and the one a
 * stand-in can satisfy.
 */
export function keys() {
	/** @type {Set<string>} */
	const out = new Set(memory.keys());
	try {
		const store = backing();
		if (store) for (let i = 0; i < store.length; i++) {
			const key = store.key(i);
			if (key != null) out.add(key);
		}
	} catch (error) {
		noteFailure(error);
	}
	return [...out];
}

/** Wipe everything (Settings ▸ Reset settings) */
export function clear() {
	memory.clear();
	try {
		backing()?.clear();
	} catch (error) {
		noteFailure(error);
	}
}

/** The spec's short names, for new code. Identical behaviour. */
export const get = getItem;
export const set = setItem;
export const remove = removeItem;

/**
 * A DROP-IN for the `localStorage` object itself, so the codemod that replaced ~500 call
 * sites is one identifier per line and nothing else — a rename a reviewer can check by
 * eye, rather than 500 opportunities to change a semicolon.
 */
export const safeStorage = { getItem, setItem, removeItem, clear, keys };

/**
 * Is persistence working, and what has it cost? The diagnostics bundle asks; so does the
 * suite. `degraded` is the thing worth reading: it means settings are applying but not
 * surviving a reload, which is otherwise completely invisible.
 */
export function storageDebug() {
	return {
		available: !!backing(),
		degraded: memory.size > 0 || failures > 0,
		fallbackKeys: memory.size,
		failures,
		lastError
	};
}

/** TEST SEAM: forget the fallback, so one suite section cannot colour the next. */
export function debugResetStorage() {
	memory.clear();
	failures = 0;
	lastError = null;
}
