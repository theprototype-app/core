import * as THREE from 'three';
import { get } from 'svelte/store';
import { isLocked, isVRMode } from '../stores/sceneStore';
import { specatorMode, anyModalOpen } from '../stores/appStore';
import { isClaimed } from './inputRuntime';
// No new dependency: inputRuntime already imports shortcuts, and nothing in lib/
// imports editorNavigation, so this closes no cycle.
import { shortcuts } from './shortcuts';
// D3 (15): same cycle argument — meshEdit/faceEdit never import editorNavigation
import { editingObject } from './meshEdit';
import { faceEditObject, meshEditHotkeys } from './faceEdit';
// 24-A1: fly keys by layout-independent letter (zero-import leaf) — on a Cyrillic
// layout W is `ц`, so `event.key` never matched and the camera could not fly
import { letterOf } from './keyOf';
import { viewportHasKeys } from './keyScope'; // 36 U11
// 103 H5/H10: fly-with-WASD + fly-direction prefs (a leaf)
import { flyWithWasd, flyDirection, setRightHeld, rightButtonHeld, noteFlew } from './flyPrefs';

// WASD fly-panning for the desktop editor, Q down / E up, Shift = 3x.
// Camera position and orbit target move together. Inert while typing, in
// play mode (Player owns WASD there), spectating or in VR.
// Note: transform-mode hotkeys moved to 1/2/3 to free these keys.

const SPEED = 5; // units per second
const KEYS = ['w', 'a', 's', 'd', 'q', 'e'];
/** @type {Set<string>} */
const pressed = new Set();
let started = false;

/**
 * Is `Shift+<key>` a registered COMMAND rather than fast flying?
 *
 * Shift on its own is the 3x fly modifier, so Shift+W/S/D/Q/E must keep moving —
 * but Shift+A opens the Add menu, and running that command used to ALSO strafe the
 * camera left (at 3x, because Shift was held), so the viewport lurched before the
 * menu appeared. Reading the registry keeps this correct for any Shift+<key>
 * shortcut added later. Checked live: registerShortcut mutates the same array.
 * @param {string} key lowercased single key
 */
function isShiftCommand(key) {
	const combo = 'shift+' + key;
	return shortcuts.some((s) => s.action && String(s.keys).toLowerCase() === combo);
}

/** @param {KeyboardEvent} event */
function guarded(event) {
	/** @type {any} */
	const target = event.target;
	return (
		target &&
		(target.tagName === 'INPUT' ||
			target.tagName === 'TEXTAREA' ||
			target.tagName === 'SELECT' ||
			target.isContentEditable)
	);
}

