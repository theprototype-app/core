// 57 M1 — the `.tpanim` format: skeleton round trip, determinism, humanoid (VRMA) normalize + bind,
// and VRMA validity read through three-vrm's own loader plugin.
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
	encodeTpanim,
	decodeTpanim,
	tpFromThreeClip,
	tpToThreeClip,
	toHumanoid,
	bindHumanoid,
	humanoidFrames,
	modelSignature,
	clipFit,
	detectFps,
	glbAnimationNames,
	glbHasMeshes,
	nodePositionsAt
} from '../../src/lib/tpanim/format.js';
import { isHumanoidMap, VRM_HUMAN_BONE_PARENTS } from '../../src/lib/tpanim/humanoidBones.js';
import { makeRig, makeClip, captureRest } from './helpers/tpanimRig.js';

/** world positions (root frame) of the named bones while `clip` plays on `root` at t */
function sampleWorld(/** @type {THREE.Object3D} */ root, /** @type {THREE.AnimationClip} */ clip, /** @type {number} */ t, /** @type {string[]} */ names) {
	const mixer = new THREE.AnimationMixer(root);
	mixer.clipAction(clip).play();
	mixer.setTime(t);
	root.updateMatrixWorld(true);
	const out = names.map((n) => {
		const o = /** @type {THREE.Object3D} */ (root.getObjectByName(n));
		return new THREE.Vector3().setFromMatrixPosition(o.matrixWorld);
	});
	mixer.stopAllAction();
	mixer.uncacheRoot(root);
	return out;
}

/** reset a rig to its captured rest */
function toRest(/** @type {THREE.Object3D} */ root, /** @type {any} */ rest) {
	root.traverse((o) => {
		const r = rest(o);
		if (!r) return;
		o.position.fromArray(r.p);
		o.quaternion.fromArray(r.q);
		o.scale.fromArray(r.s);
	});
	root.updateMatrixWorld(true);
}

