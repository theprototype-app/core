// @ts-nocheck — plain bone lists, no three.js
// 57 M2: the humanoid map is DETECTED from a rig's bone names (Mixamo, KayKit, Meshy, VRoid/UniRig,
// Unreal/Quaternius), the hierarchy decides the spine order (Meshy writes it top-down), and a rig with
// numbered bones falls back to its shape.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import {
	detectHumanoidMap,
	readBoneName,
	REQUIRED_BONES,
	rigFamily,
	presentParent,
	applyMapOverrides,
	normalizeHumanoidMap,
	mirrorBone,
	VRM_BONES
} from '../../src/lib/humanoid/humanoidMap.js';

/** ['Name', [x,y,z] local offset, ...children] -> BoneEntry[] with root-space positions */
function tree(spec) {
	const out = [];
	const walk = (node, parent, base) => {
		const [name, off, ...kids] = node;
		const pos = [base[0] + off[0], base[1] + off[1], base[2] + off[2]];
		const i = out.length;
		out.push({ name, parent, pos });
		for (const k of kids) walk(k, i, pos);
	};
	walk(spec, -1, [0, 0, 0]);
	return out;
}

const side = (s, f) => [f(s, s === 'Left' ? 1 : -1)];

function mixamo(prefix = 'mixamorig:') {
	const p = (n) => prefix + n;
	const arm = (S, x) => [
		p(S + 'Shoulder'), [0.05 * x, 0.1, 0],
		[p(S + 'Arm'), [0.1 * x, 0, 0],
			[p(S + 'ForeArm'), [0.25 * x, 0, 0],
				[p(S + 'Hand'), [0.25 * x, 0, 0],
					[p(S + 'HandThumb1'), [0.02 * x, 0, 0.03], [p(S + 'HandThumb2'), [0.03 * x, 0, 0.01], [p(S + 'HandThumb3'), [0.03 * x, 0, 0], [p(S + 'HandThumb4'), [0.02 * x, 0, 0]]]]],
					[p(S + 'HandIndex1'), [0.08 * x, 0, 0.02], [p(S + 'HandIndex2'), [0.03 * x, 0, 0], [p(S + 'HandIndex3'), [0.02 * x, 0, 0]]]]
				]
			]
		]
	];
	const leg = (S, x) => [p(S + 'UpLeg'), [0.1 * x, -0.05, 0], [p(S + 'Leg'), [0, -0.45, 0], [p(S + 'Foot'), [0, -0.45, 0], [p(S + 'ToeBase'), [0, -0.05, 0.1], [p(S + 'Toe_End'), [0, 0, 0.05]]]]]];
	return tree([
		p('Hips'), [0, 1, 0],
		[p('Spine'), [0, 0.1, 0], [p('Spine1'), [0, 0.12, 0], [p('Spine2'), [0, 0.12, 0], [p('Neck'), [0, 0.15, 0], [p('Head'), [0, 0.1, 0], [p('HeadTop_End'), [0, 0.2, 0]]]], arm('Left', 1), arm('Right', -1)]]],
		leg('Left', 1),
		leg('Right', -1)
	]);
}

describe('57 M2 bone-name reading', () => {
	it('reads side + part across the conventions', () => {
		expect(readBoneName('mixamorig:LeftForeArm')).toMatchObject({ side: 'left', part: 'lowerArm' });
		expect(readBoneName('mixamorigRightUpLeg')).toMatchObject({ side: 'right', part: 'upperLeg' });
		expect(readBoneName('upperarm.l')).toMatchObject({ side: 'left', part: 'upperArm' });
		expect(readBoneName('upperarml')).toMatchObject({ side: 'left', part: 'upperArm' }); // three sanitized the '.'
		expect(readBoneName('J_Bip_R_LowerLeg')).toMatchObject({ side: 'right', part: 'lowerLeg' });
		expect(readBoneName('J_Bip_C_UpperChest')).toMatchObject({ side: '', part: 'spine' });
		expect(readBoneName('thigh_l')).toMatchObject({ side: 'left', part: 'upperLeg' });
		expect(readBoneName('calf_r')).toMatchObject({ side: 'right', part: 'lowerLeg' });
		expect(readBoneName('clavicle_l')).toMatchObject({ side: 'left', part: 'shoulder' });
		expect(readBoneName('index_02_l')).toMatchObject({ side: 'left', part: 'finger', seg: 2 });
		expect(readBoneName('LeftHandPinky3')).toMatchObject({ side: 'left', part: 'finger', seg: 3 });
		expect(readBoneName('pelvis')).toMatchObject({ part: 'hips' });
	});

	it('helpers and end markers are never humanoid bones', () => {
		for (const n of ['HeadTop_End', 'head_end', 'headfront', 'handslot.l', 'kneeIK.l', 'control-toe-roll.r', 'IK-foot.l', 'upperarm_twist_01_l', 'root', 'Armature'])
			expect(readBoneName(n).part, n).toBe('');
	});
});

