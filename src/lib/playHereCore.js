// 60 Q1: THE PLAY HERE RULE — three only, no stores, so the unit layer runs it (playHere.js is the
// store-reading half; playSpawn re-exports the two pure functions).
import * as THREE from 'three';

/**
 * Where Play here puts the player: the feet on the first solid surface straight under the eye,
 * facing the view's heading; nothing under it → the scene's own spawn (with its own facing); no
 * spawn either → the eye stays exactly where the camera is (feet = eye − eyeHeight), which is where
 * a flying player would start anyway.
 * @param {{eye: number[], yaw: number}} view the editor camera: eye + heading (rotation.y, 0 faces −Z)
 * @param {(eye: number[]) => number | null} surfaceBelow y of the first solid surface under `eye`, or null
 * @param {{position: number[], yaw: number} | null} fallback the scene's spawn
 * @param {number} eyeHeight how far above the feet the eye stands (SPAWN_EYE on a screen, the head height in VR)
 * @returns {{position: [number, number, number], yaw: number, source: 'surface' | 'spawn' | 'camera'}}
 */
export function playHereSpawnFrom(view, surfaceBelow, fallback, eyeHeight) {
	const [x, y, z] = view.eye;
	const yaw = Number.isFinite(view.yaw) ? view.yaw : 0;
	const floor = surfaceBelow(view.eye);
	if (floor != null && Number.isFinite(floor) && floor <= y) return { position: [x, floor, z], yaw, source: 'surface' };
	if (fallback) {
		const [fx, fy, fz] = fallback.position;
		return { position: [fx, fy, fz], yaw: Number.isFinite(fallback.yaw) ? fallback.yaw : 0, source: 'spawn' };
	}
	return { position: [x, y - eyeHeight, z], yaw, source: 'camera' };
}

/** the heading of an orientation — rotation.y in YXZ order, which stays right when the view looks
 * straight down (a forward vector has no horizontal part there) @param {any} quaternion */
export function headingOf(quaternion) {
	return new THREE.Euler().setFromQuaternion(quaternion, 'YXZ').y;
}

/** something a player cannot stand on: hidden (itself or an ancestor), a sensor, water, a reference image
 * @param {any} object @param {any} [root] where the walk stops */
export function notGround(object, root = null) {
	for (let node = object; node && node !== root; node = node.parent) {
		if (node.visible === false) return true;
		const data = node.userData ?? {};
		if (data.water || data.physics?.sensor || data.underlay) return true;
	}
	return false;
}

/**
 * The y of the first SOLID surface straight under `eye`: the meshes under `root` and the physics
 * ground plane when it is on and below the eye. null = nothing below.
 * @param {any} root the scene objects group (or null)
 * @param {number[]} eye
 * @param {{enabled?: boolean, height?: number} | null} [ground]
 * @returns {number | null}
 */
export function surfaceBelowIn(root, eye, ground = null) {
	let best = /** @type {number | null} */ (null);
	if (root?.children?.length) {
		root.updateMatrixWorld(true);
		const ray = new THREE.Raycaster(new THREE.Vector3(eye[0], eye[1], eye[2]), new THREE.Vector3(0, -1, 0));
		for (const hit of ray.intersectObjects(root.children, true)) {
			const object = /** @type {any} */ (hit.object);
			if (!object?.isMesh || notGround(object, root)) continue;
			best = hit.point.y;
			break;
		}
	}
	const h = Number(ground?.height);
	if (ground?.enabled && Number.isFinite(h) && h <= eye[1] && (best == null || h > best)) best = h;
	return best;
}