describe('tpanim: skeleton clips', () => {
	it('round-trips nodes, tracks and extras through the GLB', () => {
		const { root } = makeRig();
		const clip = makeClip();
		const tp = tpFromThreeClip(root, clip, { loop: true, provenance: { tool: 'unit', licence: 'CC0-1.0', date: '2026-10-23' } });
		expect(tp.fps).toBe(30);
		expect(tp.frames).toBe(30);
		expect(tp.sig).toBe(modelSignature(root));
		const bytes = encodeTpanim(tp);
		const back = decodeTpanim(bytes);
		expect(back.tpExtras).toBe(true);
		expect(back.name).toBe('Walk');
		expect(back.loop).toBe(true);
		expect(back.rootMotion).toBe('moving');
		expect(back.fps).toBe(30);
		expect(back.frames).toBe(30);
		expect(back.sig).toBe(tp.sig);
		expect(back.humanoid).toBe(null);
		expect(back.provenance).toEqual({ tool: 'unit', licence: 'CC0-1.0', date: '2026-10-23' });
		expect(back.nodes.map((n) => n.name)).toEqual(tp.nodes.map((n) => n.name));
		expect(back.nodes.map((n) => n.parent)).toEqual(tp.nodes.map((n) => n.parent));
		back.nodes.forEach((n, i) => {
			for (let k = 0; k < 3; k++) expect(n.t[k]).toBeCloseTo(tp.nodes[i].t[k], 4);
			for (let k = 0; k < 4; k++) expect(n.r[k]).toBeCloseTo(tp.nodes[i].r[k], 6);
		});
		expect(back.tracks.length).toBe(clip.tracks.length);
		back.tracks.forEach((tr, i) => {
			expect(tr.path).toBe(tp.tracks[i].path);
			expect(Array.from(tr.values)).toEqual(Array.from(tp.tracks[i].values));
			expect(Array.from(tr.times)).toEqual(Array.from(tp.tracks[i].times));
		});
		// the whole armature travels (signature = every bone + the Armature holding them)
		expect(back.nodes[0].name).toBe('Armature');
		expect(back.nodes[0].s[0]).toBeCloseTo(0.01, 6);
	});

	it('writes the same bytes twice and shares one key-time row', () => {
		const { root } = makeRig();
		const tp = tpFromThreeClip(root, makeClip());
		const a = new Uint8Array(encodeTpanim(tp));
		const b = new Uint8Array(encodeTpanim(tp));
		expect(a.length).toBe(b.length);
		expect(Buffer.compare(Buffer.from(a), Buffer.from(b))).toBe(0);
		// 8 tracks on one 31-key time row: the row is stored once
		const json = JSON.parse(new TextDecoder().decode(a.subarray(20, 20 + new DataView(a.buffer).getUint32(12, true))));
		const inputs = new Set(json.animations[0].samplers.map((/** @type {any} */ s) => s.input));
		expect(inputs.size).toBe(1);
		expect(json.extras.theprototype.format).toBe(1);
		expect(json.extras.theprototype.kind).toBe('clip');
		expect(glbAnimationNames(a)).toEqual(['Walk']);
		expect(glbHasMeshes(a)).toBe(false);
	});

	it('plays back identically on the source rig', () => {
		const { root } = makeRig();
		const rest = captureRest(root);
		const clip = makeClip();
		const back = tpToThreeClip(decodeTpanim(encodeTpanim(tpFromThreeClip(root, clip))));
		const names = ['mixamorigLeftHand', 'mixamorigHead', 'mixamorigLeftFoot'];
		for (const t of [0, 0.37, 0.8]) {
			toRest(root, rest);
			const want = sampleWorld(root, clip, t, names);
			toRest(root, rest);
			const got = sampleWorld(root, back, t, names);
			got.forEach((v, i) => expect(v.distanceTo(want[i])).toBeLessThan(1e-4));
		}
	});

	it('poses its own skeleton (the thumbnail stick figure) where the model would be', () => {
		const { root } = makeRig();
		const rest = captureRest(root);
		const clip = makeClip();
		const tp = tpFromThreeClip(root, clip, { rest });
		const pos = nodePositionsAt(tp, 0.5);
		const want = sampleWorld(root, clip, 0.5, ['mixamorigHead'])[0];
		const i = tp.nodes.findIndex((n) => n.name === 'mixamorigHead');
		expect(Math.hypot(pos[i * 3] - want.x, pos[i * 3 + 1] - want.y, pos[i * 3 + 2] - want.z)).toBeLessThan(1e-4);
	});

	it('reports fit by signature and by node name', () => {
		const a = makeRig();
		const tp = tpFromThreeClip(a.root, makeClip());
		expect(clipFit(tp, makeRig().root).fit).toBe('exact');
		expect(clipFit(tp, makeRig({ prefix: 'other' }).root).fit).toBe('none');
	});

	it('detects common frame rates', () => {
		const tr = (/** @type {number} */ fps) => [{ times: Float32Array.from({ length: 10 }, (_, i) => i / fps) }];
		expect(detectFps(tr(24))).toBe(24);
		expect(detectFps(tr(60))).toBe(60);
		expect(detectFps([])).toBe(30);
	});
});

