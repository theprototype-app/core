// 57 M1: which of a model's nodes is which VRM humanoid bone. THE SEAM 57-chars M2 owns: its
// detector (Mixamo / KayKit / Quaternius / UniRig / Meshy rules + the map editor's fixes) registers
// through `setHumanoidDetector`, and a VRM brings its own map on `userData.humanoid`. Until then a
// small built-in rule set (exact VRM names, Mixamo with any prefix) keeps clips playable.

import { VRM_HUMAN_BONES, isHumanoidMap } from './humanoidBones.js';

/** @typedef {(names: string[], root: any) => Record<string, string> | null} HumanoidDetector */
/** @type {HumanoidDetector | null} */
let detector = null;

/** 57-chars M2 plugs its detector in here @param {HumanoidDetector | null} fn */
export function setHumanoidDetector(fn) {
	detector = fn;
}

/** Mixamo suffix -> VRM bone (after the common prefix, e.g. `mixamorig` / `mixamorig1`) */
const MIXAMO = {
	Hips: 'hips', Spine: 'spine', Spine1: 'chest', Spine2: 'upperChest', Neck: 'neck', Head: 'head',
	LeftShoulder: 'leftShoulder', LeftArm: 'leftUpperArm', LeftForeArm: 'leftLowerArm', LeftHand: 'leftHand',
	RightShoulder: 'rightShoulder', RightArm: 'rightUpperArm', RightForeArm: 'rightLowerArm', RightHand: 'rightHand',
	LeftUpLeg: 'leftUpperLeg', LeftLeg: 'leftLowerLeg', LeftFoot: 'leftFoot', LeftToeBase: 'leftToes',
	RightUpLeg: 'rightUpperLeg', RightLeg: 'rightLowerLeg', RightFoot: 'rightFoot', RightToeBase: 'rightToes',
	LeftHandThumb1: 'leftThumbMetacarpal', LeftHandThumb2: 'leftThumbProximal', LeftHandThumb3: 'leftThumbDistal',
	LeftHandIndex1: 'leftIndexProximal', LeftHandIndex2: 'leftIndexIntermediate', LeftHandIndex3: 'leftIndexDistal',
	LeftHandMiddle1: 'leftMiddleProximal', LeftHandMiddle2: 'leftMiddleIntermediate', LeftHandMiddle3: 'leftMiddleDistal',
	LeftHandRing1: 'leftRingProximal', LeftHandRing2: 'leftRingIntermediate', LeftHandRing3: 'leftRingDistal',
	LeftHandPinky1: 'leftLittleProximal', LeftHandPinky2: 'leftLittleIntermediate', LeftHandPinky3: 'leftLittleDistal',
	RightHandThumb1: 'rightThumbMetacarpal', RightHandThumb2: 'rightThumbProximal', RightHandThumb3: 'rightThumbDistal',
	RightHandIndex1: 'rightIndexProximal', RightHandIndex2: 'rightIndexIntermediate', RightHandIndex3: 'rightIndexDistal',
	RightHandMiddle1: 'rightMiddleProximal', RightHandMiddle2: 'rightMiddleIntermediate', RightHandMiddle3: 'rightMiddleDistal',
	RightHandRing1: 'rightRingProximal', RightHandRing2: 'rightRingIntermediate', RightHandRing3: 'rightRingDistal',
	RightHandPinky1: 'rightLittleProximal', RightHandPinky2: 'rightLittleIntermediate', RightHandPinky3: 'rightLittleDistal'
};

/**
 * The built-in rules over a list of node names: exact VRM bone names (any case), or Mixamo names
 * behind one shared prefix. null when neither yields a full humanoid.
 * @param {string[]} names @returns {Record<string, string> | null}
 */
export function guessHumanoidMap(names) {
	/** @type {Record<string, string>} */
	const exact = {};
	const lower = new Map(names.map((n) => [n.toLowerCase(), n]));
	for (const bone of VRM_HUMAN_BONES) {
		const hit = lower.get(bone.toLowerCase());
		if (hit) exact[bone] = hit;
	}
	if (isHumanoidMap(exact)) return exact;
	const hips = names.find((n) => /hips$/i.test(n));
	if (!hips) return null;
	const prefix = hips.slice(0, hips.length - 4);
	/** @type {Record<string, string>} */
	const mixamo = {};
	const set = new Set(names);
	for (const [suffix, bone] of Object.entries(MIXAMO)) if (set.has(prefix + suffix)) mixamo[bone] = prefix + suffix;
	return isHumanoidMap(mixamo) ? mixamo : null;
}

/**
 * A model's humanoid map, or null: its own (`userData.humanoid`, a VRM's or one fixed in the map
 * editor), else the registered detector, else the built-in rules.
 * @param {any} root a three Object3D @returns {Record<string, string> | null}
 */
export function humanoidMapOf(root) {
	const own = root?.userData?.humanoid;
	if (isHumanoidMap(own)) return own;
	/** @type {string[]} */
	const names = [];
	root?.traverse?.((/** @type {any} */ o) => {
		if (o !== root && o.name) names.push(o.name);
	});
	if (detector) {
		try {
			const found = detector(names, root);
			if (isHumanoidMap(found)) return found;
		} catch (error) {
			console.log('humanoid detector failed', error);
		}
	}
	return guessHumanoidMap(names);
}

/** the same, for a bare list of names (a BVH / FBX animation file being converted) @param {string[]} names */
export function humanoidMapOfNames(names) {
	if (detector) {
		try {
			const found = detector(names, null);
			if (isHumanoidMap(found)) return found;
		} catch {}
	}
	return guessHumanoidMap(names);
}
