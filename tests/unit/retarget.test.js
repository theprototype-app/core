// @ts-nocheck — plain rig rows
// 57 M2: retargeting moves each mapped bone's WORLD change from rest (rest-pose correction), conjugated
// into the target's facing, with the hips' travel scaled by the size ratio. Same inputs, same clip.
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { makeSnapshot, retargetClip, restBasis, retargetScale } from '../../src/lib/humanoid/retarget.js';

const I = [0, 0, 0, 1];
const ONE = [1, 1, 1];

/** a small humanoid: [vrmBone, nodeName, parentVrm, localPos, localQuat?] */
function rig(rows, { scale = 1, rest = {} } = {}) {
	const nodes = [];
	const map = {};
	const at = new Map();
	for (const [bone, name, parent, t, q] of rows) {
		at.set(bone, nodes.length);
		nodes.push({ name, parent: parent ? at.get(parent) : -1, t: t.map((v) => v * scale), q: rest[bone] ?? q ?? I, s: ONE });
		if (bone[0] !== '_') map[bone] = name;
	}
	return makeSnapshot(nodes, map);
}

const BODY = (n = (b) => b) => [
	['_armature', n('Armature'), null, [0, 0, 0]],
	['hips', n('hips'), '_armature', [0, 1, 0]],
	['spine', n('spine'), 'hips', [0, 0.2, 0]],
	['head', n('head'), 'spine', [0, 0.5, 0]],
	['leftUpperArm', n('upperarm.l'), 'spine', [0.2, 0.3, 0]],
	['leftLowerArm', n('lowerarm.l'), 'leftUpperArm', [0.3, 0, 0]],
	['leftHand', n('hand.l'), 'leftLowerArm', [0.25, 0, 0]],
	['rightUpperArm', n('upperarm.r'), 'spine', [-0.2, 0.3, 0]],
	['rightLowerArm', n('lowerarm.r'), 'rightUpperArm', [-0.3, 0, 0]],
	['rightHand', n('hand.r'), 'rightLowerArm', [-0.25, 0, 0]],
	['leftUpperLeg', n('upperleg.l'), 'hips', [0.1, -0.05, 0]],
	['leftLowerLeg', n('lowerleg.l'), 'leftUpperLeg', [0, -0.45, 0]],
	['leftFoot', n('foot.l'), 'leftLowerLeg', [0, -0.45, 0]],
	['rightUpperLeg', n('upperleg.r'), 'hips', [-0.1, -0.05, 0]],
	['rightLowerLeg', n('lowerleg.r'), 'rightUpperLeg', [0, -0.45, 0]],
	['rightFoot', n('foot.r'), 'rightLowerLeg', [0, -0.45, 0]]
];

const q = (axis, deg) => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(...axis).normalize(), (deg * Math.PI) / 180);

/** a 1 s clip: the left upper arm turns 90° (world) about Z by the end, the hips walk 1 m forward */
function sourceClip(src) {
	const arm = src.nodes[src.index.get(src.map.leftUpperArm)];
	const r0 = new THREE.Quaternion().fromArray(arm.q);
	const r1 = q([0, 0, 1], 90).multiply(r0); // parent (spine) is identity in world → world == local here
	return new THREE.AnimationClip('Wave', 1, [
		new THREE.QuaternionKeyframeTrack(src.map.leftUpperArm + '.quaternion', [0, 1], [...r0.toArray(), ...r1.toArray()]),
		new THREE.VectorKeyframeTrack(src.map.hips + '.position', [0, 1], [0, 1, 0, 0, 1, 1])
	]);
}

/** the target's root-space world rotation of a node at the clip's frame f */
function worldAt(snap, clip, frame) {
	const local = snap.nodes.map((n) => ({ q: new THREE.Quaternion().fromArray(n.q), t: new THREE.Vector3().fromArray(n.t) }));
	for (const tr of clip.tracks) {
		const [node, prop] = tr.name.split(/\.(?=[^.]+$)/);
		const i = snap.index.get(node);
		const v = tr.values;
		if (prop === 'quaternion') local[i].q.fromArray(v, frame * 4);
		else local[i].t.fromArray(v, frame * 3);
	}
	const W = [];
	const P = [];
	snap.nodes.forEach((n, i) => {
		const pq = n.parent >= 0 ? W[n.parent] : new THREE.Quaternion();
		const pp = n.parent >= 0 ? P[n.parent] : new THREE.Vector3();
		W.push(pq.clone().multiply(local[i].q));
		P.push(local[i].t.clone().applyQuaternion(pq).add(pp));
	});
	return { W, P };
}

const angle = (a, b) => (2 * Math.acos(Math.min(1, Math.abs(a.dot(b))))) * (180 / Math.PI);