describe('tpanim: humanoid clips (VRMA)', () => {
	it('normalizes a rig into identity-rest humanoid nodes named after the bones', () => {
		const { root, map } = makeRig();
		expect(isHumanoidMap(map)).toBe(true);
		const rest = captureRest(root);
		const hum = toHumanoid(tpFromThreeClip(root, makeClip(), { rest }), map);
		expect(hum.humanoid?.hips).toBe(0);
		expect(hum.nodes.every((n) => n.r.join() === '0,0,0,1')).toBe(true);
		expect(hum.nodes.map((n) => n.name)).toContain('leftUpperArm');
		// offsets are in metres in the model frame: the hips stand ~1 m up
		expect(hum.nodes[0].t[1]).toBeCloseTo(1, 3);
		// every parent is the bone's VRM parent
		hum.nodes.forEach((n) => {
			if (n.parent < 0) return;
			expect(/** @type {any} */ (VRM_HUMAN_BONE_PARENTS)[n.name]).toBe(hum.nodes[n.parent].name);
		});
	});

	it('binds back onto the source rig with the same pose', () => {
		const { root, map } = makeRig();
		const rest = captureRest(root);
		const clip = makeClip();
		const tp = decodeTpanim(encodeTpanim(toHumanoid(tpFromThreeClip(root, clip, { rest }), map)));
		const bound = bindHumanoid(tp, root, map, { rest });
		const names = ['mixamorigLeftHand', 'mixamorigRightHand', 'mixamorigHead', 'mixamorigLeftFoot', 'mixamorigRightFoot'];
		for (const t of [0, 0.2, 0.5, 1]) {
			toRest(root, rest);
			const want = sampleWorld(root, clip, t, names);
			toRest(root, rest);
			const got = sampleWorld(root, bound, t, names);
			got.forEach((v, i) => expect(v.distanceTo(want[i])).toBeLessThan(2e-3));
		}
	});

	it('plays on a DIFFERENT rig (other names, other rest rotations, a twist bone)', () => {
		const src = makeRig();
		const srcRest = captureRest(src.root);
		const clip = makeClip();
		const tp = decodeTpanim(encodeTpanim(toHumanoid(tpFromThreeClip(src.root, clip, { rest: srcRest }), src.map)));
		const dst = makeRig({ prefix: 'Bip_', twist: true, restTwist: true });
		const dstRest = captureRest(dst.root);
		const bound = bindHumanoid(tp, dst.root, dst.map, { rest: dstRest });
		// the WORLD rotation change of each mapped bone matches the source's (same motion, other rig)
		const pairs = [['mixamorigLeftForeArm', 'Bip_LeftForeArm'], ['mixamorigHead', 'Bip_Head'], ['mixamorigRightUpLeg', 'Bip_RightUpLeg']];
		for (const t of [0.25, 0.75]) {
			toRest(src.root, srcRest);
			toRest(dst.root, dstRest);
			const qa = pairs.map(([a]) => worldDelta(src.root, clip, t, a));
			const qb = pairs.map(([, b]) => worldDelta(dst.root, bound, t, b));
			qa.forEach((q, i) => expect(Math.abs(q.dot(qb[i]))).toBeGreaterThan(0.9999));
		}
	});

	it('is a valid VRMA: three-vrm reads the same normalized tracks', async () => {
		const { root, map } = makeRig();
		const rest = captureRest(root);
		const hum = toHumanoid(tpFromThreeClip(root, makeClip(), { rest }), map);
		const bytes = encodeTpanim(hum);
		const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
		const { VRMAnimationLoaderPlugin } = await import('@pixiv/three-vrm-animation');
		const loader = new GLTFLoader();
		loader.register((parser) => new VRMAnimationLoaderPlugin(parser));
		/** @type {any} */
		const gltf = await new Promise((resolve, reject) => loader.parse(bytes, '', resolve, reject));
		const vrma = gltf.userData.vrmAnimations?.[0];
		expect(vrma).toBeTruthy();
		expect(vrma.restHipsPosition.y).toBeCloseTo(1, 3);
		const ours = humanoidFrames(decodeTpanim(bytes));
		for (const bone of ['leftUpperArm', 'spine', 'leftUpperLeg', 'leftLowerArm']) {
			const track = vrma.humanoidTracks.rotation.get(bone);
			expect(track, bone).toBeTruthy();
			const interp = track.createInterpolant();
			for (const f of [0, 7, 15, 30]) {
				const t = ours.times[f];
				const theirs = new THREE.Quaternion().fromArray(interp.evaluate(t));
				const mine = new THREE.Quaternion().fromArray(ours.rot[bone], f * 4);
				expect(Math.abs(theirs.dot(mine))).toBeGreaterThan(0.99999);
			}
		}
		const hips = vrma.humanoidTracks.translation.get('hips');
		expect(hips.values[1]).toBeCloseTo(ours.hips?.[1] ?? 0, 4);
	});
});

