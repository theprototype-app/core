import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
	getItem,
	setItem,
	removeItem,
	keys,
	clear,
	storageDebug,
	debugResetStorage,
	safeStorage,
	get,
	set,
	remove
} from '../../src/lib/safeStorage.js';

// 27-H (audit M4). The whole value of this module is what it does when storage is
// BROKEN, and every one of those states is reachable here with no browser: node has no
// `localStorage` at all, and the two failure modes are a `setItem` that throws (Safari
// private mode, a full quota) and a `localStorage` property that throws on ACCESS (a
// sandboxed iframe, some enterprise policies) — the second of which every
// `typeof localStorage === 'undefined'` guard in this codebase misses.

/** a working stand-in, so the happy path is testable too @param {any} overrides */
function fakeStorage(overrides = {}) {
	/** @type {Map<string, string>} */
	const map = new Map();
	return Object.assign(
		{
			/** @param {string} k */
			getItem: (k) => (map.has(k) ? map.get(k) : null),
			/** @param {string} k @param {any} v */
			setItem: (k, v) => map.set(k, String(v)),
			/** @param {string} k */
			removeItem: (k) => map.delete(k),
			clear: () => map.clear(),
			get length() {
				return map.size;
			},
			/** @param {number} i */
			key: (i) => [...map.keys()][i] ?? null,
			__map: map
		},
		overrides
	);
}

/** @param {any} value */
function install(value) {
	Object.defineProperty(globalThis, 'localStorage', {
		configurable: true,
		get() {
			if (typeof value === 'function') return value();
			return value;
		}
	});
}

afterEach(() => {
	// @ts-ignore - installed by `install()` above; node has no localStorage to begin with
	delete globalThis.localStorage;
	debugResetStorage();
});

beforeEach(() => debugResetStorage());

describe('with no storage at all (SSR, or a browser that has none)', () => {
	it('still remembers what you set, for this session', () => {
		expect(setItem('theme', 'light')).toBe(false);
		expect(getItem('theme')).toBe('light');
	});

	it('says so, rather than pretending', () => {
		setItem('theme', 'light');
		const state = storageDebug();
		expect(state.available).toBe(false);
		expect(state.degraded).toBe(true);
		expect(state.fallbackKeys).toBe(1);
	});

	it('reads a key nobody set as null, not undefined', () => {
		expect(getItem('never-set')).toBe(null);
	});
});

describe('with working storage', () => {
	it('writes through and keeps nothing in memory', () => {
		const store = fakeStorage();
		install(store);
		expect(setItem('theme', 'dark')).toBe(true);
		expect(store.__map.get('theme')).toBe('dark');
		expect(storageDebug().fallbackKeys).toBe(0);
		expect(storageDebug().degraded).toBe(false);
		expect(getItem('theme')).toBe('dark');
	});

	it('coerces like localStorage does', () => {
		install(fakeStorage());
		setItem('count', 3);
		expect(getItem('count')).toBe('3');
	});

	it('removes from both sides', () => {
		const store = fakeStorage();
		install(store);
		setItem('theme', 'dark');
		removeItem('theme');
		expect(getItem('theme')).toBe(null);
		expect(store.__map.has('theme')).toBe(false);
	});
});

describe("Safari private mode: setItem throws, and that used to kill the caller's subscriber", () => {
	it('does not throw, and the setting still applies', () => {
		install(
			fakeStorage({
				setItem() {
					throw new DOMException('QuotaExceededError', 'QuotaExceededError');
				}
			})
		);
		expect(() => setItem('theme', 'light')).not.toThrow();
		expect(getItem('theme')).toBe('light');
		const state = storageDebug();
		expect(state.degraded).toBe(true);
		expect(state.failures).toBe(1);
		expect(state.lastError).toBe('QuotaExceededError');
	});

	it('the counterfactual: a bare call in the same place does throw', () => {
		install(
			fakeStorage({
				setItem() {
					throw new Error('nope');
				}
			})
		);
		expect(() => globalThis.localStorage.setItem('theme', 'light')).toThrow();
	});

	it('a later successful write makes real storage the truth again', () => {
		let broken = true;
		const store = fakeStorage({
			/** @param {string} k @param {any} v */
			setItem(k, v) {
				if (broken) throw new Error('nope');
				store.__map.set(k, String(v));
			}
		});
		install(store);
		setItem('theme', 'light');
		expect(storageDebug().fallbackKeys).toBe(1);
		broken = false;
		setItem('theme', 'dark');
		// the shadow is dropped, or it would outvote the real value forever
		expect(storageDebug().fallbackKeys).toBe(0);
		expect(getItem('theme')).toBe('dark');
	});
});

describe('a sandboxed iframe: touching localStorage throws on ACCESS', () => {
	it('is survived, which no `typeof localStorage` guard manages', () => {
		install(() => {
			throw new DOMException('The operation is insecure.', 'SecurityError');
		});
		expect(() => setItem('theme', 'light')).not.toThrow();
		expect(() => getItem('theme')).not.toThrow();
		expect(() => keys()).not.toThrow();
		// the value is still readable — that is the promise — so read it BEFORE the two
		// calls that legitimately drop the fallback
		expect(getItem('theme')).toBe('light');
		expect(storageDebug().available).toBe(false);
		expect(() => removeItem('theme')).not.toThrow();
		expect(() => clear()).not.toThrow();
	});
});

describe('keys() is the union of both sides', () => {
	it('lists real keys and fallen-back ones together', () => {
		const store = fakeStorage({
			/** @param {string} k @param {any} v */
			setItem(k, v) {
				if (k === 'bad') throw new Error('nope');
				store.__map.set(k, String(v));
			}
		});
		install(store);
		setItem('win:a', '1');
		setItem('bad', '2');
		expect(keys().sort()).toEqual(['bad', 'win:a']);
	});
});

describe('the shapes callers use', () => {
	it('the drop-in object and the short names are the same functions', () => {
		expect(safeStorage.getItem).toBe(getItem);
		expect(safeStorage.setItem).toBe(setItem);
		expect(safeStorage.removeItem).toBe(removeItem);
		expect(get).toBe(getItem);
		expect(set).toBe(setItem);
		expect(remove).toBe(removeItem);
	});
});
