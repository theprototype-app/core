// 60 Q5: where a new reference image goes, from the editor view — the one piece of underlay code
// that needs THREE and the camera (underlays.js stays a store/wire leaf).
//  · 'ground': lying flat on the physics ground plane under the point the view orbits around, its
//    top edge pointing away from you, about as wide as that point is far (it fills the view);
//  · 'view': standing at the orbit point, facing the camera square-on (the camera's own
//    orientation), 80 % of the view's width there — Blender's "Reference" image.
// Both are FIXED in the world once placed; "Face the view" re-poses a 'view' one.
import * as THREE from 'three';
import { get } from 'svelte/store';
import { editorCam, orbitControls } from '../stores/sceneStore';
import { scenePhysicsGround } from './scenePhysics';
import { headingOf } from './playHereCore';

/** a ground underlay floats this far over the ground plane (no z-fight with the grid or a floor) */
export const GROUND_LIFT = 0.004;

/**
 * @param {'ground' | 'view'} mode
 * @returns {{mode: 'ground' | 'view', position: number[], quaternion: number[], width: number} | null}
 */
export function underlayPoseFromView(mode) {
	/** @type {any} */
	const cam = get(editorCam);
	if (!cam?.isObject3D) return null;
	/** @type {any} */
	const controls = get(orbitControls);
	cam.updateMatrixWorld(true);
	const eye = cam.getWorldPosition(new THREE.Vector3());
	const q = cam.getWorldQuaternion(new THREE.Quaternion());
	const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
	const target = controls?.target ? controls.target.clone() : eye.clone().addScaledVector(forward, 10);
	const distance = THREE.MathUtils.clamp(eye.distanceTo(target), 1, 500);
	if (mode === 'view') {
		const position = eye.clone().addScaledVector(forward, distance);
		const fov = THREE.MathUtils.degToRad(Number(cam.fov) || 40);
		const aspect = Number(cam.aspect) || 1.6;
		const width = 2 * distance * Math.tan(fov / 2) * Math.min(aspect, 2) * 0.8;
		return { mode, position: position.toArray(), quaternion: q.toArray(), width: THREE.MathUtils.clamp(width, 0.1, 1000) };
	}
	const ground = get(scenePhysicsGround);
	const y = (ground?.enabled && Number.isFinite(ground.height) ? ground.height : 0) + GROUND_LIFT;
	// flat (−90° about X), its "up" turned to the view's heading
	const flat = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, headingOf(q), 0, 'YXZ'));
	return { mode: 'ground', position: [target.x, y, target.z], quaternion: flat.toArray(), width: THREE.MathUtils.clamp(distance, 1, 1000) };
}
