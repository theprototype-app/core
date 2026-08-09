// @ts-ignore - no bundled three type declarations (project-wide)
import * as THREE from 'three';
import { writable, get } from 'svelte/store';
import { objectsGroup, lockedObjects, orbitControls, globalCamera, globalRenderer, isVRMode } from '../stores/sceneStore';
import { peers, showToast } from '../stores/appStore';
import { recordTransform } from './history';
import { suspendAnimation, resumeAnimation, notifyExternalMove } from './flowRuntime';
import { selectObject } from './objectActions';
import { getInput, onInput, claimInput, releaseInput } from './inputRuntime';
import { nameOf } from './lockControl';

// Possess (K-D): drive any scene object with WASD/arrows (or the VR left
// stick) with a follow camera — the host primitive behind the avatar module
// and the car. Possessing = SELECTING (our selection IS our lock, so peers see
// the usual lock highlight and can't grab the object). Tank controls: W/S move
// along the object's facing, A/D turn — no pointer-lock needed in the editor.
// Movement replicates as plain throttled `move`s (~10Hz, the multiTransform /
// physics rate) + one final move and ONE transform history entry on release.
// Mid-sim, the move stream lands on P-A's external-hold path — a possessed
// dynamic body follows kinematically and drops back to dynamic on release.

/** @type {import('svelte/store').Writable<string | null>} possessed uuid */
export const possessed = writable(null);

/** @type {any} */ let state = null; // {uuid, opts, before, raf, lastSent, offEsc, camSave}

const forward = new THREE.Vector3();
const camTarget = new THREE.Vector3();
const camOffset = new THREE.Vector3();

/** Third-person chase framing shared by possess and the follow cam (C3):
 * sit behind + above the facing, ease in, look at the object.
 * @param {any} cam @param {any} object @param {number} dt */
function chaseCamera(cam, object, dt) {
	camOffset.set(0, 2.2, 4.5).applyQuaternion(object.quaternion);
	camTarget.copy(object.position).add(camOffset);
	cam.position.lerp(camTarget, 1 - Math.pow(0.001, dt));
	cam.lookAt(object.position);
}

/** 17-A1: camera modes this build supports — modules feature-detect via
 * api.possessModes (an unknown `camera` value degrades silently, so the
 * capability list is the probe). */
export const possessModes = ['chase', 'orbit', 'none', 'first'];

const camEuler = new THREE.Euler(0, 0, 0, 'YXZ');
/** First-person framing (17-A1, the fps-player seam): eye at the object plus
 * eyeHeight, yaw = the object's tank heading, pitch = accumulated mouse look.
 * @param {any} cam @param {any} object @param {number} eyeHeight @param {number} pitch */
function firstCamera(cam, object, eyeHeight, pitch) {
	cam.position.copy(object.position);
	cam.position.y += eyeHeight;
	camEuler.set(pitch, object.rotation.y, 0);
	cam.quaternion.setFromEuler(camEuler);
}

/**
 * Take control of an object. @param {string} uuid
 * @param {{camera?: 'chase'|'orbit'|'none'|'first', speed?: number, turnSpeed?: number,
 *   eyeHeight?: number, mouseLook?: boolean}=} opts
 * 'first' (17-A1) parks the eye at the object + eyeHeight; mouseLook requests
 * pointer lock — X turns the OBJECT (movement follows the look), Y pitches the
 * camera only. Leaving pointer lock (Esc) releases the possession.
 * @returns {boolean}
 */
