// 30b P4: THE DESKTOP HALF OF A SPAWN — a LEAF (THREE + svelte/store + sceneStore +
// playSettings), so PointerLockControls, objectActions and moduleSDK can all reach it
// without closing a cycle. The VR half lives in vrControls.spawnPlayer (it moves the XR
// reference space, which only vrControls holds).
//
// A spawn is `{position: [x, y, z], yaw}` — y is the FEET, yaw is three's rotation.y (0 faces
// -Z) — resolved by playSettings.resolvePlaySettings: a module's runtime api.setSpawn, else
// a publisher's userData.play.spawn, else the scene's play.spawn.
import * as THREE from 'three';
import { get } from 'svelte/store';
import { playerCam } from '../stores/sceneStore';
import { resolvePlaySettings } from './playSettings';
import { globalScene } from '../stores/sceneStore';

/** the play camera's eye above the feet: the walker's 1.7 m person */
export const SPAWN_EYE = 1.7;

/** the spawn in force right now, or null @returns {{position: [number, number, number], yaw: number} | null} */
export function currentSpawn() {
	return resolvePlaySettings(get(globalScene)).spawn;
}

/**
 * Where an EYE stands on a spawn, and a point straight ahead of it at eye height (what
 * flyTo and lookAt want). Pure. @param {{position: number[], yaw: number}} spawn
 */
export function spawnEyePose(spawn) {
	const [x, y, z] = spawn.position;
	const eye = [x, y + SPAWN_EYE, z];
	const lookAt = [x - Math.sin(spawn.yaw) * 2, y + SPAWN_EYE, z - Math.cos(spawn.yaw) * 2];
	return { eye, lookAt };
}

/**
 * Put desktop Play's camera on the spawn: eye at feet + SPAWN_EYE, facing its yaw, level.
 * PointerLockControls derives yaw/pitch from the camera's quaternion every look, so writing
 * the quaternion is the whole of "face this way".
 * @param {{position: number[], yaw: number} | null} [spawn] defaults to the one in force
 * @returns {boolean} whether the camera moved
 */
export function spawnDesktopPlayer(spawn = currentSpawn()) {
	/** @type {any} */
	const cam = get(playerCam);
	if (!spawn || !cam?.isObject3D) return false;
	const { eye } = spawnEyePose(spawn);
	const target = new THREE.Vector3(eye[0], eye[1], eye[2]);
	if (cam.parent) {
		cam.parent.updateWorldMatrix(true, false);
		cam.parent.worldToLocal(target);
	}
	cam.position.copy(target);
	cam.quaternion.setFromEuler(new THREE.Euler(0, spawn.yaw, 0, 'YXZ'));
	cam.updateMatrixWorld(true);
	return true;
}
