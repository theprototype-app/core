// panel-gestures item 5: the hideable chrome buttons — the registry refuses a "+", the record parses
// defensively, "Show buttons" lists only what a strip kind hid, and the button menu's rows.
import { describe, it, expect, beforeEach } from 'vitest';
import { get, writable } from 'svelte/store';
import {
	registerChromeButton,
	chromeButtonDefs,
	isHideable,
	parseHidden,
	hiddenChromeButtons,
	hiddenChromeIds,
	hideChromeButton,
	showChromeButton,
	showAllChromeButtons,
	setChromeButtonShown,
	showButtonsItems,
	chromeButtonMenuItems
} from '../../src/lib/chromeButtons.js';
import { isLayoutKey } from '../../src/lib/uiLayoutsCore.js';

beforeEach(() => showAllChromeButtons());

describe('registry', () => {
	it('has the strip buttons of every kind and no "+"', () => {
		const ids = chromeButtonDefs().map((d) => d.id);
		for (const id of ['sidebar.toggle', 'sidebar.full', 'dock.split', 'dock.undock', 'dock.minimize', 'group.dock', 'group.close']) expect(ids).toContain(id);
		expect(ids.some((id) => /add|plus/.test(id))).toBe(false);
	});
	it('refuses to register a "+" or an unknown kind; registering twice is harmless', () => {
		expect(registerChromeButton({ id: 'dock.add', kind: 'dock', label: 'Add' })).toBe(false);
		expect(registerChromeButton({ id: 'sidebar:plus', kind: 'sidebar', label: 'Add' })).toBe(false);
		expect(registerChromeButton({ id: 'x.y', kind: 'nowhere', label: 'X' })).toBe(false);
		expect(registerChromeButton({ id: 'pane.test', kind: 'pane', label: 'Test pane' })).toBe(true);
		expect(registerChromeButton({ id: 'pane.test', kind: 'pane', label: 'Test pane' })).toBe(true);
		expect(chromeButtonDefs('pane').filter((d) => d.id === 'pane.test')).toHaveLength(1);
		expect(isHideable('dock.add')).toBe(false);
		expect(isHideable('pane.test')).toBe(true);
	});
});

describe('the record', () => {
	it('parses defensively (bad JSON, non-arrays, junk and "+" ids drop out; sorted, unique)', () => {
		expect(parseHidden(null)).toEqual([]);
		expect(parseHidden('{')).toEqual([]);
		expect(parseHidden('{"a":1}')).toEqual([]);
		expect(parseHidden('["dock.split", 3, "", "dock.add", "dock.split", "a.b"]')).toEqual(['a.b', 'dock.split']);
	});
	it('hide / show / show all; a "+" or unknown id is never hidden', () => {
		expect(hideChromeButton('dock.split')).toBe(true);
		expect(hideChromeButton('sidebar.full')).toBe(true);
		expect(hideChromeButton('dock.add')).toBe(false);
		expect(hideChromeButton('nope.nope')).toBe(false);
		expect(get(hiddenChromeButtons)).toEqual(['dock.split', 'sidebar.full']);
		showChromeButton('dock.split');
		expect(get(hiddenChromeButtons)).toEqual(['sidebar.full']);
		setChromeButtonShown('dock.undock', false);
		showAllChromeButtons('sidebar');
		expect(get(hiddenChromeButtons)).toEqual(['dock.undock']);
		showAllChromeButtons();
		expect(get(hiddenChromeButtons)).toEqual([]);
	});
	it('rides the named workspace layouts', () => {
		expect(isLayoutKey('chromeButtons')).toBe(true);
	});
});

describe('a bound button (its state lives elsewhere)', () => {
	it('hide / show / show all reach its own state; the record never holds it; menus and the combined list see it', () => {
		const off = writable(false);
		const bound = { hidden: off, set: (/** @type {boolean} */ h) => off.set(h) };
		expect(registerChromeButton({ id: 'top.bound', kind: 'top', label: 'Bound', state: bound })).toBe(true);
		expect(get(hiddenChromeIds)).toEqual([]);
		expect(hideChromeButton('top.bound')).toBe(true);
		expect(get(off)).toBe(true);
		expect(get(hiddenChromeButtons)).toEqual([]);
		expect(get(hiddenChromeIds)).toEqual(['top.bound']);
		expect(showButtonsItems('top')[0].children.map((/** @type {any} */ c) => c.label)).toEqual(['Bound']);
		showButtonsItems('top')[0].children[0].action();
		expect(get(off)).toBe(false);
		// its OWN control switching it off is seen too (the Panels button's Settings row)
		off.set(true);
		hideChromeButton('dock.split');
		expect(get(hiddenChromeIds)).toEqual(['dock.split', 'top.bound']);
		showAllChromeButtons('top');
		expect(get(off)).toBe(false);
		expect(get(hiddenChromeIds)).toEqual(['dock.split']);
		off.set(true);
		setChromeButtonShown('top.bound', true);
		expect(get(off)).toBe(false);
	});
});

describe('menus', () => {
	it('"Show buttons" lists only the hidden buttons of that strip kind, "Show all" from two', () => {
		expect(showButtonsItems('dock')).toEqual([]);
		hideChromeButton('dock.split');
		hideChromeButton('group.close');
		let rows = showButtonsItems('dock');
		expect(rows).toHaveLength(1);
		expect(rows[0].children.map((/** @type {any} */ c) => c.label)).toEqual(['Split']);
		hideChromeButton('dock.undock');
		rows = showButtonsItems('dock');
		expect(rows[0].children.map((/** @type {any} */ c) => c.label)).toEqual(['Split', 'Undock', 'Show all']);
		rows[0].children[0].action();
		expect(get(hiddenChromeButtons)).toEqual(['dock.undock', 'group.close']);
	});
	it('a button menu: Hide this button first, then that kind\'s Show buttons, then Customize', () => {
		hideChromeButton('sidebar.full');
		const rows = chromeButtonMenuItems('sidebar.toggle');
		expect(rows.map((/** @type {any} */ r) => r.label)).toEqual(['Hide this button', 'Show buttons', 'Customize buttons…']);
		rows[0].action();
		expect(get(hiddenChromeButtons)).toContain('sidebar.toggle');
		expect(chromeButtonMenuItems('dock.add')).toEqual([]);
	});
});
