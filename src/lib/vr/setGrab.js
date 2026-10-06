import * as THREE from 'three';

// 37 R1 — GRIPPING A SELECTION IN VR moves the whole set, about the pivot point.
//
// Until now a grip took ONE object and `selectObject` collapsed the selection to it, so a
// box-selected set could only be duplicated, grouped or deleted in the headset, never moved,
// and the desktop's pivot modes (multiTransform.pivotMode) meant nothing there. A grip on a
// MEMBER of a selection of two or more now carries every member:
//   * the hand's TRANSLATION moves the whole set 1:1 (world space, so a grabbed world rig
//     still follows the hand visually);
//   * a wrist TWIST turns the set about the pivot, and the stick's X scales it about the
//     pivot — Median = the set's centre, Active = the object you gripped, Parent = the
//     shared parent's origin, Individual = every object turns and scales in place.
// The maths is the desktop pivot's: one world delta T(c+Δ)·R·S·T(−c) per member, then the
// member's start world matrix, then back into its parent's frame. Pure (THREE only) so the
// headless suites can drive it without a headset.

const _t1 = new THREE.Matrix4();
const _r = new THREE.Matrix4();
const _s = new THREE.Matrix4();
const _t2 = new THREE.Matrix4();

/**
 * The world-space delta for one pivot: translate by the hand, turn by the wrist, scale by
 * the stick — all about `pivot`.
 * @param {THREE.Vector3} pivot world point the set turns/scales about (at grab start)
 * @param {THREE.Vector3} move the hand's world translation since grab start
 * @param {THREE.Quaternion} turn the hand's world rotation since grab start
 * @param {number} scale uniform factor since grab start
 * @param {THREE.Matrix4} [out]
 */
export function setGrabDelta(pivot, move, turn, scale, out = new THREE.Matrix4()) {
	_t1.makeTranslation(pivot.x + move.x, pivot.y + move.y, pivot.z + move.z);
	_r.makeRotationFromQuaternion(turn);
	_s.makeScale(scale, scale, scale);
	_t2.makeTranslation(-pivot.x, -pivot.y, -pivot.z);
	return out.copy(_t1).multiply(_r).multiply(_s).multiply(_t2);
}

/**
 * Where the set turns about, by mode. `members[i].origin` is each member's own world origin
 * at grab start; `gripped` is the member the hand closed on.
 * @param {'median'|'active'|'parent'|'individual'} mode
 * @param {{origin: THREE.Vector3, worldPos: THREE.Vector3}[]} members
 * @param {number} gripped index into members
 * @param {THREE.Vector3 | null} parentOrigin the common parent's world origin, if any
 * @returns {THREE.Vector3 | null} null = Individual (each member uses its own origin)
 */
export function setGrabPivot(mode, members, gripped, parentOrigin) {
	if (mode === 'individual') return null;
	if (mode === 'active' && members[gripped]) return members[gripped].origin.clone();
	if (mode === 'parent' && parentOrigin) return parentOrigin.clone();
	const c = new THREE.Vector3();
	for (const m of members) c.add(m.worldPos);
	return members.length ? c.divideScalar(members.length) : c;
}

const _delta = new THREE.Matrix4();
const _world = new THREE.Matrix4();
const _inv = new THREE.Matrix4();

/**
 * Pose every member for this frame. Each member: `{object, startWorld: Matrix4, origin}`.
 * Writes position/quaternion/scale in the member's PARENT frame.
 * @param {{object: any, startWorld: THREE.Matrix4, origin: THREE.Vector3}[]} members
 * @param {THREE.Vector3 | null} pivot null = Individual
 * @param {THREE.Vector3} move @param {THREE.Quaternion} turn @param {number} scale
 */
export function poseSetGrab(members, pivot, move, turn, scale) {
	for (const m of members) {
		setGrabDelta(pivot ?? m.origin, move, turn, scale, _delta);
		_world.multiplyMatrices(_delta, m.startWorld);
		m.object.parent.updateMatrixWorld(true);
		_inv.copy(m.object.parent.matrixWorld).invert();
		_world.premultiply(_inv);
		_world.decompose(m.object.position, m.object.quaternion, m.object.scale);
	}
}
