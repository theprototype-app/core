// Module SDK — the spawn point and the pointer ray.
// One slice of the api object makeApi() assembles (sdk/index.js, the ONE table).

import { isVRMode, isLocked, editorMode } from '../../stores/sceneStore';
import { runtimeSpawn, setRuntimeSpawn } from '../playSettings';
import { spawnDesktopPlayer, currentSpawn, desktopSpawn, spawnEyePose } from '../playSpawn';
import { get } from 'svelte/store';
import { pointerRayNow } from './pointer.js';
import { vrControlsRef, objectActionsRef } from './refs.js';

/**
 * 30b P4: move the player to the spawn in force — VR moves the rig (vrControls), desktop
 * Play moves the play camera, desktop Interact the editor view. Edit is never moved.
 * @returns {boolean}
 */
function respawnPlayerNow() {
	const spawn = currentSpawn();
	if (!spawn) return false;
	if (get(isVRMode)) {
		if (get(editorMode) !== 'interact') return false;
		return !!vrControlsRef?.spawnPlayer?.();
	}
	// 30b (core-games): a VR-only spawn leaves the desktop view where it is
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

/** @param {import('./context.js').SdkContext} ctx */
export function sdkPlayer(ctx) {
	const { moduleId, onDispose } = ctx;
	/** 30b P4: setSpawn journals its clear once per module */
	let spawnDisposeHooked = false;
	return {
		/**
		 * 30b P4: where the player STARTS — entering Interact or Play puts them here (VR: the
		 * rig so the FEET land on it facing `yaw`; desktop Play: the play camera; desktop
		 * Interact: the editor view). `position` is [x, y, z] with y the FEET height; `yaw`
		 * is radians, three's rotation.y (0 faces -Z, forward = (-sin yaw, 0, -cos yaw)).
		 * Overrides the scene's authored `play.spawn`. LOCAL: every peer's module sets its
		 * own from the same replicated state; never saved. `{teleport: true}` also moves the
		 * player there NOW when Interact or Play is on (a new level, a new dungeon floor) —
		 * without it a changed spawn is a checkpoint, used on the next entry.
		 * `setSpawn(null)` clears it. Cleared when the module is disabled.
		 * @param {number[] | null} position @param {number=} yaw
		 * @param {{teleport?: boolean}=} options @returns {boolean} whether it was accepted
		 */
		setSpawn(position, yaw = 0, options = {}) {
			const ok = setRuntimeSpawn(position, yaw, moduleId);
			if (!spawnDisposeHooked) {
				spawnDisposeHooked = true;
				onDispose(() => {
					if (get(runtimeSpawn)?.owner === moduleId) setRuntimeSpawn(null);
				});
			}
			if (ok && position && options?.teleport) respawnPlayerNow();
			return ok;
		},
		/**
		 * 30b P4: move the player to the spawn in force now (see setSpawn) — only while
		 * Interact or Play is on; the editor's Edit view is never moved.
		 * @returns {boolean} whether the player was moved
		 */
		respawnPlayer() {
			return respawnPlayerNow();
		},
		/**
		 * Where the user is POINTING, as a THREE.Raycaster in world space —
		 * desktop mouse over the viewport, or the VR pointer hand's ray. A fresh
		 * instance per call (safe to keep). Null before the first pointer event.
		 * 30 P4: in play under a pointer lock it is the CROSSHAIR ray (the view's
		 * centre) — the mouse ray is frozen there; a free-cursor game keeps the mouse.
		 * The drag recipe (190/untangle): click to pick, follow pointerRay() in a
		 * frame task, click to drop. (190)
		 */
		pointerRay() {
			return pointerRayNow();
		}
	};
}
