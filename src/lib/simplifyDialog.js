import { writable } from 'svelte/store';

// 102 M1: the open Simplify dialog, a LEAF so App can render the dialog without pulling the
// simplifier (meshSimplifyAction, the worker, GLTFExporter) into the boot chunk. null = closed.
/** @type {import('svelte/store').Writable<{uuid: string, name: string, triangles: number, bake?: boolean} | null>} */
export const simplifyDialog = writable(null);
