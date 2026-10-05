// 36 U3b/I5 — the app's tour engine (contract T1): engine.js bound to safeStorage, with the
// running tour published as a store for the two surfaces (TourCard.svelte on a screen, the
// world-space panel in a headset).
//
//   tours.register(id, {title, surface, steps})   → unregister
//   tours.start(id, {from: 'resume' | 'start'})   tours.seen(id)   tours.signal(name)
//
// Lanes that add UI a tour points at put a stable `data-tour="<id>"` on it; a step's `target`
// names that id. This file imports only the storage leaf and svelte/store, so anything may
// import it (the radial menu, Settings, the logo menu) without joining a cycle.

import { writable } from 'svelte/store';
import { safeStorage } from '../safeStorage';
import { createTourEngine } from './engine.js';

/** @type {import('svelte/store').Writable<import('./engine.js').ActiveTour | null>} */
export const activeTour = writable(null);

/** bumps whenever a tour's record changes (Settings shows Seen / In progress / New) */
export const tourRecords = writable(0);

const engine = createTourEngine({
	storage: safeStorage,
	onChange: (active) => {
		activeTour.set(active);
		tourRecords.update((n) => n + 1);
	}
});

/** The tour API (T1). */
export const tours = {
	...engine,
	/** @param {boolean} on */
	setAutoStart(on) {
		engine.setAutoStart(on);
		tourRecords.update((n) => n + 1);
	},
	/** @param {string} [id] */
	reset(id) {
		engine.reset(id);
		tourRecords.update((n) => n + 1);
	}
};

/** the suites' view (registered in debugHooks as `tours`) */
export function toursDebug() {
	return engine.debug();
}
