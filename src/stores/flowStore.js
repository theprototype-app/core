import { writable } from 'svelte/store';

// Shared node graph state, replicated between peers

/** @type {import('svelte/store').Writable<any[]>} */
export const flowNodes = writable([]);

/** @type {import('svelte/store').Writable<any[]>} */
export const flowEdges = writable([]);

// scene object uuids whose flow effects (animations/colors) are muted locally
/** @type {import('svelte/store').Writable<string[]>} */
export const mutedFlowObjects = writable([]);

// live output value of each value/logic node (133), for the on-card readouts —
// the runtime writes it ~6/s; nodeId -> number | boolean | [x,y,z] | string
/** @type {import('svelte/store').Writable<Record<string, any>>} */
export const flowValues = writable({});

// event-node state (134): OnClick/Counter ride replicated trigger messages, not
// streamed state. nodeId -> { count, lastT } (lastT = shared synced time of the
// last pulse). A trigger log, deterministic because the timestamp is shared.
/** @type {import('svelte/store').Writable<Record<string, {count: number, lastT: number}>>} */
export const flowTriggers = writable({});

// live peer cursors in the flow editor: peerId -> { x, y, name, ts } (flow coordinates)
/** @type {import('svelte/store').Writable<Record<string, any>>} */
export const flowCursors = writable({});

// animations use wall-clock time so phases match across peers (NTP keeps
// machines within tens of ms); off = local page time like before
export const syncedAnimations = writable(
	typeof localStorage === 'undefined' || localStorage.getItem('syncedAnimations') !== 'false'
);

// user-designed node definitions ({id, name, params, code}), replicated
/** @type {import('svelte/store').Writable<any[]>} */
export const customNodeDefs = writable([]);

// script side panel: node id being edited (null = closed)
/** @type {import('svelte/store').Writable<string | null>} */
export const scriptEditorOpen = writable(null);

// node designer modal: def being edited (null = closed, 'new' = create)
/** @type {import('svelte/store').Writable<any>} */
export const nodeDesignerOpen = writable(null);

// nodeId -> last script error message (shown as a badge on the node)
/** @type {import('svelte/store').Writable<Record<string, string>>} */
export const scriptErrors = writable({});
