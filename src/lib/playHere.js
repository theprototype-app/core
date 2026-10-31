// 60 Q1: PLAY HERE — Play, with the player standing where the editor camera is looking from.
// Roblox Studio's "Play Here" / Godot's PlayAtCamPos: test the corner you are building without
// walking there from the spawn, and come back to exactly the view you left.
//
// The whole act is four things around the ordinary play press:
//   1. remember the editor camera (pose + orbit target) and the selection;
//   2. resolve a spawn from the camera (playSpawn.playHereSpawnFrom — pure, unit-tested): the
//      feet on the first solid surface straight under the eye, facing the view's heading; nothing
//      under it → the scene's spawn; no spawn either → the eye stays where the camera is;
//   3. hand that spawn to playSpawn as a session-only OVERRIDE — `currentSpawn()` is the one read
//      every spawn path shares (PointerLockControls, the VR walker, api.respawnPlayer, the game
//      shell), so a character controller, a game's restart and a fall out of the world all
//      respawn HERE for this round, with no second code path;
//   4. `requestPlay()` — the same press as the FAB, so VR/AR vs desktop is still decided once.
// Leaving Play (any exit: Esc, the touch ✕, Back, a HUD quit) clears the override and puts the
// camera and the selection back.
//
// A near-LEAF on purpose (three, stores, playSpawn, playMode, bvhPicking, scenePhysics): it is
// imported from shortcuts.js, which sits in history.js's import subtree. The selection restore
// reaches objectActions by DYNAMIC import for that reason.
import * as THREE from 'three';
import { get, writable } from 'svelte/store';
import { editorCam, orbitControls, isLocked, isVRMode, objectsGroup, selectedObjects, selectedObject } from '../stores/sceneStore';
import { requestPlay } from './playMode';
import { desktopSpawn, setPlayHereSpawn, playHereSpawn, SPAWN_EYE } from './playSpawn';
import { playHereSpawnFrom, headingOf, surfaceBelowIn } from './playHereCore';
import { ensureBoundsTrees } from './bvhPicking';
import { scenePhysicsGround } from './scenePhysics';

/** true from a Play here press until that Play ends (the toolbar cell's tint, the suites' view) */
export const playingHere = writable(false);

/** @type {{position: number[], quaternion: number[], target: number[] | null, selection: string[]} | null} */
let saved = null;
/** the last resolution, for the suites and the debug hook */
/** @type {{position: number[], yaw: number, source: string} | null} */
let lastSpawn = null;

/**
 * The y of the first SOLID surface straight under `eye` — the scene's meshes (on the shared pick's
 * BVH bounds trees) and the physics ground plane when it is on. Hidden objects, sensors, water and
 * reference images do not count (playHereCore.notGround). null = nothing below.
 * @param {number[]} eye
 * @returns {number | null}
 */
export function surfaceBelow(eye) {
	/** @type {any} */
	const group = get(objectsGroup);
	if (group?.children?.length) ensureBoundsTrees(group);
	return surfaceBelowIn(group, eye, get(scenePhysicsGround));
}

/** the editor camera as a Play here view: eye + heading @returns {{eye: number[], yaw: number} | null} */
export function editorView() {
	/** @type {any} */
	const cam = get(editorCam);
	if (!cam?.isObject3D) return null;
	cam.updateMatrixWorld(true);
	const eye = cam.getWorldPosition(new THREE.Vector3());
	const q = cam.getWorldQuaternion(new THREE.Quaternion());
	return { eye: eye.toArray(), yaw: headingOf(q) };
}

/** resolve (without playing) where Play here would put the player — the suites' and the button's view */
export function resolvePlayHere() {
	const view = editorView();
	if (!view) return null;
	return playHereSpawnFrom(view, surfaceBelow, desktopSpawn(), SPAWN_EYE);
}

