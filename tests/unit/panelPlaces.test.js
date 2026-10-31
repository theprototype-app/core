// 70 W2/W4 — where each panel lives (the leaf store over the layout model) and the menu rows it
// builds for the main window's menus, with a stand-in window host.
import { describe, it, expect, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import { panelLayout, panelAway, isAway, awayKeys, releasePanel, popOutItems, registerPanelHost, canPopOut, tearOffAt } from '../../src/lib/windows/panelPlaces.js';
import { emptyLayout, popOut, popOutDock } from '../../src/lib/windows/panelLayout.js';

/** a host that records what it was asked */
function fakeHost({ wins = /** @type {{id: string, title: string}[]} */ ([]), pop = true } = {}) {
	/** @type {any[]} */
	const calls = [];
	registerPanelHost({
		popOut: (key, opts) => (calls.push(['popOut', key, opts]), true),
		popOutDock: (keys, origin) => (calls.push(['popOutDock', keys, origin]), true),
		moveTo: (key, id) => calls.push(['moveTo', key, id]),
		dockBack: (key) => calls.push(['dockBack', key]),
		bringAllBack: () => calls.push(['bringAllBack']),
		focus: () => true,
		canPop: (key) => pop && key !== 'objects',
		titleOf: (key) => key.toUpperCase(),
		windows: () => wins
	});
	return calls;
}

beforeEach(() => {
	panelLayout.set(emptyLayout());
	registerPanelHost(null);
});

describe('panelAway', () => {
	it('maps every popped key to its window', () => {
		let l = popOut(emptyLayout(), 'explorer').layout;
		l = popOutDock(l, ['flow', 'timeline'], { origin: 'bottom' }).layout;
		panelLayout.set(l);
		expect(get(panelAway)).toEqual({ explorer: 'w1', flow: 'w2', timeline: 'w2' });
		expect(isAway('flow')).toBe(true);
		expect(isAway('inspector')).toBe(false);
		expect(awayKeys().sort()).toEqual(['explorer', 'flow', 'timeline']);
	});
	it('releasePanel takes a key out and collapses the window it empties', () => {
		panelLayout.set(popOut(emptyLayout(), 'explorer').layout);
		releasePanel('explorer');
		expect(get(panelLayout).windows).toEqual([]);
		releasePanel('explorer'); // not away: no-op
		expect(get(panelLayout).windows).toEqual([]);
	});
});

describe('popOutItems', () => {
	it('is empty with no host (and where pop-outs are not supported: W6)', () => {
		expect(popOutItems('explorer')).toEqual([]);
		fakeHost({ pop: false });
		expect(popOutItems('explorer')).toEqual([]);
		expect(canPopOut('explorer')).toBe(false);
	});
	it('offers "Pop out" alone while no window is open', () => {
		const calls = fakeHost();
		const rows = popOutItems('explorer');
		expect(rows.map((r) => r.label)).toEqual(['Pop out into a new window']);
		rows[0].action();
		expect(calls[0][0]).toBe('popOut');
		expect(calls[0][1]).toBe('explorer');
	});
	it('adds Move to window ▸ and Bring all windows back once windows are open', () => {
		const calls = fakeHost({ wins: [{ id: 'w1', title: 'Explorer' }, { id: 'w2', title: 'Node editor (+1)' }] });
		const rows = popOutItems('inspector');
		expect(rows.map((r) => r.label)).toEqual(['Pop out into a new window', 'Move to window', 'Bring all windows back']);
		expect(rows[1].children.map((/** @type {any} */ c) => c.label)).toEqual(['Explorer', 'Node editor (+1)']);
		rows[1].children[1].action();
		rows[2].action();
		expect(calls).toEqual([['moveTo', 'inspector', 'w2'], ['bringAllBack']]);
	});
	it('stays empty for a panel that cannot pop out', () => {
		fakeHost();
		expect(popOutItems('objects')).toEqual([]);
	});
});

describe('tearOffAt (W4)', () => {
	it('tears off only when released outside the browser window', () => {
		const calls = fakeHost();
		/** @type {any} */ (globalThis).window = { innerWidth: 1000, innerHeight: 700 };
		try {
			expect(tearOffAt('explorer', { clientX: 500, clientY: 300, screenX: 500, screenY: 300 })).toBe(false);
			expect(tearOffAt('explorer', { clientX: 1200, clientY: 300, screenX: 1300, screenY: 400 })).toBe(true);
			expect(tearOffAt('objects', { clientX: -10, clientY: 300, screenX: 0, screenY: 0 })).toBe(false);
			expect(calls).toEqual([['popOut', 'explorer', { rect: { left: 1240, top: 384 } }]]);
		} finally {
			delete (/** @type {any} */ (globalThis).window);
		}
	});
});
