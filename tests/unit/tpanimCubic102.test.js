// @ts-nocheck -- fixture test: hand-built TpClips
// 102 M8 — `.tpanim` keeps cubic curves: CUBICSPLINE read / write (additive), one Hermite evaluation
// (curveEdit.hermiteInto) in the file's interpolant, resampling turns a curve into LINEAR frames, and a
// GLTFLoader-style cubic track keeps its tangents through tpFromThreeClip.
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { encodeTpanim, decodeTpanim, tpFromThreeClip, tpToThreeClip, tpInterpolant, threeTrackOf, isCubic } from '../../src/lib/tpanim/format.js';
import { resample } from '../../src/lib/tpanim/clipOps.js';
import { normalizeCurve, sampleCurve } from '../../src/lib/curveCore.js';
import { toCubicSpline, splitCubic } from '../../src/lib/curveEdit.js';
import { unpackGlb } from '../../src/lib/tpanim/glb.js';

/** an auto vec3 curve (always exact as CUBICSPLINE) and its TpTrack */
function curveTrack() {
	const keys = normalizeCurve('vec3', [
		{ id: 'a', t: 0, v: [0, 0, 0] },
		{ id: 'b', t: 0.5, v: [1, 2, 0] },
		{ id: 'c', t: 1.25, v: [-1, 0.5, 2] },
		{ id: 'd', t: 2, v: [0, 1, 0] }
	]);
	const cs = toCubicSpline('vec3', keys);
	const { inT, values, outT } = splitCubic(cs.values, 3);
	return { keys, track: { node: 0, path: 'translation', times: Float32Array.from(cs.times), values, interp: 'CUBICSPLINE', inT, outT } };
}
function clipOf(tracks, extra = {}) {
	return {
		name: 'Curve',
		duration: 2,
		fps: 30,
		frames: 60,
		loop: false,
		rootMotion: 'moving',
		nodes: [{ name: 'Box', parent: -1, t: [0, 0, 0], r: [0, 0, 0, 1], s: [1, 1, 1] }],
		tracks,
		humanoid: null,
		sig: 'sk1-test',
		provenance: null,
		tpExtras: true,
		...extra
	};
}

