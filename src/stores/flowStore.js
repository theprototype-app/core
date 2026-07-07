import { writable } from 'svelte/store';

// Shared node graph state, replicated between peers

/** @type {import('svelte/store').Writable<any[]>} */
export const flowNodes = writable([]);

/** @type {import('svelte/store').Writable<any[]>} */
export const flowEdges = writable([]);

// scene object uuids whose flow effects (animations/colors) are muted locally
/** @type {import('svelte/store').Writable<string[]>} */
export const mutedFlowObjects = writable([]);
