import { writable } from 'svelte/store';

// Shared node graph state, replicated between peers

/** @type {import('svelte/store').Writable<any[]>} */
export const flowNodes = writable([]);

/** @type {import('svelte/store').Writable<any[]>} */
export const flowEdges = writable([]);

// scene object uuids whose flow effects (animations/colors) are muted locally
/** @type {import('svelte/store').Writable<string[]>} */
export const mutedFlowObjects = writable([]);

// live peer cursors in the flow editor: peerId -> { x, y, name, ts } (flow coordinates)
/** @type {import('svelte/store').Writable<Record<string, any>>} */
export const flowCursors = writable({});

// animations use wall-clock time so phases match across peers (NTP keeps
// machines within tens of ms); off = local page time like before
export const syncedAnimations = writable(
	typeof localStorage === 'undefined' || localStorage.getItem('syncedAnimations') !== 'false'
);
