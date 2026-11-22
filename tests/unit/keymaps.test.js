import { describe, it, expect, vi, beforeEach } from 'vitest';
import { writable, get } from 'svelte/store';

// 103 row 9: saved keymaps = a base preset + the person's changes. The registry is mocked down to the working state
// (keymapPreset + overrides) so the save / switch / dirty / file rules run without the app.
const state = vi.hoisted(() => ({ overrides: /** @type {Record<string, string>} */ ({}) }));
vi.mock('../../src/lib/shortcuts', () => {
	const keymapPreset = writable('theprototype');
	const activeKeymapId = writable(/** @type {string | null} */ (null));
	return {
		shortcuts: [{ id: 'transform.move', keys: '1' }, { id: 'transform.rotate', keys: '2' }],
		shortcutOverrides: () => ({ ...state.overrides }),
		replaceOverrides: (/** @type {Record<string, string>} */ m) => (state.overrides = { ...m }),
		setKeymapPreset: async (/** @type {string} */ id) => keymapPreset.set(id),
		keymapPreset,
		activeKeymapId,
		setActiveKeymapId: (/** @type {string | null} */ id) => activeKeymapId.set(id)
	};
});
const km = await import('../../src/lib/keymaps.js');
const sc = await import('../../src/lib/shortcuts');

beforeEach(async () => {
	state.overrides = {};
	km.savedKeymaps.set([]);
	sc.activeKeymapId.set(null);
	sc.keymapPreset.set('theprototype');
});

describe('saved keymaps', () => {
	it('a built-in preset is changed when a rebind sits on it', () => {
		expect(km.keymapDirty()).toBe(false);
		state.overrides = { 'transform.move': 'G' };
		expect(km.keymapDirty()).toBe(true);
	});
	it('Save current as… stores the base and the changes, and the working state belongs to it', async () => {
		sc.keymapPreset.set('blender');
		state.overrides = { 'transform.move': 'G' };
		const k = km.saveCurrentAs('Mine');
		expect(k).toMatchObject({ name: 'Mine', base: 'blender', changes: { 'transform.move': 'G' } });
		expect(get(sc.activeKeymapId)).toBe(k?.id);
		expect(km.keymapDirty()).toBe(false);
		state.overrides = { 'transform.move': 'H' };
		expect(km.keymapDirty()).toBe(true);
		await km.discardChanges();
		expect(state.overrides).toEqual({ 'transform.move': 'G' });
	});
	it('switching between two saved keymaps puts each one`s base and changes in force', async () => {
		state.overrides = { 'transform.move': 'G' };
		const a = km.saveCurrentAs('A');
		sc.keymapPreset.set('unity');
		state.overrides = { 'transform.rotate': 'R' };
		const b = km.saveCurrentAs('B');
		await km.switchKeymap(/** @type {any} */ (a).id);
		expect(get(sc.keymapPreset)).toBe('theprototype');
		expect(state.overrides).toEqual({ 'transform.move': 'G' });
		await km.switchKeymap(/** @type {any} */ (b).id);
		expect(get(sc.keymapPreset)).toBe('unity');
		expect(state.overrides).toEqual({ 'transform.rotate': 'R' });
		// leaving a saved keymap for a built-in preset starts from that preset's own keys
		await km.switchKeymap('preset:blender');
		expect(state.overrides).toEqual({});
		expect(get(sc.activeKeymapId)).toBe(null);
	});
	it('only a switch that would replace changes is asked about (built-in to built-in carries them)', () => {
		state.overrides = { 'transform.move': 'G' };
		expect(km.switchDropsChanges('preset:blender')).toBe(false);
		const k = km.saveCurrentAs('A');
		expect(km.switchDropsChanges('preset:blender')).toBe(false); // saved and clean
		state.overrides = { 'transform.move': 'H' };
		expect(km.switchDropsChanges('preset:blender')).toBe(true);
		expect(km.switchDropsChanges(/** @type {any} */ (k).id)).toBe(true);
	});
	it('names stay unique; rename, duplicate and delete', () => {
		const a = km.saveCurrentAs('Mine');
		const b = km.saveCurrentAs('Mine');
		expect(b?.name).toBe('Mine (2)');
		const copy = km.duplicateKeymap(/** @type {any} */ (a).id);
		expect(copy?.name).toBe('Mine copy');
		km.renameKeymap(/** @type {any} */ (copy).id, 'Mine');
		expect(get(km.savedKeymaps).find((k) => k.id === copy?.id)?.name).toBe('Mine (3)');
		km.deleteKeymap(/** @type {any} */ (b).id);
		expect(get(km.savedKeymaps).map((k) => k.name)).toEqual(['Mine', 'Mine (3)']);
		expect(get(sc.activeKeymapId)).toBe(null); // b was the active one
	});
	it('reset this keymap clears the working changes and the saved copy', () => {
		state.overrides = { 'transform.move': 'G', 'transform.rotate': 'R' };
		km.saveCurrentAs('A');
		expect(km.changedFromBaseCount()).toBe(2);
		km.resetKeymapToBase();
		expect(state.overrides).toEqual({});
		expect(get(km.savedKeymaps)[0].changes).toEqual({});
	});
});

