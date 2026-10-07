// VR controls — THE SEAT (37-slipped, plan 21-C "Race touch + VR"): ride an object in VR.
//
// A desktop driver gets the chase camera (possess.js startFollowCam), which moves the editor
// camera — meaningless in a headset, so entering VR stops it. In VR the player is put IN the
// object instead: the head lands on a seat point (object-local), facing the object's forward,
// and from then on the WHOLE tracking space is carried rigidly with the object, frame by frame.
//
// Carried, never pinned. Pinning the head to the seat every frame would cancel the player's own
// head motion (lean to look past the bonnet and nothing moves = instant nausea). Carrying the
// space means the object's motion is the only artificial motion; the head still tracks.
// Yaw + translation only: the object's pitch and roll never tilt the horizon (a car on a bump
// would roll the world otherwise; the race cars have both frozen anyway).
//
// The rig moves the WebXR way (the convention across locomotion.js): offset the reference
// space. A pose in the NEW space is `inverse(offset) * pose in the old one`, so an offset that
// rotates by `a` turns the viewer by `-a`, and one translating by `t` moves the viewer by `-t`.
// While seated the seat claims the 'sticks' input scope, so stick walking, snap/smooth turn and
// teleport all stand down (VRControls.svelte + vrNavigationSuppressed) — the module that seated
// the player still reads the sticks through api.input() (that is how a car is driven).
import * as THREE from 'three';
import { get } from 'svelte/store';
import { objectsGroup } from '../../stores/sceneStore';
import { claimInput, releaseInput } from '../inputRuntime';
import { renderer } from './core.js';
import { registerVRFrameHook } from './hooks.js';
import { viewerNow } from './locomotion.js';
import { DEFAULT_SEAT, yawOfQuaternion, seatPoint, seatPlace, seatCarry } from './seatMath.js';

/** where an unseated player stands, object-local (the driver's door side) */
const STEP_OUT = [-2.2, 0, 0];

/** @param {{x: number, y: number, z: number}} offset @param {{x: number, y: number, z: number, w: number}} [orientation] */
function offsetSpace(offset, orientation) {
	const space = renderer?.xr?.getReferenceSpace?.();
	if (!space || typeof XRRigidTransform === 'undefined') return false;
	renderer.xr.setReferenceSpace(
		space.getOffsetReferenceSpace(orientation ? new XRRigidTransform(offset, orientation) : new XRRigidTransform(offset))
	);
	return true;
}

/** @param {string} uuid */
function objectOf(uuid) {
	return get(objectsGroup)?.getObjectByProperty('uuid', uuid) ?? null;
}
/** @param {any} object @returns {{position: number[], yaw: number}} */
function poseOf(object) {
	object.updateMatrixWorld?.(true);
	const p = object.getWorldPosition(new THREE.Vector3());
	const q = object.getWorldQuaternion(new THREE.Quaternion());
	return { position: [p.x, p.y, p.z], yaw: yawOfQuaternion(q) };
}

/** @type {null | {uuid: string, seat: number[], last: {position: number[], yaw: number} | null, off: () => void}} */
let seat = null;

/** the frame hook while seated: sit down on the first frame with a viewer pose, then carry */
function tick() {
	if (!seat) return;
	if (!renderer?.xr?.getSession?.()) return; // not presenting: wait (the request survives a session start)
	const object = objectOf(seat.uuid);
	if (!object) {
		unseatViewer(false); // deleted out from under us
		return;
	}
	const viewer = viewerNow();
	if (!viewer) return;
	const now = poseOf(object);
	if (!seat.last) {
		const { turn, move } = seatPlace(viewer.head, viewer.yaw, now, seat.seat);
		offsetSpace(turn.position, turn.orientation);
		offsetSpace(move);
	} else {
		const { turn, move } = seatCarry(viewer.head, seat.last, now);
		if (turn) offsetSpace(turn.position, turn.orientation);
		if (move.x || move.y || move.z) offsetSpace(move);
	}
	seat.last = now;
}

/**
 * Seat the VR viewer in an object (api.vrSeat). Re-seating the same object keeps the ride;
 * another object moves the seat. Outside a session the request waits for one.
 * @param {string} uuid @param {{seat?: number[]}} [opts] `seat` = the eye point, object-local
 * @returns {boolean} whether the object exists
 */
export function seatViewer(uuid, opts = {}) {
	if (!objectOf(uuid)) return false;
	const local = Array.isArray(opts.seat) && opts.seat.length === 3 && opts.seat.every((n) => Number.isFinite(Number(n)))
		? opts.seat.map(Number)
		: DEFAULT_SEAT;
	if (seat?.uuid === uuid) {
		seat.seat = local;
		return true;
	}
	if (seat) unseatViewer(false);
	claimInput('sticks');
	const off = registerVRFrameHook(tick);
	seat = { uuid, seat: local, last: null, off };
	return true;
}

/**
 * Get up (api.vrUnseat). By default the player steps out beside the object, feet on its
 * floor, facing its way — never left hovering at seat height inside a car.
 * @param {boolean} [stepOut]
 */
export function unseatViewer(stepOut = true) {
	if (!seat) return;
	const was = seat;
	seat = null;
	was.off();
	releaseInput('sticks');
	if (!stepOut || !was.last || !renderer?.xr?.getSession?.()) return;
	const object = objectOf(was.uuid);
	const viewer = viewerNow();
	if (!object || !viewer) return;
	// beside the door, the head headHeight above the object's origin level less a little (a car's
	// origin rides above its wheels); Interact's walk gravity settles the feet from there
	const { turn, move } = seatPlace(viewer.head, viewer.yaw, poseOf(object), [STEP_OUT[0], viewer.headHeight - 0.3, STEP_OUT[2]]);
	offsetSpace(turn.position, turn.orientation);
	offsetSpace(move);
}

/** the seated object's uuid, or null @returns {string | null} */
export function seatedOn() {
	return seat?.uuid ?? null;
}

/** suites: the live seat state */
export function seatDebug() {
	return seat ? { uuid: seat.uuid, seat: [...seat.seat], last: seat.last } : null;
}
