// 57 M1: plain animation files become `.tpanim` on import. A `.vrma` gains our extras (it already
// IS the humanoid format); a `.bvh`, an animation-only `.fbx` (Mixamo "without skin") or a `.glb`
// holding only nodes + animations becomes one clip file PER animation — humanoid when its bones
// map onto VRM's set (humanoidMap: 57-chars M2's detector, else the built-in rules), a skeleton
// clip otherwise. A model with meshes is NOT a clip file: it imports as a model, as before.
//
// Loaded on demand by the Explorer's import (explorer.js asks only for these extensions).

import * as THREE from 'three';
import { decodeTpanim, encodeTpanim, tpFromThreeClip, toHumanoid, glbAnimationNames, glbHasMeshes, TPANIM_EXT, sanitizeName } from './format.js';
import { humanoidMapOfNames } from './humanoidMap.js';

/** the extensions that MAY be animation files (the converter decides) */
export const MAYBE_ANIMATION = ['vrma', 'bvh', 'glb', 'fbx'];

/** @param {string} name */
const extOf = (name) => name.split('.').pop()?.toLowerCase() ?? '';
/** @param {string} name */
const baseOf = (name) => name.replace(/\.[^.]+$/, '') || 'Clip';

/** @param {string} source */
function provenance(source) {
	return { tool: 'import', source, date: new Date().toISOString().slice(0, 10) };
}

/**
 * A skeleton clip -> humanoid when its bones map, else as it is.
 * @param {import('./format.js').TpClip} tp
 */
export function maybeHumanoid(tp) {
	if (tp.humanoid) return tp;
	const map = humanoidMapOfNames(tp.nodes.map((n) => sanitizeName(n.name)));
	if (!map) return tp;
	try {
		return toHumanoid(tp, map);
	} catch (error) {
		console.log('humanoid conversion failed, keeping the skeleton clip', error);
		return tp;
	}
}

/** @param {string} name @param {ArrayBuffer} bytes */
function clipFile(name, bytes) {
	return new File([bytes], name + '.' + TPANIM_EXT, { type: 'model/gltf-binary' });
}

/**
 * The `.tpanim` files an import should store instead of `file`, or null = not an animation file
 * (import it as it is). Throws when the file claims to be one and cannot be read.
 * @param {File} file @returns {Promise<File[] | null>}
 */
export async function convertAnimationFile(file) {
	const ext = extOf(file.name);
	if (!MAYBE_ANIMATION.includes(ext)) return null;
	const base = baseOf(file.name);
	const buf = await file.arrayBuffer();
	if (ext === 'vrma') {
		const tp = decodeTpanim(buf);
		if (!tp.humanoid) throw new Error(file.name + ' has no VRM humanoid');
		return [clipFile(base, encodeTpanim({ ...tp, provenance: tp.provenance ?? provenance(file.name), tpExtras: true }))];
	}
	if (ext === 'glb') {
		if (glbHasMeshes(buf)) return null;
		const names = glbAnimationNames(buf);
		if (!names.length) return null;
		return names.map((/** @type {string} */ n, /** @type {number} */ i) => {
			const tp = maybeHumanoid({ ...decodeTpanim(buf, { animation: i }), provenance: provenance(file.name) });
			return clipFile(names.length > 1 ? base + ' - ' + n : base, encodeTpanim({ ...tp, name: n }));
		});
	}
	if (ext === 'bvh') {
		// @ts-ignore - three addons ship no declarations here (project-wide)
		const { BVHLoader } = await import('three/addons/loaders/BVHLoader.js');
		const res = new BVHLoader().parse(new TextDecoder().decode(buf));
		const root = new THREE.Group();
		const holder = new THREE.Object3D();
		holder.name = 'BVH';
		root.add(holder);
		holder.add(res.skeleton.bones[0]);
		root.updateMatrixWorld(true);
		// mocap is usually in centimetres: a standing hips height over 20 units is, so the clip is
		// stored in metres. A BVH rests its root at the floor and puts the height in the MOTION, so
		// the height is read from the first frame's root position, not the rest pose.
		const rootBone = res.skeleton.bones[0];
		const rootPos = res.clip.tracks.find((/** @type {any} */ t) => t.name === rootBone.name + '.position');
		const hipsY = rootPos ? rootPos.values[1] : new THREE.Vector3().setFromMatrixPosition(rootBone.matrixWorld).y;
		if (Math.abs(hipsY) > 20) holder.scale.setScalar(0.01);
		const tp = maybeHumanoid(tpFromThreeClip(root, res.clip, { name: base, provenance: provenance(file.name) }));
		return [clipFile(base, encodeTpanim(tp))];
	}
	if (ext === 'fbx') {
		// @ts-ignore
		const { FBXLoader } = await import('three/addons/loaders/FBXLoader.js');
		const obj = new FBXLoader().parse(buf, '');
		let meshes = false;
		obj.traverse((/** @type {any} */ o) => {
			if (o.isMesh) meshes = true;
		});
		const clips = obj.animations ?? [];
		if (meshes || !clips.length) return null;
		return clips.map((/** @type {THREE.AnimationClip} */ clip, /** @type {number} */ i) => {
			const name = clips.length > 1 ? base + ' - ' + (clip.name || 'Clip ' + (i + 1)) : base;
			const tp = maybeHumanoid(tpFromThreeClip(obj, clip, { name: clips.length > 1 ? clip.name || name : base, provenance: provenance(file.name) }));
			return clipFile(name, encodeTpanim(tp));
		});
	}
	return null;
}
