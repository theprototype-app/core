import { describe, it, expect } from 'vitest';
import { coalescedSubscribe, nextFrame, FRAME_FALLBACK_MS } from '../../src/lib/coalesce.js';

// R29 S2. The debounce behind api.flow/game/peerVars.onChange. A minimal svelte-shaped
// store (subscribe calls back synchronously with the current value, as svelte's does).
/** @param {any} [value] */
function store(value = 0) {
	/** @type {Set<(v: any) => void>} */
	const subs = new Set();
	return {
		/** @param {any} v */
		set(v) {
			value = v;
			for (const s of subs) s(value);
		},
		/** @param {(v: any) => void} cb */
		subscribe(cb) {
			subs.add(cb);
			cb(value);
			return () => subs.delete(cb);
		},
		get count() {
			return subs.size;
		}
	};
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('coalescedSubscribe', () => {
	it('the synchronous subscribe callback is not a change', async () => {
		let calls = 0;
		coalescedSubscribe([store()], () => calls++);
		await tick();
		expect(calls).toBe(0);
	});
	it('a burst of sixty writes runs the handler ONCE, after the burst', async () => {
		const s = store();
		let calls = 0;
		let seen = -1;
		coalescedSubscribe([s], () => {
			calls++;
			seen = 59;
		});
		for (let i = 0; i < 60; i++) s.set(i);
		expect(calls).toBe(0); // not inside the burst
		await tick();
		expect(calls).toBe(1);
		expect(seen).toBe(59);
	});
	it('writes to SEVERAL stores in one burst still coalesce to one call', async () => {
		const a = store(), b = store();
		let calls = 0;
		coalescedSubscribe([a, b], () => calls++);
		a.set(1); b.set(1); a.set(2);
		await tick();
		expect(calls).toBe(1);
	});
	it('separate bursts are separate calls', async () => {
		const s = store();
		let calls = 0;
		coalescedSubscribe([s], () => calls++);
		s.set(1);
		await tick();
		s.set(2);
		await tick();
		expect(calls).toBe(2);
	});
	it('teardown unsubscribes, and a flush already queued does not run', async () => {
		const s = store();
		let calls = 0;
		const off = coalescedSubscribe([s], () => calls++);
		expect(s.count).toBe(1);
		s.set(1);
		off();
		expect(s.count).toBe(0);
		await tick();
		expect(calls).toBe(0);
		s.set(2);
		await tick();
		expect(calls).toBe(0);
	});
	it('a throwing handler does not break the next burst', async () => {
		const s = store();
		let calls = 0;
		const warn = console.warn;
		console.warn = () => {};
		coalescedSubscribe([s], () => {
			calls++;
			throw new Error('module bug');
		});
		s.set(1);
		await tick();
		s.set(2);
		await tick();
		console.warn = warn;
		expect(calls).toBe(2);
	});
});

describe('nextFrame', () => {
	it('runs once on the frame, and the fallback timer does not run it again', async () => {
		/** @type {any[]} */
		const frames = [];
		/** @type {any} */ (globalThis).requestAnimationFrame = (/** @type {any} */ cb) => frames.push(cb);
		let calls = 0;
		nextFrame(() => calls++);
		expect(calls).toBe(0);
		frames.shift()();
		await new Promise((r) => setTimeout(r, FRAME_FALLBACK_MS + 30));
		expect(calls).toBe(1);
		delete (/** @type {any} */ (globalThis)).requestAnimationFrame;
	});
	it('a tab that never paints still gets its call (the timer races the frame)', async () => {
		/** @type {any} */ (globalThis).requestAnimationFrame = () => {};
		let calls = 0;
		nextFrame(() => calls++);
		await new Promise((r) => setTimeout(r, FRAME_FALLBACK_MS + 30));
		expect(calls).toBe(1);
		delete (/** @type {any} */ (globalThis)).requestAnimationFrame;
	});
});
