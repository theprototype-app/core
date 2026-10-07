// VR controls — Edit / Interact in a headset: session start, the mode toggle + wrist label, spawn on entry.
// 34 R4 (A5): one concern of src/lib/vrControls.js, which re-exports the public names unchanged.
import * as THREE from 'three';
import { get } from 'svelte/store';
import { globalScene, editorMode } from '../../stores/sceneStore';
import { resolvePlaySettings, playPublishers } from '../playSettings';
import { hudDocs, isGameHud } from '../hudDocs';
import { setEditorMode, toggleEditorMode } from '../objectActions';
import { S } from './state.js';
import { renderer } from './core.js';
import { grabs, syncGrabbedHand, endGrab, emptyAirSqueeze, resetWorldRig } from './grip.js';
import { endWorldSnap } from './worldSnap.js';
import { hapticPulse } from './haptics.js';
import { controllerIndexFor } from './input.js';
import { noteXRBaseSpace, viewerNow, spawnPlayer } from './locomotion.js';
import { handOf, bindingOf, bindingLabel, controlName } from './bindings.js';

// ---- 30b P4: ENTER INTERACT, SWITCH IN VR, SPAWN ------------------------------------------
// Contract C1: pressing Play in VR on a GAME enters Interact; the left Y button toggles
// Edit <-> Interact in the headset (a haptic tick + a label on that wrist says which); and
// entering Interact puts the world back to 1:1 and the player on the game's spawn.

/** Is this scene a game? A HUD screen bound to a game state (the GameChip rule), a spawn,
 * or a module publishing the play contract (a dungeon). */
export function sceneIsGame() {
	const scene = get(globalScene);
	if (isGameHud(get(hudDocs))) return true;
	if (resolvePlaySettings(scene).spawn) return true;
	return playPublishers(scene).length > 0;
}

/** which hand owns the mode button: the LEFT (Y), unless the radial menu lives there — 36 (plan 55): the
 * mode binding says (it follows a menu-hand move, so the old rule still holds by default) */
export function modeHand() {
	return handOf('mode');
}

/** Scene's onsessionstart (after the base space is live). */
export function onVRSessionStart() {
	noteXRBaseSpace();
	// a game is played, not edited: Play in VR lands in Interact (the stores follow below)
	if (sceneIsGame() && get(editorMode) !== 'interact') setEditorMode('interact');
	else if (get(editorMode) === 'interact') enterInteractVR();
	updateModeLabel();
}

/** Interact starts at 1:1, on the spawn, with no editor gesture half-done. */
function enterInteractVR() {
	S.worldGrab = null;
	endWorldSnap(); // 37 R10: the readout goes with the gesture
	S.worldPan = null;
	emptyAirSqueeze[0] = emptyAirSqueeze[1] = false;
	for (let i = 0; i < grabs.length; i++) {
		const held = grabs[i];
		if (!held || held.interact) continue;
		grabs[i] = null;
		endGrab(held.object, held.before);
	}
	syncGrabbedHand();
	resetWorldRig();
	// at sessionstart no XR frame exists yet (so no viewer pose to move FROM): the spawn
	// waits for the first frame that has one (updateVRControls)
	spawnPending = true;
	if (viewerNow()) {
		spawnPending = false;
		spawnPlayer();
	}
}

/** The button: flip the mode, tick the hand, flash the label. @returns {'edit'|'interact'} */
export function toggleVRMode() {
	const next = toggleEditorMode();
	hapticPulse(0.35, 40, /** @type {any} */ (modeHand()), true);
	modeLabelFlashUntil = Date.now() + 500;
	updateModeLabel();
	return next;
}

let spawnPending = false;
/** a spawn owed since enterInteractVR, paid on the first frame with a viewer pose */
export function payPendingSpawn() {
	if (!spawnPending || !viewerNow()) return;
	spawnPending = false;
	spawnPlayer();
}

