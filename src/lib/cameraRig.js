// 37 (R8): the Camera Rig node — a scene CAMERA OBJECT follows and/or looks at a target, with
// damping and an offset. A leaf (three only), so the maths is unit-tested with no scene.
//
// The rules that make it safe:
// · It moves the camera MARKER (an object carrying `userData.camera`, -Z forward, the 16-P5
//   convention). It never touches the editor camera, and it never moves a peer's view. Like every
//   flow effect, each peer computes the pose LOCALLY from the replicated graph, the target's
//   replicated pose and its own clock, so nothing is sent. Looking through the camera
//   (Set Active Camera, the camera preview) is what turns that into a view, and that choice is
//   each peer's own.
// · The flow runtime only calls it for objects in the replicated objects group, and the glue
//   refuses anything that is not a camera marker.
// · Damping is a TIME CONSTANT (seconds): alpha = 1 - exp(-dt / tau), so the lag is the same at
//   30 and 120 fps. 0 = rigid.

import * as THREE from 'three';

export const RIG_MODES = Object.freeze(['both', 'follow', 'lookat']);
export const RIG_SPACES = Object.freeze(['world', 'target']);

const _m = new THREE.Matrix4();
const _up = new THREE.Vector3(0, 1, 0);
const _aim = new THREE.Vector3();
const _q = new THREE.Quaternion();

/**
 * The pose the rig is heading for this frame (no smoothing).
 * @param {{pos: THREE.Vector3, quat: THREE.Quaternion}} cam the camera's CURRENT world pose
 * @param {{pos: THREE.Vector3, quat?: THREE.Quaternion}} target the target's world pose
 * @param {{mode?: string, space?: string, offset?: number[], aim?: number}} opts
 * @returns {{pos: THREE.Vector3, quat: THREE.Quaternion}}
 */
export function rigGoal(cam, target, opts) {
	const mode = RIG_MODES.includes(opts.mode ?? '') ? opts.mode : 'both';
	const off = new THREE.Vector3().fromArray(validVec(opts.offset) ?? [0, 2, 5]);
	if (opts.space === 'target' && target.quat) off.applyQuaternion(target.quat);
	const pos = mode === 'lookat' ? cam.pos.clone() : target.pos.clone().add(off);
	let quat = cam.quat.clone();
	if (mode !== 'follow') {
		_aim.copy(target.pos);
		_aim.y += Number.isFinite(opts.aim) ? Number(opts.aim) : 0;
		// Matrix4.lookAt builds +Z from the target to the eye, so -Z (the camera's forward) aims at
		// the target: the camera convention, which a marker shares
		if (pos.distanceToSquared(_aim) > 1e-10) quat = new THREE.Quaternion().setFromRotationMatrix(_m.lookAt(pos, _aim, _up));
	}
	return { pos, quat };
}

/**
 * One smoothed step from `cam` toward `goal`. @param {{pos: THREE.Vector3, quat: THREE.Quaternion}} cam
 * @param {{pos: THREE.Vector3, quat: THREE.Quaternion}} goal @param {number} damping seconds (0 = rigid)
 * @param {number} dt seconds since the last step (clamped to 0..0.25)
 * @returns {{pos: THREE.Vector3, quat: THREE.Quaternion}}
 */
export function rigStep(cam, goal, damping, dt) {
	const tau = Number.isFinite(damping) ? Math.max(0, damping) : 0;
	const step = Math.min(Math.max(Number.isFinite(dt) ? dt : 0, 0), 0.25);
	const alpha = tau <= 0 ? 1 : 1 - Math.exp(-step / tau);
	return {
		pos: cam.pos.clone().lerp(goal.pos, alpha),
		quat: _q.copy(cam.quat).slerp(goal.quat, alpha).clone()
	};
}

/** A finite [x, y, z], or null. @param {any} v @returns {number[] | null} */
export function validVec(v) {
	return Array.isArray(v) && v.length >= 3 && v.slice(0, 3).every((n) => Number.isFinite(+n)) ? v.slice(0, 3).map(Number) : null;
}
