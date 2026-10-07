// Module SDK — the follow camera, VR hand poses and VR panels.
// One slice of the api object makeApi() assembles (sdk/index.js, the ONE table).

import { possessRef, vrControlsRef } from './refs.js';

/** 33 (L4): which module last started the follow camera (api.followCam) @type {string | null} */
let followingFor = null;
/** 37: which module last seated the VR viewer (api.vrSeat) @type {string | null} */
let seatedFor = null;

/** @param {import('./context.js').SdkContext} ctx */
export function sdkView(ctx) {
	const { moduleId, onDispose, owned } = ctx;
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
				}, 'followCam');
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
			return owned('vrPanel', vrControlsRef?.registerOverlayPanel?.(object) ?? (() => {}));
		},
		/**
		 * 37 (21-C Race VR): ride an object in VR — the head lands on `seat` (object-local eye
		 * point, default [0, 0.8, 0.3]) facing the object's forward (-Z), and the tracking space
		 * is carried with it (yaw + translation only) until vrUnseat. While seated the sticks
		 * stop walking/turning/teleporting; api.input() still reports them (drive with them).
		 * Outside a VR session the request waits for one. LOCAL. Feature-detect:
		 * `api.vrSeat?.(uuid)`. @param {string} uuid @param {{seat?: number[]}} [opts]
		 * @returns {boolean} whether the object exists
		 */
		vrSeat(uuid, opts) {
			const ok = vrControlsRef?.seatViewer?.(uuid, opts) ?? false;
			if (ok) seatedFor = moduleId;
			// one journal entry however often it is called (a module unloaded mid-ride stands up)
			if (ok)
				onDispose(
					() => {
						if (seatedFor === moduleId) vrControlsRef?.unseatViewer?.(false);
						seatedFor = null;
					},
					'vrSeat',
					{ key: 'vrSeat' }
				);
			return ok;
		},
		/** Get up from api.vrSeat: the player steps out beside the object. */
		vrUnseat() {
			if (seatedFor === moduleId) seatedFor = null;
			vrControlsRef?.unseatViewer?.();
		}
	};
}

/** 34 R6 (T2): what each member does to the module's lifecycle — see SURFACE_KINDS in
 * sdk/lifecycle.js. tests/unit/moduleLifecycle.test.js holds every 'registers' member to a
 * teardown path; a member missing here fails it. */
sdkView.surface = {
	followCam: 'registers',
	stopFollowCam: 'action',
	vrHand: 'read',
	vrPanel: 'registers',
	vrSeat: 'registers',
	vrUnseat: 'action'
};
