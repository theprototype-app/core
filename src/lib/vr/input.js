// VR controls — controllers and hands: slot by handedness, hand snapshots/segments, frame rate, pinch, input-source changes.
// 34 R4 (A5): one concern of src/lib/vrControls.js, which re-exports the public names unchanged.
import * as THREE from 'three';
import { get } from 'svelte/store';
import { vrMenuHand, vrMenuOpen, vrGrabbedHand, vrTargetHz } from '../../stores/sceneStore';
import { vrEndHandleDrag } from '../meshEdit';
import { S } from './state.js';
import { renderer, previousButtons } from './core.js';
import { grabs, endGrab, emptyAirSqueeze, gripHeld } from './grip.js';
import { endWorldSnap } from './worldSnap.js';

/** 194: resolve a controller slot by HANDEDNESS. three's getController(i) is a
 * persistent object; Scene stamps controller.userData.handedness from each
 * 'connected' event, so this survives a hands<->controllers reorder (the raw
 * inputSources index does NOT — that put the radial on the wrong hand). Falls
 * back to the inputSources order if userData isn't stamped yet. @param {string} handedness */
export function controllerIndexFor(handedness) {
	if (renderer) {
		for (let i = 0; i < 2; i++) {
			if (renderer.xr.getController(i)?.userData?.handedness === handedness) return i;
		}
	}
	const session = renderer?.xr.getSession();
	if (!session) return -1;
	return [...session.inputSources].findIndex((source) => source.handedness === handedness);
}

const _handPos = new THREE.Vector3();
const _handQuat = new THREE.Quaternion();
/** 17-A1 (api.vrHand): one hand's WORLD pose + button state for the module
 * api. Slot resolved by the stamped handedness (194/210, never a raw index);
 * buttons read from the inputSource matched by ITS OWN handedness (the
 * axesForSlot rule). Null when not presenting or the hand is untracked.
 * @param {'left'|'right'} handedness */
export function handSnapshot(handedness) {
	if (!renderer?.xr?.isPresenting) return null;
	const index = controllerIndexFor(handedness);
	if (index < 0) return null;
	const controller = renderer.xr.getController(index);
	if (!controller) return null;
	controller.getWorldPosition(_handPos);
	controller.getWorldQuaternion(_handQuat);
	const session = renderer.xr.getSession();
	const source = session
		? [...session.inputSources].find((s) => s.handedness === handedness)
		: null;
	const buttons = source?.gamepad?.buttons ?? [];
	return {
		position: _handPos.toArray(),
		quaternion: _handQuat.toArray(),
		trigger: !!buttons[0]?.pressed,
		gripped: !!buttons[1]?.pressed,
		connected: !!source
	};
}

/** 210: gamepad axes for the physical hand at three.js controller SLOT `slot`.
 * The gamepad lives on the inputSource, whose ORDER can differ from the controller
 * slot order after a hands<->controllers swap (194), so match by the slot's stamped
 * handedness rather than indexing inputSources by the slot. @param {number} slot */
export function axesForSlot(slot) {
	const session = renderer?.xr.getSession();
	const hand = renderer?.xr.getController(slot)?.userData?.handedness;
	const src = session && hand ? [...session.inputSources].find((s) => s.handedness === hand) : null;
	return src?.gamepad?.axes ?? [];
}

const _contentRigQuat = new THREE.Quaternion();
/** 195: rewrite a WORLD pose into the shared CONTENT frame (worldRig-local), in
 * place. VR presence (head + hands) is broadcast in this frame so a two-grip
 * world-grab — which bends the rig instead of moving the camera — repositions you
 * for peers. A no-op when rig is null/identity (desktop + normal VR), so the
 * common presence path is byte-unchanged. Peers render avatars back through their
 * OWN rig (Player's peerFrame), which recovers the world pose.
 * @param {any} rig the worldRig group @param {any} pos THREE.Vector3 (mutated)
 * @param {any} quat THREE.Quaternion (mutated) */
export function worldToContentPose(rig, pos, quat) {
	if (!rig) return;
	rig.updateWorldMatrix(true, false);
	rig.worldToLocal(pos);
	rig.getWorldQuaternion(_contentRigQuat).invert();
	quat.premultiply(_contentRigQuat);
}

// ---- B2.1 (roadmap 9): target VR refresh rate ----
/** Apply the vrTargetHz preference to the live session. Gated on
 * supportedFrameRates — an out-of-range value REJECTS a promise threlte's sync
 * try/catch would miss, so we only ever request a supported rate. */
export function applyVRFrameRate() {
	const session = renderer?.xr?.getSession?.();
	const rates = session?.supportedFrameRates;
	if (!session || !rates || !rates.length || !session.updateTargetFrameRate) return null;
	const pref = get(vrTargetHz);
	const max = Math.max(...rates);
	const wanted = pref === 'auto' ? max : Number(pref);
	const target = rates.includes ? (rates.includes(wanted) ? wanted : max) : max;
	try {
		const p = session.updateTargetFrameRate(target);
		p?.catch?.(() => {});
	} catch {}
	return target;
}

/** B2.2: should this frame's vrhands broadcast go out? Pure — the switch-back
 * (hands→controllers) bug was the `!moved && !hasJoints` gate eating the ONE
 * message that tells peers the representation flipped. repChanged forces it.
 * @param {{moved: boolean, hasJoints: boolean, prevLens: number[], lens: number[]}} s */
