import { writable, derived } from 'svelte/store';

// Bottom dock coexistence (95, quiz: tabbed): when BOTH the Flow editor and
// the Explorer are open AND docked, they share the bottom dock as notebook
// tabs — the active one renders, the other stays mounted but hidden. Each
// panel reports its docked+open state (and height) here; the tab strip
// renders inside whichever panel is visible.
// 105: the visible dock height publishes as the CSS var --bottom-inset so
// drawers and edge-docked windows always end ABOVE the dock.

/** which tab owns the shared dock */
export const bottomDockActive = writable(
	typeof localStorage !== 'undefined' ? localStorage.getItem('bottomDockActive') ?? 'flow' : 'flow'
);
bottomDockActive.subscribe((value) => {
	try {
		localStorage.setItem('bottomDockActive', value);
	} catch {}
});

/** {flow: {present, height}, explorer: {present, height}} — docked AND open */
export const dockOccupants = writable({
	flow: { present: false, height: 0 },
	explorer: { present: false, height: 0 }
});

/** @param {'flow' | 'explorer'} key @param {boolean} present @param {number=} height */
export function setDockOccupant(key, present, height = 0) {
	dockOccupants.update((state) => {
		const entry = state[key];
		if (entry.present === present && entry.height === height) return state;
		return { ...state, [key]: { present, height } };
	});
}

/** true while both panels want the dock — the tab strip shows */
export const dockShared = derived(
	dockOccupants,
	($o) => $o.flow.present && $o.explorer.present
);

/** height of the VISIBLE docked panel (0 when the dock is empty) */
export const bottomInset = derived([dockOccupants, bottomDockActive], ([$o, $active]) => {
	const shared = $o.flow.present && $o.explorer.present;
	if (shared) return $o[$active === 'explorer' ? 'explorer' : 'flow'].height;
	if ($o.flow.present) return $o.flow.height;
	if ($o.explorer.present) return $o.explorer.height;
	return 0;
});

// publish as a CSS var so drawers/docked windows adjust in pure CSS (105)
if (typeof document !== 'undefined') {
	bottomInset.subscribe((inset) => {
		document.documentElement.style.setProperty('--bottom-inset', inset + 'px');
	});
}
