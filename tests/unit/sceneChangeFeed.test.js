import { describe, it, expect, vi } from 'vitest';
import { sceneChangeFeed } from '../../src/lib/sceneChangeFeed.js';

// CL-5 (37-continuity): the feed a cloud room keeper autosaves from. A minimal store stub (the svelte
// writable contract: subscribe calls back synchronously with the current value, returns unsubscribe)
// keeps this in the zero-import unit layer.
function counter(start = 0) {
	let value = start;
	const subs = new Set();
	return {
		subscribe(fn) {
			subs.add(fn);
			fn(value);
			return () => subs.delete(fn);
		},
		bump() {
			value++;
			for (const fn of [...subs]) fn(value);
		},
		get size() {
			return subs.size;
		}
	};
}

describe('sceneChangeFeed', () => {
	it('reads 0 and subscribes nothing before the source is primed', () => {
		const feed = sceneChangeFeed(() => null);
		expect(feed.revision()).toBe(0);
		const off = feed.onChange(() => {});
		expect(typeof off).toBe('function');
		off();
	});

	it('subscribes NOTHING until a plugin asks (the OSS build is untouched)', () => {
		const store = counter();
		sceneChangeFeed(() => store);
		expect(store.size).toBe(0);
		store.bump();
		expect(store.size).toBe(0);
	});

	it('revision() reads the counter without leaving a subscription behind', () => {
		const store = counter(5);
		const feed = sceneChangeFeed(() => store);
		expect(feed.revision()).toBe(5);
		store.bump();
		expect(feed.revision()).toBe(6);
		expect(store.size).toBe(0);
	});

	it('a listener hears changes, never the synchronous first call', () => {
		const store = counter(3);
		const feed = sceneChangeFeed(() => store);
		const heard = [];
		const off = feed.onChange((n) => heard.push(n));
		expect(heard).toEqual([]);
		store.bump();
		store.bump();
		expect(heard).toEqual([4, 5]);
		off();
	});

	it('off() unsubscribes, once, and is idempotent', () => {
		const store = counter();
		const feed = sceneChangeFeed(() => store);
		const fn = vi.fn();
		const off = feed.onChange(fn);
		expect(store.size).toBe(1);
		off();
		off();
		expect(store.size).toBe(0);
		store.bump();
		expect(fn).not.toHaveBeenCalled();
	});

	it('a throwing listener never breaks the others', () => {
		const store = counter();
		const feed = sceneChangeFeed(() => store);
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const good = vi.fn();
		feed.onChange(() => {
			throw new Error('boom');
		});
		feed.onChange(good);
		store.bump();
		expect(good).toHaveBeenCalledWith(1);
		warn.mockRestore();
	});

	it('ignores a non-function listener', () => {
		const store = counter();
		const feed = sceneChangeFeed(() => store);
		const off = feed.onChange(/** @type {any} */ (null));
		expect(store.size).toBe(0);
		off();
	});
});
