// 31 (K3): the per-game settings leaf with no browser — row normalisation, coercion, the
// per-game key scheme, game rows beside the core rows, and the resolvers core reads live.
import { describe, it, expect, beforeEach } from 'vitest';
import {
	CORE_SETTINGS,
	slugGameId,
	shellKey,
	rowKey,
	normalizeSettingRow,
	coerceSettingValue,
	noteSceneFileName,
	noteSceneLevelName,
	forceGameId,
	currentGameId,
	gameSettingValue,
	setGameSetting,
	registerGameSetting,
	unregisterGameSettingsOf,
	resetCoreSettings,
	sfxLevel,
	musicLevel,
	hapticsAllowed,
	resolveTurning,
	debugResetGameSettings
} from '../../src/lib/gameSettings.js';
import { safeStorage, debugResetStorage } from '../../src/lib/safeStorage.js';

beforeEach(() => {
	for (const key of safeStorage.keys()) safeStorage.removeItem(key);
	debugResetStorage();
	debugResetGameSettings();
});

describe('ids and keys', () => {
	it('slugs a game name', () => {
		expect(slugGameId('Stars Room')).toBe('stars-room');
		expect(slugGameId('  Dungeon Realms!! ')).toBe('dungeon-realms');
		expect(slugGameId('')).toBe('untitled');
		expect(slugGameId(null)).toBe('untitled');
	});
	it('keys per game', () => {
		expect(shellKey('Towers')).toBe('tp:game:towers:shell');
		expect(rowKey('Stars Room', 'stars-clap')).toBe('tp:game:stars-room:stars-clap');
	});
	it('the file name wins over the saved scene name, then untitled', () => {
		expect(currentGameId()).toBe('untitled');
		noteSceneLevelName('My level');
		expect(currentGameId()).toBe('my-level');
		noteSceneFileName('Towers');
		expect(currentGameId()).toBe('towers');
		noteSceneFileName(null);
		expect(currentGameId()).toBe('my-level');
		forceGameId('fixture');
		expect(currentGameId()).toBe('fixture');
	});
});

describe('rows', () => {
	it('normalises a toggle / choice / range', () => {
		expect(normalizeSettingRow({ id: 'a', label: 'A', type: 'toggle', default: 'true' })?.default).toBe(true);
		const c = normalizeSettingRow({ id: 'b', type: 'choice', options: ['globe', '2d'], default: 'cube' });
		expect(c?.default).toBe('globe');
		const r = normalizeSettingRow({ id: 'r', type: 'range', min: 10, max: 0, default: 99 });
		expect(r?.min).toBe(0);
		expect(r?.max).toBe(10);
		expect(r?.default).toBe(10);
	});
	it('refuses what cannot be a row', () => {
		expect(normalizeSettingRow(null)).toBe(null);
		expect(normalizeSettingRow({ label: 'no id' })).toBe(null);
		expect(normalizeSettingRow({ id: 'x', type: 'colour' })).toBe(null);
		expect(normalizeSettingRow({ id: 'x', type: 'choice', options: [] })).toBe(null);
	});
	it('coerces values to the row kind', () => {
		const t = /** @type {any} */ (normalizeSettingRow({ id: 't', default: true }));
		expect(coerceSettingValue(t, 'false')).toBe(false);
		expect(coerceSettingValue(t, 'maybe')).toBe(true);
		const r = /** @type {any} */ (normalizeSettingRow({ id: 'r', type: 'range', min: 0, max: 5, default: 2 }));
		expect(coerceSettingValue(r, 0)).toBe(0); // zero is a real value, never "missing"
		expect(coerceSettingValue(r, 9)).toBe(5);
		expect(coerceSettingValue(r, 'x')).toBe(2);
	});
	it('a game row may not take a core id', () => {
		expect(registerGameSetting({ id: 'music', type: 'toggle', default: true })).toBe(null);
		expect(registerGameSetting({ id: 'shell', type: 'toggle', default: true })).toBe(null);
	});
});

describe('values per game', () => {
	it('core defaults', () => {
		for (const row of CORE_SETTINGS) expect(gameSettingValue(row.id)).toEqual(row.default);
	});
	it('SFX off in game A does not reach game B', () => {
		noteSceneFileName('Towers');
		setGameSetting('sfx', false);
		expect(sfxLevel()).toBe(0);
		noteSceneFileName('Waves');
		expect(gameSettingValue('sfx')).toBe(true);
		expect(sfxLevel()).toBe(1);
		noteSceneFileName('Towers');
		expect(gameSettingValue('sfx')).toBe(false);
	});
	it('volumes multiply, off means zero', () => {
		setGameSetting('musicVolume', 40);
		expect(musicLevel()).toBeCloseTo(0.4);
		setGameSetting('music', false);
		expect(musicLevel()).toBe(0);
		setGameSetting('haptics', false);
		expect(hapticsAllowed()).toBe(false);
		resetCoreSettings();
		expect(musicLevel()).toBe(1);
		expect(hapticsAllowed()).toBe(true);
	});
	it('a game row persists under its own key and reads back after re-registering', () => {
		noteSceneFileName('Stars Room');
		/** @type {any[]} */
		const heard = [];
		const off = registerGameSetting({ id: 'stars-clap', label: 'Make stars with a clap', type: 'toggle', default: true, onChange: (/** @type {any} */ v) => heard.push(v) }, 'node:n1');
		expect(typeof off).toBe('function');
		expect(gameSettingValue('stars-clap')).toBe(true);
		setGameSetting('stars-clap', false);
		expect(heard).toEqual([false]);
		expect(safeStorage.getItem('tp:game:stars-room:stars-clap')).toBe('false');
		off?.();
		expect(gameSettingValue('stars-clap')).toBe(undefined);
		registerGameSetting({ id: 'stars-clap', type: 'toggle', default: true }, 'node:n1');
		expect(gameSettingValue('stars-clap')).toBe(false);
		unregisterGameSettingsOf('node:n1');
		expect(gameSettingValue('stars-clap')).toBe(undefined);
	});
	it('an unknown id writes nothing', () => {
		expect(setGameSetting('nope', 1)).toBe(undefined);
	});
});

describe('turning', () => {
	it('device default follows the device angle, 0 = off', () => {
		expect(resolveTurning({ turning: 'default', turnAngle: 'default' }, 30)).toEqual({ mode: 'snap', angle: 30 });
		expect(resolveTurning({ turning: 'default', turnAngle: 'default' }, 0)).toEqual({ mode: 'off', angle: 0 });
	});
	it('a game choice wins', () => {
		expect(resolveTurning({ turning: 'smooth', turnAngle: 'default' }, 30)).toEqual({ mode: 'smooth', angle: 30 });
		expect(resolveTurning({ turning: 'snap', turnAngle: '90' }, 0)).toEqual({ mode: 'snap', angle: 90 });
		expect(resolveTurning({ turning: 'off', turnAngle: '90' }, 45)).toEqual({ mode: 'off', angle: 0 });
		expect(resolveTurning({ turning: 'default', turnAngle: '15' }, 0)).toEqual({ mode: 'snap', angle: 15 });
	});
});
