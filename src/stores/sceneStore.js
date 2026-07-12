import { writable } from 'svelte/store';

/** @type {import('svelte/store').Writable<any>} */
export const globalScene = writable(null);
/** @type {import('svelte/store').Writable<any>} */
export const objectsGroup = writable(null);
/** @type {import('svelte/store').Writable<any>} */
export const showGrid = writable(null);
/** @type {import('svelte/store').Writable<any>} */
export const TControls = writable(null);
/** active gizmo transform mode (151): shared so the toolbar tint + 1/2/3 shortcuts agree */
export const transformMode = writable('translate');
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
// snap-turn angle in degrees (15 / 30 / 45, or 0 = off — 155)
export const vrSnapAngle = writable(
	typeof localStorage !== 'undefined' ? parseInt(localStorage.getItem('vrSnapAngle') || '45') : 45
);
// mirror snap-turn direction (155): left flick turns right and vice-versa
export const vrMirrorSnapTurn = writable(
	typeof localStorage !== 'undefined' && localStorage.getItem('vrMirrorSnapTurn') === 'true'
);
// teleport locomotion (157): default ON; off disables the right-stick-up arc
export const vrTeleportEnabled = writable(
	typeof localStorage === 'undefined' || localStorage.getItem('vrTeleportEnabled') !== 'false'
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
// native VR objects panel (101), opened from the radial Objects sector
export const vrObjectsPanelOpen = writable(false);
// VR chat panel (117), opened from the radial Chat sector
export const vrChatPanelOpen = writable(false);
// VR color palette (110), opened from Edit ▸ Color
export const vrPaletteOpen = writable(false);
// VR properties panel (112), opened from Edit ▸ Properties
export const vrPropsPanelOpen = writable(false);
// VR prefabs window (115), opened from Add ▸ Prefabs
export const vrPrefabsPanelOpen = writable(false);
// VR Edit Mesh side-menu (137), opened from Edit ▸ Edit Mesh (toggle)
export const vrEditMenuOpen = writable(false);
// 161: VR stretch mode — uuid being stretched (null = off) + the active axis (0=W/1=H/2=D)
/** @type {import('svelte/store').Writable<any>} */
export const vrStretchObject = writable(null);
export const vrStretchAxis = writable(0);
// VR Snap side-menu (156), opened from Edit ▸ Snap (toggle)
export const vrSnapMenuOpen = writable(false);
// VR snap MODE (156): 'off' | 'grid' | 'surface' | 'rotation'
export const vrSnapMode = writable(
	typeof localStorage !== 'undefined' ? localStorage.getItem('vrSnapMode') || 'off' : 'off'
);
// 115: true = the prefabs window is world-fixed (📌), false = lazy-follows the view
export const vrPrefabsPinned = writable(false);
// VR selection indicator style (110): wireframe (default) or the shell
export const vrWireframeSelection = writable(
	typeof localStorage === 'undefined' || localStorage.getItem('vrWireframe') !== 'false'
);
// stats card on the pointer controller (102) — persisted so it re-attaches
export const vrStatsOpen = writable(
	typeof localStorage !== 'undefined' && localStorage.getItem('vrStats') === 'true'
);
// true while an AR (passthrough) session presents — a LOCAL view mode: the
// scene background/fog go transparent so the room shows through; the
// replicated environment state is untouched
export const passthroughActive = writable(false);
/** @type {import('svelte/store').Writable<'move' | 'rotate'>} grab behavior; scale is always two-handed */
export const vrTransformMode = writable('move');
/** grab style (100): 'rigid' = controller-as-handle (default); 'move'/'rotate' = legacy gizmo grabs */
export const vrGrabStyle = writable(
	typeof localStorage !== 'undefined' ? localStorage.getItem('vrGrabStyle') ?? 'rigid' : 'rigid'
);
/** handedness currently holding a grab ('left'|'right'|null) — gates that hand's stick */
export const vrGrabbedHand = writable(null);
