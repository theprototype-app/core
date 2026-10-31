import { writable } from 'svelte/store';

// fix-batch-2: the capturing Path patrol node id as a LEAF (svelte/store only), so
// flowRuntime can pause that node's motion while its points are placed — pathCapture.js
// imports nodesHandler, which is history-family, and flowRuntime may not reach it.

/** @type {import('svelte/store').Writable<string | null>} node id capturing clicks */
export const pathCaptureNode = writable(null);
