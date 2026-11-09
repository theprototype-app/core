// 78 PL32 — A GUEST NO LONGER SPAWNS INSIDE THE HOST'S CAMERA.
//
// Every fresh page opens on the same default camera, and an avatar stands where its person's camera is —
// so the moment a join was approved, the host was looking out from inside the guest's head (desktop,
// unfolded and folded N6 alike; the review's 1b shots). Two halves, both LOCAL (no wire, nothing saved):
//
//   · FADE — any avatar nearer than ~1.4 m to THIS screen's camera fades out (gone inside ~0.6 m). It is
//     the general fix: it also covers Watch (the camera rides the watched avatar) and two people walking
//     into each other in VR. Each avatar's materials are its own, so the fade writes opacity in place
//     and puts the remembered values back when the avatar is clear again; an avatar that never comes
//     near is never touched.
//   · SIDE STEP — a JOINER whose editor camera sits on top of another avatar moves 1.5 m to the side,
//     facing the same way (`sideStepSpot`), once, right after the join. The host never moves.
//
// THREE + stores only (no component, no objectActions — the caller hands in the fly).
import * as THREE from 'three';

/** nearer than `full` an avatar starts to fade; at `hide` it is gone */
export const NEAR_FADE = { hide: 0.6, full: 1.4 };
/** how far a joiner's eye keeps from another avatar's head */
export const JOIN_CLEARANCE = 1.2;
/** the side step: right first, then left, then twice as far */
export const SIDE_STEPS = [1.5, -1.5, 3, -3, 4.5, -4.5];

/** opacity for an avatar at distance `d` from the camera @param {number} d */
export function nearFadeAlpha(d) {
	if (!Number.isFinite(d)) return 1;
	if (d <= NEAR_FADE.hide) return 0;
	if (d >= NEAR_FADE.full) return 1;
	return (d - NEAR_FADE.hide) / (NEAR_FADE.full - NEAR_FADE.hide);
}

/**
 * Where a joiner stands clear of the others: `eye` itself when it already is, else the first of the
 * side steps (along the camera's RIGHT, height kept) clear of every avatar, else `eye`. Pure.
 * @param {number[]} eye [x, y, z] @param {number[]} right a unit vector [x, y, z] (the camera's right)
 * @param {number[][]} others avatar heads [x, y, z] @param {number} [clearance]
 * @returns {number[]}
 */
export function sideStepSpot(eye, right, others, clearance = JOIN_CLEARANCE) {
	const clear = (/** @type {number[]} */ p) => others.every((o) => Math.hypot(o[0] - p[0], o[1] - p[1], o[2] - p[2]) >= clearance);
	if (clear(eye)) return eye;
	// sideways only: the right vector flattened onto the floor
	const len = Math.hypot(right[0], right[2]) || 1;
	const rx = right[0] / len;
	const rz = right[2] / len;
	for (const s of SIDE_STEPS) {
		const p = [eye[0] + rx * s, eye[1], eye[2] + rz * s];
		if (clear(p)) return p;
	}
	return eye;
}

/**
 * Fade one avatar's meshes to `alpha`, IN PLACE: every avatar material is that avatar's own (the rigged
 * body's `makeAvatarMaterial` per instance, the head built per avatar, the classic head's Threlte
 * materials per component) — and a clone would LOSE the body's outfit shader (`Material.copy` does not
 * carry `onBeforeCompile`, and it JSON-copies the uniforms out of `userData`). The first fade remembers
 * what each material started as; alpha 1 puts that back.
 * Skipped: troika text (the name label, a derived material troika rebuilds) and instanced meshes (the
 * dizzy stars share ONE material across every avatar).
 * @param {(THREE.Object3D | null | undefined)[]} roots @param {number} alpha
 */
export function fadeAvatar(roots, alpha) {
	for (const root of roots) {
		if (!root) continue;
		root.traverse((/** @type {any} */ o) => {
			if (!o.isMesh || !o.material || o.isInstancedMesh) return;
			if (o.isTroikaText) return;
			const mats = Array.isArray(o.material) ? o.material : [o.material];
			for (const m of mats) {
				if (m.isDerivedMaterial) continue;
				const base = m.userData.__fadeBase;
				if (alpha >= 1) {
					if (!base) continue;
					m.opacity = base.opacity;
					m.transparent = base.transparent;
					m.depthWrite = base.depthWrite;
					delete m.userData.__fadeBase;
					m.needsUpdate = true;
					continue;
				}
				if (!base) {
					m.userData.__fadeBase = { opacity: m.opacity, transparent: m.transparent, depthWrite: m.depthWrite };
					if (!m.transparent) m.needsUpdate = true;
					m.transparent = true;
					m.depthWrite = false;
				}
				m.opacity = m.userData.__fadeBase.opacity * alpha;
			}
			// a fully faded body leaves the shadow map too
			if (o.userData.__fadeCast === undefined) o.userData.__fadeCast = o.castShadow;
			o.castShadow = alpha > 0.05 ? o.userData.__fadeCast : false;
			if (alpha >= 1) delete o.userData.__fadeCast;
		});
	}
}

/** the distance from a world point to an object's world position @param {THREE.Vector3} at @param {THREE.Object3D} obj */
const tmp = new THREE.Vector3();
export function distanceTo(at, obj) {
	obj.getWorldPosition(tmp);
	return tmp.distanceTo(at);
}
