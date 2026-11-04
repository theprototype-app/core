// ONE gate for every in-headset UI — the VR welcome tour, the wrist menus and radial, the VR
// panels, the VR HUD / perf strip / REC badge, the rays and hover boxes. While Film is open (on any
// camera, in any session: the gyro view, a headset, or the phone's AR walk) none of them is drawn:
// Film's own DOM controls are the whole UI, and anything head-locked would be filmed into the shot
// (or, on a phone's AR framebuffer, smeared across it). A LEAF (svelte/store + two leaf stores), so
// the tours, Scene and the VR frame loop read it without importing Film's lazy chunk.
import { derived, get } from 'svelte/store';
import { filmOpen } from './film/filmState';
import { filmWalkActive } from './arTableState.js';

/** true while Film is open or its AR walk is running / being asked for */
export const vrUiHidden = derived([filmOpen, filmWalkActive], ([open, walking]) => !!open || !!walking);

/** the same test for code outside a component (the tour trigger, the VR frame hooks) */
export function vrUiStandsDown() {
	return get(vrUiHidden);
}
