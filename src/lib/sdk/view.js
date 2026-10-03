// Module SDK — the follow camera, VR hand poses and VR panels.
// One slice of the api object makeApi() assembles (sdk/index.js, the ONE table).

import { possessRef, vrControlsRef } from './refs.js';

/** 33 (L4): which module last started the follow camera (api.followCam) @type {string | null} */
let followingFor = null;

/** @param {import('./context.js').SdkContext} ctx */
export function sdkView(ctx) {
	const { moduleId, onDispose } = ctx;
	/** 33 (L4): api.followCam journals its stop once per module */
	let followDisposeHooked = false;
	return {
		/** Park the editor camera behind an object and follow it (the car's chase
		 * cam) — LOCAL, no selection, no undo. @param {string} uuid */
		followCam(uuid) {
			const ok = possessRef?.startFollowCam(uuid) ?? false;
			// 33 (L4): a module unloaded mid-follow must not leave the camera chasing its car
			if (ok && !followDisposeHooked) {
				followDisposeHooked = true;
				onDispose(() => {
					if (followingFor === moduleId) possessRef?.stopFollowCam();
				});
			}
			if (ok) followingFor = moduleId;
			return ok;
		},
		stopFollowCam() {
			if (followingFor === moduleId) followingFor = null;
			possessRef?.stopFollowCam();
		},
		/**
		 * One VR hand's WORLD pose + button state, or null when untracked / not
		 * in VR (DEVX #2): {position:[x,y,z], quaternion:[x,y,z,w], trigger,
		 * gripped, connected}. Poll it from a frame task (a fresh plain object
		 * per call — safe to keep). @param {'left'|'right'} hand
		 */
		vrHand(hand) {
			return vrControlsRef?.handSnapshot?.(hand) ?? null;
		},
		/**
		 * 31 K2: make `object` (a group of meshes: your VR menu, level bar, buttons) a VR
		 * PANEL — drawn OVER the scene so a floor or a base can never hide it, and a place the
		 * controller beam ends with its dot. Hit testing is unchanged. Returns the undo (also
		 * run when the module is disabled). Feature-detect: `api.vrPanel?.(group)`.
		 * @param {any} object @returns {() => void}
		 */
		vrPanel(object) {
			const off = vrControlsRef?.registerOverlayPanel?.(object) ?? (() => {});
			onDispose(off);
			return off;
		}
	};
}
