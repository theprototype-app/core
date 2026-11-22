// uir-account: openSettingsAt — the one way core and the cloud plugin open Settings at a page (and an element of it)
import { describe, it, expect, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import { openSettingsAt } from '../../src/lib/settings/openSettingsAt.js';
import { settingsOpen, settingsSection, settingsAnchor } from '../../src/stores/appStore.js';

describe('openSettingsAt', () => {
	beforeEach(() => {
		settingsOpen.set(null);
		settingsSection.set(null);
		settingsAnchor.set(null);
	});
	it('opens a page, with or without an anchor', () => {
		expect(openSettingsAt('account', 'connected-apps-settings')).toBe(true);
		expect([get(settingsOpen), get(settingsSection), get(settingsAnchor)]).toEqual([true, 'account', 'connected-apps-settings']);
		expect(openSettingsAt('interface')).toBe(true);
		expect(get(settingsAnchor)).toBe(null);
	});
	it('refuses an empty page or a malformed id, and opens nothing', () => {
		for (const [s, a] of [['', null], ['   ', null], ['x'.repeat(41), null], ['account', 'bad id'], ['account', '"]'], ['account', '1abc'], ['account', 'a'.repeat(81)]]) {
			expect(openSettingsAt(/** @type {string} */ (s), a)).toBe(false);
		}
		expect(get(settingsOpen)).toBe(null);
		expect(get(settingsAnchor)).toBe(null);
	});
});
