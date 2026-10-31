// 57 M1 (F2): the VRM 1.0 humanoid bone set — the ONE standard every humanoid `.tpanim` clip is
// stored on, so a clip plays on any mapped humanoid (VRMs map themselves; 57-chars M2 detects the
// rest). A LEAF of plain data: the parent map is VRM 1.0's own (three-vrm-core
// VRMHumanBoneParentMap), so a clip normalized here reads back identically through three-vrm.

/** bone -> its humanoid parent (null for hips). Order = a valid parent-first walk. */
export const VRM_HUMAN_BONE_PARENTS = /** @type {const} */ ({
	hips: null,
	spine: 'hips',
	chest: 'spine',
	upperChest: 'chest',
	neck: 'upperChest',
	head: 'neck',
	leftEye: 'head',
	rightEye: 'head',
	jaw: 'head',
	leftUpperLeg: 'hips',
	leftLowerLeg: 'leftUpperLeg',
	leftFoot: 'leftLowerLeg',
	leftToes: 'leftFoot',
	rightUpperLeg: 'hips',
	rightLowerLeg: 'rightUpperLeg',
	rightFoot: 'rightLowerLeg',
	rightToes: 'rightFoot',
	leftShoulder: 'upperChest',
	leftUpperArm: 'leftShoulder',
	leftLowerArm: 'leftUpperArm',
	leftHand: 'leftLowerArm',
	rightShoulder: 'upperChest',
	rightUpperArm: 'rightShoulder',
	rightLowerArm: 'rightUpperArm',
	rightHand: 'rightLowerArm',
	leftThumbMetacarpal: 'leftHand',
	leftThumbProximal: 'leftThumbMetacarpal',
	leftThumbDistal: 'leftThumbProximal',
	leftIndexProximal: 'leftHand',
	leftIndexIntermediate: 'leftIndexProximal',
	leftIndexDistal: 'leftIndexIntermediate',
	leftMiddleProximal: 'leftHand',
	leftMiddleIntermediate: 'leftMiddleProximal',
	leftMiddleDistal: 'leftMiddleIntermediate',
	leftRingProximal: 'leftHand',
	leftRingIntermediate: 'leftRingProximal',
	leftRingDistal: 'leftRingIntermediate',
	leftLittleProximal: 'leftHand',
	leftLittleIntermediate: 'leftLittleProximal',
	leftLittleDistal: 'leftLittleIntermediate',
	rightThumbMetacarpal: 'rightHand',
	rightThumbProximal: 'rightThumbMetacarpal',
	rightThumbDistal: 'rightThumbProximal',
	rightIndexProximal: 'rightHand',
	rightIndexIntermediate: 'rightIndexProximal',
	rightIndexDistal: 'rightIndexIntermediate',
	rightMiddleProximal: 'rightHand',
	rightMiddleIntermediate: 'rightMiddleProximal',
	rightMiddleDistal: 'rightMiddleIntermediate',
	rightRingProximal: 'rightHand',
	rightRingIntermediate: 'rightRingProximal',
	rightRingDistal: 'rightRingIntermediate',
	rightLittleProximal: 'rightHand',
	rightLittleIntermediate: 'rightLittleProximal',
	rightLittleDistal: 'rightLittleIntermediate'
});

/** @typedef {keyof typeof VRM_HUMAN_BONE_PARENTS} VrmHumanBone */

/** every bone, parents before children @type {VrmHumanBone[]} */
export const VRM_HUMAN_BONES = /** @type {any} */ (Object.keys(VRM_HUMAN_BONE_PARENTS));

/** the bones VRM 1.0 requires — a map missing one is not a humanoid */
export const VRM_REQUIRED_BONES = [
	'hips',
	'spine',
	'head',
	'leftUpperLeg',
	'leftLowerLeg',
	'leftFoot',
	'rightUpperLeg',
	'rightLowerLeg',
	'rightFoot',
	'leftUpperArm',
	'leftLowerArm',
	'leftHand',
	'rightUpperArm',
	'rightLowerArm',
	'rightHand'
];

/** @param {string} name */
export function isVrmHumanBone(name) {
	return Object.prototype.hasOwnProperty.call(VRM_HUMAN_BONE_PARENTS, name);
}

/**
 * The nearest ancestor of `bone` that `has` accepts (VRM's own rule for optional bones: a missing
 * upperChest makes the shoulders hang off chest). null = none (hips' parent).
 * @param {string} bone @param {(b: string) => boolean} has @returns {any}
 */
export function humanParentIn(bone, has) {
	/** @type {any} */
	let p = /** @type {any} */ (VRM_HUMAN_BONE_PARENTS)[bone] ?? null;
	while (p && !has(p)) p = /** @type {any} */ (VRM_HUMAN_BONE_PARENTS)[p] ?? null;
	return p;
}

/**
 * Is this map a humanoid? Every required bone named, every node named once.
 * @param {Record<string, string> | null | undefined} map VRM bone -> node name
 */
export function isHumanoidMap(map) {
	if (!map || typeof map !== 'object') return false;
	if (!VRM_REQUIRED_BONES.every((b) => typeof map[b] === 'string' && map[b])) return false;
	const nodes = Object.entries(map).filter(([b, n]) => isVrmHumanBone(b) && n).map(([, n]) => n);
	return new Set(nodes).size === nodes.length;
}
