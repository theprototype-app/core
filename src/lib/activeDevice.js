// 92-input GC3 — WHICH DEVICE IS THE PLAYER USING RIGHT NOW, and the BOOT half of the pad's play actions.
// The device is the last one that did something real: a pad button or a stick past its dead zone = pad
// (inputRuntime.pollGamepads reports it; the pad's family — its face buttons decide the glyphs — comes from
// playActions.js, lazy, loaded with the first pad); a key,
// a mouse move = keyboard; a finger = touch. Until a pad is seen it is the keyboard, so the window
// listeners that notice "back on the keyboard" start with the lazy pad bridge (padActions.js). Prompts
// (InputGlyph.svelte, the help lines, the banner, HUD key hints) follow it. Synthetic events (a touch button
// or the pad bridge sending a key) are not the player's device. A LEAF (svelte/store only); the pad
// catalog, glyph names and help lines are playActions.js (lazy).
import { writable } from 'svelte/store';

/** @typedef {{kind: 'keyboard' | 'pad' | 'touch', family: string}} ActiveInput */

/** @type {ActiveInput} */
let current = { kind: 'keyboard', family: 'generic' };
/** @type {import('svelte/store').Writable<ActiveInput>} */
export const activeInput = writable(current);

/** @param {'keyboard' | 'pad' | 'touch'} kind @param {string} family */
function note(kind, family) {
	if (current.kind === kind && current.family === family) return;
	current = { kind, family };
	activeInput.set(current);
}

/** the keyboard / mouse or a finger did something (padActions' window listeners) @param {'keyboard' | 'touch'} kind */
export function noteDeviceInput(kind) {
	note(kind, current.family);
}

/** pad id -> family; playActions.js registers it when it loads (with the first pad) @type {((id: string) => string) | null} */
let familyOf = null;
/** @param {(id: string) => string} fn */
export function setPadFamilyOf(fn) {
	familyOf = fn;
}
/** a pad did something (inputRuntime's poll) @param {string} id the pad's Gamepad id */
export function notePadInput(id) {
	note('pad', familyOf ? familyOf(id) : 'generic');
}

/** the pad help lines (playActions.js registers them when it loads) @type {((family: string) => string[]) | null} */
let padLines = null;
/** @param {(family: string) => string[]} fn */
export function setPadLines(fn) {
	padLines = fn;
}
/** the How to play lines for a pad of this family, or null before the pad half loaded @param {string} family */
export function padHelpLines(family) {
	return padLines ? padLines(family) : null;
}

/** the device in force, without a subscription @returns {ActiveInput} */
export function activeInputNow() {
	return current;
}
