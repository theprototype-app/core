// 93 (found by levels-progress): a load loop yields with scheduler.yield(), whose continuation runs AHEAD of timers,
// so a progress publish that waited on setTimeout never fired until the loop ended — the levels loading screen (and
// the load bar) read 0 % for seconds and then 100 %. progress() now publishes on its own once 100 ms have passed.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { get } from 'svelte/store';
import { beginLoad, progress, endLoad, sceneLoad } from '../../src/lib/sceneLoader.js';

afterEach(() => vi.restoreAllMocks());

describe('93 — load progress publishes without a timer', () => {
	it('a loop that never lets a timer run still publishes about every 100 ms', () => {
		let t = 1000;
		vi.spyOn(performance, 'now').mockImplementation(() => t);
		const job = beginLoad('cave', 200);
		/** @type {number[]} */
		const seen = [];
		const unsub = sceneLoad.subscribe((j) => j && seen.push(j.done));
		for (let i = 0; i < 200; i++) {
			t += 5; // 5 ms per object, and no timer ever gets a turn
			progress(job);
		}
		unsub();
		const mids = seen.filter((d) => d > 0 && d < 200);
		expect(mids.length).toBeGreaterThanOrEqual(8); // ~1 s of building: about ten publishes
		expect(mids.length).toBeLessThanOrEqual(12); // still throttled
		endLoad(job);
		expect(get(sceneLoad)).toBe(null);
	});
});