export function shouldSendHands(s) {
	const repChanged = s.lens[0] !== s.prevLens[0] || s.lens[1] !== s.prevLens[1];
	return s.moved || s.hasJoints || repChanged;
}

// B2.3: cuboid-bone hand — segment pairs over the 25-joint WebXR order
// (0 wrist; 1-4 thumb; 5-9 index; 10-14 middle; 15-19 ring; 20-24 pinky)
const HAND_BONES = [
	[0, 1], [1, 2], [2, 3], [3, 4],
	[0, 5], [5, 6], [6, 7], [7, 8], [8, 9],
	[0, 10], [10, 11], [11, 12], [12, 13], [13, 14],
	[0, 15], [15, 16], [16, 17], [17, 18], [18, 19],
	[0, 20], [20, 21], [21, 22], [22, 23], [23, 24]
];
const _boneUp = new THREE.Vector3(0, 1, 0);
/** Wrist-local joint positions (flat 75 floats) → ~24 cuboid bone segments
 * {pos:[3], rot:[3], len}. Pure; Player renders these. @param {number[]} flat */
export function handBoneSegments(flat) {
	/** @type {{pos: number[], rot: number[], len: number}[]} */
	const out = [];
	if (!flat || flat.length < 75) return out;
	const v = (/** @type {number} */ i) => new THREE.Vector3(flat[i * 3], flat[i * 3 + 1], flat[i * 3 + 2]);
	for (const [a, b] of HAND_BONES) {
		const va = v(a);
		const vb = v(b);
		const dir = vb.clone().sub(va);
		const len = Math.max(dir.length(), 0.001);
		const mid = va.add(vb).multiplyScalar(0.5);
		const quat = new THREE.Quaternion().setFromUnitVectors(_boneUp, dir.normalize());
		const e = new THREE.Euler().setFromQuaternion(quat);
		out.push({ pos: [mid.x, mid.y, mid.z], rot: [e.x, e.y, e.z], len });
	}
	return out;
}

/** R-3 'model' hand style: the same bones as handBoneSegments but with
 * per-bone RADII (palm metacarpals thick, fingertips thin) for rounded capsule
 * rendering — reads as a hand rather than a wireframe. Pure. @param {number[]} flat */
export function handModelSegments(flat) {
	const segments = handBoneSegments(flat);
	return segments.map((segment, index) => {
		const [a, b] = HAND_BONES[index];
		const fromWrist = a === 0; // metacarpal
		const isTip = [4, 9, 14, 19, 24].includes(b);
		return { ...segment, r: fromWrist ? 0.011 : isTip ? 0.006 : 0.008 };
	});
}

// ---- B2.4: pinch-HOLD on the menu hand toggles the radial (hands have no B/Y) ----
const pinchStartAt = { left: 0, right: 0 };
/** ms the pinch must be held to toggle the menu (a quick pinch = native select) */
export const PINCH_HOLD_MS = 500;
/** set when the hold fires, so Scene's onXRSelect can swallow the release-click */
export let pinchMenuToggledAt = 0;
/** @param {string} handedness */
export function onHandPinchStart(handedness) {
	pinchStartAt[handedness === 'left' ? 'left' : 'right'] = Date.now();
}
/** @param {string} handedness @returns {boolean} true if the menu toggled */
export function onHandPinchEnd(handedness) {
	const side = handedness === 'left' ? 'left' : 'right';
	const held = Date.now() - (pinchStartAt[side] || 0);
	pinchStartAt[side] = 0;
	if (handedness !== get(vrMenuHand) || held < PINCH_HOLD_MS) return false;
	vrMenuOpen.update((v) => !v);
	pinchMenuToggledAt = Date.now();
	return true;
}

/** 188: WebXR re-issues inputsourceschange on hands<->controllers and on a
 * controller reconnect (e.g. headset off/on); the controller SLOT<->handedness
 * mapping can flip. All per-slot button state + in-progress grabs are keyed by
 * slot index, so a survivor would drive the WRONG controller's ray. Reset the
 * cached per-slot state and DROP any transient grab/gesture (edit/stretch MODES
 * stay); the next frame re-binds cleanly from the live input sources. */
export function onInputSourcesChange() {
	previousButtons[0] = {};
	previousButtons[1] = {};
	emptyAirSqueeze[0] = false;
	emptyAirSqueeze[1] = false;
	gripHeld[0] = false;
	gripHeld[1] = false;
	// drop slot-index-bound transient gestures (a mid-gesture source swap)
	if (S.vertexTriggerGrab) {
		vrEndHandleDrag();
		S.vertexTriggerGrab = null;
	}
	// a dropped grab RELEASES its body (it used to leave it in its kinematic hold)
	for (let i = 0; i < grabs.length; i++) {
		const held = grabs[i];
		grabs[i] = null;
		if (held) endGrab(held.object, held.interact ? null : held.before);
	}
	S.scaleGrab = null;
	S.worldGrab = null;
	endWorldSnap(); // 37 R10: the readout goes with the gesture
	S.worldPan = null;
	S.windowGrab = null;
	S.windowGrabPending = null;
	vrGrabbedHand.set(null);
}
