import { writable } from 'svelte/store';

/** @type {import('svelte/store').Writable<any>} */
export const globalScene = writable(null);
/** @type {import('svelte/store').Writable<any>} */
export const objectsGroup = writable(null);
/** @type {import('svelte/store').Writable<any>} */
export const showGrid = writable(null);
/** @type {import('svelte/store').Writable<any>} */
export const TControls = writable(null);
/** @type {import('svelte/store').Writable<any[]>} */
export const lockedObjects = writable([]);
/** @type {import('svelte/store').Writable<any>} */
export const selectedObject = writable([]);
/** multi-select (13): uuids of every selected object; selectedObject stays the primary */
/** @type {import('svelte/store').Writable<string[]>} */
export const selectedObjects = writable([]);
/** marquee rectangle while shift-dragging in the viewport: {x0,y0,x1,y1} | null */
/** @type {import('svelte/store').Writable<any>} */
export const marqueeRect = writable(null);
/** VR world grab (71): the group wrapping all world content — scaled/rotated
 * LOCALLY by the both-grips gesture, identity outside VR, never replicated */
/** @type {import('svelte/store').Writable<any>} */
export const worldRig = writable(null);
/** @type {import('svelte/store').Writable<any>} */
export const backgroundColor = writable('#ffffff');
export const isLocked = writable(null);
export const isVRMode = writable(false);
export const vrOverride = writable(false);
export const playerCam = writable(false);
export const editorCam = writable(false);
export const specators = writable([]);
/** @type {import('svelte/store').Writable<any>} */
export const globalCamera = writable(null);
/** @type {import('svelte/store').Writable<any>} */
export const camSave = writable(null);
/** @type {import('svelte/store').Writable<any>} */
export const globalRenderer = writable(null);
/** @type {import('svelte/store').Writable<any>} */
export const orbitControls = writable(null);
// peers' VR controller poses: peerId -> { left, right, active, ts }
/** @type {import('svelte/store').Writable<Record<string, any>>} */
export const peerHands = writable({});

// --- VR control suite ---
// which hand carries the quick-menu (the other hand is the pointer)
export const vrMenuHand = writable(
	typeof localStorage !== 'undefined' ? localStorage.getItem('vrMenuHand') || 'right' : 'right'
);
export const vrMenuOpen = writable(false);
// snap-turn angle in degrees (15 / 30 / 45)
export const vrSnapAngle = writable(
	typeof localStorage !== 'undefined' ? parseInt(localStorage.getItem('vrSnapAngle') || '45') : 45
);
// VR flying: left-stick movement follows the controller aim (pitch included)
export const vrFlying = writable(
	typeof localStorage !== 'undefined' && localStorage.getItem('vrFlying') === 'true'
);
// passthrough preference (90): the VR button requests immersive-ar instead of
// immersive-vr on the NEXT session start (WebXR can't hot-swap modes)
export const vrPassthrough = writable(
	typeof localStorage !== 'undefined' && localStorage.getItem('vrPassthrough') === 'true'
);
// radial menu open style (74): false = B/Y toggles (default), true = hold B/Y
// and release over a sector to activate it
export const vrMenuHold = writable(
	typeof localStorage !== 'undefined' && localStorage.getItem('vrMenuHold') === 'true'
);
// true while an AR (passthrough) session presents — a LOCAL view mode: the
// scene background/fog go transparent so the room shows through; the
// replicated environment state is untouched
export const passthroughActive = writable(false);
/** @type {import('svelte/store').Writable<'move' | 'rotate'>} grab behavior; scale is always two-handed */
export const vrTransformMode = writable('move');
