// 30b (vr-play): "IS THE PLAYER PLAYING?" — the ONE predicate behind every piece of game
// feel: controller haptics, game music, the VR game panel and the hold-and-sweep.
//
// The user's rule, verbatim from the Quest report: "The vibration should be only
// interactive mode, not in edit mode." A game feels like a game in INTERACT and in PLAY,
// and the editor stays quiet. Both halves are LOCAL state on this device (`editorMode` is
// never sent, `isLocked` is this peer's play press), so nothing here replicates.
//
// `isLocked` is THREE-state (null editor / true playing / false the exit transient), so
// playing is `=== true` — the transient must read "not playing" (the 21-E3 rule).
// VR has no pointer lock: a headset session enters INTERACT (30b-vr-modes' C1), which is
// why `editorMode === 'interact'` alone is also enough.
//
// A LEAF: sceneStore + svelte/store only, so vrControls, moduleSDK, the audio leaves and
// the HUD layer can all read it without reaching the history cycle family.
import { derived, get } from 'svelte/store';
import { isLocked, editorMode } from '../stores/sceneStore';

/** true while this device is in Interact or Play @returns {boolean} */
export function gameFeelActive() {
	return get(isLocked) === true || get(editorMode) === 'interact';
}

/** the same answer as a store — a falling edge is "the player left the game" */
export const gameFeelOn = derived(
	[isLocked, editorMode],
	([$locked, $mode]) => $locked === true || $mode === 'interact'
);

/**
 * The click MODE a game-side press dispatches with (moduleSDK's CLICK_MODES): 'play'
 * under desktop Play, 'interact' in Interact (VR Play enters Interact), 'edit' otherwise.
 * @returns {'edit' | 'interact' | 'play'}
 */
export function gameClickMode() {
	if (get(isLocked) === true) return 'play';
	return get(editorMode) === 'interact' ? 'interact' : 'edit';
}
