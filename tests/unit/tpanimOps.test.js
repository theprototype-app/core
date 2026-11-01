// 57 M3 + M8 — clip operations: in place (stripping), the loop seam + Loop it, trim/split, join
// with crossfades (no snap at the seam), on the Mixamo-style rig under a turned, scaled Armature.
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { tpFromThreeClip, toHumanoid, decodeTpanim, encodeTpanim } from '../../src/lib/tpanim/format.js';
import { resample, stripRootMotion, rootPath, rootTravel, loopSeam, makeLoop, trimClip, splitClip, joinClips, joinProblem, maxFrameJump } from '../../src/lib/tpanim/clipOps.js';
import { makeRig, makeClip, captureRest } from './helpers/tpanimRig.js';

function walkTp() {
	const { root } = makeRig();
	return tpFromThreeClip(root, makeClip(), { rest: captureRest(root) });
}
function humanWalk() {
	const { root, map } = makeRig();
	return toHumanoid(tpFromThreeClip(root, makeClip(), { rest: captureRest(root) }), map);
}

describe('M3 in place', () => {
	for (const [label, make] of /** @type {[string, () => any][]} */ ([['skeleton', walkTp], ['humanoid', humanWalk]])) {
		it(label + ': the root keeps its height and loses its horizontal travel', () => {
			const tp = make();
			const before = rootPath(resample(tp));
			expect(rootTravel(tp).distance).toBeGreaterThan(1); // the walk covers 1.2 m in the model frame
			const flat = stripRootMotion(tp);
			expect(flat.rootMotion).toBe('inplace');
			const after = /** @type {Float32Array} */ (rootPath(resample(flat)));
			for (let k = 0; k < after.length; k += 3) {
				expect(after[k]).toBeCloseTo(after[0], 5);
				expect(after[k + 2]).toBeCloseTo(after[2], 5);
				expect(after[k + 1]).toBeCloseTo(/** @type {Float32Array} */ (before)[k + 1], 5); // the bob stays
			}
			expect(rootTravel(flat).distance).toBeLessThan(1e-4);
			// nothing but the root changed
			const rot = (/** @type {any} */ t) => t.tracks.filter((/** @type {any} */ x) => x.path === 'rotation').map((/** @type {any} */ x) => Array.from(x.values).join());
			expect(rot(flat)).toEqual(rot(tp));
		});
	}

	it('survives the file round trip', () => {
		const back = decodeTpanim(encodeTpanim(stripRootMotion(humanWalk())));
		expect(back.rootMotion).toBe('inplace');
		expect(rootTravel(back).distance).toBeLessThan(1e-3);
	});
});

describe('M3 loop seam + Loop it', () => {
	it('flags a clip whose last frame is not its first, and Loop it closes the seam', () => {
		const tp = walkTp();
		const seam = loopSeam(tp);
		expect(seam.ok).toBe(false);
		expect(seam.angle).toBeGreaterThan(3);
		const looped = makeLoop(tp);
		expect(looped.loop).toBe(true);
		const after = loopSeam(looped);
		expect(after.angle).toBeLessThan(0.01);
		expect(after.jump).toBeLessThan(1e-4);
		expect(after.ok).toBe(true);
		// a moving clip keeps travelling
		expect(rootTravel(looped).distance).toBeCloseTo(rootTravel(tp).distance, 3);
		// and the blend is smooth: no frame jumps more than the clip already did
		expect(maxFrameJump(looped).angle).toBeLessThan(maxFrameJump(tp).angle * 2.5);
	});

	it('an in-place loop also closes its root', () => {
		const looped = makeLoop(stripRootMotion(humanWalk()));
		expect(loopSeam(looped).ok).toBe(true);
	});
});

describe('M8 trim / split', () => {
	it('trims to the in/out frames, re-based at 0', () => {
		const tp = walkTp();
		const r = resample(tp);
		const cut = trimClip(tp, 0.2, 0.6, 'Mid');
		expect(cut.name).toBe('Mid');
		expect(cut.duration).toBeCloseTo(0.4, 5);
		expect(cut.frames).toBe(12);
		const spine = r.tracks.findIndex((t) => r.nodes[t.node].name === 'mixamorigSpine');
		const f6 = Array.from(r.tracks[spine].values.subarray(6 * 4, 7 * 4));
		expect(Array.from(cut.tracks[spine].values.subarray(0, 4))).toEqual(f6);
	});

	it('splits at a time into two clips that share the cut frame', () => {
		const [a, b] = splitClip(walkTp(), 0.5);
		expect(a.duration + b.duration).toBeCloseTo(1, 5);
		const last = a.tracks[1].values.subarray((a.frames) * 4, (a.frames + 1) * 4);
		expect(Array.from(b.tracks[1].values.subarray(0, 4))).toEqual(Array.from(last));
	});
});

describe('M8 join with crossfades', () => {
	/** two different moves on one skeleton: the walk, and the walk mirrored + shifted (a hard seam) */
	function pair() {
		const { root } = makeRig();
		const rest = captureRest(root);
		const a = tpFromThreeClip(root, makeClip(), { rest });
		const other = makeClip();
		for (const t of other.tracks)
			if (t.name.endsWith('quaternion'))
				for (let i = 0; i < t.values.length; i += 4) {
					const q = new THREE.Quaternion().fromArray(t.values, i).multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(0.9, 0, 0.5)));
					q.toArray(t.values, i);
				}
		const b = tpFromThreeClip(root, other, { rest, name: 'Wave' });
		return [a, b];
	}

	it('sequences the clips, overlapping by the fade', () => {
		const [a, b] = pair();
		const j = joinClips([a, b], 0.2);
		expect(j.duration).toBeCloseTo(a.duration + b.duration - 0.2, 4);
		expect(j.name).toBe('Walk + Wave');
	});

	it('a crossfade removes the snap a hard cut has', () => {
		const [a, b] = pair();
		const hard = maxFrameJump(joinClips([a, b], 0));
		const soft = maxFrameJump(joinClips([a, b], 0.3));
		const own = Math.max(maxFrameJump(a).angle, maxFrameJump(b).angle);
		expect(hard.angle).toBeGreaterThan(own * 3); // the counterfactual: a cut snaps
		expect(soft.angle).toBeLessThan(hard.angle / 2.5);
		expect(soft.angle).toBeLessThan(own * 3);
	});

	it('the root keeps travelling across the seam (no jump back to the start)', () => {
		const [a, b] = pair();
		const j = resample(joinClips([a, b], 0.2));
		const p = /** @type {Float32Array} */ (rootPath(j));
		let worst = 0;
		for (let k = 3; k < p.length; k += 3) worst = Math.max(worst, Math.hypot(p[k] - p[k - 3], p[k + 2] - p[k - 1]));
		expect(worst).toBeLessThan(0.1); // ~4 cm per frame at 1.2 m/s; a jump back would be ~1.2 m
		expect(rootTravel(j).distance).toBeGreaterThan(2);
	});

	it('humanoid clips join; mixed ones are refused with a reason', () => {
		const h = humanWalk();
		expect(joinProblem([h, h])).toBe(null);
		expect(joinClips([h, h], 0.25).humanoid).toBeTruthy();
		expect(joinProblem([h, walkTp()])).toMatch(/humanoid/);
		const other = tpFromThreeClip(makeRig({ prefix: 'x' }).root, makeClip('x'));
		expect(joinProblem([walkTp(), other])).toMatch(/another skeleton/);
	});
});
