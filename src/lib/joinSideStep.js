// 78 PL32 — THE SIDE STEP: a JOINER whose editor camera opens on top of another person's avatar (every
// fresh page starts on the same default camera, so a joiner's eye sat in the host's head) moves to the
// side once, facing the same way. The FADE half (nearAvatars.fadeAvatar, run by AvatarRig) is what
// covers everything else; this only makes the first moment of a join look like arriving beside
// someone rather than inside them.
//
// LOCAL: it moves this screen's camera, and the ordinary camera stream tells everyone. Play mode is
// NOT handled here — its spawn already clears avatars (playSpawn.clearOfAvatars, the 98-int F4 fix) —
// and neither are VR or spectating (flyTo refuses both). The fly is handed in, so this module stays
// clear of objectActions (history family).
import * as THREE from 'three';
import { get } from 'svelte/store';
import { sessionHost } from './connectionState';
import { globalCamera, orbitControls, isLocked, isVRMode } from '../stores/sceneStore';
import { specatorMode } from '../stores/appStore';
import { avatarPositions, otherPlayerIds } from './playSpawn';
import { sideStepSpot } from './nearAvatars';

/** how long after the approval the step still waits for the host's avatar to arrive */
export const SIDE_STEP_WAIT_MS = 15000;

/** @type {{moved: boolean, from?: number[], to?: number[], others: number[][], at: number} | null} */
let last = null;
/** what the last join did (the e2e reads it) */
export const lastJoinSideStep = () => last;

/**
 * One try: 'wait' (no camera or no avatar posed yet), 'skip' (play / VR / spectating), 'clear' (the
 * camera is already clear of everyone) or 'moved'.
 * @param {(eye: number[], target: number[]) => void} fly
 */
export function trySideStep(fly) {
	if (get(isLocked) === true || get(isVRMode) || get(specatorMode)) return 'skip';
	/** @type {any} */
	const cam = get(globalCamera);
	/** @type {any} */
	const controls = get(orbitControls);
	if (!cam?.isObject3D || !controls?.target) return 'wait';
	const others = avatarPositions(otherPlayerIds());
	if (!others.length) return 'wait';
	cam.updateMatrixWorld(true);
	const eye = cam.getWorldPosition(new THREE.Vector3()).toArray();
	const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0).toArray();
	const spot = sideStepSpot(eye, right, others);
	if (spot === eye) {
		last = { moved: false, others, at: Date.now() };
		return 'clear';
	}
	// flyTo writes the camera's LOCAL position: carry the world step into its parent's frame
	const dx = spot[0] - eye[0];
	const dz = spot[2] - eye[2];
	const p = cam.position;
	const t = controls.target;
	fly([p.x + dx, p.y, p.z + dz], [t.x + dx, t.y, t.z + dz]);
	last = { moved: true, from: eye, to: spot, others, at: Date.now() };
	return 'moved';
}

/**
 * Watch for OUR join being approved (`sessionHost` turning from nobody into a peer) and try the step
 * every 250 ms until the host's avatar is posed, for up to SIDE_STEP_WAIT_MS. Returns the stop.
 * @param {(eye: number[], target: number[]) => void} fly
 */
export function watchJoinSideStep(fly) {
	/** @type {ReturnType<typeof setInterval> | null} */
	let timer = null;
	let prev = get(sessionHost);
	const stop = () => {
		if (timer) clearInterval(timer);
		timer = null;
	};
	const unsub = sessionHost.subscribe((host) => {
		const was = prev;
		prev = host;
		if (!host) return stop();
		if (host === was) return;
		stop();
		const until = Date.now() + SIDE_STEP_WAIT_MS;
		timer = setInterval(() => {
			if (Date.now() > until || get(sessionHost) !== host) return stop();
			if (trySideStep(fly) !== 'wait') stop();
		}, 250);
	});
	return () => {
		stop();
		unsub();
	};
}
