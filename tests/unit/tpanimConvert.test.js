// @ts-nocheck — synthetic animation files built inline
// 57 M1 — import conversion: a Mixamo-named BVH becomes a HUMANOID .tpanim (in metres), an
// animation-only GLB becomes one .tpanim per animation, a .vrma keeps its humanoid and gains our
// extras, a model GLB is left alone.
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { convertAnimationFile } from '../../src/lib/tpanim/convert.js';
import { decodeTpanim, encodeTpanim, tpFromThreeClip, toHumanoid, humanoidFrames } from '../../src/lib/tpanim/format.js';
import { packGlb } from '../../src/lib/tpanim/glb.js';
import { makeRig, makeClip, captureRest } from './helpers/tpanimRig.js';

/** a small Mixamo-named BVH: hips in cm, the spine, a head, both arms and legs; 3 frames at 30 fps */
function bvh() {
	const j = (name, off, kids = '', end = false) =>
		`JOINT ${name}\n{\nOFFSET ${off}\nCHANNELS 3 Zrotation Xrotation Yrotation\n${kids}${end ? 'End Site\n{\nOFFSET 0 5 0\n}\n' : ''}}\n`;
	const arm = (s, x) => j(s + 'Shoulder', `${x * 5} 10 0`, j(s + 'Arm', `${x * 10} 0 0`, j(s + 'ForeArm', `${x * 25} 0 0`, j(s + 'Hand', `${x * 22} 0 0`, '', true))));
	const leg = (s, x) => j(s + 'UpLeg', `${x * 9} -5 0`, j(s + 'Leg', '0 -42 0', j(s + 'Foot', '0 -42 0', '', true)));
	const spine = j('Spine', '0 10 0', j('Spine1', '0 12 0', j('Spine2', '0 12 0', j('Neck', '0 14 0', j('Head', '0 8 0', '', true)) + arm('Left', 1) + arm('Right', -1))));
	const hier = `HIERARCHY\nROOT Hips\n{\nOFFSET 0 0 0\nCHANNELS 6 Xposition Yposition Zposition Zrotation Xrotation Yrotation\n${spine}${leg('Left', 1)}${leg('Right', -1)}}\n`;
	const joints = (hier.match(/CHANNELS 3/g) ?? []).length;
	const frame = (f) => [0, 100, f * 4, 0, 0, f * 5, ...Array.from({ length: joints * 3 }, (_, i) => (i % 3 === 1 ? f * 10 : 0))].join(' ');
	return hier + `MOTION\nFrames: 3\nFrame Time: 0.0333333\n${[0, 1, 2].map(frame).join('\n')}\n`;
}

describe('convertAnimationFile', () => {
	it('a Mixamo-named BVH becomes one HUMANOID clip, stored in metres', async () => {
		const out = await convertAnimationFile(new File([bvh()], 'walk.bvh'));
		expect(out.map((f) => f.name)).toEqual(['walk.tpanim']);
		const tp = decodeTpanim(await out[0].arrayBuffer());
		expect(tp.tpExtras).toBe(true);
		expect(tp.humanoid?.hips).toBeDefined();
		expect(tp.humanoid?.leftUpperArm).toBeDefined();
		expect(tp.fps).toBe(30);
		expect(tp.provenance?.source).toBe('walk.bvh');
		const fr = humanoidFrames(tp);
		expect(fr.restHipsY).toBeCloseTo(1, 3); // 100 cm hips -> 1 m
		// the hips travel 4 cm a frame along z in the source
		expect(fr.hips[2 * 3 + 2] - fr.hips[2]).toBeCloseTo(0.08, 3);
	});

	it('an animation-only GLB becomes one clip per animation; a model GLB is not touched', async () => {
		const { root, map } = makeRig();
		const rest = captureRest(root);
		const a = tpFromThreeClip(root, makeClip(), { rest });
		// a plain two-animation GLB (no extras): nodes + two animations
		const bytes = encodeTpanim({ ...a, tpExtras: false });
		const { unpackGlb } = await import('../../src/lib/tpanim/glb.js');
		const { json, bin } = unpackGlb(bytes);
		delete json.extras;
		json.animations.push({ ...json.animations[0], name: 'Wave' });
		const two = packGlb(json, bin);
		const out = await convertAnimationFile(new File([two], 'moves.glb'));
		expect(out.map((f) => f.name)).toEqual(['moves - Walk.tpanim', 'moves - Wave.tpanim']);
		const wave = decodeTpanim(await out[1].arrayBuffer());
		expect(wave.name).toBe('Wave');
		expect(wave.humanoid?.hips).toBeDefined(); // the Mixamo names made it humanoid
		// a GLB with a mesh is a model
		const model = packGlb({ asset: { version: '2.0' }, meshes: [{ primitives: [] }], nodes: [{ mesh: 0 }], scenes: [{ nodes: [0] }] }, null);
		expect(await convertAnimationFile(new File([model], 'chair.glb'))).toBe(null);
		expect(map.hips).toBe('mixamorigHips');
	});

	it('a .vrma keeps its humanoid and gains our extras', async () => {
		const { root, map } = makeRig();
		const hum = toHumanoid(tpFromThreeClip(root, makeClip(), { rest: captureRest(root) }), map);
		const raw = encodeTpanim(hum);
		const { unpackGlb } = await import('../../src/lib/tpanim/glb.js');
		const { json, bin } = unpackGlb(raw);
		delete json.extras; // as another tool would write it
		const out = await convertAnimationFile(new File([packGlb(json, bin)], 'dance.vrma'));
		const tp = decodeTpanim(await out[0].arrayBuffer());
		expect(out[0].name).toBe('dance.tpanim');
		expect(tp.tpExtras).toBe(true);
		expect(Object.keys(tp.humanoid).length).toBe(Object.keys(hum.humanoid).length);
	});

	it('other files are not animation files', async () => {
		expect(await convertAnimationFile(new File(['x'], 'notes.txt'))).toBe(null);
	});
});
