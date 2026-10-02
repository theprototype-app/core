// 31 (K3): the game shell's pure parts — levels normalisation and picking, the menu items,
// stepping a setting the way a controller does, the VR hit ids, the FPS median and the
// comfort vignette's target curve.
import { describe, it, expect, beforeEach } from 'vitest';
import {
	normalizeLevels,
	setGameLevels,
	pickGameLevel,
	shellMenuItems,
	stepGameSetting,
	pressShellHit,
	settingDisplay,
	setGameHelp,
	shellHelpLines,
	resetGameShell,
	gameShellDebug,
	shellLevelTabs,
	shellMenu,
	showShellPage
} from '../../src/lib/gameShell.js';
import { get } from 'svelte/store';
import { gameSettingValue, setGameSetting, debugResetGameSettings, registerGameSetting } from '../../src/lib/gameSettings.js';
import { fpsOf } from '../../src/lib/fpsMeter.js';
import { vignetteTarget, easeVignette } from '../../src/lib/comfortVignette.js';
import { safeStorage, debugResetStorage } from '../../src/lib/safeStorage.js';

beforeEach(() => {
	for (const key of safeStorage.keys()) safeStorage.removeItem(key);
	debugResetStorage();
	debugResetGameSettings();
	resetGameShell();
});

describe('levels', () => {
	it('normalises: ids, dedupe, stars 0..5, locked boolean, current must exist', () => {
		const n = normalizeLevels({ list: [{ id: 'a', stars: 9 }, { id: 'a' }, { id: '' }, { id: 'b', label: 'Two', locked: 1, stars: 0 }], current: 'zzz' });
		expect(n?.list).toEqual([{ id: 'a', label: 'a', stars: 5 }, { id: 'b', label: 'Two', locked: true }]);
		expect(n?.current).toBe(null);
		expect(normalizeLevels({ list: [] })).toBe(null);
		expect(normalizeLevels(null)).toBe(null);
	});
	it('a pick reaches onPick, a locked or unknown level refuses', () => {
		/** @type {string[]} */
		const picked = [];
		const off = setGameLevels({ list: [{ id: 'l1' }, { id: 'l2', locked: true }], current: 'l1', onPick: (/** @type {string} */ id) => picked.push(id) }, 'mod');
		expect(pickGameLevel('l2')).toBe(false);
		expect(pickGameLevel('nope')).toBe(false);
		expect(pickGameLevel('l1')).toBe(true);
		expect(picked).toEqual(['l1']);
		expect(gameShellDebug().levels?.current).toBe('l1');
		off?.();
		expect(gameShellDebug().levels).toBe(null);
	});
	it('re-callable: a second registration replaces the first', () => {
		setGameLevels({ list: [{ id: 'a' }] }, 'm');
		setGameLevels({ list: [{ id: 'a' }, { id: 'b', stars: 2 }], current: 'b' }, 'm');
		expect(gameShellDebug().levels?.list?.length).toBe(2);
		expect(gameShellDebug().levels?.current).toBe('b');
	});
});

describe('the menu', () => {
	it('Levels appears third only when registered; VR drops Back to editor', () => {
		expect(shellMenuItems().map((i) => i.id)).toEqual(['resume', 'restart', 'settings', 'help', 'mainmenu', 'editor']);
		setGameLevels({ list: [{ id: 'a' }] }, 'm');
		expect(shellMenuItems({ vr: true }).map((i) => i.id)).toEqual(['resume', 'restart', 'levels', 'settings', 'help', 'mainmenu']);
	});
	it('help: the game\'s own words first, then the device controls', () => {
		setGameHelp('Line one\nLine two', 'm');
		const lines = shellHelpLines({ vr: true });
		expect(lines.slice(0, 2)).toEqual(['Line one', 'Line two']);
		expect(lines.some((l) => /left controller/.test(l))).toBe(true);
	});
});