export function possess(uuid, opts = {}) {
	if (state) release();
	const object = get(objectsGroup)?.getObjectByProperty('uuid', uuid);
	if (!object) {
		showToast('Nothing to possess — select an object first');
		return false;
	}
	const lock = get(lockedObjects).find((entry) => entry[1] === uuid);
	if (lock) {
		showToast('Locked by ' + nameOf(lock[0]) + ' — ask them to release it');
		return false;
	}
	selectObject(uuid); // selection = our lock; peers see the usual highlight
	suspendAnimation(uuid); // we own the transform for the ride
	claimInput('keys'); // pause editor fly / play WASD
	claimInput('locomotion'); // pause VR left-stick locomotion

	/** @type {any} */
	const controls = get(orbitControls);
	state = {
		uuid,
		opts: { camera: 'chase', speed: 4, turnSpeed: 2.5, eyeHeight: 1.7, mouseLook: false, ...opts },
		before: {
			pos: object.position.toArray(),
			rot: object.rotation.toArray(),
			scale: object.scale.toArray()
		},
		camSave: controls ? { enabled: controls.enabled, target: controls.target.clone() } : null,
		pitch: 0,
		lastSent: 0,
		raf: 0,
		lastTime: performance.now(),
		offEsc: onInput((kind, code) => {
			if (kind === 'down' && code === 'Escape') release();
		})
	};
	if ((state.opts.camera === 'chase' || state.opts.camera === 'first') && controls)
		controls.enabled = false;
	if (state.opts.camera === 'first' && state.opts.mouseLook) startMouseLook();
	possessed.set(uuid);
	state.raf = requestAnimationFrame(tick);
	return true;
}

// ---- first-person mouse look (17-A1) ----------------------------------------
// Pointer lock swallows Esc (the browser exits the lock without a keydown ever
// reaching the page), so leaving the lock IS the release signal.

/** @param {MouseEvent} event */
function onLookMove(event) {
	// only while the lock is actually engaged — an unlocked mousemove still
	// carries movementX and would steer the object on any cursor travel
	if (!state || !document.pointerLockElement) return;
	const object = get(objectsGroup)?.getObjectByProperty('uuid', state.uuid);
	if (object) object.rotation.y -= event.movementX * 0.0025;
	state.pitch = Math.max(-1.45, Math.min(1.45, state.pitch - event.movementY * 0.0025));
}

function onLockChange() {
	// lock lost (Esc / alt-tab) while we hold a mouse-look possession → release
	if (state?.opts.mouseLook && !document.pointerLockElement) release();
}

function startMouseLook() {
	/** @type {any} */
	const renderer = get(globalRenderer);
	const target = renderer?.domElement ?? document.body;
	document.addEventListener('mousemove', onLookMove);
	document.addEventListener('pointerlockchange', onLockChange);
	try {
		target.requestPointerLock?.();
	} catch {}
}

function stopMouseLook() {
	document.removeEventListener('mousemove', onLookMove);
	document.removeEventListener('pointerlockchange', onLockChange);
	if (document.pointerLockElement) document.exitPointerLock?.();
}

/** Release control: restore the camera, record ONE undo entry, final move. */
export function release() {
	if (!state) return;
	cancelAnimationFrame(state.raf);
	state.offEsc?.();
	if (state.opts.camera === 'first' && state.opts.mouseLook) stopMouseLook();
	releaseInput('keys');
	releaseInput('locomotion');
	const { uuid, before, camSave } = state;
	/** @type {any} */
	const controls = get(orbitControls);
	if (controls && camSave) {
		controls.enabled = camSave.enabled;
		// keep looking where the ride ended rather than snapping back
		const object = get(objectsGroup)?.getObjectByProperty('uuid', uuid);
		if (object) controls.target.copy(object.position);
	}
	const object = get(objectsGroup)?.getObjectByProperty('uuid', uuid);
	if (object) {
		const after = {
			pos: object.position.toArray(),
			rot: object.rotation.toArray(),
			scale: object.scale.toArray()
		};
		if (JSON.stringify(before) !== JSON.stringify(after))
			recordTransform({ uuid, before, after });
		/** @type {any} */
		const peer = get(peers);
		if (peer)
			peer.send({ type: 'move', uuid, pos: after.pos, rot: after.rot, scale: after.scale });
	}
	resumeAnimation(uuid);
	notifyExternalMove(uuid); // the ride's end pose becomes the animation base
	state = null;
	possessed.set(null);
}

