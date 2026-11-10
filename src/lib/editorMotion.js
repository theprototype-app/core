// 78 F6 — "ANIMATE IN EDITOR": one switch for all flow motion while you edit. Off, every flow
// MOTION node (Spin, Bounce, Orbit, Path patrol, Wander…) stands down outside Play and its
// objects rest at their authored pose, so you can place things without chasing them; Play runs
// everything as always. It is the 21-F2 `whilePlaying` rule (flowRuntime's `dormant`) applied to
// every motion node at once, so the restore loop hands each object back cleanly.
//
// LOCAL and per viewer (safeStorage), default ON = byte-identical: it decides what YOUR editor
// view shows. Motion stays a function of the shared clock, so switching it back on lands every
// object exactly where everyone else sees it (a freeze would drift this peer's clock instead).
// A LEAF: svelte/store + safeStorage.

import { writable } from 'svelte/store';
import { safeStorage } from './safeStorage';

const KEY = 'flow:animateInEditor';

/** flow node types that MOVE their object (nodeCatalog.animationTypes minus the look/visibility/
 * device writers, which are state, not motion) */
export const EDITOR_MOTION_TYPES = new Set([
	'shake',
	'spin',
	'bounce',
	'orbit',
	'pulse',
	'blink',
	'pathpatrol',
	'rotor',
	'flowfloat',
	'followpath',
	'wander',
	'orientvelocity',
	'bodywave',
	'lookat',
	'camerarig'
]);

function read() {
	return safeStorage.getItem(KEY) !== 'false';
}

/** true = flow motion plays in the editor (the default) */
export const animateInEditor = writable(read());
animateInEditor.subscribe((on) => {
	if (on) safeStorage.removeItem(KEY);
	else safeStorage.setItem(KEY, 'false');
});

export function toggleAnimateInEditor() {
	animateInEditor.update((on) => !on);
}