function snapshotEditor() {
	/** @type {any} */
	const cam = get(editorCam);
	/** @type {any} */
	const controls = get(orbitControls);
	const set = get(selectedObjects);
	/** @type {any} */
	const primary = get(selectedObject);
	return {
		position: cam.position.toArray(),
		quaternion: cam.quaternion.toArray(),
		target: controls?.target ? controls.target.toArray() : null,
		selection: set.length ? set.map((/** @type {any} */ o) => o?.uuid ?? o).filter(Boolean) : primary?.uuid ? [primary.uuid] : []
	};
}

/**
 * THE PRESS. Synchronous all the way to `requestPlay` (an XR session is only granted inside the
 * gesture that asked for it). @returns {boolean} whether Play was asked for
 */
export function playHere() {
	if (get(isLocked) === true || get(isVRMode)) return false;
	/** @type {any} */
	const cam = get(editorCam);
	if (!cam?.isObject3D) return false;
	const spawn = resolvePlayHere();
	if (!spawn) return false;
	saved = snapshotEditor();
	lastSpawn = spawn;
	setPlayHereSpawn(spawn);
	playingHere.set(true);
	requestPlay();
	// a press that could not start Play (already in a transient exit, a refused session) must not
	// leave the override standing for the NEXT ordinary Play: the queued replay sets isLocked
	// within a macrotask, the XR path within its watchdog — both clear through the exit below
	return true;
}

/** put the editor camera and the selection back the way Play here found them */
function restoreEditor() {
	const was = saved;
	saved = null;
	if (!was) return;
	/** @type {any} */
	const cam = get(editorCam);
	if (cam?.isObject3D) {
		cam.position.fromArray(was.position);
		cam.quaternion.fromArray(was.quaternion);
		cam.updateMatrixWorld(true);
	}
	/** @type {any} */
	const controls = get(orbitControls);
	if (controls?.target && was.target) {
		controls.target.fromArray(was.target);
		// damping would otherwise ease the view from wherever it drifted
		controls.update?.();
		if (cam?.isObject3D) {
			cam.position.fromArray(was.position);
			cam.quaternion.fromArray(was.quaternion);
		}
	}
	if (was.selection.length) {
		void import('./objectActions')
			.then((m) => {
				/** @type {any} */
				const group = get(objectsGroup);
				const live = was.selection.filter((uuid) => !!group?.getObjectByProperty?.('uuid', uuid));
				const now = get(selectedObjects).map((/** @type {any} */ o) => o?.uuid ?? o);
				if (!live.length || (live.length === now.length && live.every((uuid) => now.includes(uuid)))) return;
				m.applySelectionSet(live);
			})
			.catch(() => {
				/* a selection that cannot come back is not worth an error */
			});
	}
}

/** the end of a Play here round: whatever ended it */
export function endPlayHere() {
	if (!get(playingHere) && !playHereSpawn()) return;
	setPlayHereSpawn(null);
	playingHere.set(false);
	restoreEditor();
}

/** the row Play's own menus carry (the desktop FAB's right-click, the phone bar's long press) */
export function playHereItems() {
	return [
		{ section: 'Start' },
		{
			label: 'Play here',
			tooltip: 'Start Play where the camera is, facing the view — leaving Play brings this view back (Ctrl+Shift+Enter)',
			action: () => void playHere()
		}
	];
}

/** test/debug view */
export function playHereDebug() {
	return { playing: get(playingHere), override: playHereSpawn(), last: lastSpawn, saved };
}

// The exit, on the state and not on any one button (the playMode W4 rule): `isLocked` leaving
// `true` after a Play here press ends the round. A press that never reached Play (refused XR, no
// lock) is cleared when the watchdog / transient settles back to the editor.
if (typeof window !== 'undefined') {
	let wasPlaying = get(isLocked) === true;
	isLocked.subscribe((v) => {
		const playing = v === true;
		if (wasPlaying && !playing) endPlayHere();
		wasPlaying = playing;
	});
	// a Play here that turned into an XR session ends with the session (isVRMode back to false)
	let wasVR = get(isVRMode);
	isVRMode.subscribe((v) => {
		if (wasVR && !v && get(isLocked) !== true) endPlayHere();
		wasVR = !!v;
	});
}
