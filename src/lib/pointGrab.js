// 31 (Stars Room S2): MAY A PLAYER PICK THINGS UP BY POINTING AT THEM? A leaf (svelte/store
// only), so flowRuntime writes it and vrControls + playInteract read it with no edge between
// them.
//
// "Pointing" is every grab that reaches an object at a DISTANCE: the VR grip's ray in
// Interact/Play (a star three metres away comes to your hand) and the desktop crosshair /
// cursor carry. Touching is not pointing, so it stays: a VR hand INSIDE an object still
// holds it, and the knock (a hand or a walking player bumping a body) is untouched — that
// is the whole point of the Stars Room's "Point to move stars: off", where stars move only
// when a hand meets them.
//
// The value is RUNTIME and PER PEER (a Point Grab node reads a per-player game setting),
// never saved, never sent. The default — no node anywhere — is `true`, today's behaviour.

import { writable, get } from 'svelte/store';

/** false while any Point Grab node in the scene reads `enabled: off` @type {import('svelte/store').Writable<boolean>} */
export const pointGrabEnabled = writable(true);

/** @returns {boolean} */
export function pointGrabAllowed() {
	return get(pointGrabEnabled);
}

/** flowRuntime's writer — only on change, so the store is quiet frame to frame @param {boolean} on */
export function setPointGrabEnabled(on) {
	if (get(pointGrabEnabled) !== !!on) pointGrabEnabled.set(!!on);
}
