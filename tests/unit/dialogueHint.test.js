// 92-dialogue (GC7): the first Dialogue a person adds says how to write it, once per device.
import { describe, test, expect } from 'vitest';
import { dialogueHintOnce, DIALOGUE_HINT_KEY } from '../../src/lib/dialogue/hint.js';
import { safeStorage } from '../../src/lib/safeStorage.js';

describe('dialogue first-use hint', () => {
	test('shows once, then never again on this device', () => {
		safeStorage.removeItem?.(DIALOGUE_HINT_KEY);
		/** @type {any[]} */
		const shown = [];
		const ui = { show: (/** @type {string} */ id, /** @type {string} */ msg, /** @type {any[]} */ actions) => shown.push({ id, msg, actions }) };
		expect(dialogueHintOnce(ui)).toBe(true);
		expect(dialogueHintOnce(ui)).toBe(false);
		expect(shown.length).toBe(1);
		expect(shown[0].msg).toMatch(/Speaker: text/);
		expect(shown[0].actions.map((/** @type {any} */ a) => a.label)).toEqual(['Got it']);
	});
});
