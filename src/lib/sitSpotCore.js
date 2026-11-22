// @ts-ignore - no bundled three type declarations (project-wide)
import * as THREE from 'three';

// 85 I3 — SIT SPOT, the pure-ish half (three only): where a seat puts your eyes and which way it
// faces you. sitSpot.js does the sitting.

const box = new THREE.Box3();
const FACINGS = /** @type {Record<string, number>} */ ({ '+z': 0, '-z': Math.PI, '+x': Math.PI / 2, '-x': -Math.PI / 2 });

/** @param {any} x @param {number} f @param {number} lo @param {number} hi */
export const num = (x, f, lo, hi) => {
	const n = Number(x);
	return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : f;
};

/**
 * Where a seat puts your eyes (world) and which way it faces: the top of its bounds, centred
 * (plus the node's offset along the seat's front), `eyeHeight` above it; the yaw is the seat's own
 * world yaw turned to its `facing` side (three's convention: yaw 0 looks down -Z, so a seat whose
 * front is +z faces you away from -Z by PI).
 * @param {any} object @param {any} data @returns {{eye: number[], yaw: number, floor: number}}
 */
export function seatPose(object, data) {
	object.updateWorldMatrix(true, true);
	box.setFromObject(object);
	const centre = box.getCenter(new THREE.Vector3());
	const q = object.getWorldQuaternion(new THREE.Quaternion());
	const e = new THREE.Euler().setFromQuaternion(q, 'YXZ');
	const face = FACINGS[data?.facing] ?? 0;
	// the seat's front in the world: its local facing axis, flattened
	const front = new THREE.Vector3(Math.sin(face), 0, Math.cos(face)).applyAxisAngle(new THREE.Vector3(0, 1, 0), e.y);
	const forward = num(data?.forward, 0, -2, 2);
	const eye = [centre.x + front.x * forward, box.max.y + num(data?.eyeHeight, 0.7, 0, 3), centre.z + front.z * forward];
	// the view LOOKS along the front: yaw such that (-sin yaw, -cos yaw) = front
	const yaw = Math.atan2(-front.x, -front.z);
	return { eye, yaw, floor: box.min.y };
}

