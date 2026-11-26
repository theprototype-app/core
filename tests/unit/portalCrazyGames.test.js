import { describe, it, expect } from 'vitest';
import { portalPhase, createPortalDriver } from '../../src/lib/export/portals/crazygames.js';
import { PORTAL_SDK_SCRIPTS } from '../../src/lib/export/portals/index.js';
import { EXPORT_ALLOWED_HOSTS } from '../../src/lib/export/exportCore.js';

// 63 PG3: the CrazyGames adapter — the game-flow facts folded into loading / gameplay / break, and
// the SDK called on the EDGES only, in the order the docs ask for (sdk/game, read 2026-11-23).

const base = { runtime: 'playing', locked: true, shellUnused: false, state: 'playing', pointerFree: false, transition: 'idle', levelLoading: false };

describe('portalPhase', () => {
	it('boot = loading; Play with the round underway = gameplay', () => {
		expect(portalPhase({ ...base, runtime: 'scene' })).toBe('loading');
		expect(portalPhase(base)).toBe('gameplay');
	});
	it('a menu, a pause, game over, a level change, out of Play = break', () => {
		expect(portalPhase({ ...base, state: 'menu' })).toBe('break');
		expect(portalPhase({ ...base, state: 'paused' })).toBe('break');
		expect(portalPhase({ ...base, state: 'over' })).toBe('break');
		expect(portalPhase({ ...base, pointerFree: true })).toBe('break');
		expect(portalPhase({ ...base, transition: 'out' })).toBe('break');
		expect(portalPhase({ ...base, locked: false })).toBe('break');
		expect(portalPhase({ ...base, levelLoading: true })).toBe('loading');
	});
	it('a scene that never uses the game shell plays the whole time it is in Play', () => {
		expect(portalPhase({ ...base, shellUnused: true, state: 'menu' })).toBe('gameplay');
	});
});

describe('createPortalDriver', () => {
	it('start / pause / resume / game over / next level, each edge once, in order', () => {
		/** @type {string[]} */
		const sdk = [];
		const game = { loadingStart: () => sdk.push('loadingStart'), loadingStop: () => sdk.push('loadingStop'), gameplayStart: () => sdk.push('gameplayStart'), gameplayStop: () => sdk.push('gameplayStop') };
		const d = createPortalDriver(game);
		const seq = [
			{ ...base, runtime: 'engine' },
			{ ...base, runtime: 'scene' }, // still loading: no call
			{ ...base, state: 'menu' }, // the start menu
			base, // Start pressed
			base, // a re-publish of the same state: no call
			{ ...base, state: 'paused' },
			base, // resume
			{ ...base, state: 'over' }, // game over
			{ ...base, transition: 'out' }, // next level: the cover
			{ ...base, levelLoading: true },
			base // the next level plays
		];
		for (const f of seq) d.update(portalPhase(f));
		expect(sdk).toEqual(['loadingStart', 'loadingStop', 'gameplayStart', 'gameplayStop', 'gameplayStart', 'gameplayStop', 'loadingStart', 'loadingStop', 'gameplayStart']);
		expect(d.calls).toEqual(sdk);
	});
	it('a throwing SDK never stops the game (the disabled environment throws on every call)', () => {
		const boom = () => {
			throw new Error('disabled');
		};
		const d = createPortalDriver({ loadingStart: boom, loadingStop: boom, gameplayStart: boom, gameplayStop: boom });
		expect(() => d.update('loading')).not.toThrow();
		expect(() => d.update('gameplay')).not.toThrow();
	});
	it('the SDK script is the one host the CrazyGames preset allows', () => {
		expect(EXPORT_ALLOWED_HOSTS.crazygames).toEqual([new URL(PORTAL_SDK_SCRIPTS.crazygames).host]);
	});
});
