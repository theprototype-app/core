// @ts-nocheck -- fixture test: stubbed modules and loose mocks
// 54i (fix-batch-3 aa): a lazy chunk that fails to load is retried ONCE, then one "A new version
// is ready – Reload" toast — and the splice into vite's preload helper still matches this vite.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { buildReport, CHUNK_LOAD_MSG } from '../../src/lib/errorReportCore.js';

const require = createRequire(import.meta.url);
const { addImportRetry, HELPER_ID, ANCHOR } = require('../../scripts/import-retry.cjs');

const toasts = [];
vi.mock('../../src/stores/appStore.js', () => ({ showToast: (...a) => toasts.push(a) }));
const chunk = await import('../../src/lib/chunkReload.js');

const FAIL = () => new TypeError('Failed to fetch dynamically imported module: https://theprototype.app/_app/immutable/chunks/cm70kyiT.js');

describe('the vite preload helper splice', () => {
	it('matches the installed vite (a vite upgrade that moves it fails here)', () => {
		const src = readFileSync(new URL('../../node_modules/vite/dist/node/chunks/node.js', import.meta.url), 'utf8');
		expect(ANCHOR.test(src)).toBe(true);
	});

	it('routes a failure through the retry, then vite’s own handler', async () => {
		const helper = 'function f(baseModule, handlePreloadError) { return baseModule().catch(handlePreloadError); }';
		const res = addImportRetry(helper, HELPER_ID);
		expect(res.matched).toBe(true);
		expect(addImportRetry(helper, '/src/x.js')).toBeNull();
		const f = new Function('return ' + res.code)();
		let calls = 0;
		const base = () => (++calls === 1 ? Promise.reject(FAIL()) : Promise.resolve('module'));
		globalThis.__tpImportRetry = (load) => load();
		await expect(f(base, (e) => { throw e; })).resolves.toBe('module');
		expect(calls).toBe(2);
		delete globalThis.__tpImportRetry;
		calls = 0;
		await expect(f(base, () => 'handled')).resolves.toBe('handled');
		expect(calls).toBe(1);
	});
});

describe('retryImport', () => {
	beforeEach(() => vi.useFakeTimers());

	it('a dropped fetch is retried once and recovers, with no notice', async () => {
		let n = 0;
		const p = chunk.retryImport(() => (++n, Promise.resolve('ok')), FAIL());
		await vi.advanceTimersByTimeAsync(chunk.RETRY_MS);
		await expect(p).resolves.toBe('ok');
		expect(n).toBe(1);
		expect(toasts.length).toBe(0);
	});

	it('a module that threw while evaluating is not retried', async () => {
		const load = vi.fn();
		await expect(chunk.retryImport(load, new Error('boom'))).rejects.toThrow('boom');
		expect(load).not.toHaveBeenCalled();
	});

	it('a chunk that is gone: one retry, then ONE sticky Reload toast however often it happens', async () => {
		const load = vi.fn(() => Promise.reject(FAIL()));
		const p1 = chunk.retryImport(load, FAIL());
		p1.catch(() => {});
		await vi.advanceTimersByTimeAsync(chunk.RETRY_MS);
		await expect(p1).rejects.toThrow(/dynamically imported module/);
		const p2 = chunk.retryImport(load, FAIL());
		p2.catch(() => {});
		await vi.advanceTimersByTimeAsync(chunk.RETRY_MS);
		await expect(p2).rejects.toThrow();
		expect(load).toHaveBeenCalledTimes(2);
		expect(toasts.length).toBe(1);
		const [message, actions, opts] = toasts[0];
		expect(message).toMatch(/^A new version is ready – Reload/);
		expect(actions.map((a) => a.label)).toEqual(['Reload']);
		expect(opts).toEqual({ keep: true });
	});
});

describe('error reports', () => {
	it('every chunk failure files under one signature', () => {
		const ctx = { origin: 'https://theprototype.app', release: '1.54.3', build: 'abc', device: 'phone', browser: 'chrome 140', os: 'android 15', gpu: 'webgl2', area: 'edit', env: 'prod' };
		const a = buildReport({ kind: 'rejection', message: FAIL().message }, ctx);
		const b = buildReport({ kind: 'rejection', message: 'Failed to fetch dynamically imported module: https://theprototype.app/_app/immutable/nodes/2.Xy.js', stack: 'TypeError\n    at x (https://theprototype.app/_app/immutable/chunks/a.js:1:2)' }, ctx);
		expect(a?.msg).toBe(CHUNK_LOAD_MSG);
		expect(b?.sig).toBe(a?.sig);
	});
});
