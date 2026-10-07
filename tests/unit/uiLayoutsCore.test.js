import { describe, it, expect } from 'vitest';
import {
	isLayoutKey,
	pickLayoutStorage,
	layoutWrites,
	normalizeLayout,
	parseLayouts,
	upsertLayout,
	removeLayout,
	renameLayout,
	cleanName,
	onLayoutRestore,
	runLayoutReloaders,
	storedPanelLayout,
	MAX_LAYOUTS
} from '../../src/lib/uiLayoutsCore.js';

// 37 R14 — the rules of a named workspace layout (the live half is e2e `workspace-layouts`).

describe('which stored keys are the layout', () => {
	it('takes window rects, docks and panel modes, nothing else', () => {
		for (const key of ['win:chat', 'dockWidth:explorer', 'dockSplit:left', 'dockedWindows', 'bottomDockActive', 'flowDockHeight', 'dockTabOrder', 'windowTabGroups', 'objectListRect', 'flowDocked', 'explorerWinW', 'codeWinH'])
			expect(isLayoutKey(key), key).toBe(true);
		for (const key of ['uiLayouts', 'theme', 'controlsLayout', 'viewMode', 'win', 'flowPaletteOpen', 'explorerSingleClickOpen', 'shortcutOverrides'])
			expect(isLayoutKey(key), key).toBe(false);
	});

	it('picks the layout keys out of storage, skipping oversized values', () => {
		/** @type {Record<string, string>} */
		const store = { 'win:chat': '{"left":1,"top":2}', theme: 'light', flowDocked: 'false', 'win:huge': 'x'.repeat(5000) };
		expect(pickLayoutStorage(Object.keys(store), (k) => store[k])).toEqual({ flowDocked: 'false', 'win:chat': '{"left":1,"top":2}' });
	});

	it('restoring SETS what the layout names and REMOVES layout keys it does not', () => {
		const { set, remove } = layoutWrites({ 'win:chat': 'A', flowDocked: 'true' }, ['win:chat', 'win:flowWin', 'theme', 'explorerDocked', 'uiLayouts']);
		expect(set).toEqual([['win:chat', 'A'], ['flowDocked', 'true']]);
		// counterfactual: a key outside the layout (theme, the list itself) is never touched
		expect(remove).toEqual(['win:flowWin', 'explorerDocked']);
	});
});

describe('the saved list', () => {
	const rec = (/** @type {string} */ id, /** @type {string} */ name) => ({ id, name, savedAt: 1, open: { flow: true }, storage: { flowDocked: 'true' } });

	it('normalizes: a bad record is dropped, foreign storage keys are stripped, unknown fields kept', () => {
		expect(normalizeLayout(null)).toBe(null);
		expect(normalizeLayout({ id: 'a', name: '   ' })).toBe(null);
		const n = normalizeLayout({ id: 'a', name: ' Model\nling ', storage: { theme: 'x', 'win:a': 'y' }, open: { flow: true, bad: 3 }, future: 7 });
		expect(n?.name).toBe('Model ling');
		expect(n?.storage).toEqual({ 'win:a': 'y' });
		expect(n?.open).toEqual({ flow: true });
		expect(n?.future).toBe(7);
	});

	it('parses defensively and drops duplicate ids', () => {
		expect(parseLayouts('not json')).toEqual([]);
		expect(parseLayouts('{"a":1}')).toEqual([]);
		expect(parseLayouts(JSON.stringify([rec('a', 'One'), rec('a', 'Two'), rec('b', 'Three')])).map((l) => l.name)).toEqual(['One', 'Three']);
	});

	it('saving under an existing name (any case) UPDATES it in place and keeps its id', () => {
		const list = [rec('a', 'Modelling'), rec('b', 'Nodes')];
		const next = upsertLayout(list, { ...rec('z', 'modelling'), open: { uv: true } });
		expect(next?.length).toBe(2);
		expect(next?.[0].id).toBe('a');
		expect(next?.[0].open).toEqual({ uv: true });
	});

	it('refuses a NEW name past the cap, but still updates an existing one', () => {
		const full = Array.from({ length: MAX_LAYOUTS }, (_, i) => rec('id' + i, 'L' + i));
		expect(upsertLayout(full, rec('new', 'Another'))).toBe(null);
		expect(upsertLayout(full, rec('new', 'L3'))?.length).toBe(MAX_LAYOUTS);
	});

	it('renames (refusing a clash or an empty name) and deletes', () => {
		const list = [rec('a', 'One'), rec('b', 'Two')];
		expect(renameLayout(list, 'a', 'two')).toBe(null);
		expect(renameLayout(list, 'a', '  ')).toBe(null);
		expect(renameLayout(list, 'a', 'Uno')?.[0].name).toBe('Uno');
		expect(removeLayout(list, 'a').map((l) => l.id)).toEqual(['b']);
		expect(cleanName('x'.repeat(60)).length).toBe(40);
	});
});

describe('the reload registry', () => {
	it('runs every re-read, survives one that throws, and unregisters', () => {
		const seen = /** @type {string[]} */ ([]);
		const offA = onLayoutRestore(() => seen.push('a'));
		const offB = onLayoutRestore(() => {
			throw new Error('boom');
		});
		const offC = onLayoutRestore(() => seen.push('c'));
		expect(runLayoutReloaders()).toBe(2);
		expect(seen).toEqual(['a', 'c']);
		offA();
		offB();
		offC();
		expect(runLayoutReloaders()).toBe(0);
	});

	it('reads a panel mode + size with the panel defaults', () => {
		/** @type {Record<string, string>} */
		const store = { flowDocked: 'false', flowWinW: '800' };
		expect(storedPanelLayout((k) => store[k] ?? null, 'flow', 760, 480)).toEqual({ docked: false, w: 800, h: 480 });
		expect(storedPanelLayout(() => null, 'uv', 640, 460)).toEqual({ docked: true, w: 640, h: 460 });
	});
});
