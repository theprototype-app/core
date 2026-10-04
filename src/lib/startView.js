// 36 L2 — THE SCENE'S START VIEW, and who owns the editor camera while a scene loads.
//
// THE REPORT: Tavern Interior and Market Square snapped the camera back a few seconds into the
// load; Forest Clearing and Castle Courtyard did not. A scene's saved view (`payload.camera`)
// was applied at the END of the restore — after the time-sliced object build, warmPrograms and
// the animated imports. A scene of pack stubs reaches that line in ~0.1 s, before anybody can
// move; a scene with many inline objects reaches it ~2.6 s later (measured, start-view-probe)
// and overrode whatever the user had done meanwhile.
//
// Now the view is applied at the START of the load (it is in the payload before any object
// exists), and from then on there are two rules, chosen per scene:
//
//   start view first  (the default) — loading parks the camera once, at the start. If the user
//                     moves it (any way at all: orbit, pan, zoom, fly keys, trackpad, touch, a
//                     focus/frame command) the load never moves it again, and when the load ends
//                     a "Back to start view" button offers the way back for ~6 s (Home does the
//                     same at any time).
//   hold              (Configure Scene ▸ Camera ▸ "Hold camera until loaded", saved in the scene,
//                     replicated with the other scene settings) — the camera sits at the start
//                     view and editor camera input is ignored while the scene loads. It can never
//                     trap anyone: the hold ends at the FIRST of every object loaded, every piece
//                     still missing being stuck or failed (U9's amber/red — a broken piece never
//                     extends it), the stuck threshold as a hard cap (10 s by default, the same
//                     setting), and Esc or "Take control" on the hint.
//
// "Moved" is read from the POSE, not from input events: the camera stands exactly on the start
// view from the moment it is applied, so anything that left it is somebody moving it, whatever
// device or command did it. Applying flushes OrbitControls' damping first, so momentum from a
// drag that began before the load cannot count as a move (or carry the camera off the view).
//
// VR: the headset owns the camera, so the start view only ever covers the desktop editor
// camera. A hold suspends VR locomotion the same way (teleport, turn, the walk stick and the
// world grab) through the existing nav-suppressor and world-grab-divert registries. Games are
// unchanged: Play places the player at `play.spawn` when Play starts, which this never touches.
// A load that runs WHILE PLAYING (a travel node) or while watching a peer is not about the editor
// camera at all — there the view is applied at the end exactly as 1.21 did, and nothing is held;
// a hold also ends the moment Play starts.
//
// LOCAL: nothing here is saved, sent or undone — the scene setting lives in scenePhysics (the
// replicated scene-settings singleton); this module only reads it out of the payload it loads.

import { writable, get } from 'svelte/store';
import { globalCamera, orbitControls, isVRMode, isLocked } from '../stores/sceneStore';
import { specatorMode } from '../stores/appStore';
import { currentJob } from './sceneLoader';
import { currentStuckMs } from './loadStates';
import { allPlaceholdersStalled } from './placeholders';
import { registerNavSuppressor, registerWorldGrabDivert } from './vr/hooks.js';

/** how long the "Back to start view" button stays after a load the user moved during */
export const BACK_BUTTON_MS = 6000;
/** the hint's "Take control" button appears after this long */
export const TAKE_CONTROL_AFTER_MS = 1500;
/** a pose this close to the start view IS the start view (metres) */
const EPS = 0.01;

/**
 * @typedef {{position: number[], target: number[]}} StartViewPose
 * @typedef {{kind: 'held', since: number, takeControl: boolean} | {kind: 'back', until: number} | null} StartViewHint
 */

/** What the overlay shows (StartViewHint.svelte). LOCAL. @type {import('svelte/store').Writable<StartViewHint>} */
export const startViewHint = writable(/** @type {StartViewHint} */ (null));