/** @type {any} */ let modeLabel = null;
/** @type {any} */ let modeLabelCanvas = null;
let modeLabelText = '';
let modeLabelKey = '';
let modeLabelFlashUntil = 0;

function ensureModeLabel() {
	if (modeLabel || typeof document === 'undefined') return modeLabel;
	modeLabelCanvas = document.createElement('canvas');
	modeLabelCanvas.width = 256;
	modeLabelCanvas.height = 80;
	const texture = new THREE.CanvasTexture(modeLabelCanvas);
	texture.colorSpace = THREE.SRGBColorSpace;
	modeLabel = new THREE.Mesh(
		new THREE.PlaneGeometry(0.075, 0.0234),
		new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: true })
	);
	modeLabel.name = 'vr-mode-label';
	// on the back of the controller, tilted up toward the eyes (the wrist you glance at)
	modeLabel.position.set(0, 0.03, 0.07);
	modeLabel.rotation.set(-1.0, 0, 0);
	modeLabel.renderOrder = 996;
	return modeLabel;
}

/** redraw the label when the mode changes; re-parent it onto the mode hand's controller */
export function updateModeLabel() {
	const label = ensureModeLabel();
	if (!label || !renderer) return;
	const presenting = !!renderer.xr.getSession?.();
	const index = presenting ? controllerIndexFor(modeHand()) : -1;
	label.visible = index >= 0;
	if (index < 0) return;
	const controller = renderer.xr.getController(index);
	if (label.parent !== controller) controller.add(label);
	const interact = get(editorMode) === 'interact';
	const text = interact ? 'INTERACT' : 'EDIT';
	label.scale.setScalar(Date.now() < modeLabelFlashUntil ? 1.35 : 1);
	// 36: the corner letter is the mode BINDING's, so a remap redraws the label too
	const key = text + '|' + bindingLabel('mode');
	if (key === modeLabelKey) return;
	modeLabelKey = key;
	modeLabelText = text;
	const ctx = modeLabelCanvas.getContext('2d');
	if (!ctx) return;
	ctx.clearRect(0, 0, 256, 80);
	ctx.fillStyle = interact ? 'rgba(20, 110, 90, 0.9)' : 'rgba(150, 95, 10, 0.9)';
	ctx.beginPath();
	ctx.roundRect?.(4, 4, 248, 72, 18);
	if (!ctx.roundRect) ctx.rect(4, 4, 248, 72);
	ctx.fill();
	ctx.fillStyle = '#ffffff';
	ctx.font = 'bold 34px sans-serif';
	ctx.textAlign = 'center';
	ctx.textBaseline = 'middle';
	ctx.fillText(text, 112, 42);
	ctx.font = 'bold 22px sans-serif';
	ctx.fillStyle = 'rgba(255,255,255,0.75)';
	const mb = bindingOf('mode');
	ctx.fillText(mb.control === 'stickClick' ? '◉' : controlName(mb.hand, mb.control), 228, 42);
	label.material.map.needsUpdate = true;
}

/** test/debug view of the label */
export function vrModeLabelDebug() {
	return {
		text: modeLabelText,
		visible: !!modeLabel?.visible,
		hand: modeLabel?.parent?.userData?.handedness ?? null,
		flashing: Date.now() < modeLabelFlashUntil
	};
}

// THE LAST STATEMENT IN THE FILE on purpose: a module-level subscribe runs its callback
// synchronously at evaluation, so every `let` it reaches must already be declared (the
// TDZ rule that took the whole app down twice). Entering Interact in a live session resets
// the world and spawns; either way the label follows.
let lastEditorMode = get(editorMode);
editorMode.subscribe((mode) => {
	if (mode === lastEditorMode) return;
	lastEditorMode = mode;
	if (!renderer?.xr?.getSession?.()) return;
	if (mode === 'interact') enterInteractVR();
	updateModeLabel();
});
