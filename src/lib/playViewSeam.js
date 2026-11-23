// 92-input GC4a + GC4 — THE PLAY VIEW SEAM (boot side; the views themselves are playView.js, lazy).
//
// A Character Controller's `camera` picks how Play LOOKS: first (through the player's eyes, every
// scene before 92-input and the default), third (behind the player, the camera pulled in by walls),
// side (a side-scroller: a locked plane, the view ahead of where the player faces) or top (top-down:
// a fixed angle, zoom between limits). The PLAYER does not move: the play camera stays the walker,
// so every game system that reads "where the player is" (sensors, Proximity, reach, the camera
// stream peers draw your avatar from, spatial audio) reads exactly what it read before. Only the
// DRAW moves: the render seam (Outline.svelte) puts the play camera at the view's pose for one draw
// and back after it — the Camera Shake rule (gameFeelFx.applyShake). Your own avatar is drawn where
// you stand (Player.svelte, `selfBody`), the body peers already see.
//
// VR keeps first person (comfort: a headset view never leaves the head). A possession owns the
// camera (the 'keys' claim) and a scene camera made active (Set Active Camera) is not the play
// camera: both stand the view down.
import { writable } from 'svelte/store';
import { charControl } from './charController';
import { isLocked, isVRMode, playerCam } from '../stores/sceneStore';
import { inputClaims } from './inputRuntime';

import { PLAY_VIEWS, PLAY_VIEW_DEFAULTS, playViewSettings } from './playViewSettings.js';
export { PLAY_VIEWS, PLAY_VIEW_DEFAULTS, playViewSettings };
/** @typedef {import('./playViewSettings.js').PlayView} PlayView */

/** @type {PlayView | null} */ let view = null;
let locked = false;
let vr = false;
/** @type {string[]} */ let claims = [];
/** @type {any} */ let cam = null;
/** @type {any} the lazy half (playView.js) */ let impl = null;
let loading = false;

/** YOUR body while a view other than first person is in force: AvatarRig's `preview` pose object
 * (mutated per frame by playView.js, never re-set), or null. @type {import('svelte/store').Writable<any>} */
export const selfBody = writable(null);

/** the view in force right now, or null (first person) */
function active() {
	return view && locked && !vr && !claims.includes('keys') ? view : null;
}

function refreshBody() {
	selfBody.set(active() && impl ? impl.body : null);
}

function load() {
	if (impl || loading) return;
	loading = true;
	import('./playView.js')
		.then((m) => {
			impl = m.playViewImpl;
			refreshBody();
		})
		.catch(() => (loading = false));
}

charControl.subscribe((c) => {
	view = /** @type {any} */ (c)?.view ?? null;
	if (view) load();
	refreshBody();
});
isLocked.subscribe((v) => {
	locked = v === true;
	impl?.reset();
	refreshBody();
});
isVRMode.subscribe((v) => {
	vr = !!v;
	refreshBody();
});
inputClaims.subscribe((c) => {
	claims = c;
	refreshBody();
});
playerCam.subscribe((c) => (cam = c));

/** the camera in force: 'first' | 'third' | 'side' | 'top' */
export function playViewKind() {
	return active()?.camera ?? 'first';
}

/** does the mouse / right stick / touch drag turn the player? (side + top fix the view) */
export function playViewLooks() {
	const k = playViewKind();
	return k === 'first' || k === 'third';
}

/**
 * The render seam (Outline.svelte): put the play camera at the view's pose for this one draw.
 * Returns the undo, or null when first person is in force (or XR, or another camera draws).
 * @param {any} camera @param {boolean} xr @returns {null | (() => void)}
 */
export function applyPlayView(camera, xr) {
	const v = active();
	if (!v || xr || !impl || !camera || camera !== cam) return null;
	return impl.apply(camera, v);
}

/**
 * Side / top: the keys and the stick are WORLD directions (right is +X, up the screen is -Z), so the
 * player turns to face the way they go and walks forward. Returns the move state to use.
 * @template {{forward: number, backward: number, left: number, right: number}} M
 * @param {any} rig @param {M} move @returns {M}
 */
export function steerPlayMove(rig, move) {
	const v = active();
	if (!v || v.camera === 'third' || !impl) return move;
	return impl.steer(rig, move, v);
}

/** side: keep the player on the plane Play started on @param {any} rig */
export function lockPlayPlane(rig) {
	const v = active();
	if (v?.camera === 'side' && impl) impl.lockPlane(rig);
}

/** the wheel zooms a third / side / top view (between its limits); true = taken @param {number} deltaY */
export function playViewWheel(deltaY) {
	const v = active();
	if (!v || !impl) return false;
	impl.zoom(deltaY, v);
	return true;
}

/** suites: the lazy half's state, or null before it loaded */
export function playViewDebug() {
	return { kind: playViewKind(), view, loaded: !!impl, ...(impl?.debug?.() ?? {}) };
}
