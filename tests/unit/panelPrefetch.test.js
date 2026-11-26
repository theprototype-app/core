// 102-boot-diet-3 (Q3 = b) — the idle prefetch of the five dock editors: WHEN it may run (the link), and that a
// failure is SILENT (chunkReload.quietly keeps the "A new version is ready" notice for loads the person asked for).
// The page-level rows (after the load event, nothing fetched during boot, Save-Data / 2G skip, blocked chunks then a
// working first open) are tests/e2e/dock-on-demand section 2.
import { describe, it, expect, vi } from 'vitest';

/** @type {any[]} */
const toasts = [];
vi.mock('../../src/stores/appStore.js', () => ({
	showToast: (/** @type {any} */ t) => toasts.push(t),
	dismissToastById: () => {}
}));
vi.mock('../../src/lib/playMode.js', async () => ({ embedMode: (await import('svelte/store')).writable(false) }));
const { prefetchAllowed, PREFETCH_KEYS } = await import('../../src/lib/panelPrefetch.js');
const chunk = await import('../../src/lib/chunkReload.js');

describe('prefetchAllowed', () => {
	it('runs when the browser says nothing about the link', () => {
		expect(prefetchAllowed(undefined)).toBe(true);
		expect(prefetchAllowed(null)).toBe(true);
		expect(prefetchAllowed({})).toBe(true);
		expect(prefetchAllowed({ effectiveType: '4g' })).toBe(true);
		expect(prefetchAllowed({ effectiveType: '3g', saveData: false })).toBe(true);
	});
	it('stands down on Save-Data and on a 2G-class link', () => {
		expect(prefetchAllowed({ saveData: true, effectiveType: '4g' })).toBe(false);
		expect(prefetchAllowed({ effectiveType: '2g' })).toBe(false);
		expect(prefetchAllowed({ effectiveType: 'slow-2g' })).toBe(false);
	});
	it('covers exactly the five dock editors', () => {
		expect([...PREFETCH_KEYS].sort()).toEqual(['animation', 'hud', 'shader', 'timeline', 'uv']);
	});
});

describe('quietly', () => {
	it('a chunk failure inside a background load says nothing; a later one does', async () => {
		const fail = () =>
			Promise.reject(new Error('Failed to fetch dynamically imported module: /x.js'));
		await expect(
			chunk.quietly(() => fail().catch((e) => (chunk.noteStaleCode(), Promise.reject(e))))
		).rejects.toThrow();
		expect(toasts.length).toBe(0);
		expect(chunk.reloadPromptShown()).toBe(false);
		chunk.noteStaleCode(); // a load the person asked for
		expect(toasts.length).toBe(1);
	});
});
