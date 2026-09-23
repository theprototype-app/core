// 30 P4: the storage leaf with no browser — namespacing, JSON round trips, the cap, and a
// broken entry never throwing. vitest runs in node, where localStorage does not exist, so
// safeStorage serves every key from its in-memory fallback: the same path Safari private
// mode takes, which is exactly the one worth covering here.
import { describe, it, expect, beforeEach } from 'vitest';
import {
	makeModuleStorage,
	moduleStorageKey,
	sceneStorageKey,
	readStored,
	writeStored,
	MODULE_STORAGE_CAP,
	debugResetGameStorage
} from '../../src/lib/gameStorage.js';
import { safeStorage, debugResetStorage } from '../../src/lib/safeStorage.js';

beforeEach(() => {
	for (const key of safeStorage.keys()) safeStorage.removeItem(key);
	debugResetStorage();
	debugResetGameStorage();
});

describe('the key contract', () => {
	it('is byte-for-byte what a module fallback writes', () => {
		expect(moduleStorageKey('untangle', 'progress')).toBe('tp:mod:untangle:progress');
		expect(sceneStorageKey('Towers', 'best')).toBe('tp:scene:Towers:best');
		expect(sceneStorageKey('', 'best')).toBe('tp:scene:untitled:best');
		expect(sceneStorageKey(null, 'best')).toBe('tp:scene:untitled:best');
	});
});

describe('makeModuleStorage', () => {
	it('round-trips JSON values', () => {
		const s = makeModuleStorage('a');
		expect(s.set('n', 3)).toBe(true);
		expect(s.set('o', { unlocked: 4, solved: [1, 2] })).toBe(true);
		expect(s.set('t', 'hi')).toBe(true);
		expect(s.get('n')).toBe(3);
		expect(s.get('o')).toEqual({ unlocked: 4, solved: [1, 2] });
		expect(s.get('t')).toBe('hi');
		expect(safeStorage.getItem('tp:mod:a:o')).toBe('{"unlocked":4,"solved":[1,2]}');
	});

	it('hands back the fallback for a missing or unreadable key', () => {
		const s = makeModuleStorage('a');
		expect(s.get('missing', 7)).toBe(7);
		safeStorage.setItem('tp:mod:a:broken', '{not json');
		expect(s.get('broken', 'fb')).toBe('fb');
	});

	it('keeps two modules apart', () => {
		const a = makeModuleStorage('a');
		const b = makeModuleStorage('b');
		a.set('score', 1);
		b.set('score', 2);
		expect(a.get('score')).toBe(1);
		expect(b.get('score')).toBe(2);
		expect(a.keys()).toEqual(['score']);
		a.clear();
		expect(a.keys()).toEqual([]);
		expect(b.get('score')).toBe(2);
	});

	it('remove and keys', () => {
		const s = makeModuleStorage('a');
		s.set('x', 1);
		s.set('y', 2);
		expect(s.keys()).toEqual(['x', 'y']);
		s.remove('x');
		expect(s.keys()).toEqual(['y']);
		expect(s.set('y', undefined)).toBe(true);
		expect(s.keys()).toEqual([]);
	});

	it('refuses a write over the cap, once per call, and writes nothing', () => {
		/** @type {any[]} */
		const over = [];
		const s = makeModuleStorage('a', { cap: 100, onOverCap: (info) => over.push(info) });
		expect(s.set('small', 'x'.repeat(40))).toBe(true);
		expect(s.set('big', 'x'.repeat(80))).toBe(false);
		expect(over.length).toBe(1);
		expect(s.get('big', null)).toBe(null);
		// replacing a key measures the NEW value, not old + new
		expect(s.set('small', 'y'.repeat(40))).toBe(true);
		expect(MODULE_STORAGE_CAP).toBe(262144);
	});

	it('refuses what JSON cannot carry instead of throwing', () => {
		const s = makeModuleStorage('a');
		/** @type {any} */
		const cyclic = {};
		cyclic.self = cyclic;
		expect(s.set('c', cyclic)).toBe(false);
		expect(s.set('f', () => 1)).toBe(false);
	});
});

describe('the scene half', () => {
	it('writeStored/readStored share the cache with a direct read', () => {
		const full = sceneStorageKey('Towers', 'best');
		writeStored(full, 12);
		expect(readStored(full, 0)).toBe(12);
		debugResetGameStorage();
		expect(readStored(full, 0)).toBe(12);
	});
});
