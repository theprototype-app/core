// @ts-nocheck — plain fixtures; the module under test is typed
// fix-agenttest item 9: a STRING reaching HUD Text / HUD Bar is text, not 0.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { hudFormat } from '../../src/lib/hudFormat.js';

describe('hudFormat', () => {
	it('a non-numeric string passes through as text (a behaviour line -> HUD Text)', () => {
		expect(hudFormat('{v}', 'Collected 3 gems', 0)).toBe('Collected 3 gems');
		expect(hudFormat('Status: {v}', 'ready', 2)).toBe('Status: ready');
		expect(hudFormat(undefined, 'Player One', 0)).toBe('Player One');
	});
	it('numbers format exactly as before', () => {
		expect(hudFormat('Gems: {v}', 3, 0)).toBe('Gems: 3');
		expect(hudFormat('{v}', 2.5, 2)).toBe('2.50');
		expect(hudFormat('{v}', 1.23456789, 99)).toBe('1.234568'); // decimals clamp at 6
		expect(hudFormat('{v} / {v}', 4, 0)).toBe('4 / 4');
	});
	it('numeric strings, booleans, vectors and an unwired socket keep the old number reading', () => {
		expect(hudFormat('{v}', '42', 1)).toBe('42.0');
		expect(hudFormat('{v}', true, 0)).toBe('1');
		expect(hudFormat('{v}', [7, 8, 9], 0)).toBe('7');
		expect(hudFormat('{v}', undefined, 0)).toBe('0');
		expect(hudFormat('{v}', null, 0)).toBe('0');
		expect(hudFormat('{v}', '', 0)).toBe('0');
		expect(hudFormat('{v}', NaN, 0)).toBe('0');
	});
	it('a pattern without {v} is shown as-is; an empty one shows the value', () => {
		expect(hudFormat('GAME OVER', 'x', 0)).toBe('GAME OVER');
		expect(hudFormat('', 'hello', 0)).toBe('hello');
	});
	it('flowRuntime hands HUD Text and HUD Bar the RAW value (no num() first)', () => {
		const src = readFileSync(new URL('../../src/lib/flowRuntime.js', import.meta.url), 'utf8');
		expect(src).not.toMatch(/hudFormat\(data\.format, num\(data\.value\)/);
		expect(src).toMatch(/hudFormat\(data\.format, data\.value, num\(data\.decimals\)\)/);
		expect(src).toMatch(/hudFormat\(data\.format, data\.value, 0\)/);
	});
});
