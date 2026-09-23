// 30c: the play SPAWN is scene data on scenePhysics' play block — present only when set, so a
// scene that never set one normalizes (and saves) exactly as before.
import { describe, it, expect } from 'vitest';
import { normalizeScenePhysics } from '../../src/lib/scenePhysics.js';

describe('scenePhysics play.spawn', () => {
	it('is absent by default (a scene without one is byte-identical)', () => {
		const state = normalizeScenePhysics({});
		expect('spawn' in state.play).toBe(false);
		expect(JSON.stringify(normalizeScenePhysics({ play: { simOnPlay: true } }).play)).toBe(
			JSON.stringify({ interaction: 'grab', grounded: false, simOnPlay: true })
		);
	});

	it('keeps a valid spawn: feet position and yaw', () => {
		const state = normalizeScenePhysics({ play: { spawn: { pos: [1, 0.3, 4.6], yaw: -0.2 } } });
		expect(state.play.spawn).toEqual({ pos: [1, 0.3, 4.6], yaw: -0.2 });
		// yaw defaults to 0 (looking down -Z, the fixed start's direction)
		expect(normalizeScenePhysics({ play: { spawn: { pos: [0, 0, 0] } } }).play.spawn).toEqual({ pos: [0, 0, 0], yaw: 0 });
	});

	it('drops a malformed or cleared spawn instead of carrying it', () => {
		for (const spawn of [null, {}, { pos: [1, 2] }, { pos: [1, 'x', 3] }, { pos: [NaN, 0, 0] }, { pos: [1e9, 0, 0] }])
			expect('spawn' in normalizeScenePhysics({ play: { spawn } }).play).toBe(false);
	});
});