describe('57 M2 humanoid map detection', () => {
	it('Mixamo (colon and sanitized prefixes) maps every required bone + fingers', () => {
		for (const prefix of ['mixamorig:', 'mixamorig', 'mixamorig1:', '']) {
			const m = detectHumanoidMap(mixamo(prefix));
			expect(m.ok, prefix).toBe(true);
			expect(m.missing).toEqual([]);
			expect(m.map.hips).toBe(prefix + 'Hips');
			expect(m.map.spine).toBe(prefix + 'Spine');
			expect(m.map.chest).toBe(prefix + 'Spine1');
			expect(m.map.upperChest).toBe(prefix + 'Spine2');
			expect(m.map.leftUpperArm).toBe(prefix + 'LeftArm');
			expect(m.map.leftLowerArm).toBe(prefix + 'LeftForeArm');
			expect(m.map.rightUpperLeg).toBe(prefix + 'RightUpLeg');
			expect(m.map.rightLowerLeg).toBe(prefix + 'RightLeg');
			expect(m.map.leftToes).toBe(prefix + 'LeftToeBase');
			expect(m.map.leftThumbMetacarpal).toBe(prefix + 'LeftHandThumb1');
			expect(m.map.leftThumbDistal).toBe(prefix + 'LeftHandThumb3');
			expect(m.map.rightIndexIntermediate).toBe(prefix + 'RightHandIndex2');
		}
		expect(rigFamily(mixamo().map((b) => b.name))).toBe('mixamo');
	});

	it('Meshy: the spine is read off the hierarchy (Hips > Spine02 > Spine01 > Spine)', () => {
		const arm = (S, x) => [S + 'Shoulder', [0.05 * x, 0.05, 0], [S + 'Arm', [0.1 * x, 0, 0], [S + 'ForeArm', [0.25 * x, 0, 0], [S + 'Hand', [0.25 * x, 0, 0]]]]];
		const leg = (S, x) => [S + 'UpLeg', [0.1 * x, -0.05, 0], [S + 'Leg', [0, -0.45, 0], [S + 'Foot', [0, -0.45, 0], [S + 'ToeBase', [0, -0.05, 0.1]]]]];
		const bones = tree(['Hips', [0, 1, 0], leg('Left', 1), leg('Right', -1), ['Spine02', [0, 0.1, 0], ['Spine01', [0, 0.12, 0], ['Spine', [0, 0.12, 0], arm('Left', 1), arm('Right', -1), ['neck', [0, 0.15, 0], ['Head', [0, 0.1, 0], ['head_end', [0, 0.2, 0]], ['headfront', [0, 0.1, 0.1]]]]]]]]);
		const m = detectHumanoidMap(bones);
		expect(m.ok).toBe(true);
		expect([m.map.spine, m.map.chest, m.map.upperChest]).toEqual(['Spine02', 'Spine01', 'Spine']);
		expect(m.map.neck).toBe('neck');
		expect(m.map.head).toBe('Head');
		expect(rigFamily(bones.map((b) => b.name))).toBe('meshy');
	});

	it('KayKit (the shipped avatar GLB, raw and sanitized names): hand beats wrist, no neck', () => {
		const b = fs.readFileSync(new URL('../../static/avatars/knight.glb', import.meta.url));
		const json = JSON.parse(b.subarray(20, 20 + b.readUInt32LE(12)).toString());
		const parent = new Map();
		json.nodes.forEach((n, i) => (n.children ?? []).forEach((c) => parent.set(c, i)));
		for (const sanitize of [false, true]) {
			const bones = json.nodes.map((n, i) => ({
				name: sanitize ? n.name.replace(/[\[\]\.:\/]/g, '') : n.name,
				parent: parent.has(i) ? parent.get(i) : -1
			}));
			const m = detectHumanoidMap(bones);
			expect(m.ok, 'sanitized ' + sanitize).toBe(true);
			const dot = sanitize ? '' : '.';
			expect(m.map).toMatchObject({
				hips: 'hips',
				spine: 'spine',
				chest: 'chest',
				head: 'head',
				leftUpperArm: 'upperarm' + dot + 'l',
				leftLowerArm: 'lowerarm' + dot + 'l',
				leftHand: 'hand' + dot + 'l',
				rightUpperLeg: 'upperleg' + dot + 'r',
				rightFoot: 'foot' + dot + 'r',
				leftToes: 'toes' + dot + 'l'
			});
			expect(m.map.neck).toBeUndefined();
			expect(rigFamily(bones.map((x) => x.name))).toBe('kaykit');
		}
	});

	it('VRoid / UniRig-VRoid (J_Bip_*) and Unreal / Quaternius (pelvis, clavicle_l, thigh_l)', () => {
		const vroidArm = (S, x) => ['J_Bip_' + S + '_Shoulder', [0.05 * x, 0.1, 0], ['J_Bip_' + S + '_UpperArm', [0.1 * x, 0, 0], ['J_Bip_' + S + '_LowerArm', [0.25 * x, 0, 0], ['J_Bip_' + S + '_Hand', [0.25 * x, 0, 0], ['J_Bip_' + S + '_Little1', [0.08 * x, 0, -0.02], ['J_Bip_' + S + '_Little2', [0.02 * x, 0, 0], ['J_Bip_' + S + '_Little3', [0.02 * x, 0, 0]]]]]]]];
		const vroidLeg = (S, x) => ['J_Bip_' + S + '_UpperLeg', [0.1 * x, -0.05, 0], ['J_Bip_' + S + '_LowerLeg', [0, -0.45, 0], ['J_Bip_' + S + '_Foot', [0, -0.45, 0], ['J_Bip_' + S + '_ToeBase', [0, -0.05, 0.1]]]]];
		const vroid = tree(['Root', [0, 0, 0], ['J_Bip_C_Hips', [0, 1, 0], vroidLeg('L', 1), vroidLeg('R', -1), ['J_Bip_C_Spine', [0, 0.1, 0], ['J_Bip_C_Chest', [0, 0.1, 0], ['J_Bip_C_UpperChest', [0, 0.1, 0], vroidArm('L', 1), vroidArm('R', -1), ['J_Bip_C_Neck', [0, 0.1, 0], ['J_Bip_C_Head', [0, 0.1, 0]]]]]], ['J_Sec_Hair1_01', [0, 0.5, 0]]]]);
		const v = detectHumanoidMap(vroid);
		expect(v.ok).toBe(true);
		expect(v.map).toMatchObject({ hips: 'J_Bip_C_Hips', upperChest: 'J_Bip_C_UpperChest', leftHand: 'J_Bip_L_Hand', rightLittleDistal: 'J_Bip_R_Little3', leftToes: 'J_Bip_L_ToeBase' });
		expect(rigFamily(vroid.map((b) => b.name))).toBe('vroid');

		const ueArm = (s, x) => ['clavicle_' + s, [0.05 * x, 0.1, 0], ['upperarm_' + s, [0.1 * x, 0, 0], ['upperarm_twist_01_' + s, [0.1 * x, 0, 0]], ['lowerarm_' + s, [0.25 * x, 0, 0], ['hand_' + s, [0.25 * x, 0, 0], ['thumb_01_' + s, [0.02 * x, 0, 0.03], ['thumb_02_' + s, [0.02 * x, 0, 0], ['thumb_03_' + s, [0.02 * x, 0, 0]]]]]]]];
		const ueLeg = (s, x) => ['thigh_' + s, [0.1 * x, -0.05, 0], ['calf_' + s, [0, -0.45, 0], ['calf_twist_01_' + s, [0, -0.2, 0]], ['foot_' + s, [0, -0.45, 0], ['ball_' + s, [0, -0.05, 0.1]]]]];
		const ue = tree(['root', [0, 0, 0], ['pelvis', [0, 1, 0], ueLeg('l', 1), ueLeg('r', -1), ['spine_01', [0, 0.1, 0], ['spine_02', [0, 0.1, 0], ['spine_03', [0, 0.1, 0], ueArm('l', 1), ueArm('r', -1), ['neck_01', [0, 0.1, 0], ['head', [0, 0.1, 0]]]]]]], ['ik_foot_root', [0, 0, 0]]]);
		const u = detectHumanoidMap(ue);
		expect(u.ok).toBe(true);
		expect(u.map).toMatchObject({ hips: 'pelvis', spine: 'spine_01', chest: 'spine_02', upperChest: 'spine_03', neck: 'neck_01', leftShoulder: 'clavicle_l', leftUpperArm: 'upperarm_l', rightLowerLeg: 'calf_r', leftToes: 'ball_l', leftThumbProximal: 'thumb_02_l' });
		expect(rigFamily(ue.map((b) => b.name))).toBe('unreal');
	});

	it('numbered bones (UniRig) fall back to the SHAPE: legs down, arms sideways, left = +X', () => {
		let n = 0;
		const b = (off, ...kids) => ['bone_' + n++, off, ...kids];
		// build in an order where ids say nothing
		const leftLeg = b([0.1, -0.05, 0], b([0, -0.45, 0], b([0, -0.45, 0], b([0, -0.05, 0.1]))));
		const rightLeg = b([-0.1, -0.05, 0], b([0, -0.45, 0], b([0, -0.45, 0], b([0, -0.05, 0.1]))));
		const leftArm = b([0.05, 0.05, 0], b([0.12, 0, 0], b([0.25, 0, 0], b([0.25, 0, 0]))));
		const rightArm = b([-0.05, 0.05, 0], b([-0.12, 0, 0], b([-0.25, 0, 0], b([-0.25, 0, 0]))));
		const neck = b([0, 0.15, 0], b([0, 0.12, 0]));
		const bones = tree(b([0, 1, 0], rightLeg, b([0, 0.12, 0], b([0, 0.12, 0], leftArm, neck, rightArm)), leftLeg));
		const m = detectHumanoidMap(bones);
		expect(m.via).toBe('structure');
		expect(m.ok).toBe(true);
		const name = (spec) => spec[0];
		expect(m.map.leftUpperLeg).toBe(name(leftLeg));
		expect(m.map.rightUpperLeg).toBe(name(rightLeg));
		expect(m.map.leftShoulder).toBe(name(leftArm));
		expect(m.map.neck).toBe(name(neck));
		expect(m.map.head).toBe(name(neck[2]));
		expect(rigFamily(bones.map((x) => x.name))).toBe('unirig');
	});

	it('a rig without legs says what it is missing', () => {
		const bones = tree(['Hips', [0, 1, 0], ['Spine', [0, 0.1, 0], ['Head', [0, 0.3, 0]]]]);
		const m = detectHumanoidMap(bones);
		expect(m.ok).toBe(false);
		expect(m.missing).toContain('leftUpperLeg');
		expect(m.missing).toContain('rightHand');
	});
});

