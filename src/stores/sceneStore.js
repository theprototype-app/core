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
/** @type {import('svelte/store').Writable<'move' | 'rotate'>} grab behavior; scale is always two-handed */
export const vrTransformMode = writable('move');