/** @param {number} now */
function tick(now) {
	if (!state) return;
	const object = get(objectsGroup)?.getObjectByProperty('uuid', state.uuid);
	if (!object) {
		release(); // deleted out from under us
		return;
	}
	const dt = Math.min((now - state.lastTime) / 1000, 0.1);
	state.lastTime = now;
	const { codes, axes } = getInput();
	const { speed, turnSpeed, camera } = state.opts;

	// tank controls: W/S (or Up/Down, or VR left-stick y) drive, A/D (Left/
	// Right, stick x) turn — deadzone the stick like computeMoveOffset does
	const dead = (/** @type {number} */ v) => (Math.abs(v) > 0.15 ? v : 0);
	let drive =
		(codes.has('KeyW') || codes.has('ArrowUp') ? 1 : 0) -
		(codes.has('KeyS') || codes.has('ArrowDown') ? 1 : 0) -
		dead(axes.ly);
	let turn =
		(codes.has('KeyA') || codes.has('ArrowLeft') ? 1 : 0) -
		(codes.has('KeyD') || codes.has('ArrowRight') ? 1 : 0) -
		dead(axes.lx);
	drive = Math.max(-1, Math.min(1, drive));
	turn = Math.max(-1, Math.min(1, turn));

	if (drive || turn) {
		object.rotation.y += turn * turnSpeed * dt;
		forward.set(0, 0, -1).applyQuaternion(object.quaternion);
		object.position.addScaledVector(forward, drive * speed * dt);
		object.updateMatrix();
		if (now - state.lastSent > 100) {
			state.lastSent = now;
			/** @type {any} */
			const peer = get(peers);
			if (peer)
				peer.send({
					type: 'move',
					uuid: object.uuid,
					pos: object.position.toArray(),
					rot: [object.rotation.x, object.rotation.y, object.rotation.z],
					scale: object.scale.toArray()
				});
		}
	}

	/** @type {any} */
	const controls = get(orbitControls);
	/** @type {any} */
	const cam = get(globalCamera);
	if (camera === 'chase' && cam) {
		chaseCamera(cam, object, dt);
	} else if (camera === 'first' && cam) {
		firstCamera(cam, object, state.opts.eyeHeight, state.pitch);
	} else if (camera === 'orbit' && controls) {
		controls.target.copy(object.position); // free orbit/zoom around the ride
	}

	state.raf = requestAnimationFrame(tick);
}

// ---- camera-only chase follow (C3) ------------------------------------------
// The car module reuses the possess chase framing WITHOUT the movement half:
// something else (the physics sim) owns the object's transform, we only fly the
// editor camera behind it. No input claim, no selection, no history.

/** @type {import('svelte/store').Writable<string | null>} followed uuid (tests/UI) */
export const followingCam = writable(null);

/** @type {any} */ let follow = null; // {uuid, raf, lastTime, camSave}

/** @param {string} uuid @returns {boolean} */
export function startFollowCam(uuid) {
	if (follow?.uuid === uuid) return true;
	stopFollowCam();
	const object = get(objectsGroup)?.getObjectByProperty('uuid', uuid);
	if (!object) return false;
	/** @type {any} */
	const controls = get(orbitControls);
	follow = {
		uuid,
		camSave: controls ? { enabled: controls.enabled, target: controls.target.clone() } : null,
		lastTime: performance.now(),
		raf: 0
	};
	if (controls) controls.enabled = false;
	followingCam.set(uuid);
	follow.raf = requestAnimationFrame(followTick);
	return true;
}

export function stopFollowCam() {
	if (!follow) return;
	cancelAnimationFrame(follow.raf);
	/** @type {any} */
	const controls = get(orbitControls);
	if (controls && follow.camSave) {
		controls.enabled = follow.camSave.enabled;
		// keep looking where the ride ended rather than snapping back
		const object = get(objectsGroup)?.getObjectByProperty('uuid', follow.uuid);
		if (object) controls.target.copy(object.position);
	}
	follow = null;
	followingCam.set(null);
}

/** @param {number} now */
function followTick(now) {
	if (!follow) return;
	const object = get(objectsGroup)?.getObjectByProperty('uuid', follow.uuid);
	if (!object) {
		stopFollowCam(); // deleted out from under us
		return;
	}
	const dt = Math.min((now - follow.lastTime) / 1000, 0.1);
	follow.lastTime = now;
	/** @type {any} */
	const cam = get(globalCamera);
	if (cam) chaseCamera(cam, object, dt);
	follow.raf = requestAnimationFrame(followTick);
}

let started = false;
export function startPossess() {
	if (started || typeof window === 'undefined') return;
	started = true;
	// entering VR mid-possession: the editor camera modes make no sense there
	isVRMode.subscribe((vr) => {
		if (vr) release();
		if (vr) stopFollowCam();
	});
}
