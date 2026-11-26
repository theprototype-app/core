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
		expect(openSettingsAt('account', 'account-connected-apps-link')).toBe(true);
		expect([get(settingsOpen), get(settingsSection), get(settingsAnchor)]).toEqual([true, 'account', 'account-connected-apps-link']);
		expect(openSettingsAt('interface')).toBe(true);
		expect(get(settingsAnchor)).toBe(null);
	});
	it('89 I2: the Connected apps anchors and the old page key land on Settings ▸ AI (they moved there)', () => {
		for (const [s, a] of [
			['account', 'connected-apps-settings'],
			['account', 'row-connected-app-g_1'],
			['account', 'row-connector-tab'],
			['Account', 'connected-apps-revoke-all']
		]) {
			expect(openSettingsAt(s, a)).toBe(true);
			expect([get(settingsSection), get(settingsAnchor)]).toEqual(['ai', a]);
		}
		expect(openSettingsAt('connectedapps')).toBe(true);
		expect([get(settingsSection), get(settingsAnchor)]).toEqual(['ai', 'connected-apps-settings']);
		// the rest of Account stays on Account
		expect(openSettingsAt('account', 'settings-account')).toBe(true);
		expect(get(settingsSection)).toBe('account');
	});
	it('refuses an empty page or a malformed id, and opens nothing', () => {
		for (const [s, a] of [['', null], ['   ', null], ['x'.repeat(41), null], ['account', 'bad id'], ['account', '"]'], ['account', '1abc'], ['account', 'a'.repeat(81)]]) {
			expect(openSettingsAt(/** @type {string} */ (s), a)).toBe(false);
		}
		expect(get(settingsOpen)).toBe(null);
		expect(get(settingsAnchor)).toBe(null);
	});
});
