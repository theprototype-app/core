import { writable, derived } from 'svelte/store';

// Bottom dock coexistence (95, quiz: tabbed): when BOTH the Flow editor and
// the Explorer are open AND docked, they share the bottom dock as notebook
// tabs — the active one renders, the other stays mounted but hidden. Each
// panel reports its docked+open state here; the tab strip renders inside
// whichever panel is visible.

/** which tab owns the shared dock */
export const bottomDockActive = writable(
	typeof localStorage !== 'undefined' ? localStorage.getItem('bottomDockActive') ?? 'flow' : 'flow'
);
bottomDockActive.subscribe((value) => {
	try {
		localStorage.setItem('bottomDockActive', value);
	} catch {}
});

/** {flow: boolean, explorer: boolean} — docked AND open */
export const dockOccupants = writable({ flow: false, explorer: false });

/** @param {'flow' | 'explorer'} key @param {boolean} present */
export function setDockOccupant(key, present) {
	dockOccupants.update((state) => (state[key] === present ? state : { ...state, [key]: present }));
}

/** true while both panels want the dock — the tab strip shows */
export const dockShared = derived(dockOccupants, ($o) => $o.flow && $o.explorer);
