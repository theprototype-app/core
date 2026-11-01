// @ts-nocheck — drives the writers on the shipped KayKit GLB and hand-made rigs
// 57 M9: clips added to a model's OWN bytes (the rest of the file untouched), clips as their own
// files (.tpanim / .glb / .vrma shape), and the BVH writer round trip through three's BVHLoader:
// every joint lands where the rig puts it, at frame 0 and mid-clip.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { BVHLoader } from 'three/examples/jsm/loaders/BVHLoader.js';
import {
	readGlb,
	writeGlb,
	nodeIndexByName,
	isGlb,
	animationNames
} from '../../src/lib/download/glbEdit.js';
import { writeClipFile, glbWithClips, plainClip } from '../../src/lib/download/clipFiles.js';
import { writeBvh } from '../../src/lib/download/bvhWriter.js';
import {
	bindClip,
	localsAt,
	worldMatrices,
	skeletonSignature
} from '../../src/lib/download/rigSample.js';

globalThis.self = globalThis;
const knightBytes = () => {
	const b = fs.readFileSync(new URL('../../static/avatars/knight.glb', import.meta.url));
	return new Uint8Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
};
const parse = (bytes) =>
	new Promise((resolve, reject) => {
		const err = console.error;
		const warn = console.warn;
		console.error = () => {};
		console.warn = () => {};
		const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
		new GLTFLoader().parse(
			u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength),
			'',
			(g) => {
				console.error = err;
				console.warn = warn;
				resolve(g);
			},
			(e) => {
				console.error = err;
				console.warn = warn;
				reject(e);
			}
		);
	});

const q = (axis, deg) =>
	new THREE.Quaternion()
		.setFromAxisAngle(new THREE.Vector3(...axis).normalize(), (deg * Math.PI) / 180)
		.toArray();

/** a rig with a scaled non-bone Armature (Mixamo FBX style), rest rotations and a hips walk */
function rig() {
	const rows = [
		{
			name: 'Armature',
			parent: -1,
			t: [0, 0, 0],
			q: q([1, 0, 0], 0),
			s: [0.01, 0.01, 0.01],
			bone: false
		},
		{ name: 'Hips', parent: 0, t: [0, 100, 0], q: q([0, 1, 0], 10), s: [1, 1, 1], bone: true },
		{ name: 'Spine', parent: 1, t: [0, 10, 0], q: q([1, 0, 0], 5), s: [1, 1, 1], bone: true },
		{ name: 'Head', parent: 2, t: [0, 50, 0], q: q([0, 0, 1], 0), s: [1, 1, 1], bone: true },
		{ name: 'LeftArm', parent: 2, t: [20, 30, 0], q: q([0, 0, 1], -40), s: [1, 1, 1], bone: true },
		{
			name: 'LeftForeArm',
			parent: 4,
			t: [30, 0, 0],
			q: q([0, 1, 0], 15),
			s: [1, 1, 1],
			bone: true
		},
		{
			name: 'LeftUpLeg',
			parent: 1,
			t: [10, -5, 0],
			q: q([0, 0, 1], 180),
			s: [1, 1, 1],
			bone: true
		},
		{ name: 'LeftLeg', parent: 6, t: [0, 45, 0], q: q([1, 0, 0], 3), s: [1, 1, 1], bone: true }
	];
	const arm0 = new THREE.Quaternion().fromArray(rows[4].q);
	const arm1 = new THREE.Quaternion().fromArray(q([1, 0, 0], 70)).multiply(arm0);
	const clip = new THREE.AnimationClip('Wave', 2, [
		new THREE.QuaternionKeyframeTrack(
			'LeftArm.quaternion',
			[0, 1, 2],
			[...arm0.toArray(), ...arm1.toArray(), ...arm0.toArray()]
		),
		new THREE.QuaternionKeyframeTrack(
			'.bones[LeftLeg].quaternion',
			[0, 2],
			[...rows[7].q, ...q([1, 0, 0], 60)]
		),
		new THREE.VectorKeyframeTrack('Hips.position', [0, 2], [0, 100, 0, 0, 100, 80])
	]);
	return { rows, clip };
}

describe('57 M9 GLB edit', () => {
	it('read -> write keeps the file (JSON equal, BIN byte-identical)', () => {
		const src = knightBytes();
		expect(isGlb(src)).toBe(true);
		const doc = readGlb(src);
		const out = readGlb(writeGlb(doc));
		expect(out.json).toEqual(readGlb(src).json);
		expect(Buffer.from(out.bin).equals(Buffer.from(readGlb(src).bin))).toBe(true);
	});

	it('node names resolve the way three names them ("upperarm.l" -> "upperarml")', () => {
		const idx = nodeIndexByName(readGlb(knightBytes()).json);
		expect(idx.get('upperarml')).toBe(idx.get('upperarm.l'));
		expect(idx.get('upperarml')).toBeGreaterThanOrEqual(0);
	});

	it("layout (a): a clip added to the model's own bytes parses back and binds to its bones", async () => {
		const clip = new THREE.AnimationClip('Wave', 1, [
			new THREE.QuaternionKeyframeTrack(
				'upperarml.quaternion',
				[0, 1],
				[...q([0, 0, 1], 0), ...q([0, 0, 1], 90)]
			)
		]);
		const { bytes, added, dropped } = glbWithClips(knightBytes(), [clip], null);
		expect(added).toBe(1);
		expect(dropped).toBe(0);
		const g = await parse(bytes);
		expect(g.animations.map((a) => a.name)).toEqual(['Wave']);
		expect(g.animations[0].tracks[0].name).toBe('upperarml.quaternion');
		expect(Array.from(g.animations[0].tracks[0].values.slice(4))).toEqual(
			q([0, 0, 1], 90).map((v) => Math.fround(v))
		);
		// layout (c) of the result: strip every clip, keep the model
		const stripped = glbWithClips(bytes, [], []);
		expect(animationNames(readGlb(stripped.bytes).json)).toEqual([]);
		expect(readGlb(stripped.bytes).json.skins.length).toBe(
			readGlb(knightBytes()).json.skins.length
		);
	});
});