describe('keymap files', () => {
	it('export then import is the same keymap', () => {
		state.overrides = { 'transform.move': 'G' };
		const k = km.saveCurrentAs('Round trip');
		const text = JSON.stringify(km.keymapFile(/** @type {any} */ (k)));
		const r = km.parseKeymapFile(text);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.keymap).toMatchObject({ name: 'Round trip', base: 'theprototype', changes: { 'transform.move': 'G' } });
	});
	it('refuses what is not a keymap, and a newer version by name', () => {
		expect(km.parseKeymapFile('').ok).toBe(false);
		expect(km.parseKeymapFile('not json').ok).toBe(false);
		expect(km.parseKeymapFile('{"format":"other","version":1,"name":"x"}').ok).toBe(false);
		const newer = km.parseKeymapFile('{"format":"theprototype-keymap","version":2,"name":"x","changes":{}}');
		expect(newer.ok).toBe(false);
		if (!newer.ok) expect(newer.reason).toMatch(/newer version/);
		expect(km.parseKeymapFile('{"format":"theprototype-keymap","version":1,"name":"x","changes":{}}'.padEnd(70000, ' ')).ok).toBe(false);
	});
	it('cleans what it keeps: bad ids, long or reserved keys, an unknown base', () => {
		const r = km.parseKeymapFile(
			JSON.stringify({ format: 'theprototype-keymap', version: 1, name: '  Mine\n', base: 'emacs', changes: { 'transform.move': 'G', 'bad id!': 'X', 'transform.rotate': 'Escape', 'mod:x': 'K'.repeat(50), 'module:later:row': 'J' } })
		);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.keymap.name).toBe('Mine');
		expect(r.keymap.base).toBe('theprototype');
		expect(r.keymap.changes).toEqual({ 'transform.move': 'G', 'module:later:row': 'J' });
		expect(r.skipped).toBe(3);
		expect(r.unknown).toBe(1); // a row this build does not have is kept
	});
	it('an import is added under a unique name and not switched to', () => {
		km.saveCurrentAs('Mine');
		const r = km.importKeymap(JSON.stringify({ format: 'theprototype-keymap', version: 1, name: 'Mine', base: 'blender', changes: {} }));
		expect(r.ok).toBe(true);
		expect(get(km.savedKeymaps).map((k) => k.name)).toEqual(['Mine', 'Mine (2)']);
		expect(get(km.savedKeymaps)[0].id).toBe(get(sc.activeKeymapId));
	});
	it('file names are slugs', () => {
		expect(km.keymapFileName('My Blender keys!')).toBe('my-blender-keys.keymap.json');
	});
});
