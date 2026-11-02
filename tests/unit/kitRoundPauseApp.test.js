// 54i F15 (roadmap 78): kit.round's clock through a pause on the APP's real path — runtime.js's kit
// (sessionNow, core's gameState singleton, tickKit per frame) — paused both ways the app can: the
// round's own Pause node and a game-state pause (the pause menu / Set Game State) the tick adopts.
// The round's own clock was never the bug (see sim/behaviourPause.test.js); this keeps it proven.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { kit, tickKit, resetKit } from '../../src/lib/kit/runtime.js';
import { setGameState, gameState } from '../../src/lib/gameState.js';
import { get } from 'svelte/store';

/** frames at 60 Hz for `ms` @param {number} ms */
const run = (ms) => {
	for (let t = 0; t < ms; t += 16) {
		vi.advanceTimersByTime(16);
		tickKit();
	}
};

describe('kit.round pause / resume on the app runtime (54i F15)', () => {
	afterEach(() => vi.useRealTimers());
	for (const via of ['round', 'game']) {
		it(`paused via ${via}: 6 s paused, then still playing with the pause excluded`, () => {
			vi.useFakeTimers({ now: 1_800_000_000_000 });
			resetKit();
			const R = kit.impls.round;
			R.configure(1, 30, 'lose', 1);
			R.start();
			run(1100);
			expect(R.phase()).toBe('playing');
			run(2000);
			if (via === 'round') R.pause();
			else setGameState('paused');
			run(6300);
			expect(R.phase()).toBe('paused');
			if (via === 'round') R.resume();
			else setGameState('playing');
			run(100);
			expect(R.phase()).toBe('playing');
			expect(get(gameState).state).toBe('playing');
			expect(R.extra.state().pausedMs).toBeGreaterThan(6200);
			run(8000);
			expect(R.phase()).toBe('playing');
			// 2 + 0.1 + 8 s of play: ~19.9 s left
			expect(R.remaining()).toBeGreaterThan(19);
			expect(R.remaining()).toBeLessThan(21);
		});
	}
});
