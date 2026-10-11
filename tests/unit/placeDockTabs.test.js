// 41 G7 — a window dropped on the docked tab strip docks AT the caret: `placeDockTabs`
// gives the keys their slots before they report themselves docked, so `noteDockOrder`
// (which appends) finds them placed and leaves them there.
import { describe, it, expect, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import { placeDockTabs, setDockOccupant, dockTabOrder, dockTabs, dockOccupants } from '../../src/lib/bottomDock.js';

const keys = () => get(dockTabs).map((t) => t.key);

describe('placeDockTabs', () => {
	beforeEach(() => {
		dockOccupants.set({});
		dockTabOrder.set([]);
		setDockOccupant('flow', true, 300);
		setDockOccupant('explorer', true, 300);
	});

	it('inserts before the tab the caret stands in front of', () => {
		placeDockTabs(['flowcode'], 'explorer');
		setDockOccupant('flowcode', true, 300);
		expect(keys()).toEqual(['flow', 'flowcode', 'explorer']);
	});

	it('null = after the last present tab (not after closed views that keep a slot)', () => {
		dockTabOrder.set(['flow', 'explorer', 'animation']); // animation closed, slot kept
		placeDockTabs(['uv'], null);
		expect(get(dockTabOrder)).toEqual(['flow', 'explorer', 'uv', 'animation']);
		setDockOccupant('uv', true, 300);
		expect(keys()).toEqual(['flow', 'explorer', 'uv']);
	});

	it('several keys keep their order, and a key that already had a slot moves', () => {
		dockTabOrder.set(['flow', 'uv', 'explorer']);
		placeDockTabs(['flowcode', 'uv'], 'flow');
		expect(get(dockTabOrder)).toEqual(['flowcode', 'uv', 'flow', 'explorer']);
	});

	it('ignores views with no docked mode', () => {
		placeDockTabs(['objects'], 'flow');
		expect(get(dockTabOrder)).toEqual(['flow', 'explorer']);
	});
});
