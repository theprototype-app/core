// 57 M9 — THE BVH WRITER: one clip on one rig as Biovision Hierarchy text, for mocap and animation
// tools (Blender, MotionBuilder, Cascadeur). A LAZY chunk (only a BVH download loads it).
//
// BVH joints have an OFFSET and rotation channels but no rest ROTATION, so the writer bakes: each
// joint's channels are its rotation relative to its BVH parent, computed from the rig's root-space
// WORLD rotations (rest rotations and any non-bone ancestor — Mixamo's 0.01-scaled Armature — are
// folded in), and each offset is the joint's rest translation scaled by its parent's world scale.
// Every joint then lands exactly where the rig puts it, frame by frame: what the round-trip suite
// checks against three's BVHLoader. Channels are ZXY (the common mocap order).

import * as THREE from 'three';
import { bindClip, localsAt, worldMatrices, frameTimes } from './rigSample.js';

/** @typedef {import('./rigSample.js').RestRow} RestRow */

const fmt = (/** @type {number} */ n) =>
	Math.abs(n) < 1e-9 ? '0' : Number(n.toFixed(6)).toString();

/** a BVH-safe joint name @param {string} n @param {Set<string>} used */
function jointName(n, used) {
	let base = String(n || 'joint').replace(/[^A-Za-z0-9_:.\-]/g, '_') || 'joint';
	let name = base;
	for (let k = 2; used.has(name); k++) name = base + '_' + k;
	used.add(name);
	return name;
}

/**
 * Write a BVH. `rows` = the rig's rest rows (bones + their ancestors, parent-first); only BONE
 * rows become joints (a non-bone ancestor is folded into the root). The root is the first bone
 * whose parents are not bones.
 * @param {RestRow[]} rows @param {THREE.AnimationClip} clip
 * @param {{fps?: number, scale?: number}} [opts] `scale` multiplies every distance (1 = model units)
 * @returns {{text: string, joints: string[], frames: number}}
 */
export function writeBvh(rows, clip, opts = {}) {
	const fps = Math.max(1, Math.min(120, opts.fps ?? 30));
	const scale = opts.scale ?? 1;
	const isBone = rows.map((r) => r.bone !== false);
	/** nearest bone ancestor per row (-1 = none) */
	const boneParent = rows.map((r) => {
		let p = r.parent;
		while (p >= 0 && !isBone[p]) p = rows[p].parent;
		return p;
	});
	const roots = rows.map((_, i) => i).filter((i) => isBone[i] && boneParent[i] < 0);
	if (!roots.length) throw new Error('no bones to write');
	// several top-level bones (IK helpers beside the hips): keep the one with the most below it
	const below = (/** @type {number} */ i) =>
		rows.reduce((n, _, j) => {
			let p = boneParent[j];
			while (p >= 0 && p !== i) p = boneParent[p];
			return n + (p === i ? 1 : 0);
		}, 0);
	const root = roots.sort((a, b) => below(b) - below(a))[0];
	/** @type {number[][]} */
	const kids = rows.map(() => []);
	rows.forEach((_, i) => {
		if (isBone[i] && boneParent[i] >= 0) kids[boneParent[i]].push(i);
	});
	/** @type {number[]} joint order = depth-first from the root */
	const order = [];
	const used = new Set();
	/** @type {Map<number, string>} */
	const names = new Map();
	const rest = worldMatrices(rows, rows);
	const ws = new THREE.Vector3();
	const wp = new THREE.Vector3();
	const wq = new THREE.Quaternion();
	/** @param {number} i @returns {number[]} */
	const offsetOf = (i) => {
		// the ROOT's offset is zero and its position channels absolute: readers ADD the offset to
		// the channels (three's BVHLoader, Blender), which every other exporter relies on too
		if (i === root) return [0, 0, 0];
		// the joint's rest position in its BVH parent's (unrotated, unscaled) frame
		rest[boneParent[i]].decompose(wp, wq, ws);
		const p = new THREE.Vector3()
			.setFromMatrixPosition(rest[i])
			.sub(wp)
			.applyQuaternion(wq.clone().invert());
		return p.multiplyScalar(scale).toArray();
	};
	/** @type {string[]} */
	const lines = ['HIERARCHY'];
	/** @param {number} i @param {number} depth */
	const emit = (i, depth) => {
		const pad = '\t'.repeat(depth);
		const name = jointName(rows[i].name, used);
		names.set(i, name);
		order.push(i);
		lines.push(pad + (i === root ? 'ROOT ' : 'JOINT ') + name);
		lines.push(pad + '{');
		lines.push(pad + '\tOFFSET ' + offsetOf(i).map(fmt).join(' '));
		lines.push(
			pad +
				'\tCHANNELS ' +
				(i === root
					? '6 Xposition Yposition Zposition Zrotation Xrotation Yrotation'
					: '3 Zrotation Xrotation Yrotation')
		);
		if (kids[i].length) for (const k of kids[i]) emit(k, depth + 1);
		else {
			// an End Site a short way along the bone's own direction
			const o =
				i === root ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3().fromArray(offsetOf(i));
			const tip =
				o.lengthSq() > 1e-12
					? o.normalize().multiplyScalar(0.05 * scale)
					: new THREE.Vector3(0, 0.05 * scale, 0);
			lines.push(pad + '\tEnd Site');
			lines.push(pad + '\t{');
			lines.push(pad + '\t\tOFFSET ' + tip.toArray().map(fmt).join(' '));
			lines.push(pad + '\t}');
		}
		lines.push(pad + '}');
	};
	emit(root, 0);

	const times = frameTimes(clip.duration, fps);
	const bound = bindClip(rows, clip);
	lines.push('MOTION');
	lines.push('Frames: ' + times.length);
	lines.push('Frame Time: ' + fmt(1 / fps));
	const e = new THREE.Euler();
	const q = new THREE.Quaternion();
	const pq = new THREE.Quaternion();
	for (const t of times) {
		const M = worldMatrices(rows, localsAt(rows, bound, t));
		/** @type {number[]} */
		const vals = [];
		for (const i of order) {
			M[i].decompose(wp, q, ws);
			if (i === root) {
				vals.push(wp.x * scale, wp.y * scale, wp.z * scale);
			} else {
				M[boneParent[i]].decompose(new THREE.Vector3(), pq, new THREE.Vector3());
				q.premultiply(pq.invert());
			}
			e.setFromQuaternion(q.normalize(), 'ZXY');
			vals.push(
				THREE.MathUtils.radToDeg(e.z),
				THREE.MathUtils.radToDeg(e.x),
				THREE.MathUtils.radToDeg(e.y)
			);
		}
		lines.push(vals.map(fmt).join(' '));
	}
	return {
		text: lines.join('\n') + '\n',
		joints: order.map((i) => /** @type {string} */ (names.get(i))),
		frames: times.length
	};
}
