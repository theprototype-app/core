// 24-E2: THE HELPER LAYER — "the editor sees it, the game does not". Light helpers and
// their pick proxies, camera frustums and (while hidden) camera MARKERS live on render
// layer HELPER_LAYER (30, see below); the editor camera enables it outside Play (and in Play with the debug
// toggle), and every camera that renders FOR someone — the play camera, a camera-object
// preview, PiP, thumbnails, captureThroughCamera — is a fresh THREE camera on layer 0
// only, so it never sees them.
//
// Two kinds of thing, two rules:
//  · scene-root helpers never serialise, so they sit on the layer PERMANENTLY
//    (`markHelper` at creation) — the Scene's selection raycaster enables the layer to
//    keep hitting the light proxies;
//  · camera markers are replicated meshes every raycaster in the app picks (VR rays,
//    snapping, Explorer drops, the SDK pointer ray, …). Moving them to the layer for
//    good would need every one of those to enable it, so a marker HOPS onto the layer
//    only while it must be hidden (Play without the debug toggle, a camera preview, the
//    one render of a capture) and comes back to layer 0 after. `toJSON` writes the
//    mask, so a peer snapshot taken mid-Play carries the hop — harmless, because every
//    peer normalises markers from ITS OWN state on the next helper sync (the reason
//    layers beat `visible`, which would replicate as a fact about the object).
//  Bits are flipped with enable/disable, never `set`: the outline passes mark a
//  selected object with a layer bit of their own, and `set` would wipe it.
//
//
// 30b P0 — THE LAYER NUMBER IS NOT FREE. three's WebXRManager renders each eye through
// its own sub-camera and RESERVES layers 1 and 2 for them: every frame it writes
// `cameraL.mask = (camera.mask | 0b110) & ~0b100` and `cameraR.mask = (camera.mask |
// 0b110) & ~0b010` (WebXRManager.updateCamera, "1 = left, 2 = right"). So on layer 1 a
// helper was ALWAYS drawn by the left eye — whatever the editor camera enabled — and never
// by the right one: the light-source helper a Quest user saw "with one eye" in Towers,
// Stars Room and Football. Any number the XR eye cameras only ever INHERIT (3..30; 31 is
// overloadGuard's REDUCED_LAYER, and postprocessing's Selection ids count up from 2) is
// correct; 30 keeps well clear of both.
//
// 30b P0/P1 — Interact hides helpers too: Edit is the only mode that draws the editor's
// scaffolding, in both eyes; Interact (desktop or VR) and Play draw none of it.
//
// Imports sceneStore only (the lightHelpers/cameraHelpers family), no THREE.
import { derived, get, writable } from 'svelte/store';
import { isLocked, editorCam, globalCamera, objectsGroup, editorMode } from '../stores/sceneStore';
import { safeStorage } from './safeStorage';

export const HELPER_LAYER = 30;

/** "Show helpers in Play (debug)" — LOCAL pref, default off. While on, helpers render
 * in Play and a DEBUG chip sits in the play HUD so a screenshot cannot be mistaken for
 * the game. @type {import('svelte/store').Writable<boolean>} */
export const helpersInPlay = writable(
	typeof localStorage !== 'undefined' && safeStorage.getItem('helpersInPlay') === 'true'
);
helpersInPlay.subscribe((value) => {
	if (typeof localStorage !== 'undefined') safeStorage.setItem('helpersInPlay', String(value));
});

/** Put a scene-root helper (and its whole subtree) on the helper layer, only.
 * @param {any} object */
export function markHelper(object) {
	if (!object?.traverse) return object;
	object.traverse((/** @type {any} */ node) => {
		if (node?.layers) node.layers.set(HELPER_LAYER);
	});
	return object;
}

/** Enable or disable the helper layer on a camera. @param {any} camera @param {boolean} on */
export function applyHelperLayer(camera, on) {
	if (!camera?.layers) return;
	if (on) camera.layers.enable(HELPER_LAYER);
	else camera.layers.disable(HELPER_LAYER);
}

/** 30b P1: the ONE predicate every editor helper answers to — Play (`isLocked === true`)
 * or Interact hides them, unless the "Show helpers in Play (debug)" toggle keeps them.
 * Pure so a suite can pin the table. @param {any} locked @param {any} mode @param {boolean} debug */
export function helpersHiddenFor(locked, mode, debug) {
	return (locked === true || mode === 'interact') && !debug;
}

/** Should helpers be hidden right now (Play or Interact, without the debug toggle)? */
export function helpersHidden() {
	return helpersHiddenFor(get(isLocked), get(editorMode), get(helpersInPlay));
}

/** 30b P1: the same answer as a store, for components (the grid, the VR selection shell)
 * and for anything that toggles `visible` per frame. */
export const editorHelpersShown = derived(
	[isLocked, editorMode, helpersInPlay],
	([$locked, $mode, $debug]) => !helpersHiddenFor($locked, $mode, $debug)
);

/** the marker-hop state the last `setMarkersHidden` applied (reads for the test seam) */
let markersHidden = false;
export function markersAreHidden() {
	return markersHidden;
}

/**
 * Hop every camera marker onto the helper layer (`hidden`) or back to layer 0. A
 * marker is any replicated object carrying `userData.camera` (the cameraObjects
 * contract; checked by shape so this leaf imports nothing of it).
 * @param {boolean} hidden
 */
export function setMarkersHidden(hidden) {
	markersHidden = !!hidden;
	const group = get(objectsGroup);
	if (!group?.traverse) return;
	group.traverse((/** @type {any} */ node) => {
		if (!node?.userData?.camera || !node.layers) return;
		if (hidden) {
			node.layers.enable(HELPER_LAYER);
			node.layers.disable(0);
		} else {
			node.layers.enable(0);
			node.layers.disable(HELPER_LAYER);
		}
	});
}

/** Run one render with the markers hidden (captureThroughCamera), then put them back
 * the way they were. @template T @param {() => T} fn @returns {T} */
export function withMarkersHidden(fn) {
	const before = markersHidden;
	setMarkersHidden(true);
	try {
		return fn();
	} finally {
		setMarkersHidden(before);
	}
}

/** the editor's own camera: the T.PerspectiveCamera Scene binds, else the current one */
function editorCamera() {
	/** @type {any} */
	const cam = get(editorCam);
	return cam && cam.layers ? cam : get(globalCamera);
}

function applyToEditorCamera() {
	applyHelperLayer(editorCamera(), !helpersHidden());
}

let started = false;

/** Boot (App.svelte): the editor camera follows Play / the debug toggle. Markers are
 * normalised by cameraHelpers (it also knows about previews). */
export function startHelperLayer() {
	if (started || typeof window === 'undefined') return;
	started = true;
	editorCam.subscribe(applyToEditorCamera);
	isLocked.subscribe(applyToEditorCamera);
	editorMode.subscribe(applyToEditorCamera);
	helpersInPlay.subscribe(applyToEditorCamera);
}
