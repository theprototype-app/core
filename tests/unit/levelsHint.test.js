// 93 — the first-use hint: once per device per kind, with a way to the Levels table.
import { describe, it, expect, beforeEach } from 'vitest';
import { hintOnce, hintKey, LEVEL_HINTS } from '../../src/lib/gameLevels/hint.js';
import { safeStorage } from '../../src/lib/safeStorage.js';

describe('93 first-use hint', () => {
	beforeEach(() => {
		safeStorage.removeItem(hintKey('portal'));
		safeStorage.removeItem(hintKey('checkpoint'));
	});
	it('shows once per kind, and its Levels action opens the table', () => {
		/** @type {any[]} */
		const shown = [];
		let opened = 0;
		const ui = { show: (/** @type {string} */ id, /** @type {string} */ msg, /** @type {any[]} */ actions) => shown.push({ id, msg, actions }), openLevels: () => opened++ };
		expect(hintOnce('portal', ui)).toBe(true);
		expect(hintOnce('portal', ui)).toBe(false);
		expect(hintOnce('checkpoint', ui)).toBe(true);
		expect(shown.map((s) => s.id)).toEqual(['levels-hint-portal', 'levels-hint-checkpoint']);
		expect(shown[0].msg).toBe(LEVEL_HINTS.portal);
		shown[0].actions.find((/** @type {any} */ a) => a.label === 'Levels').action();
		expect(opened).toBe(1);
	});
	it('no emoji in the copy (owner rule)', () => {
		for (const t of Object.values(LEVEL_HINTS)) expect(/\p{Extended_Pictographic}/u.test(t)).toBe(false);
	});
});