describe('.tpanim CUBICSPLINE', () => {
	it('writes a CUBICSPLINE sampler with [in, v, out] per key and reads the tangents back', () => {
		const { track } = curveTrack();
		const bytes = encodeTpanim(clipOf([track]));
		const { json } = unpackGlb(bytes);
		const sampler = json.animations[0].samplers[0];
		expect(sampler.interpolation).toBe('CUBICSPLINE');
		expect(json.accessors[sampler.output].count).toBe(4 * 3);
		const back = decodeTpanim(bytes);
		const tr = back.tracks[0];
		expect(tr.interp).toBe('CUBICSPLINE');
		expect(isCubic(tr)).toBe(true);
		expect(Array.from(tr.values)).toEqual(Array.from(track.values));
		expect(Array.from(tr.inT)).toEqual(Array.from(track.inT));
		expect(Array.from(tr.outT)).toEqual(Array.from(track.outT));
		// deterministic
		expect(new Uint8Array(encodeTpanim(back))).toEqual(new Uint8Array(bytes));
	});

	it('plays the curve, not straight lines between the keys (the tangents used to be dropped)', () => {
		const { keys, track } = curveTrack();
		const back = decodeTpanim(encodeTpanim(clipOf([track])));
		const ip = tpInterpolant(back.tracks[0]);
		let worst = 0;
		let fromLine = 0;
		for (let t = 0; t <= 2; t += 0.01) {
			const got = Array.from(ip.evaluate(t));
			const want = sampleCurve('vec3', keys, t);
			for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(got[c] - want[c]));
			const lin = tpInterpolant({ ...back.tracks[0], interp: 'LINEAR', inT: undefined, outT: undefined }).evaluate(t);
			for (let c = 0; c < 3; c++) fromLine = Math.max(fromLine, Math.abs(got[c] - lin[c]));
		}
		expect(worst).toBeLessThan(1e-4); // float32 storage
		expect(fromLine).toBeGreaterThan(0.05); // the counterfactual: a linear read is visibly different
	});

	it('a three clip from the file mixes like any other (the GLTFLoader factory flag)', () => {
		const { keys, track } = curveTrack();
		const clip = tpToThreeClip(decodeTpanim(encodeTpanim(clipOf([track]))));
		const box = new THREE.Object3D();
		box.name = 'Box';
		const mixer = new THREE.AnimationMixer(box);
		mixer.clipAction(clip).play();
		mixer.setTime(0.8);
		const want = sampleCurve('vec3', keys, 0.8);
		expect(box.position.x).toBeCloseTo(want[0], 3);
		expect(box.position.y).toBeCloseTo(want[1], 3);
		expect(box.position.z).toBeCloseTo(want[2], 3);
	});

	it('a cubic rotation stays a unit quaternion', () => {
		const times = Float32Array.from([0, 1]);
		const q1 = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 1.2, 0));
		const values = Float32Array.from([0, 0, 0, 1, q1.x, q1.y, q1.z, q1.w]);
		const inT = new Float32Array(8);
		const outT = Float32Array.from([0, 0.9, 0, 0, 0, 0, 0, 0]);
		const ip = tpInterpolant({ node: 0, path: 'rotation', times, values, interp: 'CUBICSPLINE', inT, outT });
		for (let t = 0; t <= 1; t += 0.1) {
			const v = ip.evaluate(t);
			expect(Math.hypot(v[0], v[1], v[2], v[3])).toBeCloseTo(1, 6);
		}
	});

	it('resampling (trim / split / join / loop) turns a curve into LINEAR frames on the curve', () => {
		const { keys, track } = curveTrack();
		const r = resample(clipOf([track]));
		const tr = r.tracks[0];
		expect(tr.interp).toBe('LINEAR');
		expect(tr.inT).toBe(undefined);
		expect(tr.times.length).toBe(61);
		const f = 20;
		const want = sampleCurve('vec3', keys, tr.times[f]);
		for (let c = 0; c < 3; c++) expect(tr.values[f * 3 + c]).toBeCloseTo(want[c], 4);
	});

	it('tpFromThreeClip keeps a GLTFLoader-style cubic track’s tangents', () => {
		const { track } = curveTrack();
		const three = threeTrackOf('Box.position', track);
		const root = new THREE.Object3D();
		const box = new THREE.Object3D();
		box.name = 'Box';
		root.add(box);
		const tp = tpFromThreeClip(root, new THREE.AnimationClip('c', 2, [three]));
		const tr = tp.tracks.find((t) => t.path === 'translation');
		expect(tr.interp).toBe('CUBICSPLINE');
		expect(Array.from(tr.outT)).toEqual(Array.from(track.outT));
		expect(tr.values.length).toBe(track.values.length);
	});

	it('LINEAR and STEP tracks write exactly as before (no tangents, same layout)', () => {
		const lin = { node: 0, path: 'translation', times: Float32Array.from([0, 1]), values: Float32Array.from([0, 0, 0, 1, 1, 1]), interp: 'LINEAR' };
		const step = { ...lin, path: 'scale', interp: 'STEP' };
		const { json } = unpackGlb(encodeTpanim(clipOf([lin, step])));
		expect(json.animations[0].samplers.map((s) => s.interpolation)).toEqual(['LINEAR', 'STEP']);
		expect(json.accessors[json.animations[0].samplers[0].output].count).toBe(2);
		// a CUBICSPLINE label without tangents is written LINEAR (what an older reader would play anyway)
		const bare = { ...lin, interp: 'CUBICSPLINE' };
		const j2 = unpackGlb(encodeTpanim(clipOf([bare]))).json;
		expect(j2.animations[0].samplers[0].interpolation).toBe('LINEAR');
	});
});
