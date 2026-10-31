// 57: a small Mixamo-named humanoid rig + a walk-ish clip, shared by the .tpanim unit suites.
import * as THREE from 'three';

/**
 * A small Mixamo-named humanoid under an FBX-style Armature (rotated -90° X, scaled 0.01 — the
 * cm rig), arms in an A-pose, plus one UNMAPPED twist bone between upper and lower arm.
 * @param {{prefix?: string, twist?: boolean, restTwist?: boolean}} [o]
 */
export function makeRig(o = {}) {
	const P = o.prefix ?? 'mixamorig';
	const root = new THREE.Group();
	root.name = 'Model';
	const arm = new THREE.Object3D();
	arm.name = 'Armature';
	arm.rotation.x = -Math.PI / 2;
	arm.scale.setScalar(0.01);
	root.add(arm);
	/** @type {Record<string, THREE.Bone>} */
	const b = {};
	/** @param {string} n @param {THREE.Object3D} parent @param {number[]} pos (cm, parent frame) @param {number[]} [rot] euler */
	const bone = (n, parent, pos, rot) => {
		const x = new THREE.Bone();
		x.name = P + n;
		x.position.fromArray(pos);
		if (rot) x.rotation.set(rot[0], rot[1], rot[2]);
		if (o.restTwist) x.quaternion.multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(0.1, 0.2, -0.15)));
		parent.add(x);
		b[n] = x;
		return x;
	};
	// the armature turns -90° X, so a bone's +Z in the armature is world +Y (up)
	bone('Hips', arm, [0, 0, 100]);
	bone('Spine', b.Hips, [0, 0, 10]);
	bone('Spine1', b.Spine, [0, 0, 12]);
	bone('Spine2', b.Spine1, [0, 0, 12]);
	bone('Neck', b.Spine2, [0, 0, 14]);
	bone('Head', b.Neck, [0, 0, 8]);
	for (const [side, s] of /** @type {[string, number][]} */ ([['Left', 1], ['Right', -1]])) {
		bone(side + 'Shoulder', b.Spine2, [s * 6, 0, 10]);
		bone(side + 'Arm', b[side + 'Shoulder'], [s * 12, 0, 0], [0, s * 0.6, 0]); // A-pose: tilted down
		if (o.twist) bone(side + 'ArmTwist', b[side + 'Arm'], [s * 13, 0, 0]);
		bone(side + 'ForeArm', o.twist ? b[side + 'ArmTwist'] : b[side + 'Arm'], [s * (o.twist ? 13 : 26), 0, 0]);
		bone(side + 'Hand', b[side + 'ForeArm'], [s * 24, 0, 0]);
		bone(side + 'UpLeg', b.Hips, [s * 9, 0, -5]);
		bone(side + 'Leg', b[side + 'UpLeg'], [0, 0, -42]);
		bone(side + 'Foot', b[side + 'Leg'], [0, 0, -42]);
	}
	root.updateMatrixWorld(true);
	/** @type {Record<string, string>} VRM bone -> node name */
	const map = {
		hips: P + 'Hips', spine: P + 'Spine', chest: P + 'Spine1', upperChest: P + 'Spine2', neck: P + 'Neck', head: P + 'Head',
		leftShoulder: P + 'LeftShoulder', leftUpperArm: P + 'LeftArm', leftLowerArm: P + 'LeftForeArm', leftHand: P + 'LeftHand',
		rightShoulder: P + 'RightShoulder', rightUpperArm: P + 'RightArm', rightLowerArm: P + 'RightForeArm', rightHand: P + 'RightHand',
		leftUpperLeg: P + 'LeftUpLeg', leftLowerLeg: P + 'LeftLeg', leftFoot: P + 'LeftFoot',
		rightUpperLeg: P + 'RightUpLeg', rightLowerLeg: P + 'RightLeg', rightFoot: P + 'RightFoot'
	};
	return { root, bones: b, map };
}

/** a walk-ish clip on the rig: hips travel + bob, spine twist, arm + leg swing, keys at 30 fps */
export function makeClip(P = 'mixamorig', twist = false) {
	const fps = 30;
	const n = 31;
	const times = Array.from({ length: n }, (_, i) => i / fps);
	const q = (/** @type {number[]} */ axis, /** @type {(t: number) => number} */ angle) =>
		times.flatMap((t) => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(...axis).normalize(), angle(t)).toArray());
	const tracks = [
		new THREE.VectorKeyframeTrack(P + 'Hips.position', times, times.flatMap((t) => [0, -120 * t, 100 + 3 * Math.sin(t * 12)])),
		new THREE.QuaternionKeyframeTrack(P + 'Spine.quaternion', times, q([0, 0, 1], (t) => 0.3 * Math.sin(t * 6))),
		new THREE.QuaternionKeyframeTrack(P + 'LeftArm.quaternion', times, times.flatMap((t) => new THREE.Quaternion().setFromEuler(new THREE.Euler(0.5 * Math.sin(t * 6), 0.6, 0)).toArray())),
		new THREE.QuaternionKeyframeTrack(P + 'RightArm.quaternion', times, times.flatMap((t) => new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.5 * Math.sin(t * 6), -0.6, 0)).toArray())),
		new THREE.QuaternionKeyframeTrack(P + 'LeftForeArm.quaternion', times, q([0, 0, 1], (t) => 0.4 + 0.2 * Math.sin(t * 6))),
		new THREE.QuaternionKeyframeTrack(P + 'LeftUpLeg.quaternion', times, q([1, 0, 0], (t) => 0.6 * Math.sin(t * 6))),
		new THREE.QuaternionKeyframeTrack(P + 'RightUpLeg.quaternion', times, q([1, 0, 0], (t) => -0.6 * Math.sin(t * 6))),
		new THREE.QuaternionKeyframeTrack(P + 'LeftLeg.quaternion', times, q([1, 0, 0], (t) => Math.max(0, -0.8 * Math.sin(t * 6))))
	];
	if (twist) tracks.push(new THREE.QuaternionKeyframeTrack(P + 'LeftArmTwist.quaternion', times, q([1, 0, 0], (t) => 0.5 * t)));
	return new THREE.AnimationClip('Walk', 1, tracks);
}

/** the rest pose of every node, captured before any mixer touches it */
export function captureRest(/** @type {THREE.Object3D} */ root) {
	const m = new Map();
	root.traverse((o) => m.set(o, { p: o.position.toArray(), q: o.quaternion.toArray(), s: o.scale.toArray() }));
	return (/** @type {THREE.Object3D} */ o) => m.get(o) ?? null;
}