describe('tpanim: a foreign VRMA (non-identity rest rotations)', () => {
	/** the raw rig written AS a VRMA: humanBones point at the raw nodes, rests are A-pose + twisted */
	function foreign() {
		const src = makeRig({ restTwist: true });
		const rest = captureRest(src.root);
		const clip = makeClip();
		const tp = tpFromThreeClip(src.root, clip, { rest });
		/** @type {Record<string, number>} */
		const humanoid = {};
		for (const [bone, name] of Object.entries(src.map)) humanoid[bone] = tp.nodes.findIndex((n) => n.name === name);
		return { src, rest, clip, bytes: encodeTpanim({ ...tp, humanoid }) };
	}

	it('reads the same normalized rotations three-vrm does', async () => {
		const { bytes } = foreign();
		const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
		const { VRMAnimationLoaderPlugin } = await import('@pixiv/three-vrm-animation');
		const loader = new GLTFLoader();
		loader.register((parser) => new VRMAnimationLoaderPlugin(parser));
		/** @type {any} */
		const gltf = await new Promise((resolve, reject) => loader.parse(bytes, '', resolve, reject));
		const vrma = gltf.userData.vrmAnimations[0];
		const ours = humanoidFrames(decodeTpanim(bytes));
		for (const bone of ['leftUpperArm', 'spine', 'leftLowerArm', 'rightUpperLeg']) {
			const interp = vrma.humanoidTracks.rotation.get(bone).createInterpolant();
			for (const f of [0, 9, 30]) {
				const theirs = new THREE.Quaternion().fromArray(interp.evaluate(ours.times[f]));
				const mine = new THREE.Quaternion().fromArray(ours.rot[bone], f * 4);
				expect(Math.abs(theirs.dot(mine)), bone + '@' + f).toBeGreaterThan(0.99999);
			}
		}
		const hips = vrma.humanoidTracks.translation.get('hips').createInterpolant();
		const v = new THREE.Vector3().fromArray(hips.evaluate(ours.times[12]));
		expect(v.distanceTo(new THREE.Vector3().fromArray(/** @type {Float32Array} */ (ours.hips), 12 * 3))).toBeLessThan(1e-4);
	});

	it('binds onto a plain rig with the source motion', () => {
		const { src, rest, clip, bytes } = foreign();
		const dst = makeRig({ prefix: 'B_' });
		const dstRest = captureRest(dst.root);
		const bound = bindHumanoid(decodeTpanim(bytes), dst.root, dst.map, { rest: dstRest });
		for (const t of [0.3, 0.9]) {
			toRest(src.root, rest);
			toRest(dst.root, dstRest);
			const a = worldDelta(src.root, clip, t, 'mixamorigLeftForeArm');
			const b = worldDelta(dst.root, bound, t, 'B_LeftForeArm');
			expect(Math.abs(a.dot(b))).toBeGreaterThan(0.9999);
		}
	});
});

/** world rotation change of one bone at t relative to rest */
function worldDelta(/** @type {THREE.Object3D} */ root, /** @type {THREE.AnimationClip} */ clip, /** @type {number} */ t, /** @type {string} */ name) {
	root.updateMatrixWorld(true);
	const o = /** @type {THREE.Object3D} */ (root.getObjectByName(name));
	const restQ = new THREE.Quaternion();
	o.matrixWorld.decompose(new THREE.Vector3(), restQ, new THREE.Vector3());
	const mixer = new THREE.AnimationMixer(root);
	mixer.clipAction(clip).play();
	mixer.setTime(t);
	root.updateMatrixWorld(true);
	const q = new THREE.Quaternion();
	o.matrixWorld.decompose(new THREE.Vector3(), q, new THREE.Vector3());
	mixer.stopAllAction();
	mixer.uncacheRoot(root);
	return q.multiply(restQ.invert()).normalize();
}
