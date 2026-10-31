// @ts-nocheck — plain three rigs
// 57 M1 x M2 (the union): a clip written in 57-clips' `.tpanim` shape (VRM normalized space) and
// read back is bound through 57-chars' retarget (`tpSnapshot` + `retargetClip`). Onto the rig it came
// from it must give back the pose it was made of — rest rotations that are not identity included.
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
	tpFromThreeClip,
	toHumanoid,
	encodeTpanim,
	decodeTpanim,
	tpToThreeClip
} from '../../src/lib/tpanim/format.js';
import { rigSnapshot, retargetClip, tpSnapshot } from '../../src/lib/humanoid/retarget.js';

const q = (axis, deg) =>
	new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(...axis).normalize(), (deg * Math.PI) / 180);

/** a small Mixamo-named humanoid; the arms rest turned (an A-pose done by rotation) */
function makeRig() {
	const root = new THREE.Group();
	const bones = {};
	const add = (name, parent, t, r = null) => {
		const b = new THREE.Bone();
		b.name = name;
		b.position.fromArray(t);
		if (r) b.quaternion.copy(r);
		(parent ? bones[parent] : root).add(b);
		bones[name] = b;
	};
	add('mixamorigHips', null, [0, 1, 0]);
	add('mixamorigSpine', 'mixamorigHips', [0, 0.2, 0]);
	add('mixamorigHead', 'mixamorigSpine', [0, 0.5, 0]);
	add('mixamorigLeftArm', 'mixamorigSpine', [0.2, 0.3, 0], q([0, 0, 1], -35));
	add('mixamorigLeftForeArm', 'mixamorigLeftArm', [0.3, 0, 0]);
	add('mixamorigLeftHand', 'mixamorigLeftForeArm', [0.25, 0, 0]);
	add('mixamorigRightArm', 'mixamorigSpine', [-0.2, 0.3, 0], q([0, 0, 1], 35));
	add('mixamorigRightForeArm', 'mixamorigRightArm', [-0.3, 0, 0]);
	add('mixamorigRightHand', 'mixamorigRightForeArm', [-0.25, 0, 0]);
	for (const side of ['Left', 'Right']) {
		const x = side === 'Left' ? 0.1 : -0.1;
		add(`mixamorig${side}UpLeg`, 'mixamorigHips', [x, -0.05, 0]);
		add(`mixamorig${side}Leg`, `mixamorig${side}UpLeg`, [0, -0.45, 0]);
		add(`mixamorig${side}Foot`, `mixamorig${side}Leg`, [0, -0.45, 0]);
	}
	root.updateMatrixWorld(true);
	const map = {
		hips: 'mixamorigHips',
		spine: 'mixamorigSpine',
		head: 'mixamorigHead',
		leftUpperArm: 'mixamorigLeftArm',
		leftLowerArm: 'mixamorigLeftForeArm',
		leftHand: 'mixamorigLeftHand',
		rightUpperArm: 'mixamorigRightArm',
		rightLowerArm: 'mixamorigRightForeArm',
		rightHand: 'mixamorigRightHand',
		leftUpperLeg: 'mixamorigLeftUpLeg',
		leftLowerLeg: 'mixamorigLeftLeg',
		leftFoot: 'mixamorigLeftFoot',
		rightUpperLeg: 'mixamorigRightUpLeg',
		rightLowerLeg: 'mixamorigRightLeg',
		rightFoot: 'mixamorigRightFoot'
	};
	return { root, bones, map };
}

/** root-space world rotation of a bone once the clip's frame-`t` values are applied */
function worldRotAt(rig, clip, t, name) {
	const mixer = new THREE.AnimationMixer(rig.root);
	mixer.clipAction(clip).play();
	mixer.setTime(t);
	rig.root.updateMatrixWorld(true);
	const out = new THREE.Quaternion();
	rig.bones[name].getWorldQuaternion(out);
	mixer.stopAllAction();
	mixer.uncacheRoot(rig.root);
	return out;
}

const angle = (a, b) => (2 * Math.acos(Math.min(1, Math.abs(a.dot(b))))) * (180 / Math.PI);

describe('57 union: .tpanim humanoid clips bind through the M2 retarget', () => {
	it('a clip written by encodeTpanim comes back onto its own rig as the same pose', () => {
		const rig = makeRig();
		const restOf = new Map();
		rig.root.traverse((o) => {
			if (o !== rig.root)
				restOf.set(o, { p: o.position.toArray(), q: o.quaternion.toArray(), s: o.scale.toArray() });
		});
		const armRest = rig.bones.mixamorigLeftArm.quaternion.clone();
		const clip = new THREE.AnimationClip('Wave', 1, [
			new THREE.QuaternionKeyframeTrack(
				'mixamorigLeftArm.quaternion',
				[0, 0.5, 1],
				[...armRest.toArray(), ...q([1, 0, 0], 40).premultiply(armRest).toArray(), ...q([0, 0, 1], 80).multiply(armRest).toArray()]
			),
			new THREE.QuaternionKeyframeTrack(
				'mixamorigSpine.quaternion',
				[0, 1],
				[0, 0, 0, 1, ...q([0, 1, 0], 25).toArray()]
			),
			new THREE.VectorKeyframeTrack('mixamorigHips.position', [0, 1], [0, 1, 0, 0, 1, 0.8])
		]);

		const tp = tpFromThreeClip(rig.root, clip, { fps: 30, rest: (o) => restOf.get(o) ?? null });
		const bytes = encodeTpanim(toHumanoid(tp, rig.map));
		const back = decodeTpanim(bytes);
		expect(back.humanoid?.hips).toBeTypeOf('number');

		const target = rigSnapshot(rig.root, rig.map);
		const bound = retargetClip(tpToThreeClip(back), tpSnapshot(back), target, { fps: 30 });
		// the clip names the rig's OWN nodes
		expect(bound.tracks.some((t) => t.name === 'mixamorigLeftArm.quaternion')).toBe(true);

		for (const t of [0, 0.5, 1])
			for (const name of ['mixamorigLeftArm', 'mixamorigSpine', 'mixamorigLeftForeArm']) {
				const want = worldRotAt(rig, clip, t, name);
				const got = worldRotAt(rig, bound, t, name);
				expect(angle(want, got), `${name} at ${t}s`).toBeLessThan(0.5);
			}
		// the hips travel comes across at the same size (same rig)
		const hips = bound.tracks.find((t) => t.name === 'mixamorigHips.position');
		expect(hips.values[hips.values.length - 1]).toBeCloseTo(0.8, 2);
	});

	it('tpSnapshot orders a file skeleton parent-first and names it the way tracks bind', () => {
		const tp = {
			nodes: [
				{ name: 'leftUpperArm', parent: 2, t: [0.2, 0.3, 0], r: [0, 0, 0, 1], s: [1, 1, 1] },
				{ name: 'hips', parent: -1, t: [0, 1, 0], r: [0, 0, 0, 1], s: [1, 1, 1] },
				{ name: 'spine.001', parent: 1, t: [0, 0.2, 0], r: [0, 0, 0, 1], s: [1, 1, 1] }
			],
			humanoid: { leftUpperArm: 0, hips: 1, spine: 2 }
		};
		const snap = tpSnapshot(tp);
		expect(snap.nodes.map((n) => n.name)).toEqual(['hips', 'spine001', 'leftUpperArm']);
		expect(snap.nodes.map((n) => n.parent)).toEqual([-1, 0, 1]);
		expect(snap.map).toEqual({ leftUpperArm: 'leftUpperArm', hips: 'hips', spine: 'spine001' });
	});
});
