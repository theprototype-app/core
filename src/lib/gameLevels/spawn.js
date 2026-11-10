// 93 LP1 / LP3 — WHERE A PLAYER LANDS: a named spawn object (a Checkpoint, a Portal, or any marker an author
// names in the Levels table) becomes a spawn `{position (feet), yaw}` facing the object's ARROW (its local -Z,
// three's yaw-0 forward), and the player is put there — VR moves the rig, desktop Play the play camera.
// A landing is THIS player's runtime spawn (playSettings.setRuntimeSpawn, LOCAL, never replicated), so a fall
// out of bounds and the pause menu's Restart bring them back to the same spot.
import * as THREE from 'three';
import { get } from 'svelte/store';
import { objectsGroup, isVRMode, isLocked, editorMode } from '../../stores/sceneStore';
import { setRuntimeSpawn, runtimeSpawn } from '../playSettings';
import { spawnDesktopPlayer, desktopSpawn, currentSpawn, spawnEyePose } from '../playSpawn';
import { vrControlsRef, objectActionsRef } from '../sdk/refs.js';

/** the runtime-spawn owner tag this module writes (so it clears only its own) */
export const LEVELS_SPAWN_OWNER = 'levels';
/** metres in front of a portal an arriving player stands (clear of its trigger) */
export const PORTAL_ARRIVAL_GAP = 1.6;

/** the yaw an object's arrow points (its world -Z) @param {any} object */
export function arrowYaw(object) {
	const q = new THREE.Quaternion();
	object.getWorldQuaternion(q);
	const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
	fwd.y = 0;
	if (fwd.lengthSq() < 1e-8) return 0;
	fwd.normalize();
	// three's yaw: rotation.y; yaw 0 faces -Z, so the forward vector is (-sin y, 0, -cos y)
	return Math.atan2(-fwd.x, -fwd.z);
}

/** find a spawn object by uuid, else by name (a marked Checkpoint / Portal wins a name tie) @param {string} key */
export function findSpawnObject(key) {
	const group = /** @type {any} */ (get(objectsGroup));
	const k = String(key ?? '').trim();
	if (!group || !k) return null;
	const byId = group.getObjectByProperty('uuid', k);
	if (byId) return byId;
	/** @type {any[]} */
	const hits = [];
	group.traverse((/** @type {any} */ o) => {
		if (o !== group && o.name === k) hits.push(o);
	});
	return hits.find((o) => o.userData?.checkpoint || o.userData?.portal) ?? hits[0] ?? null;
}

/**
 * The spawn an object stands for: a Checkpoint → its pad, a Portal → the arrival side in front of it, any
 * other object → on top of it. @param {any} object @returns {{position: [number, number, number], yaw: number}}
 */
export function spawnOfObject(object) {
	object.updateWorldMatrix(true, true);
	const box = new THREE.Box3().setFromObject(object);
	const center = box.isEmpty() ? object.getWorldPosition(new THREE.Vector3()) : box.getCenter(new THREE.Vector3());
	const yaw = arrowYaw(object);
	const marked = !!(object.userData?.checkpoint || object.userData?.portal);
	let y = box.isEmpty() ? center.y : marked ? box.min.y : box.max.y;
	let x = center.x;
	let z = center.z;
	if (object.userData?.portal) {
		x += -Math.sin(yaw) * PORTAL_ARRIVAL_GAP;
		z += -Math.cos(yaw) * PORTAL_ARRIVAL_GAP;
	}
	if (!Number.isFinite(y)) y = 0;
	return { position: [round(x), round(y), round(z)], yaw: round(yaw) };
}

/** @param {number} n */
const round = (n) => Math.round(n * 1000) / 1000;

/**
 * Move this player to the spawn in force now (the SDK's respawnPlayer rule): VR moves the rig, desktop Play the
 * play camera, desktop Interact flies the editor view. Edit is never moved. @returns {boolean}
 */
export function respawnNow() {
	const spawn = currentSpawn();
	if (!spawn) return false;
	if (get(isVRMode)) {
		if (get(editorMode) !== 'interact') return false;
		return !!vrControlsRef?.spawnPlayer?.();
	}
	const desk = desktopSpawn();
	if (!desk) return false;
	if (get(isLocked) === true) return spawnDesktopPlayer(desk);
	if (get(editorMode) === 'interact') {
		const { eye, lookAt } = spawnEyePose(desk);
		objectActionsRef?.flyTo?.(eye, lookAt);
		return !!objectActionsRef;
	}
	return false;
}

/** make a spawn this player's own and (optionally) put them there now
 * @param {{position: number[], yaw: number} | null} spawn @param {{teleport?: boolean}} [opts] */
export function setPlayerSpawn(spawn, opts = {}) {
	if (!spawn) {
		clearPlayerSpawn();
		return false;
	}
	setRuntimeSpawn(spawn.position, spawn.yaw, LEVELS_SPAWN_OWNER);
	return opts.teleport === false ? true : respawnNow();
}

/** forget this player's level / checkpoint spawn (only ours — a module's own setSpawn is left alone) */
export function clearPlayerSpawn() {
	const now = /** @type {any} */ (get(runtimeSpawn));
	if (now?.owner === LEVELS_SPAWN_OWNER) setRuntimeSpawn(null, 0, LEVELS_SPAWN_OWNER);
}

/** land on a named spawn object (false when the scene has no such object) @param {string} key @param {{teleport?: boolean}} [opts] */
export function landAt(key, opts = {}) {
	const object = findSpawnObject(key);
	if (!object) return false;
	setPlayerSpawn(spawnOfObject(object), opts);
	return true;
}
