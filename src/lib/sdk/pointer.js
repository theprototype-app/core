// Module SDK — api.pointerRay — where the user is pointing.

import * as THREE from 'three';
import { globalCamera, isVRMode, isLocked, playPointerFree } from '../../stores/sceneStore';
import { ndcFromClient } from '../canvasRect';
import { playCursorSetting } from '../playCursor';
import { get } from 'svelte/store';
import { vrControlsRef } from './refs.js';

// --- api.pointerRay (190): where the user is POINTING, as a world ray --------
// Desktop: the mouse over the viewport (tracked window-wide in NDC, same math
// as Scene.svelte's selection raycast). VR: the pointer hand's controller ray
// (vrControls, resolved by handedness). A FRESH Raycaster every call.
//
// W9: the listener records CLIENT pixels and the conversion to NDC happens at ray
// time, against the canvas. Converting on the way in would freeze the viewport's
// geometry into the stored value, and the viewport can change with the pointer
// perfectly still — opening the bottom dock shrinks it — leaving the last-known ray
// pointing at a viewport that no longer exists.
const pointerClient = { x: 0, y: 0, seen: false };
if (typeof window !== 'undefined') {
	window.addEventListener('pointermove', (event) => {
		pointerClient.x = event.clientX;
		pointerClient.y = event.clientY;
		pointerClient.seen = true;
	});
}
/** 30 P4: the CROSSHAIR ray, a fresh Raycaster through the centre of the view */
const SCREEN_CENTRE = new THREE.Vector2(0, 0);

/**
 * 30 P4: does play aim with a CROSSHAIR right now? Under a pointer lock the cursor is
 * pinned and its last client position is where the mouse happened to be when the lock
 * began — a STALE ray that never moves again (untangle's carried dot followed it, so a
 * drag in play went nowhere). So while playing, the pointer locked, and not in the menu
 * substate (the pointer is free there, over the HUD), the ray is the view's centre —
 * play mode's own NDC (0,0), the one playInteract aims with.
 */
function crosshairAims() {
	if (get(isLocked) !== true || get(playPointerFree)) return false;
	if (typeof document === 'undefined' || !document.pointerLockElement) return false;
	// 30-core-flow: free cursor — a scene whose play block says `cursor: 'free'` (or a
	// module publishing it through userData.play) plays with the real cursor and no lock,
	// so its ray IS the mouse ray. Asked through playCursor, the leaf playInteract, PLC and
	// PlayReticle ask too, so the four cannot disagree about where the player aims.
	return playCursorSetting() !== 'free';
}

function pointerRayNow() {
	if (get(isVRMode)) return vrControlsRef?.pointerHandRay?.() ?? null;
	/** @type {any} */
	const camera = get(globalCamera);
	if (!camera) return null;
	if (crosshairAims()) {
		const centre = new THREE.Raycaster();
		centre.setFromCamera(SCREEN_CENTRE, camera);
		return centre;
	}
	if (!pointerClient.seen) return null;
	const fresh = new THREE.Raycaster();
	const ndc = ndcFromClient(pointerClient.x, pointerClient.y);
	fresh.setFromCamera(new THREE.Vector2(ndc.x, ndc.y), camera);
	return fresh;
}
/** exported for tests (__stores.moduleSDK.pointerRayNow) */
export { pointerRayNow };