describe('57 M9 clip files', () => {
	it('a non-humanoid clip: skeleton + one animation + extras.theprototype', async () => {
		const { rows, clip } = rig();
		const bytes = writeClipFile(rows, clip, { fps: 30, loop: true });
		const doc = readGlb(bytes);
		expect(doc.json.extras.theprototype).toMatchObject({
			format: 1,
			kind: 'clip',
			skeleton: { sig: skeletonSignature(rows), humanoid: false },
			fps: 30,
			frames: 61,
			loop: true,
			rootMotion: false
		});
		expect(doc.json.extensionsUsed).toBeUndefined();
		const g = await parse(bytes);
		expect(g.animations).toHaveLength(1);
		expect(g.animations[0].tracks.map((t) => t.name).sort()).toEqual([
			'Hips.position',
			'LeftArm.quaternion',
			'LeftLeg.quaternion'
		]);
		expect(g.scene.getObjectByName('LeftForeArm')).toBeTruthy();
	});

	it('a humanoid clip is VRM Animation: VRMC_vrm_animation names the human bones', () => {
		const { rows, clip } = rig();
		const doc = readGlb(
			writeClipFile(rows, clip, {
				map: { hips: 'Hips', spine: 'Spine', head: 'Head', leftUpperArm: 'LeftArm' }
			})
		);
		expect(doc.json.extensionsUsed).toEqual(['VRMC_vrm_animation']);
		expect(doc.json.extensions.VRMC_vrm_animation).toEqual({
			specVersion: '1.0',
			humanoid: {
				humanBones: {
					hips: { node: 1 },
					spine: { node: 2 },
					head: { node: 3 },
					leftUpperArm: { node: 4 }
				}
			}
		});
		expect(doc.json.extras.theprototype.skeleton.humanoid).toBe(true);
	});

	it('plainClip resamples a smooth track to linear', () => {
		const t = new THREE.VectorKeyframeTrack(
			'Hips.position',
			[0, 1],
			[0, 0, 0, 1, 1, 1],
			THREE.InterpolateSmooth
		);
		const p = plainClip(new THREE.AnimationClip('s', 1, [t]), { fps: 10 });
		expect(p.channels[0].times.length).toBe(11);
		expect(p.channels[0].step).toBeUndefined();
	});
});

describe('57 M9 BVH writer round trip', () => {
	it('every joint lands where the rig puts it (frame 0, mid-clip, last frame), through BVHLoader', () => {
		const { rows, clip } = rig();
		const { text, joints, frames } = writeBvh(rows, clip, { fps: 30 });
		expect(joints).toEqual([
			'Hips',
			'Spine',
			'Head',
			'LeftArm',
			'LeftForeArm',
			'LeftUpLeg',
			'LeftLeg'
		]);
		expect(frames).toBe(61);
		expect(text.startsWith('HIERARCHY\nROOT Hips')).toBe(true);
		const res = new BVHLoader().parse(text);
		const bones = res.skeleton.bones;
		const mixer = new THREE.AnimationMixer(bones[0]);
		mixer.clipAction(res.clip).play();
		const bound = bindClip(rows, clip);
		for (const t of [0, 1, 2]) {
			mixer.setTime(Math.min(t, res.clip.duration - 1e-6));
			bones[0].updateMatrixWorld(true);
			const M = worldMatrices(rows, localsAt(rows, bound, t));
			for (const name of joints) {
				const want = new THREE.Vector3().setFromMatrixPosition(
					M[rows.findIndex((r) => r.name === name)]
				);
				const got = new THREE.Vector3().setFromMatrixPosition(
					bones.find((b) => b.name === name).matrixWorld
				);
				expect(got.distanceTo(want), name + ' @' + t).toBeLessThan(1e-3);
			}
		}
	});

	it('names a BVH tool can read; a lone IK helper beside the hips is not the root', () => {
		const { rows, clip } = rig();
		rows.push({
			name: 'IK foot.l',
			parent: 0,
			t: [0, 0, 0],
			q: [0, 0, 0, 1],
			s: [1, 1, 1],
			bone: true
		});
		const { text } = writeBvh(rows, clip);
		expect(text).toMatch(/^ROOT Hips$/m);
		expect(text).not.toMatch(/IK foot/);
	});
});
