import { writable } from 'svelte/store';

// 114 (v1.13): the node editor's MOUSE BINDINGS, a LOCAL pref (a leaf: svelte/store
// only, so Settings and Nodes.svelte can both reach it with no cycle).
//
//   'classic' — the default and the behaviour every version so far shipped: a left
//               drag on the pane PANS; a rectangle selection needs Shift.
//   'select'  — "Select-first", the DCC convention: a left drag on the pane draws a
//               selection rectangle and dragging any selected node moves the whole
//               set; the MIDDLE or RIGHT button pans; a right click that does not
//               travel still opens the pane menu (Nodes.svelte re-emits it — xyflow's
//               pane swallows every contextmenu once the right button pans).
//
// The user's call (2026-07-11) was to keep Classic as the default and make it
// adjustable, so a saved graph, a peer or a suite that never touches this store sees
// byte-identical editor behaviour.

/** @typedef {'classic' | 'select'} FlowMouseBindings */

const KEY = 'flow:mouseBindings';

/** @param {any} value @returns {FlowMouseBindings} */
function normalize(value) {
	return value === 'select' ? 'select' : 'classic';
}

/** @type {import('svelte/store').Writable<FlowMouseBindings>} */
export const flowMouseBindings = writable(
	normalize(typeof localStorage !== 'undefined' ? localStorage.getItem(KEY) : null)
);
if (typeof localStorage !== 'undefined')
	flowMouseBindings.subscribe((value) => localStorage.setItem(KEY, normalize(value)));

/** the choices, as DATA, so the Settings row and the docs cannot drift */
export const FLOW_MOUSE_BINDINGS = [
	{ value: 'classic', name: 'Classic — left-drag pans' },
	{ value: 'select', name: 'Select-first — left-drag selects, right-drag pans' }
];