/** @type {StartViewPose | null} the view of the scene loaded last (Home goes back to it) */
let view = null;
/** @type {any} the load this owns, or null once it ended */
let job = null;
let holding = false;
let holdSince = 0;
/** when the last hold ended (the suites read how long it lasted) */
let releasedAt = 0;
/** why the last hold ended ('loaded' | 'stalled' | 'cap' | 'user' | 'cancelled' | 'play') */
let releasedBy = '';
let moved = false;
/** the load began while playing or spectating: the 1.21 rule (apply at the end, no hold) */
let legacy = false;
let backTimer = /** @type {any} */ (null);
/** @type {{enabled: boolean, controls: any} | null} what the hold switched off */
let stoodDown = null;
/** injectable clock for the unit layer */
let clock = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** @param {any} raw @returns {StartViewPose | null} */
export function normalizeStartView(raw) {
	const ok = (/** @type {any} */ v) => Array.isArray(v) && v.length === 3 && v.every((n) => Number.isFinite(Number(n)));
	if (!raw || !ok(raw.position)) return null;
	return { position: raw.position.map(Number), target: ok(raw.target) ? raw.target.map(Number) : [0, 0, 0] };
}

/** The scene setting, read straight out of a payload's physics block (36 L2: it must act
 * at the START of a load, long before scenePhysicsRestore runs). @param {any} physics */
export function sceneHoldsCamera(physics) {
	return physics?.holdCamera === true;
}

/** Does this camera/controls pair stand on the view? @param {any} camera @param {any} controls @param {StartViewPose} pose */
export function onView(camera, controls, pose) {
	const near = (/** @type {any} */ v, /** @type {number[]} */ a) => Math.abs(v.x - a[0]) < EPS && Math.abs(v.y - a[1]) < EPS && Math.abs(v.z - a[2]) < EPS;
	return near(camera.position, pose.position) && (!controls?.target || near(controls.target, pose.target));
}

/**
 * Put the camera on the view, with no momentum left in the controls: a NON-damped update
 * applies and zeroes whatever rotate/pan/zoom was still pending, then the pose is set again.
 * @param {any} camera @param {any} controls @param {StartViewPose} pose
 */
export function placeCamera(camera, controls, pose) {
	camera.position.fromArray(pose.position);
	if (!controls?.target) {
		camera.lookAt(pose.target[0], pose.target[1], pose.target[2]);
		return;
	}
	controls.target.fromArray(pose.target);
	const damping = controls.enableDamping;
	controls.enableDamping = false;
	controls.update();
	controls.enableDamping = damping;
	camera.position.fromArray(pose.position);
	controls.target.fromArray(pose.target);
	controls.update();
}

function cameraAndControls() {
	return { camera: /** @type {any} */ (get(globalCamera)), controls: /** @type {any} */ (get(orbitControls)) };
}

/** Playing (the player camera is live) or watching a peer (their camera drives ours)? */
function notEditorCamera() {
	return get(isLocked) === true || !!get(specatorMode);
}

/** Is the user's camera input being ignored right now (the VR registries and the suites read it)? */
export function startViewHeld() {
	return holding;
}

function standDownControls() {
	const { controls } = cameraAndControls();
	if (!controls) return;
	if (!stoodDown || stoodDown.controls !== controls) stoodDown = { enabled: controls.enabled !== false, controls };
	// per frame, like syncOrbitForPlay: <TransformControls> writes `enabled = true` on its own
	controls.enabled = false;
}

function restoreControls() {
	if (stoodDown?.controls) stoodDown.controls.enabled = stoodDown.enabled;
	stoodDown = null;
}

/** @param {KeyboardEvent} event */
function onKey(event) {
	if (!holding || event.key !== 'Escape') return;
	event.preventDefault();
	event.stopPropagation();
	releaseHold('user');
}

/** End the hold (Esc, "Take control", or a release condition). @param {string} [reason] */
export function releaseHold(reason = 'user') {
	if (!holding) return;
	holding = false;
	releasedBy = reason;
	releasedAt = clock();
	restoreControls();
	if (typeof window !== 'undefined') window.removeEventListener('keydown', onKey, true);
	if (get(startViewHint)?.kind === 'held') startViewHint.set(null);
}

/**
 * A scene load starts: park the camera on its saved view now, before any object exists.
 * Sessions and the autosave Restore call this right after they clear the old scene.
 * @param {any} loadJob the sceneLoader job @param {any} rawView `payload.camera`
 * @param {{hold?: boolean}} [opts] hold = the scene's "Hold camera until loaded"
 */
export function beginStartView(loadJob, rawView, opts = {}) {
	releaseHold('superseded');
	clearTimeout(backTimer);
	if (get(startViewHint)) startViewHint.set(null);
	job = loadJob;
	moved = false;
	releasedBy = '';
	releasedAt = 0;
	view = normalizeStartView(rawView);
	legacy = notEditorCamera();
	if (!view || legacy) {
		if (!view) job = null;
		return;
	}
	const { camera, controls } = cameraAndControls();
	if (camera && !get(isVRMode)) placeCamera(camera, controls, view);
	if (opts.hold) {
		holding = true;
		holdSince = clock();
		standDownControls();
		if (typeof window !== 'undefined') window.addEventListener('keydown', onKey, true);
		startViewHint.set({ kind: 'held', since: holdSince, takeControl: false });
	}
}

