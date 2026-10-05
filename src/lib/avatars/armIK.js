// 36-avatars (plan 76.3): two-bone arm IK toward a controller pose, computed per peer from the
// `vrhands` stream (76.4: nothing new on the wire).
//
// Analytic, not iterative: shoulder->elbow->wrist is a triangle with two known sides, so the elbow
// lies on a circle and a POLE hint (down, out and slightly back — where a relaxed elbow hangs) picks
// the point on it. Each bone is then turned by the shortest rotation taking its CURRENT direction to
// the solved one, in world space, and written back in its parent's frame — so the solver does not care
// which local axis the rig's bones point along (KayKit's run along +Y; a different rig would just work).
//
// STRETCH: the stylised characters have short arms (~0.48 m at avatar scale against a real arm's
// ~0.65 m), so a controller held out in front is often out of reach. Rather than lock the elbow and
// leave the hand short, the forearm and hand bones slide along their parent (a translate stretch —
// scaling a bone would shear its rotated children) up to `maxStretch`.

import * as THREE from 'three';

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _t = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _pole = new THREE.Vector3();
const _elbow = new THREE.Vector3();
const _n = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _pq = new THREE.Quaternion();
const _wq = new THREE.Quaternion();

/**
 * Rest lengths + bone translations of an arm chain, taken once from the bind pose.
 * @param {THREE.Object3D} upper @param {THREE.Object3D} lower @param {THREE.Object3D} wrist
 */
export function measureArm(upper, lower, wrist) {
	return { lowerPos: lower.position.clone(), wristPos: wrist.position.clone() };
}

/**
 * Turn `bone` so the world direction from it to `child` becomes `want` (unit), keeping its parent.
 * @param {THREE.Object3D} bone @param {THREE.Object3D} child @param {THREE.Vector3} want
 */
function aimBone(bone, child, want) {
	bone.updateWorldMatrix(true, false);
	child.updateWorldMatrix(false, false);
	bone.getWorldPosition(_a);
	child.getWorldPosition(_b);
	_dir.subVectors(_b, _a);
	if (_dir.lengthSq() < 1e-12) return;
	_dir.normalize();
	_q.setFromUnitVectors(_dir, want);
	bone.getWorldQuaternion(_wq);
	_wq.premultiply(_q);
	// back into the parent's frame
	if (bone.parent) {
		bone.parent.getWorldQuaternion(_pq);
		_wq.premultiply(_pq.invert());
	}
	bone.quaternion.copy(_wq);
	bone.updateWorldMatrix(false, true);
}

/**
 * Solve one arm. `target` is the wrist goal in WORLD space, `pole` a world-space point the elbow
 * bends toward. `weight` 0..1 blends from the animated pose (0) to the solved one (1).
 * @param {{upper: THREE.Object3D, lower: THREE.Object3D, wrist: THREE.Object3D, rest: ReturnType<typeof measureArm>}} arm
 * @param {THREE.Vector3} target @param {THREE.Vector3} pole @param {number} [weight] @param {number} [maxStretch]
 * @returns {{reached: number, stretch: number}} how far the wrist ended from the target (m) + the stretch used
 */
export function solveArm(arm, target, pole, weight = 1, maxStretch = 1.45) {
	const { upper, lower, wrist, rest } = arm;
	lower.position.copy(rest.lowerPos);
	wrist.position.copy(rest.wristPos);
	if (weight <= 0) return { reached: Infinity, stretch: 1 };
	upper.updateWorldMatrix(true, true);
	upper.getWorldPosition(_a);
	// segment lengths in WORLD metres at the rest translations (so the avatar's scale is folded in)
	lower.getWorldPosition(_b);
	wrist.getWorldPosition(_c);
	const a = _a.distanceTo(_b);
	const b = _b.distanceTo(_c);
	_t.copy(target);
	let d = _t.distanceTo(_a);
	// the stretch needed to reach, applied to both segments
	const stretch = Math.min(maxStretch, Math.max(1, d / ((a + b) * 0.999)));
	const sa = a * stretch;
	const sb = b * stretch;
	if (stretch > 1) {
		lower.position.copy(rest.lowerPos).multiplyScalar(stretch);
		wrist.position.copy(rest.wristPos).multiplyScalar(stretch);
		upper.updateWorldMatrix(false, true);
	}
	// clamp into the reachable shell
	const minD = Math.abs(sa - sb) + 1e-4;
	const maxD = (sa + sb) * 0.999;
	_dir.subVectors(_t, _a);
	if (_dir.lengthSq() < 1e-10) _dir.set(0, -1, 0);
	d = Math.max(minD, Math.min(maxD, _dir.length()));
	_dir.normalize();
	_t.copy(_a).addScaledVector(_dir, d);
	// elbow: distance along the shoulder->target line, then out toward the pole
	const along = (sa * sa - sb * sb + d * d) / (2 * d);
	const out = Math.sqrt(Math.max(0, sa * sa - along * along));
	_pole.subVectors(pole, _a);
	_n.copy(_dir).multiplyScalar(_pole.dot(_dir));
	_pole.sub(_n); // the pole's component perpendicular to the reach line
	if (_pole.lengthSq() < 1e-10) {
		// pole on the reach line: hang the elbow down (or sideways when reaching straight down)
		_pole.set(0, -1, 0).addScaledVector(_dir, _dir.y);
		if (_pole.lengthSq() < 1e-10) _pole.set(1, 0, 0);
	}
	_pole.normalize();
	_elbow.copy(_a).addScaledVector(_dir, along).addScaledVector(_pole, out);

	// blend against the animated pose: aim at a point between where the clip put each joint and the solve
	if (weight < 1) {
		lower.getWorldPosition(_b);
		_elbow.lerpVectors(_b, _elbow, weight);
		wrist.getWorldPosition(_c);
		_t.lerpVectors(_c, _t, weight);
	}
	aimBone(upper, lower, _c.subVectors(_elbow, _a).normalize());
	lower.getWorldPosition(_b);
	aimBone(lower, wrist, _c.subVectors(_t, _b).normalize());
	wrist.getWorldPosition(_c);
	return { reached: _c.distanceTo(target), stretch };
}

/**
 * Point the wrist (and the hand below it) the way the controller points. `offset` maps the
 * controller's frame to the bone's — a rig constant measured once at load.
 * @param {THREE.Object3D} wrist @param {THREE.Quaternion} worldQuat @param {THREE.Quaternion} offset @param {number} [weight]
 */
export function orientWrist(wrist, worldQuat, offset, weight = 1) {
	if (weight <= 0) return;
	_wq.copy(worldQuat).multiply(offset);
	if (wrist.parent) {
		wrist.parent.getWorldQuaternion(_pq);
		_wq.premultiply(_pq.invert());
	}
	wrist.quaternion.slerp(_wq, Math.min(1, weight));
	wrist.updateWorldMatrix(false, true);
}
