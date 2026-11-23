// 42 I9 — THE TWO STACKS CONTROLS DOES NOT DRAW ITSELF, published for the components that do.
//
// The toolbar's layout record (`controlsLayout`, $lib/toolbarLayout) places buttons in five
// regions. Controls.svelte draws the bar and the two bottom corners; the TOP-RIGHT group is
// Users.svelte's (notes, the notifications bell, the peers trigger and their panels) and the
// TOUCH TOOLS are TouchTools.svelte's (undo / redo / multi-select beside the logo). Those two
// keep drawing their own NATIVE buttons — the panels hang off them — and read here which of them
// are placed, in what order, and whether Edit positions is running (then Controls draws the whole
// region's placeholders in their place, and any OTHER roster button placed there, through a
// display:contents wrapper portaled into the group).
//
// A LEAF (svelte/store only). Controls is the one writer; the defaults are what a fresh profile
// and the server-rendered page show, so hydration never has to reconcile two answers.
import { writable } from 'svelte/store';

/** the top-right group's defaults, left → right (the pre-42 markup order) */
export const TOP_DEFAULT = ['notes', 'notifications', 'peers'];
/** the touch tools' defaults, in their pre-42 order */
export const TOUCH_DEFAULT = ['undo', 'redo', 'multiselect'];
/** the ids a component draws itself (everything else in those regions is Controls' to draw) */
export const TOP_NATIVE = ['notes', 'notifications', 'peers'];
export const TOUCH_NATIVE = ['undo', 'redo', 'multiselect'];

/**
 * @typedef {object} ToolbarSlots
 * @property {string[]} top     the top-right group, left → right
 * @property {string[]} touch   the touch tools, in order
 * @property {boolean} editing  Edit positions is on (the natives stand down for the placeholders)
 * @property {boolean} [connect] 43 K3: the Connect pill is shown (the draft's while editing; absent = shown)
 * @property {Record<string, {x?: number, y?: number, rotated?: boolean, hidden?: boolean}>} [clusters] 44 M12b: the
 *   clusters' placement / rotation (the draft's while editing) — a placed Connect pill stops docking / squeezing
 */

/** @type {import('svelte/store').Writable<ToolbarSlots>} */
export const toolbarSlots = writable({ top: [...TOP_DEFAULT], touch: [...TOUCH_DEFAULT], editing: false, connect: true });

/**
 * Where a native sits in its group: `null` = not placed there (the component hides it), else the
 * CSS `order` it takes among the group's flex items (Controls gives its own buttons the same
 * numbers, so the two interleave in record order).
 * @param {string[]} list @param {string} id
 */
export function slotOrder(list, id) {
	const at = list.indexOf(id);
	return at < 0 ? null : at;
}

// 103 H11: a cluster's placement written from OUTSIDE Controls (the Preview pill's chrome-button menu:
// "Hide this button" sets the `budget` cluster's `hidden`). Controls registers its own setCluster here,
// so the record keeps ONE writer; before it mounts a patch is dropped (nothing is drawn to hide).
/** @type {((id: string, patch: Record<string, any> | null) => void) | null} */
let clusterSetter = null;
/** @param {(id: string, patch: Record<string, any> | null) => void} fn */
export function registerClusterSetter(fn) {
	clusterSetter = fn;
	return () => {
		if (clusterSetter === fn) clusterSetter = null;
	};
}
/** @param {string} id @param {Record<string, any> | null} patch */
export function patchCluster(id, patch) {
	clusterSetter?.(id, patch);
}