/**
 * Where the load used to apply the view (after the build, the warm-up and the rigs): put it
 * back only if nobody moved the camera since the start. A move — by any input — wins.
 * @param {any} loadJob
 */
export function settleStartView(loadJob) {
	if (!view || loadJob !== job) return;
	const { camera, controls } = cameraAndControls();
	if (!camera || get(isVRMode)) return;
	if (legacy) {
		// playing / spectating: 1.21's rule, unchanged
		placeCamera(camera, controls, view);
		return;
	}
	if (holding || !moved) {
		if (!onView(camera, controls, view)) {
			if (holding) placeCamera(camera, controls, view);
			else moved = true;
		}
	}
}

/** The load is over (ended, cancelled or superseded). */
function finish() {
	const ended = job && !job.cancelled;
	if (holding) releaseHold(ended ? 'loaded' : 'cancelled');
	job = null;
	if (!ended || !view || !moved || legacy) return;
	const until = clock() + BACK_BUTTON_MS;
	startViewHint.set({ kind: 'back', until });
	clearTimeout(backTimer);
	backTimer = setTimeout(() => {
		if (get(startViewHint)?.kind === 'back') startViewHint.set(null);
	}, BACK_BUTTON_MS);
}

/** Per frame, from Scene's useTask (last, after every camera input has run). */
export function tickStartView() {
	if (!job) return;
	if (currentJob() !== job) {
		finish();
		return;
	}
	const { camera, controls } = cameraAndControls();
	if (!camera || !view || legacy) return;
	if (holding && notEditorCamera()) releaseHold('play');
	if (holding) {
		const now = clock();
		const stalled = job.phase === 'models' && allPlaceholdersStalled();
		if (stalled) releaseHold('stalled');
		else if (now - holdSince >= currentStuckMs()) releaseHold('cap');
		else {
			standDownControls();
			// whatever moved it this frame (fly keys, trackpad, a frame command) is undone
			// before the frame is drawn
			if (!get(isVRMode) && !onView(camera, controls, view)) placeCamera(camera, controls, view);
			const hint = get(startViewHint);
			if (hint?.kind === 'held' && !hint.takeControl && now - holdSince >= TAKE_CONTROL_AFTER_MS)
				startViewHint.set({ ...hint, takeControl: true });
			return;
		}
	}
	if (!moved && !get(isVRMode) && !onView(camera, controls, view)) moved = true;
}

/** Fly back to the scene's start view (the button, the Home key). @returns {boolean} */
export function backToStartView() {
	if (!view || get(isVRMode)) return false;
	if (get(startViewHint)?.kind === 'back') startViewHint.set(null);
	// lazy: objectActions is a heavy module in the history family; this leaf must not pull it
	void import('./objectActions').then((m) => m.flyTo(/** @type {any} */ (view).position, /** @type {any} */ (view).target));
	return true;
}

/** The view of the scene loaded last, or null. @returns {StartViewPose | null} */
export function currentStartView() {
	return view ? { position: [...view.position], target: [...view.target] } : null;
}

// VR: a hold stands every kind of locomotion down — the sticks (teleport, turn, walk) through
// the nav suppressors, the world grab/pan through the divert registry (`active` stops a pan
// from starting, `apply` consumes a two-grip grab). Registered once for the app's life.
registerNavSuppressor(() => holding);
registerWorldGrabDivert({ active: () => holding, apply: () => holding });

/** for the suites */
export function startViewDebug() {
	return {
		view: currentStartView(),
		loading: !!job,
		holding,
		holdSince,
		releasedBy,
		heldFor: releasedAt >= holdSince && releasedBy ? releasedAt - holdSince : null,
		moved,
		hint: get(startViewHint)
	};
}

/** @param {() => number} fn */
export function setStartViewClockForTest(fn) {
	clock = fn;
}

export function resetStartViewForTest() {
	releaseHold('reset');
	clearTimeout(backTimer);
	view = job = null;
	moved = legacy = false;
	releasedBy = '';
	startViewHint.set(null);
}
