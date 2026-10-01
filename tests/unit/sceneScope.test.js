// 33 (L4): a module the scene being LEFT used and the new one does not is LEFT BEHIND, and
// what it registered for its own game — levels, How to play, settings rows, Restart, music,
// spawn — stops counting until a scene uses it again. Pure parts, no browser.
import { describe, it, expect, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import {
	registerSceneUsage,
	noteSceneLeaving,
	settleScope,
	recomputeScope,
	forgetScopeOf,
	ownerInScope,
	leftBehindModules,
	resetSceneScope,
	scopePending
} from '../../src/lib/sceneScope.js';
import { setGameLevels, setGameHelp, gameLevels, gameHelp, resetGameShell, onGameRestart, restartGame } from '../../src/lib/gameShell.js';
import { registerGameSetting, gameSettingRows, gameSettingValue, debugResetGameSettings } from '../../src/lib/gameSettings.js';
import { resolvePlaySettings, setRuntimeSpawn } from '../../src/lib/playSettings.js';
import { safeStorage, debugResetStorage } from '../../src/lib/safeStorage.js';

/** what the "scene on screen" uses, set by each test */
let used = /** @type {string[]} */ ([]);

beforeEach(() => {
	for (const key of safeStorage.keys()) safeStorage.removeItem(key);
	debugResetStorage();
	debugResetGameSettings();
	resetGameShell();
	resetSceneScope();
	setRuntimeSpawn(null);
	used = [];
	registerSceneUsage(() => used);
});

/** a switch from a scene using `from` to one using `to` (clear, then the new scene arrives) */
function switchScene(/** @type {string[]} */ from, /** @type {string[]} */ to, declared = to) {
	used = from;
	noteSceneLeaving();
	used = to;
	settleScope(declared);
}

describe('left behind', () => {
	it('a module the old scene used and the new one does not is left behind', () => {
		switchScene(['waves', 'health'], []);
		expect([...get(leftBehindModules)].sort()).toEqual(['health', 'waves']);
		expect(ownerInScope('waves')).toBe(false);
		expect(ownerInScope('')).toBe(true);
		expect(ownerInScope('node:abc')).toBe(true);
		expect(ownerInScope('towers')).toBe(true); // never used by the scene: never judged
	});
	it('a module the new scene also uses stays in scope (Dungeon level 1 -> level 2)', () => {
		switchScene(['dungeon', 'dungeon-realms'], ['dungeon', 'dungeon-realms']);
		expect(get(leftBehindModules).size).toBe(0);
	});
	it('a module the new scene DECLARES counts as used even before its nodes land', () => {
		switchScene(['waves'], [], ['waves']);
		expect(get(leftBehindModules).size).toBe(0);
	});
	it('an objects-only clear keeps the graphs, so nothing is left behind and the judgement waits', () => {
		used = ['waves'];
		noteSceneLeaving();
		expect(get(leftBehindModules).size).toBe(0);
		expect(scopePending()).toBe(true);
		// a peer's replacement arrives later as a nodes snapshot: the recompute judges it
		used = [];
		recomputeScope();
		expect(get(leftBehindModules).has('waves')).toBe(true);
	});
	it('coming back to the game brings the module back into scope', () => {
		switchScene(['waves'], []);
		expect(ownerInScope('waves')).toBe(false);
		switchScene([], ['waves']);
		expect(ownerInScope('waves')).toBe(true);
	});
	it('a module that is (re)activated starts in scope', () => {
		switchScene(['waves'], []);
		forgetScopeOf('waves');
		expect(ownerInScope('waves')).toBe(true);
	});
});

describe('what a left-behind module registered stops counting', () => {
	it('levels: the newest IN-SCOPE registration shows, and returns with its game', () => {
		setGameLevels({ list: [{ id: '1' }, { id: '2' }] }, 'towers');
		setGameLevels({ list: [{ id: 'w1' }] }, 'waves');
		expect(get(gameLevels)?.owner).toBe('waves');
		switchScene(['waves'], []);
		expect(get(gameLevels)?.owner).toBe('towers'); // Waves kept, Towers on screen
		switchScene([], ['waves']);
		expect(get(gameLevels)?.owner).toBe('waves'); // back, with no re-registration
	});
	it('levels: a left-behind module alone shows NO levels (counterfactual of the reported leak)', () => {
		setGameLevels({ list: [{ id: 'w1' }] }, 'waves');
		switchScene(['waves'], []);
		expect(get(gameLevels)).toBe(null);
	});
	it('help follows the same rule, and off() removes only its own', () => {
		const offW = setGameHelp('Hold the crystal', 'waves');
		switchScene(['waves'], []);
		expect(get(gameHelp)).toBe(null);
		switchScene([], ['waves']);
		expect(get(gameHelp)?.lines).toEqual(['Hold the crystal']);
		offW();
		expect(get(gameHelp)).toBe(null);
	});
	it('settings rows: a left-behind module row leaves the Settings page and its value', () => {
		registerGameSetting({ id: 'board', label: 'Board', type: 'choice', options: ['globe', '2d'], default: 'globe' }, 'untangle');
		registerGameSetting({ id: 'stars-point-grab', label: 'Point', type: 'toggle', default: true }, 'node:n1');
		expect(get(gameSettingRows).map((r) => r.id).sort()).toEqual(['board', 'stars-point-grab']);
		switchScene(['untangle'], []);
		expect(get(gameSettingRows).map((r) => r.id)).toEqual(['stars-point-grab']);
		expect(gameSettingValue('board')).toBe(undefined);
		switchScene([], ['untangle']);
		expect(gameSettingValue('board')).toBe('globe');
	});
	it('restart: a left-behind module hook does not run', () => {
		/** @type {string[]} */
		const ran = [];
		onGameRestart(() => ran.push('waves'), 'waves');
		onGameRestart(() => ran.push('towers'), 'towers');
		switchScene(['waves'], []);
		restartGame();
		expect(ran).toEqual(['towers']);
	});
	it('spawn: a left-behind module spawn is ignored', () => {
		setRuntimeSpawn([5, 0, 5], 0, 'waves');
		expect(resolvePlaySettings(null).spawn?.position).toEqual([5, 0, 5]);
		switchScene(['waves'], []);
		expect(resolvePlaySettings(null).spawn ?? null).toBe(null);
	});
});
