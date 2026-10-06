// 37-settings (R21): where a Settings category sits — the grouped menu the spec asks for.
import { describe, it, expect } from 'vitest';
import { groupSections, orderSections, categoryMeta, SETTINGS_GROUPS } from '../../src/lib/settings/categories.js';

// the section keys as Settings.svelte registers them (template order), plus one a lane might add
const REGISTERED = ['interface', 'controls', 'input', 'touchcontrols', 'scene', 'explorer', 'vr', 'ai', 'export', 'nodetypes', 'connection', 'shortcuts', 'aboutwhatsnew'];

describe('settings categories', () => {
	it('groups the menu exactly as the spec lists it, About left out (it is pinned)', () => {
		const g = groupSections(REGISTERED);
		expect(g.map((x) => x.group.label)).toEqual(['General', 'Workspace', 'Devices & services']);
		expect(g[0].keys).toEqual(['interface', 'controls', 'input', 'touchcontrols', 'shortcuts']);
		expect(g[1].keys).toEqual(['scene', 'explorer', 'nodetypes', 'export']);
		expect(g[2].keys).toEqual(['vr', 'ai', 'connection']);
		expect(g.flatMap((x) => x.keys)).not.toContain('aboutwhatsnew');
	});

	it('puts a section another lane adds under "More", keeping its registration order', () => {
		const g = groupSections([...REGISTERED, 'zeta', 'alpha']);
		const more = g.find((x) => x.group.id === 'more');
		expect(more?.keys).toEqual(['zeta', 'alpha']);
		expect(g[g.length - 1].group.id).toBe('more');
	});

	it('orders by the menu order, not by registration', () => {
		expect(orderSections(['connection', 'shortcuts', 'interface'])).toEqual(['interface', 'shortcuts', 'connection']);
	});

	it('every known page has a one-sentence description; the groups are the spec’s', () => {
		for (const k of REGISTERED.filter((k) => k !== 'aboutwhatsnew')) {
			const d = categoryMeta(k).description;
			expect(d.length).toBeGreaterThan(10);
			expect(d.trim().endsWith('.')).toBe(true);
		}
		expect(SETTINGS_GROUPS.map((g) => g.id)).toEqual(['general', 'workspace', 'devices', 'more']);
	});
});
