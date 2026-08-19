import * as THREE from 'three';

// 21-B B2: the release-velocity estimator, in ONE place.
//
// Three callers need it — the initiator's own gizmo/play release, the play-mode
// interact release, and B5's receive side for a peer's `throw` — and it imports
// THREE and nothing else, so none of them closes a cycle.
//
// It exists because the old inline version had two real bugs:
//
//  1. it finite-differenced RAW EULER COMPONENTS (`b.rot.x - a.rot.x`). Across a
//     wrap that is a ~2*PI jump, and even without one the Euler derivative is
//     simply not the angular velocity vector — YXZ order couples the axes, so a
//     ring spinning cleanly about +Y reported a large NEGATIVE spin. The right
//     quantity is the quaternion delta: q_rel = q_new * q_old^-1, negated when
//     w < 0 (the shortest arc), then axis * angle / dt.
//
//  2. the clamps were PER COMPONENT, which rotates the direction whenever one
//     axis saturates: a 30 m/s diagonal throw came out as a differently-aimed
//     20 m/s one, so how hard you threw stopped agreeing with where it went.
//     The clamp is on the MAGNITUDE, which is direction-preserving by
//     construction.

/** m/s ceiling on a release estimate (not a solver clamp — see the B4 table) */
export const MAX_LINVEL = 20;
/** rad/s ceiling on a release estimate */
export const MAX_ANGVEL = 20;

/** Samples closer together than this are treated as this far apart, so a
 * double-sampled frame cannot divide by ~0 and fling the body. */
const MIN_DT = 1e-3;

const relQuat = new THREE.Quaternion();
const invOld = new THREE.Quaternion();

/** Accept a Vector3, a plain [x,y,z], or {x,y,z}. @param {any} v */
function toVec(v) {
	if (!v) return new THREE.Vector3();
	if (Array.isArray(v)) return new THREE.Vector3(v[0] ?? 0, v[1] ?? 0, v[2] ?? 0);
	return new THREE.Vector3(v.x ?? 0, v.y ?? 0, v.z ?? 0);
}

/** Scale to `max` if longer, keeping the DIRECTION. @param {THREE.Vector3} v @param {number} max */
function clampMagnitude(v, max) {
	const length = v.length();
	if (!Number.isFinite(length)) return v.set(0, 0, 0);
	if (length > max && length > 0) v.multiplyScalar(max / length);
	return v;
}

/**
 * The ONE place the release clamps live — local throws and a peer's `throw`
 * message both end here, which is what makes the receive-side validation free.
 * @param {any} linvel @param {any} angvel
 * @returns {{linvel: THREE.Vector3, angvel: THREE.Vector3}}
 */
export function clampThrow(linvel, angvel) {
	return {
		linvel: clampMagnitude(toVec(linvel), MAX_LINVEL),
		angvel: clampMagnitude(toVec(angvel), MAX_ANGVEL)
	};
}

/**
 * Estimate the velocity a held body should be released with, from a short ring
 * of recent poses. Returns clamped values — every caller wants them clamped and
 * a second opinion about the ceiling is exactly the bug this replaced.
 * @param {{t: number, pos: THREE.Vector3, quat: THREE.Quaternion}[]} samples oldest first
 * @param {{minDt?: number}} [opts]
 * @returns {{linvel: THREE.Vector3, angvel: THREE.Vector3}}
 */
export function velocityFromSamples(samples, opts = {}) {
	if (!Array.isArray(samples) || samples.length < 2) return clampThrow(null, null);
	const a = samples[0];
	const b = samples[samples.length - 1];
	if (!a?.pos || !b?.pos) return clampThrow(null, null);
	const dt = Math.max((b.t - a.t) / 1000, opts.minDt ?? MIN_DT);

	const linvel = new THREE.Vector3().subVectors(b.pos, a.pos).divideScalar(dt);

	const angvel = new THREE.Vector3();
	if (a.quat && b.quat) {
		invOld.copy(a.quat).invert();
		relQuat.copy(b.quat).multiply(invOld);
		// shortest arc: q and -q are the same rotation, but only one of them
		// describes it as a turn of less than half a revolution
		if (relQuat.w < 0) {
			relQuat.x = -relQuat.x;
			relQuat.y = -relQuat.y;
			relQuat.z = -relQuat.z;
			relQuat.w = -relQuat.w;
		}
		const half = Math.acos(Math.max(-1, Math.min(1, relQuat.w)));
		const sinHalf = Math.sin(half);
		// below this the axis is numerical noise and the angle is ~0 anyway
		if (sinHalf > 1e-6) {
			angvel
				.set(relQuat.x, relQuat.y, relQuat.z)
				.divideScalar(sinHalf)
				.multiplyScalar((2 * half) / dt);
		}
	}
	return clampThrow(linvel, angvel);
}