export function startEditorNavigation() {
	if (started || typeof window === 'undefined') return;
	started = true;
	// String(event.key || ''): Chrome's password manager fires synthetic key events
	// with key === undefined (e.g. saving an API key in Settings) — never dereference
	window.addEventListener('keydown', (event) => {
		if (event.key === 'Shift') return pressed.add('shift');
		// 15-B6: non-modal dialogs leave the page live — don't fly the camera
		// behind an open Settings/Sessions/Modules modal
		// R22 round 13 (user): "Alt+E alt+a open/close window, but it also affects WASD".
		// The #183 shortcuts are Alt-aware, so Alt+E toggles a panel - and this guard
		// checked Ctrl and Meta but not Alt, so the same press ALSO registered e as a
		// movement key and the camera flew. A modified press is a COMMAND, never movement.
		// The keyup below stays unguarded on purpose (the Ctrl+V push-to-talk lesson):
		// guarding it strands a key held down when the modifier arrives mid-hold.
		if (guarded(event) || event.ctrlKey || event.metaKey || event.altKey || get(anyModalOpen)) return;
		// 36 U11: the camera flies only while the VIEWPORT has the keyboard — A frames
		// all nodes and Q/E align them in the node editor, and must not strafe the camera
		if (!viewportHasKeys(event)) return;
		const key = letterOf(event);
		if (event.shiftKey && isShiftCommand(key)) return; // a command, not movement
		// 103 H5: 'only while holding the right mouse button' — a bare W / S outside a hold is a
		// command key (the Blender preset's S resizes), never movement
		if (get(flyWithWasd) === 'rmb' && !rightButtonHeld()) return;
		if (KEYS.includes(key)) pressed.add(key);
	});
	// 103 H5: the right-button hold that 'rmb' fly mode waits for. Capture phase on window:
	// OrbitControls captures the pointer on press, so the release may land anywhere.
	window.addEventListener(
		'pointerdown',
		(event) => {
			if (event.button !== 2) return;
			const target = /** @type {any} */ (event.target);
			if (target?.tagName === 'CANVAS' || target?.closest?.('[data-viewport], #viewport')) setRightHeld(true);
		},
		true
	);
	const releaseRight = (/** @type {PointerEvent} */ event) => {
		if (event.type === 'pointerup' && event.button !== 2) return;
		if (!rightButtonHeld()) return;
		setRightHeld(false);
		if (get(flyWithWasd) === 'rmb') pressed.clear();
	};
	window.addEventListener('pointerup', releaseRight, true);
	window.addEventListener('pointercancel', releaseRight, true);
	window.addEventListener('keyup', (event) => {
		if (event.key === 'Shift') return pressed.delete('shift');
		pressed.delete(letterOf(event));
	});
	window.addEventListener('blur', () => {
		pressed.clear();
		setRightHeld(false);
	});
}

const forward = new THREE.Vector3();
const right = new THREE.Vector3();
const movement = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

/**
 * Called every frame from Scene's useTask.
 * @param {number} delta @param {any} camera @param {any} controls - OrbitControls
 */
export function updateEditorNavigation(delta, camera, controls) {
	if (pressed.size === 0 || !camera || !controls) return;
	if (get(isLocked) || get(isVRMode) || get(specatorMode)) return;
	if (isClaimed('keys')) return; // K-C: a module owns WASD (possession)
	// D3: a mesh-edit session owns W/E/S while its hotkeys are on (W welds, E/S
	// arm ops) — flying the camera on the same keys fought the tools. Toggling
	// the hotkeys pref OFF returns the fly keys mid-session (quiz 15-D3).
	// Deliberately NOT claimInput('keys'): the claim set is not refcounted and
	// possess/car claim+release the same scope, which would drop ours mid-ride.
	if ((get(editingObject) || get(faceEditObject)) && get(meshEditHotkeys)) return;
	// a modal opening mid-flight must STOP the camera, not coast on held keys
	if (get(anyModalOpen)) return pressed.clear();

	movement.set(0, 0, 0);
	camera.getWorldDirection(forward);
	// 103 H10: 'look' keeps the view direction's climb, so looking up and pressing W rises.
	// The strafe axis is always level (from the flattened direction), and Q / E stay vertical.
	const look = get(flyDirection) === 'look';
	const climb = forward.y;
	forward.y = 0;
	if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
	forward.normalize();
	right.crossVectors(forward, UP).normalize();
	if (look) {
		camera.getWorldDirection(forward);
		if (forward.lengthSq() < 1e-6 || Math.abs(climb) > 0.9999) forward.set(0, Math.sign(climb) || -1, 0);
		forward.normalize();
	}

	if (pressed.has('w')) movement.add(forward);
	if (pressed.has('s')) movement.sub(forward);
	if (pressed.has('d')) movement.add(right);
	if (pressed.has('a')) movement.sub(right);
	if (pressed.has('e')) movement.y += 1;
	if (pressed.has('q')) movement.y -= 1;
	if (movement.lengthSq() === 0) return;

	movement.normalize().multiplyScalar(delta * SPEED * (pressed.has('shift') ? 3 : 1));
	if (rightButtonHeld()) noteFlew();
	camera.position.add(movement);
	controls.target.add(movement);
	controls.update?.();
}
