// 92-input GC3 — WHICH DEVICE IS THE PLAYER USING RIGHT NOW? The last one that did something real:
// a key or a mouse move = keyboard, a finger = touch, a pad button or a stick past its dead zone = pad
// (and which family: its face buttons decide the glyphs). Prompts (InputGlyph.svelte, the help lines,
// the banner) follow it. A LEAF (svelte/store only); inputRuntime.pollGamepads reports the pad.
// Synthetic events (a touch button or the pad bridge sending a key) are not the player's device.
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

/** a pad did something (inputRuntime's poll) @param {string} family */
export function notePadInput(family) {
	note('pad', family || 'generic');
}

/** the device in force, without a subscription @returns {ActiveInput} */
export function activeInputNow() {
	return current;
}

let started = false;
/** window listeners, once (capture phase: a handler that stops the event must not hide the device) */
export function watchActiveDevice() {
	if (started || typeof window === 'undefined') return;
	started = true;
	window.addEventListener('keydown', (e) => e.isTrusted && note('keyboard', current.family), true);
	window.addEventListener(
		'pointerdown',
		(e) => e.isTrusted && note(e.pointerType === 'touch' ? 'touch' : 'keyboard', current.family),
		true
	);
	window.addEventListener(
		'pointermove',
		(e) => {
			if (!e.isTrusted || e.pointerType === 'touch' || current.kind === 'keyboard') return;
			if (Math.abs(e.movementX) + Math.abs(e.movementY) > 6) note('keyboard', current.family);
		},
		true
	);
}
