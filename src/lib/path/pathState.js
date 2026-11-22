import { writable } from 'svelte/store';

// 78 F4: the Path object's LOCAL session state, as a LEAF (svelte/store only) so the runtime
// (flowRuntime -> path/pathRuntime) can read it without reaching the spline editor, which is
// history-family. Nothing here replicates: which path you are editing and where your scrub
// ghost sits are facts about this screen.

/** uuid of the Path object open in the spline editor (its walkers hold still) @type {import('svelte/store').Writable<string | null>} */
export const editingPathUuid = writable(null);

/** the scrub ghost: which path, and the cycle time it shows (null = no ghost) @type {import('svelte/store').Writable<{uuid: string, t: number} | null>} */
export const pathScrub = writable(null);

/** selected point indices in the open path editor (multi-select) @type {import('svelte/store').Writable<number[]>} */
export const pathSelectedPoints = writable([]);
