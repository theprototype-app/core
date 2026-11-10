// uir-int — the release's first-use hint: the one Chat window says once per device that Chat and the AI
// assistant share it; quiet in an automated browser unless a suite opts in.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chatHintOnce, CHAT_HINT, CHAT_HINT_KEY } from '../../src/lib/chat/chatHint.js';
import { safeStorage } from '../../src/lib/safeStorage.js';

describe('uir-int chat first-use hint', () => {
	/** @type {any} */
	let wd;
	beforeEach(() => {
		safeStorage.removeItem(CHAT_HINT_KEY);
		safeStorage.removeItem('chatHint:e2e');
		wd = Object.getOwnPropertyDescriptor(globalThis.navigator ?? {}, 'webdriver');
	});
	afterEach(() => {
		if (globalThis.navigator) Object.defineProperty(globalThis.navigator, 'webdriver', wd ?? { value: undefined, configurable: true });
	});
	const ui = () => {
		/** @type {any[]} */
		const shown = [];
		return { shown, show: (/** @type {string} */ id, /** @type {string} */ msg, /** @type {any[]} */ actions) => shown.push({ id, msg, actions }) };
	};
	it('shows once per device', () => {
		if (globalThis.navigator) Object.defineProperty(globalThis.navigator, 'webdriver', { value: false, configurable: true });
		const u = ui();
		expect(chatHintOnce(u)).toBe(true);
		expect(chatHintOnce(u)).toBe(false);
		expect(u.shown.map((s) => s.id)).toEqual(['chat-hint']);
		expect(u.shown[0].msg).toBe(CHAT_HINT);
		expect(u.shown[0].actions.map((/** @type {any} */ a) => a.label)).toEqual(['Got it']);
	});
	it('an automated browser stays quiet unless the suite opts in', () => {
		if (!globalThis.navigator) return;
		Object.defineProperty(globalThis.navigator, 'webdriver', { value: true, configurable: true });
		const u = ui();
		expect(chatHintOnce(u)).toBe(false);
		expect(safeStorage.getItem(CHAT_HINT_KEY)).toBe(null);
		safeStorage.setItem('chatHint:e2e', '1');
		expect(chatHintOnce(u)).toBe(true);
	});
	it('no emoji in the copy (owner rule)', () => {
		expect(/\p{Extended_Pictographic}/u.test(CHAT_HINT)).toBe(false);
	});
});
