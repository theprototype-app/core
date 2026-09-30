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
		const state = normalizeScenePhysics({ play: { spawn: { position: [1, 0.3, 4.6], yaw: -0.2 } } });
		expect(state.play.spawn).toEqual({ position: [1, 0.3, 4.6], yaw: -0.2 });
		// yaw defaults to 0 (looking down -Z, the fixed start's direction)
		expect(normalizeScenePhysics({ play: { spawn: { position: [0, 0, 0] } } }).play.spawn).toEqual({ position: [0, 0, 0], yaw: 0 });
	});

	it('drops a malformed or cleared spawn instead of carrying it', () => {
		for (const spawn of [null, {}, { position: [1, 2] }, { position: [1, 'x', 3] }, { position: [NaN, 0, 0] }, { position: [1e9, 0, 0] }])
			expect('spawn' in normalizeScenePhysics({ play: { spawn } }).play).toBe(false);
	});
	it('reads the first 30c shape {pos, yaw} into the contract shape {position, yaw}', () => {
		expect(normalizeScenePhysics({ play: { spawn: { pos: [2, 0, -3], yaw: 1 } } }).play.spawn).toEqual({ position: [2, 0, -3], yaw: 1 });
	});
});
