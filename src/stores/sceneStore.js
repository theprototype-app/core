import { writable } from 'svelte/store';

export const globalScene = writable(null);
export const objectsGroup = writable(null);
export const showGrid = writable(null);
export const TControls = writable(null);
export const lockedObjects = writable([]);
export const selectedObject = writable([]);
export const backgroundColor = writable('#ffffff');
export const isLocked = writable(null);
export const isVRMode = writable(false);
export const vrOverride = writable(false);
export const playerCam = writable(false);
export const editorCam = writable(false);
export const specators = writable([]);
export const globalCamera = writable(null);
export const globalRenderer = writable(null);
export const camSave = writable(null);
export const orbitControls = writable(null);
