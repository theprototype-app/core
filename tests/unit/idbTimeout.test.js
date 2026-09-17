import { describe, it, expect, vi } from 'vitest';
import { withTimeout, OP_TIMEOUT_MS } from '../../src/lib/idb.js';

// 27-H (audit M3). `withTimeout` is the pure half of the IndexedDB wrapper — the half
// that decides whether a caller ever hears back — so it is tested here, with no browser
// and no IndexedDB at all. The e2e suite covers the parts that need a real transaction
// (an abort rejecting, a stalled one hitting this bound).
//
// THE THING THAT MATTERS is the last describe: a promise that never settles must still
// reject, because that is the exact shape of the bug this phase exists to fix.

describe('a settled promise passes straight through', () => {
	it('resolves with its own value', async () => {
		await expect(withTimeout(Promise.resolve(7), 1000, 'get')).resolves.toBe(7);
	});

	it('rejects with its own error, not a timeout', async () => {
		const boom = new Error('aborted');
		await expect(withTimeout(Promise.reject(boom), 1000, 'put')).rejects.toBe(boom);
	});
});

describe('a promise that never settles is rejected anyway', () => {
	it('rejects with a labelled, marked timeout', async () => {
		const never = new Promise(() => {});
		const error = await withTimeout(never, 5, 'put').catch((e) => e);
		expect(error).toBeInstanceOf(Error);
		expect(error.timedOut).toBe(true);
		expect(String(error.message)).toContain('put');
		expect(String(error.message)).toContain('5ms');
	});

	// The counterfactual for the fix itself: without the bound, awaiting the same promise
	// produces nothing at all. `Promise.race` against a short timer is how the test says
	// "this never came back" without hanging the run.
	it('would hang forever without it', async () => {
		const never = new Promise(() => {});
		const outcome = await Promise.race([
			never.then(() => 'settled'),
			new Promise((resolve) => setTimeout(() => resolve('still waiting'), 30))
		]);
		expect(outcome).toBe('still waiting');
	});
});

describe('the timer never outlives the operation', () => {
	it('is cleared when the promise resolves first', async () => {
		vi.useFakeTimers();
		try {
			await withTimeout(Promise.resolve('ok'), 10_000, 'get');
			// a leaked 10s handle per read would keep a few hundred timers alive across
			// one storage scan, and hold a node process open
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it('is cleared when the promise rejects first', async () => {
		vi.useFakeTimers();
		try {
			await withTimeout(Promise.reject(new Error('nope')), 10_000, 'put').catch(() => {});
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('the default bound is a contract', () => {
	it('is ten seconds — enough for any write this app can make', () => {
		expect(OP_TIMEOUT_MS).toBe(10_000);
	});
});
