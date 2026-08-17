import { writable } from 'svelte/store';

// Phase 85: what a DOUBLE-CLICK on an object does, as a LOCAL preference.
//
// Since 15-O a plain click only selects and a double-click opens the properties
// panel. That is the right default and stays the default — the docs describe it,
// and "double-click opens the thing's settings" is what a non-modelling user
// expects. The other three exist because a modelling session wants something else
// from the same gesture, and which one differs per person.
//
// Imports nothing but svelte/store: Scene.svelte, the Settings panel and the
// shortcuts registry all read it, and none of them can afford a new import edge.

/** @typedef {'properties'|'meshedit'|'isolate'|'sametype'} DoubleClickAction */

export const DOUBLE_CLICK_ACTIONS = [
	{ value: 'properties', label: 'Open properties', hint: 'The panel for that object (default)' },
	{ value: 'meshedit', label: 'Edit mesh', hint: 'Jump straight into vertex/edge/face editing' },
	{ value: 'isolate', label: 'Focus and isolate', hint: 'Frame it and hide everything else until Esc' },
	{ value: 'sametype', label: 'Select same type', hint: 'Select every object of the same kind' }
];

const KEY = 'doubleClickAction';
const DEFAULT = 'properties';

/** @type {DoubleClickAction} */
const stored =
	typeof localStorage !== 'undefined' &&
	DOUBLE_CLICK_ACTIONS.some((a) => a.value === localStorage.getItem(KEY))
		? /** @type {any} */ (localStorage.getItem(KEY))
		: DEFAULT;

/** @type {import('svelte/store').Writable<DoubleClickAction>} */
export const doubleClickAction = writable(stored);

if (typeof localStorage !== 'undefined')
	doubleClickAction.subscribe((value) => localStorage.setItem(KEY, value));
