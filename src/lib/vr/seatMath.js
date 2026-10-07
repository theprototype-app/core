// VR controls — THE SEAT's pure math (37-slipped): sitting down in an object and riding it, as
// reference-space offsets. A LEAF (three only) so vitest drives it with no headset; the runtime
// half is seat.js. Convention (locomotion.js / locomotionPolicy.vrSpawnOffsets): a pose in the
// NEW space is `inverse(offset) * pose in the old one`, so an offset rotating by `a` turns the
// viewer by `-a`, and one translating by `t` moves the viewer by `-t`. Yaw = rotation about +Y,
// forward = -Z (three's camera convention; yawForward(yaw) = (-sin, 0, -cos)).
import * as THREE from 'three';

/** the default eye point, object-local: centred, a little above and behind the middle */
export const DEFAULT_SEAT = [0, 0.8, 0.3];
/**
 * Yaw (rotation about +Y, forward = -Z) of a world quaternion. @param {{x: number, y: number, z: number, w: number}} q
 */
export function yawOfQuaternion(q) {
	const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(new THREE.Quaternion(q.x, q.y, q.z, q.w));
	return Math.atan2(-fwd.x, -fwd.z);
}

/** rotate (x, z) by `yaw` about +Y (three's convention) @param {number} x @param {number} z @param {number} yaw */
function rotY(x, z, yaw) {
	const s = Math.sin(yaw);
	const c = Math.cos(yaw);
	return { x: x * c + z * s, z: -x * s + z * c };
}

/** the turn-in-place offset that turns a viewer at `head` by `delta` radians @param {{x: number, z: number}} head @param {number} delta */
function turnAbout(head, delta) {
	const a = -delta; // an offset rotating by a turns the viewer by -a
	const s = Math.sin(a);
	const c = Math.cos(a);
	return {
		position: { x: head.x - (c * head.x + s * head.z), y: 0, z: head.z - (-s * head.x + c * head.z) },
		orientation: { x: 0, y: Math.sin(a / 2), z: 0, w: Math.cos(a / 2) }
	};
}

/**
 * A world point on the object: its position plus the object-local `local` turned by its yaw.
 * @param {{position: number[], yaw: number}} pose @param {number[]} local
 */
export function seatPoint(pose, local) {
	const r = rotY(local[0], local[2], pose.yaw);
	return { x: pose.position[0] + r.x, y: pose.position[1] + local[1], z: pose.position[2] + r.z };
}

/**
 * SITTING DOWN as two reference-space offsets: turn about the head so it faces the object's
 * yaw, then move the head onto the seat point. Pure (the suites drive it with no headset).
 * @param {{x: number, y: number, z: number}} head @param {number} headYaw
 * @param {{position: number[], yaw: number}} pose the object's world pose @param {number[]} seat object-local
 */
export function seatPlace(head, headYaw, pose, seat) {
	const target = seatPoint(pose, seat);
	return {
		turn: turnAbout(head, pose.yaw - headYaw),
		move: { x: head.x - target.x, y: head.y - target.y, z: head.z - target.z }
	};
}

/**
 * ONE FRAME OF RIDING: the object moved from `prev` to `now`, so the viewer moves with it as if
 * bolted on — turn by the yaw change about the head, then translate the head to where the same
 * object-local point went. Pure. @param {{x: number, y: number, z: number}} head
 * @param {{position: number[], yaw: number}} prev @param {{position: number[], yaw: number}} now
 */
export function seatCarry(head, prev, now) {
	const dyaw = now.yaw - prev.yaw;
	const rel = rotY(head.x - prev.position[0], head.z - prev.position[2], dyaw);
	const target = { x: now.position[0] + rel.x, y: head.y + (now.position[1] - prev.position[1]), z: now.position[2] + rel.z };
	return {
		turn: dyaw ? turnAbout(head, dyaw) : null,
		move: { x: head.x - target.x, y: head.y - target.y, z: head.z - target.z }
	};
}
