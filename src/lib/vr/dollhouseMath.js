// VR controls — the DOLLHOUSE's maths (37 R10), a leaf: THREE only, so the suites can drive it with no app.
// The dollhouse is the world rig itself, shrunk onto a table in front of you: the whole scene becomes a
// model you look down on, point into and land in. Nothing is cloned (no extra draw calls on a Quest), and
// the rig is local, so peers see nothing.
import * as THREE from 'three';

/** the model's longest side in metres (arm's-length, fits the view at 0.6 m) */
export const DOLLHOUSE_SIZE = 0.9;
/** the smallest scene a dollhouse frames (m) — a lone cube still reads as a room */
export const DOLLHOUSE_MIN_EXTENT = 4;
export const DOLLHOUSE_MIN_SCALE = 0.002;
export const DOLLHOUSE_MAX_SCALE = 0.25;
/** where the model's floor sits: this far ahead of the head and this far below the eyes */
export const DOLLHOUSE_AHEAD = 0.6;
export const DOLLHOUSE_DROP = 0.5;
/** how far past the content a pointed floor still counts (content metres) */
export const DOLLHOUSE_FLOOR_MARGIN = 2;

/**
 * Where the rig goes for the dollhouse. Pure.
 * @param {{min: number[], max: number[]}} box the content bounds (content frame)
 * @param {number[]} head the head, world
 * @param {number} yaw the head's heading (three's rotation.y: forward = (-sin, 0, -cos))
 * @param {number[]} quat the rig's orientation, kept (the model is aligned with the world you see)
 * @returns {{pos: number[], quat: number[], scale: number, anchor: number[]}}
 */
export function dollhouseLayout(box, head, yaw, quat) {
	const dx = box.max[0] - box.min[0];
	const dz = box.max[2] - box.min[2];
	const extent = Math.max(dx, dz, DOLLHOUSE_MIN_EXTENT);
	const scale = THREE.MathUtils.clamp(DOLLHOUSE_SIZE / extent, DOLLHOUSE_MIN_SCALE, DOLLHOUSE_MAX_SCALE);
	const anchor = new THREE.Vector3(
		head[0] - Math.sin(yaw) * DOLLHOUSE_AHEAD,
		head[1] - DOLLHOUSE_DROP,
		head[2] - Math.cos(yaw) * DOLLHOUSE_AHEAD
	);
	// the content's floor centre lands on the anchor: pos = anchor - R·(s·c)
	const c = new THREE.Vector3((box.min[0] + box.max[0]) / 2, box.min[1], (box.min[2] + box.max[2]) / 2);
	const q = new THREE.Quaternion().fromArray(quat);
	const pos = anchor.clone().sub(c.multiplyScalar(scale).applyQuaternion(q));
	return { pos: pos.toArray(), quat: q.toArray(), scale, anchor: anchor.toArray() };
}

/** a content point through a rig transform -> world @param {number[]} p @param {{pos: number[], quat: number[], scale: number}} rig */
export function contentToWorld(p, rig) {
	return new THREE.Vector3()
		.fromArray(p)
		.multiplyScalar(rig.scale)
		.applyQuaternion(new THREE.Quaternion().fromArray(rig.quat))
		.add(new THREE.Vector3().fromArray(rig.pos))
		.toArray();
}

/**
 * A world ray onto the content floor (y = floorY in the content frame) through a rig. Pure.
 * @param {number[]} origin @param {number[]} dir world ray
 * @param {{pos: number[], quat: number[], scale: number}} rig
 * @param {number} floorY
 * @returns {number[] | null} the content point, or null when the ray never comes down to it
 */
export function rayToContentFloor(origin, dir, rig, floorY) {
	const inv = new THREE.Quaternion().fromArray(rig.quat).invert();
	const o = new THREE.Vector3().fromArray(origin).sub(new THREE.Vector3().fromArray(rig.pos)).applyQuaternion(inv).divideScalar(rig.scale);
	const d = new THREE.Vector3().fromArray(dir).applyQuaternion(inv).normalize();
	if (d.y > -1e-4) return null; // level or rising: it never reaches the floor
	const t = (floorY - o.y) / d.y;
	if (t < 0) return null;
	return o.addScaledVector(d, t).toArray();
}