describe('stepping settings (the controller way)', () => {
	it('toggle flips, choice walks and wraps, range steps and clamps', () => {
		stepGameSetting('sfx');
		expect(gameSettingValue('sfx')).toBe(false);
		setGameSetting('quality', 'high');
		stepGameSetting('quality', 1);
		expect(gameSettingValue('quality')).toBe('auto');
		stepGameSetting('quality', -1);
		expect(gameSettingValue('quality')).toBe('high');
		stepGameSetting('musicVolume', 1);
		expect(gameSettingValue('musicVolume')).toBe(100);
		stepGameSetting('musicVolume', -1);
		expect(gameSettingValue('musicVolume')).toBe(90);
	});
	it('the VR hit ids', () => {
		expect(pressShellHit('shell:set:sfx:next')).toBe(true);
		expect(gameSettingValue('sfx')).toBe(false);
		registerGameSetting({ id: 'board:mode', type: 'choice', options: ['globe', '2d'], default: 'globe' }, 'm');
		expect(pressShellHit('shell:set:board:mode:next')).toBe(true);
		expect(gameSettingValue('board:mode')).toBe('2d');
		expect(pressShellHit('nope:x')).toBe(false);
		expect(pressShellHit('shell:set:unknown:next')).toBe(false);
	});
	it('display text', () => {
		expect(settingDisplay({ type: 'toggle' }, true)).toBe('On');
		expect(settingDisplay({ type: 'choice', options: ['a', 'b'], optionLabels: ['A', 'B'] }, 'b')).toBe('B');
		expect(settingDisplay({ type: 'range' }, 30)).toBe('30');
	});
});

describe('fps + vignette', () => {
	it('fps is the median frame', () => {
		expect(fpsOf([])).toEqual({ fps: null, ms: null });
		expect(fpsOf([16.7, 16.7, 100, 16.6, 16.8]).fps).toBe(60);
	});
	it('the vignette closes on stick motion and smooth turning, not in the deadzone', () => {
		expect(vignetteTarget(0.1, 0, 1 / 72)).toBe(0);
		expect(vignetteTarget(0.8, 0, 1 / 72)).toBe(1);
		expect(vignetteTarget(0, (1.2 / 72) * 0.5, 1 / 72)).toBeCloseTo(0.5);
		expect(easeVignette(0, 1, 1 / 72)).toBeGreaterThan(0);
		expect(easeVignette(1, 0, 10)).toBe(0);
	});
});

describe('33 (G3): level tabs + the headset grid pages', () => {
	it('a choice registered onLevels is a tab row; others are not', () => {
		registerGameSetting({ id: 'board', label: 'Board', type: 'choice', options: ['globe', '2d'], optionLabels: ['Globe', '2D board'], default: 'globe', onLevels: true }, 'm');
		registerGameSetting({ id: 'hint', type: 'toggle', default: true, onLevels: true }, 'm');
		registerGameSetting({ id: 'speed', type: 'choice', options: ['a', 'b'], default: 'a' }, 'm');
		const tabs = shellLevelTabs();
		expect(tabs.map((t) => t.id)).toEqual(['board']);
		expect(tabs[0]).toEqual({ id: 'board', label: 'Board', options: [{ value: 'globe', label: 'Globe' }, { value: '2d', label: '2D board' }], value: 'globe' });
	});
	it('a tab press sets the choice (once), a bad index refuses', () => {
		let heard = 0;
		registerGameSetting({ id: 'board', type: 'choice', options: ['globe', '2d'], default: 'globe', onLevels: true, onChange: () => heard++ }, 'm');
		expect(pressShellHit('shell:tab:0:1')).toBe(true);
		expect(gameSettingValue('board')).toBe('2d');
		expect(heard).toBe(1);
		expect(pressShellHit('shell:tab:0:1')).toBe(true); // already on: nothing changes
		expect(heard).toBe(1);
		expect(pressShellHit('shell:tab:3:0')).toBe(false);
		expect(pressShellHit('shell:tab:0:9')).toBe(false);
	});
	it('the page arrows set the grid page; a page change resets it to "where the current level is"', () => {
		expect(pressShellHit('shell:lvpage:1')).toBe(true);
		expect(get(shellMenu).levelPage).toBe(1);
		showShellPage('settings');
		expect(get(shellMenu).levelPage).toBe(null);
	});
});
