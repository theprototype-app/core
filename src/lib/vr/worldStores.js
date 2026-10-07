// VR controls — 37-vr-world's shared flags, a LEAF (svelte/store only) so the radial registry
// (vrRadialMenu.js, reached from the module SDK) can light its sectors without importing the VR stack.
import { writable } from 'svelte/store';

/** the dollhouse is up (vr/dollhouse.js writes it) */
export const vrDollhouseOpen = writable(false);
/** a VR sculpt session is up (vr/sculpt.js writes it) */
export const vrSculptActive = writable(false);
