// 89 I2 — Settings ▸ "Tools & connections" is "AI" again. Every way people and code reached the old places still lands
// on the new page: the 59 T4 keys ('tools', 'toolsconnections'), the uir-account page key ('connectedapps'), a device that
// remembered the old page, and the command palette's rows (both cards + Connected apps, with the searched-for words).
import { describe, it, expect, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import { createSettingsNav, sectionKeyOf } from '../../src/lib/settingsNav.js';
import { safeStorage } from '../../src/lib/safeStorage.js';
import { SETTINGS_ROWS, SETTINGS_SECTION_IDS } from '../../src/lib/settingsIndex.js';
import { categoryMeta } from '../../src/lib/settings/categories.js';
import { readFileSync } from 'node:fs';

/** a nav with these section labels registered, each a plain open flag @param {string[]} labels */
function navWith(labels) {
	const nav = createSettingsNav();
	const open = new Map(labels.map((l) => [l, false]));
	for (const label of labels)
		nav.register({ header: null, label, isOpen: () => !!open.get(label), setOpen: (v) => open.set(label, v), el: () => null });
	return nav;
}
const LABELS = ['Interface', 'Scene', 'VR', 'AI', 'Account', 'Connection', 'About & what’s new'];

describe('89 I2 Settings ▸ AI', () => {
	beforeEach(() => safeStorage.removeItem('settings:section'));
	it('the old keys open the AI page', () => {
		expect(sectionKeyOf('AI')).toBe('ai');
		for (const key of ['ai', 'AI', 'tools', 'toolsconnections', 'Tools & connections', 'connectedapps']) {
			const nav = navWith(LABELS);
			expect(nav.activateKey(key), key).toBe(true);
			expect(get(nav.active)?.label, key).toBe('AI');
		}
		const nav = navWith(LABELS);
		expect(nav.activateKey('account')).toBe(true);
		expect(get(nav.active)?.label).toBe('Account');
	});
	it('a device that last used "Tools & connections" reopens on AI', () => {
		safeStorage.setItem('settings:section', 'toolsconnections');
		const nav = navWith(LABELS);
		nav.resolve();
		expect(get(nav.active)?.label).toBe('AI');
	});
	it('the palette knows both cards and Connected apps, with the words people search', () => {
		expect(SETTINGS_SECTION_IDS.AI).toBe('ai');
		expect(Object.keys(SETTINGS_SECTION_IDS)).not.toContain('Tools & connections');
		const ai = SETTINGS_ROWS.filter((r) => r[0] === 'AI');
		const names = ai.map((r) => r[1]);
		for (const n of ['AI inside the app (your key)', 'AI apps that work in your scene', 'Connected apps', 'Connect Claude', 'Chat providers', 'Desktop tools']) expect(names).toContain(n);
		const words = (/** @type {string} */ name) => (ai.find((r) => r[1] === name) ?? []).join(' ').toLowerCase();
		for (const w of ['key', 'gemini', 'grok']) expect(words('AI inside the app (your key)')).toContain(w);
		for (const w of ['chatgpt', 'connector', 'connected apps']) expect(words('AI apps that work in your scene')).toContain(w);
		expect(words('Connected apps')).toMatch(/revoke|remove/);
		// the card headings land on the card, not on a search no row answers
		expect(ai.find((r) => r[1] === 'AI apps that work in your scene')?.[3]).toBe('ai-card-in-scene');
		expect(ai.find((r) => r[1] === 'AI inside the app (your key)')?.[3]).toBe('ai-card-in-app');
	});
	it('the page has its description and its reset under the new key', () => {
		expect(categoryMeta('ai')?.description).toMatch(/ChatGPT/);
		// resetCategory.js pulls the whole scene in, so its RESETS keys are read from the source
		const src = readFileSync(new URL('../../src/lib/settings/resetCategory.js', import.meta.url), 'utf8');
		expect(src).toMatch(/^\tai\(\) \{$/m);
		expect(src).not.toMatch(/^\ttoolsconnections\(\) \{$/m);
	});
});
