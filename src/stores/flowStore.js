import { writable } from 'svelte/store';

// Shared node graph state, replicated between peers

/** @type {import('svelte/store').Writable<any[]>} */
export const flowNodes = writable([]);

/** @type {import('svelte/store').Writable<any[]>} */
export const flowEdges = writable([]);