describe('57 M2 map helpers', () => {
	it('the bone table is VRM 1.0 (55 bones, 15 required, parent-first)', () => {
		expect(VRM_BONES.length).toBe(55);
		expect(REQUIRED_BONES.length).toBe(15);
		const seen = new Set();
		for (const b of VRM_BONES) {
			if (b.parent) expect(seen.has(b.parent), b.name).toBe(true);
			seen.add(b.name);
		}
	});

	it('presentParent skips bones a model lacks; overrides fix or unmap; normalize drops junk', () => {
		const map = { hips: 'h', spine: 's', head: 'hd', leftShoulder: 'ls' };
		expect(presentParent('head', map)).toBe('spine');
		expect(presentParent('leftShoulder', map)).toBe('spine');
		expect(presentParent('hips', map)).toBe(null);
		expect(applyMapOverrides(map, { head: 'Head2', leftShoulder: '', bogus: 'x' })).toEqual({ hips: 'h', spine: 's', head: 'Head2' });
		expect(normalizeHumanoidMap({ hips: 'h', nope: 'x', spine: 3 })).toEqual({ hips: 'h' });
		expect(mirrorBone('leftUpperArm')).toBe('rightUpperArm');
		expect(mirrorBone('rightIndexDistal')).toBe('leftIndexDistal');
		expect(mirrorBone('spine')).toBe('');
	});
});
