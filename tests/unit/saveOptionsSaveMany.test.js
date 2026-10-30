// @ts-nocheck — a Map-backed localStorage stub
// Roadmap 56 C13 (addendum 2026-10-28f) — Settings ▸ Save options ▸ "When several libraries are open":
// a device that never chose reads Ask, a choice persists, and junk in storage reads Ask again.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const store = new Map();
globalThis.localStorage = {
	getItem: (k) => (store.has(k) ? store.get(k) : null),
	setItem: (k, v) => store.set(k, String(v)),
	removeItem: (k) => store.delete(k),
	clear: () => store.clear(),
	key: (i) => [...store.keys()][i] ?? null,
	get length() {
		return store.size;
	}
};

describe('saveMany setting', () => {
	beforeEach(() => {
		store.clear();
		vi.resetModules();
	});

	it('defaults to Ask on a device that never chose', async () => {
		const { readSaveOptions } = await import('../../src/lib/saveOptions.js');
		expect(readSaveOptions().saveMany).toBe('ask');
	});

	it('a choice persists under its key and reads back', async () => {
		const { setSaveOptions } = await import('../../src/lib/saveOptions.js');
		expect(setSaveOptions({ saveMany: 'all' }).saveMany).toBe('all');
		expect(store.get('saveManyLibraries')).toBe('all');
		vi.resetModules();
		const again = await import('../../src/lib/saveOptions.js');
		expect(again.readSaveOptions().saveMany).toBe('all');
	});

	it('an unknown stored value reads Ask', async () => {
		store.set('saveManyLibraries', 'everything');
		const { readSaveOptions } = await import('../../src/lib/saveOptions.js');
		expect(readSaveOptions().saveMany).toBe('ask');
	});
});
