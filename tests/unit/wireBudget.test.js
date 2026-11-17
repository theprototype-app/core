// 101 F4 — the per-peer inbound budget: counted drops, per peer, per second, never a disconnect;
// the `object` size cap; and the _headers frame-ancestors blocks.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createInboundBudget, approxSize, LIMITS } from '../../src/lib/wireBudget.js';

const clock = () => {
	let t = 1_000_000;
	return { now: () => t, tick: (/** @type {number} */ ms) => (t += ms) };
};

describe('wireBudget', () => {
	it('the limits sit at >= 4x the measured peaks (101-proto STATUS)', () => {
		// heaviest legit load on the receiving page: 534 msgs/s, 1,051,153 bytes/s; largest object JSON 270,665
		expect(LIMITS.msgsPerSec).toBeGreaterThanOrEqual(4 * 534);
		expect(LIMITS.bytesPerSec).toBeGreaterThanOrEqual(4 * 1051153);
		expect(LIMITS.objectBytes).toBeGreaterThanOrEqual(4 * 270665);
		// a big legit object arrives in one window: the byte budget must never be the thing that drops it
		expect(LIMITS.bytesPerSec).toBeGreaterThanOrEqual(LIMITS.objectBytes);
	});

	it('messages over the per-second budget are dropped and counted; the next second starts fresh', () => {
		const c = clock();
		/** @type {string[]} */
		const drops = [];
		const b = createInboundBudget({ now: c.now, limits: { msgsPerSec: 10 }, onDrop: (p, r) => drops.push(p + ':' + r) });
		let ok = 0;
		for (let i = 0; i < 25; i++) if (b.admit('a', { type: 'move' })) ok++;
		expect(ok).toBe(10);
		expect(b.dropped('a')).toBe(15);
		expect(drops.every((d) => d === 'a:msgs')).toBe(true);
		// another peer is not charged for it
		expect(b.admit('b', { type: 'move' })).toBe(true);
		c.tick(1000);
		expect(b.admit('a', { type: 'move' })).toBe(true);
		expect(b.peaks().maxMsgs).toBe(25);
	});

	it('a goodbye and a refusal always get through', () => {
		const c = clock();
		const b = createInboundBudget({ now: c.now, limits: { msgsPerSec: 1 } });
		b.admit('a', { type: 'move' });
		expect(b.admit('a', { type: 'move' })).toBe(false);
		expect(b.admit('a', { type: 'disconnected', peerId: 'a' })).toBe(true);
		expect(b.admit('a', { type: 'refuse', reason: 'proto', need: 2 })).toBe(true);
	});

	it('bytes over the budget drop what follows inside that second', () => {
		const c = clock();
		const b = createInboundBudget({ now: c.now, limits: { bytesPerSec: 1000 } });
		b.noteBytes('a', 600);
		expect(b.admit('a', { type: 'assetchunk' })).toBe(true);
		b.noteBytes('a', 600);
		expect(b.admit('a', { type: 'assetchunk' })).toBe(false);
		c.tick(1000);
		expect(b.admit('a', { type: 'assetchunk' })).toBe(true);
		expect(b.peaks().maxBytes).toBe(1200);
	});

	it('an object over the size cap is dropped; one under it records the measurement', () => {
		const b = createInboundBudget({ limits: { objectBytes: 10_000 } });
		expect(b.admit('a', { type: 'object', element: { geometries: [{ data: { array: new Array(100).fill(1) } }] } })).toBe(true);
		expect(b.peaks().maxObject).toBeGreaterThan(800);
		expect(b.admit('a', { type: 'object', element: { images: [{ url: 'data:' + 'x'.repeat(20_000) }] } })).toBe(false);
		expect(b.peaks().perPeer.a.capped).toBe(1);
		// other types are never size-walked
		expect(b.admit('a', { type: 'meshgeo', big: 'x'.repeat(20_000) })).toBe(true);
	});

	it('approxSize tracks JSON length closely and stops early past the limit', () => {
		const v = { type: 'object', element: { name: 'box', arr: [1.5, 2, 3], nested: { a: 'hello', b: null, c: true } } };
		const real = JSON.stringify(v).length;
		const est = approxSize(v);
		expect(est).toBeGreaterThan(real * 0.7);
		expect(est).toBeLessThan(real * 2);
		expect(approxSize(new Float32Array(1000))).toBe(4000);
		const big = { s: 'x'.repeat(1_000_000), t: 'y'.repeat(1_000_000) };
		expect(approxSize(big, 10)).toBeLessThan(1_100_000);
	});

	it('forget clears the window but keeps the peaks', () => {
		const b = createInboundBudget({ limits: { msgsPerSec: 2 } });
		b.admit('a', {});
		b.admit('a', {});
		b.admit('a', {});
		b.forget('a');
		expect(b.admit('a', {})).toBe(true);
		expect(b.peaks().maxMsgs).toBe(3);
		b.reset();
		expect(b.peaks().maxMsgs).toBe(0);
	});
});

describe('build/_headers frame-ancestors (101 F4)', () => {
	/** @param {Record<string, string>} env */
	const headers = (env) => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-headers-'));
		const clean = { ...process.env };
		for (const k of Object.keys(clean)) if (k.startsWith('VITE_')) delete clean[k];
		execFileSync('node', [path.resolve('scripts/csp-headers.cjs'), dir], { env: { ...clean, MODE: 'nonexistent-mode', ...env }, stdio: 'pipe' });
		const text = fs.readFileSync(path.join(dir, '_headers'), 'utf8');
		fs.rmSync(dir, { recursive: true, force: true });
		return text;
	};

	it('no play origin: the app is self, the play entry and the Discord page stay frameable', () => {
		const t = headers({});
		expect(t).toMatch(/^\/\*\n(.*\n)*  Content-Security-Policy: frame-ancestors 'self'\n/);
		for (const p of ['/play', '/play/*', '/discord', '/discord/*'])
			expect(t).toContain(p + "\n  ! Content-Security-Policy\n  Content-Security-Policy: frame-ancestors *\n");
	});

	it('a play origin: the app is self and the play origin is open, as in 1.65', () => {
		const t = headers({ VITE_PLAY_ORIGIN: 'https://play.example' });
		expect(t).toContain("Content-Security-Policy: frame-ancestors 'self'");
		expect(t).toContain('https://play.example/*\n  ! Content-Security-Policy\n  Content-Security-Policy: frame-ancestors *');
		expect(t).not.toContain('\n/play\n');
	});

	it('an explicit list wins everywhere', () => {
		const t = headers({ VITE_CSP_FRAME_ANCESTORS: 'https://a.example' });
		expect(t).toContain('frame-ancestors https://a.example');
		expect(t).not.toContain('frame-ancestors *');
	});
});