describe('57 M2 retarget', () => {
	it('onto an identical rig: the clip comes back unchanged (and binds by the target names)', () => {
		const src = rig(BODY());
		const dst = rig(BODY((n) => 'mixamorig' + n.replace('.', '_')));
		const clip = sourceClip(src);
		const out = retargetClip(clip, src, dst, { fps: 10 });
		expect(out.duration).toBe(1);
		expect(out.tracks.map((t) => t.name)).toContain('mixamorigupperarm_l.quaternion');
		expect(out.tracks.map((t) => t.name)).toContain('mixamorighips.position');
		const last = out.tracks[0].times.length - 1;
		const { W, P } = worldAt(dst, out, last);
		expect(angle(W[dst.index.get('mixamorigupperarm_l')], q([0, 0, 1], 90))).toBeLessThan(0.1);
		expect(P[dst.index.get('mixamorighips')].toArray().map((v) => +v.toFixed(4))).toEqual([0, 1, 1]);
		// an unanimated bone stays at rest
		expect(angle(W[dst.index.get('mixamorighead')], new THREE.Quaternion())).toBeLessThan(0.1);
	});

	it('REST-POSE CORRECTION: an A-posed target keeps its own rest and moves by the clip\'s change', () => {
		const src = rig(BODY());
		const aPose = q([0, 0, 1], -45); // left arm 45° down at rest
		const dst = rig(BODY(), { rest: { leftUpperArm: aPose.toArray(), rightUpperArm: q([0, 0, 1], 45).toArray() } });
		const out = retargetClip(sourceClip(src), src, dst, { fps: 10 });
		const a = dst.index.get('upperarm.l');
		const first = worldAt(dst, out, 0).W[a];
		expect(angle(first, aPose)).toBeLessThan(0.1); // frame 0 = the target's own rest, not the source's T
		const last = worldAt(dst, out, out.tracks[0].times.length - 1).W[a];
		expect(angle(last, q([0, 0, 1], 90).multiply(aPose))).toBeLessThan(0.1); // +90° from ITS rest
	});

	it('FACING: a target facing -Z (VRM 0.x) turns the same way relative to its own body', () => {
		const src = rig(BODY());
		// mirror the layout through Y: x and z flip, the character now faces -Z with its left at -X
		const flipped = BODY().map(([b, n, p, t]) => [b, n, p, [-t[0], t[1], -t[2]]]);
		const dst = rig(flipped);
		const basisS = restBasis(src);
		const basisD = restBasis(dst);
		expect(angle(basisD.clone().multiply(basisS.clone().invert()), q([0, 1, 0], 180))).toBeLessThan(0.1);
		const out = retargetClip(sourceClip(src), src, dst, { fps: 10 });
		const last = out.tracks[0].times.length - 1;
		const { W, P } = worldAt(dst, out, last);
		// the source's +90° about +Z is, in a body turned 180° about Y, +90° about -Z
		expect(angle(W[dst.index.get('upperarm.l')], q([0, 0, -1], 90))).toBeLessThan(0.1);
		// and "1 m forward" is 1 m along -Z
		expect(P[dst.index.get('hips')].toArray().map((v) => +v.toFixed(4))).toEqual([0, 1, -1].map((v) => (v === 0 ? 0 : v)));
	});

	it('SIZE: a twice-as-tall target walks twice as far', () => {
		const src = rig(BODY());
		const dst = rig(BODY(), { scale: 2 });
		expect(retargetScale(src, dst)).toBeCloseTo(2, 6);
		const out = retargetClip(sourceClip(src), src, dst, { fps: 10 });
		const { P } = worldAt(dst, out, out.tracks[0].times.length - 1);
		expect(P[dst.index.get('hips')].toArray().map((v) => +v.toFixed(4))).toEqual([0, 2, 2]);
	});

	it('`.bones[name]` tracks bind; unmapped bones of the target are left alone; deterministic', () => {
		const src = rig(BODY());
		const dst = rig(BODY().filter(([b]) => b !== 'rightHand'));
		const clip = sourceClip(src);
		clip.tracks[0].name = '.bones[upperarm.l].quaternion';
		const a = retargetClip(clip, src, dst, { fps: 24 });
		const b = retargetClip(clip, src, dst, { fps: 24 });
		expect(a.tracks.length).toBe(dst.nodes.length - 1 + 1); // every mapped node + the hips position, never the armature
		expect(a.tracks.map((t) => t.name)).not.toContain('Armature.quaternion');
		expect(Array.from(a.tracks[3].values)).toEqual(Array.from(b.tracks[3].values));
		expect(a.tracks[0].times.length).toBe(25);
	});

	it('hipsTranslation:false keeps the hips where they rest', () => {
		const src = rig(BODY());
		const out = retargetClip(sourceClip(src), src, rig(BODY()), { hipsTranslation: false });
		expect(out.tracks.some((t) => t.name.endsWith('.position'))).toBe(false);
	});
});
