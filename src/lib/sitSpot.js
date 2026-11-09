// @ts-ignore - no bundled three type declarations (project-wide)
import * as THREE from 'three';
import { get } from 'svelte/store';
import { playerCam, isLocked, isVRMode, editorMode, objectsGroup } from '../stores/sceneStore';
import { claimInput, releaseInput, getInput } from './inputRuntime';
import { otherPlayerIds, avatarPositions } from './playSpawn';
import { registerClickHook, sitSpotFor } from './flowRuntime';
import { showToast } from '../stores/appStore.js';
import { registerVRFrameHook } from './vr/hooks.js';
import { seatPose } from './sitSpotCore.js';

// 85 I3 — SIT SPOTS. A Sit Spot node on a chair or a sofa: a click on it (the play crosshair tap,
// a VR trigger, an Interact click) sits YOU down on it — the view drops to a seated eye height on
// top of the seat, facing its front — and any move key, the jump key or a push of the stick stands
// you up again where you were. LOCAL per player: your own camera (desktop) or rig (VR) is what
// moves, and the others see your avatar sit through the avatar stream they already have, so there
// is no new message. A seat someone else's avatar already occupies refuses with a toast.
//
// Wired through flowRuntime's click hook (flowRuntime may not import this; playInteract imports
// it, which is what loads it in every session with a Scene).

/** @typedef {{uuid: string, eye: number[], yaw: number, floor: number, standEye: number[] | null, vr: boolean}} Seat */
/** @type {Seat | null} */
let seated = null;
const v = new THREE.Vector3();
const STAND_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space']);
/** someone else's avatar is already in this seat @param {number[]} eye */
function occupied(eye) {
	return avatarPositions(otherPlayerIds()).some((p) => Math.hypot(p[0] - eye[0], p[2] - eye[2]) < 0.35 && Math.abs(p[1] - eye[1]) < 1.2);
}

/** @param {string} uuid @returns {boolean} whether the click sat us down (or stood us up) */
function onClick(uuid) {
	const data = sitSpotFor(uuid);
	if (!data) return false;
	if (seated?.uuid === uuid) {
		standUp();
		return true;
	}
	const vr = get(isVRMode) && get(editorMode) === 'interact';
	if (!vr && get(isLocked) !== true) return false; // desktop: play mode only (the editor's view is never moved)
	const object = get(objectsGroup)?.getObjectByProperty('uuid', uuid);
	if (!object) return false;
	const pose = seatPose(object, data);
	if (occupied(pose.eye)) {
		showToast('Someone is already sitting there');
		return false;
	}
	if (seated) standUp(false);
	/** @type {any} */
	const cam = get(playerCam);
	const standEye = !vr && cam?.isObject3D ? cam.getWorldPosition(new THREE.Vector3()).toArray() : null;
	seated = { uuid, eye: pose.eye, yaw: pose.yaw, floor: pose.floor, standEye, vr };
	// 'keys' stands PointerLockControls' walk + grounded eye pin down (mouse look stays), 'locomotion' the VR stick
	claimInput('keys');
	claimInput('locomotion');
	if (vr) sitVR(pose);
	else {
		placeEye(pose.eye);
		if (cam?.isObject3D) cam.quaternion.setFromEuler(new THREE.Euler(0, pose.yaw, 0, 'YXZ'));
	}
	return true;
}

/** desktop: put the play camera's eye at a world point @param {number[]} eye */
function placeEye(eye) {
	/** @type {any} */
	const cam = get(playerCam);
	if (!cam?.isObject3D) return;
	v.set(eye[0], eye[1], eye[2]);
	if (cam.parent) {
		cam.parent.updateWorldMatrix(true, false);
		cam.parent.worldToLocal(v);
	}
	cam.position.copy(v);
	cam.updateMatrixWorld(true);
}

/** VR: stand the rig so the HEAD lands at the seated eye @param {{eye: number[]}} pose */
async function sitVR(pose) {
	try {
		const loco = await import('./vr/locomotion.js');
		const viewer = loco.viewerNow();
		const head = viewer?.headHeight ?? 1.6;
		loco.teleportTo([pose.eye[0], pose.eye[1] - head, pose.eye[2]]);
	} catch (error) {
		console.warn('sit (VR):', error);
	}
}

/** stand up: back where you sat down from (desktop), or one step off the seat's front (VR)
 * @param {boolean} [restore] */
export function standUp(restore = true) {
	if (!seated) return;
	const s = seated;
	seated = null;
	releaseInput('keys');
	releaseInput('locomotion');
	if (!restore) return;
	if (s.vr) {
		import('./vr/locomotion.js')
			.then((loco) => {
				// on the floor, a step in front of the seat (the way it faces)
				loco.teleportTo([s.eye[0] - Math.sin(s.yaw) * 0.6, s.floor, s.eye[2] - Math.cos(s.yaw) * 0.6]);
			})
			.catch(() => {});
	} else if (s.standEye) placeEye(s.standEye);
}

/** call each frame (playInteract's tick, and a VR frame): hold the seat, stand on a move */
export function tickSit() {
	if (!seated) return;
	const live = get(objectsGroup)?.getObjectByProperty('uuid', seated.uuid);
	if (!live || !sitSpotFor(seated.uuid)) return standUp(false);
	if (!seated.vr && get(isLocked) !== true) return standUp(false);
	if (seated.vr && !(get(isVRMode) && get(editorMode) === 'interact')) return standUp(false);
	const input = getInput();
	// the MOVE stick only (the right one turns you, which is fine sitting down), and the touch stick
	const stick = Math.hypot(input.axes?.lx ?? 0, input.axes?.ly ?? 0) > 0.6 || Math.hypot(input.touch?.x ?? 0, input.touch?.y ?? 0) > 0.6;
	if ([...input.codes].some((c) => STAND_KEYS.has(c)) || stick) return standUp();
	// the seat may move (a swing, a train): follow it
	seated.eye = seatPose(live, sitSpotFor(seated.uuid)).eye;
	if (!seated.vr) placeEye(seated.eye);
}

/** debug / suites */
export function sitDebug() {
	return seated ? { uuid: seated.uuid, eye: seated.eye, yaw: seated.yaw, vr: seated.vr } : null;
}

registerClickHook(onClick);
// VR: the frame loop holds the seat (desktop play's tick is playInteract's)
registerVRFrameHook(() => {
	if (seated?.vr) tickSit();
});
