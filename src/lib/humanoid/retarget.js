// 57 M2 — RETARGETING: a clip made for one humanoid, played by another.
//
// The method is three's `SkeletonUtils.retargetClip` (copy each mapped bone's WORLD rotation from
// the source to the target, sampled at a fixed fps, the hips' position scaled by the size ratio)
// with the REST-POSE CORRECTION that function leaves to its caller (`localOffsets`): what moves
// across is each bone's world-space change FROM ITS REST POSE, so a T-posed clip on an A-posed
// character keeps the character's own arms at rest and swings them by the clip's amounts. The
// facing is corrected too (VRM 0.x models face -Z, glTF +Z): both rigs' rest poses give a
// basis (up = hips → head, left = right hip → left hip) and the change is conjugated into the
// target's basis.
//
// It is implemented here rather than by calling the SkeletonUtils function because that one
// works on a LIVE SkinnedMesh (it resets the target to its bind pose, writes its bones every
// frame and freezes any unmapped bone in world space) — this one works on two plain SNAPSHOTS
// (rest TRS per node), touches no scene object, runs headless in the unit suite and gives the
// same answer on every peer for the same inputs, which is what lets each peer retarget locally
// instead of sending the result.
//
// INPUT: a clip whose tracks name source nodes (`Hips.quaternion`, `.bones[Hips].quaternion`),
// the source and target snapshots and their humanoid maps. OUTPUT: a clip whose tracks name the
// TARGET's own nodes, so it binds on the target model by name like an embedded clip.

import * as THREE from 'three';

/**
 * @typedef {{name: string, parent: number, t: number[], q: number[], s: number[]}} RigNode
 * @typedef {{nodes: RigNode[], index: Map<string, number>, map: Record<string, string>}} RigSnapshot
 *   `nodes` parent-first; `parent` -1 = directly under the model root (root space = the model
 *   root's own transform excluded).
 */

/**
 * The rest snapshot of a live model: every mapped bone and all of its ancestors below `root`,
 * with their CURRENT local transforms (call it on a fresh parse, or after `skeleton.pose()`).
 * @param {THREE.Object3D} root @param {Record<string, string>} map humanoid bone -> node name
 * @returns {RigSnapshot}
 */
export function rigSnapshot(root, map) {
	/** @type {THREE.Object3D[]} */
	const keep = [];
	const seen = new Set();
	for (const nodeName of Object.values(map)) {
		const node = root.getObjectByName(nodeName);
		if (!node) continue;
		/** @type {THREE.Object3D[]} */
		const chain = [];
		for (let o = /** @type {THREE.Object3D | null} */ (node); o && o !== root; o = o.parent)
			chain.unshift(o);
		for (const o of chain) {
			if (seen.has(o)) continue;
			seen.add(o);
			keep.push(o);
		}
	}
	return snapshotFromObjects(keep, map);
}

/**
 * Every node under `root` (bones or not) as a snapshot — for a source clip that also moves
 * unmapped nodes between mapped ones (a twist bone, KayKit's wrist).
 * @param {THREE.Object3D[]} objects parent-first order not required @param {Record<string, string>} map
 */
function snapshotFromObjects(objects, map) {
	const set = new Set(objects);
	const depth = (/** @type {THREE.Object3D} */ o) => {
		let d = 0;
		for (let p = o.parent; p && set.has(p); p = p.parent) d++;
		return d;
	};
	const sorted = objects.slice().sort((a, b) => depth(a) - depth(b));
	const at = new Map(sorted.map((o, i) => [o, i]));
	/** @type {RigNode[]} */
	const nodes = sorted.map((o) => ({
		name: o.name,
		parent: o.parent && at.has(o.parent) ? /** @type {number} */ (at.get(o.parent)) : -1,
		t: o.position.toArray(),
		q: o.quaternion.toArray(),
		s: o.scale.toArray()
	}));
	return makeSnapshot(nodes, map);
}

/**
 * A snapshot from plain node rows (a clip file's own rest skeleton, the unit suite).
 * @param {RigNode[]} nodes parent-first @param {Record<string, string>} map
 * @returns {RigSnapshot}
 */
export function makeSnapshot(nodes, map) {
	const index = new Map(nodes.map((n, i) => [n.name, i]));
	return { nodes, index, map: { ...map } };
}

const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();

/**
 * Root-space world matrices + rotations of a snapshot for given locals.
 * @param {RigSnapshot} snap @param {(i: number) => {t: number[], q: number[], s: number[]}} local
 */
function worldOf(snap, local) {
	/** @type {THREE.Matrix4[]} */
	const M = [];
	/** @type {THREE.Quaternion[]} */
	const Q = [];
	snap.nodes.forEach((n, i) => {
		const L = local(i);
		const m = new THREE.Matrix4().compose(_v.fromArray(L.t), _q.fromArray(L.q), _s.fromArray(L.s));
		const q = new THREE.Quaternion().fromArray(L.q);
		if (n.parent >= 0) {
			m.premultiply(M[n.parent]);
			q.premultiply(Q[n.parent]);
		}
		M.push(m);
		Q.push(q);
	});
	return { M, Q };
}

/** @param {RigSnapshot} snap */
function restWorld(snap) {
	return worldOf(snap, (i) => snap.nodes[i]);
}

/** root-space position of a mapped humanoid bone at rest @param {RigSnapshot} snap @param {{M: THREE.Matrix4[]}} W @param {string} bone */
function bonePos(snap, W, bone) {
	const i = snap.index.get(snap.map[bone] ?? '');
	if (i === undefined) return null;
	return new THREE.Vector3().setFromMatrixPosition(W.M[i]);
}

/**
 * The rig's facing at rest: an orthonormal basis (left, up, forward) as a rotation. Up = hips →
 * head (or neck/spine); left = right → left upper leg (or arm). Falls back to identity.
 * @param {RigSnapshot} snap @param {{M: THREE.Matrix4[]}} W @returns {THREE.Quaternion}
 */
export function restBasis(snap, W = restWorld(snap)) {
	const hips = bonePos(snap, W, 'hips');
	const top =
		bonePos(snap, W, 'head') ??
		bonePos(snap, W, 'neck') ??
		bonePos(snap, W, 'upperChest') ??
		bonePos(snap, W, 'chest');
	const l = bonePos(snap, W, 'leftUpperLeg') ?? bonePos(snap, W, 'leftUpperArm');
	const r = bonePos(snap, W, 'rightUpperLeg') ?? bonePos(snap, W, 'rightUpperArm');
	if (!hips || !top || !l || !r) return new THREE.Quaternion();
	const up = top.clone().sub(hips).normalize();
	const left = l.clone().sub(r).normalize();
	if (up.lengthSq() < 0.5 || left.lengthSq() < 0.5) return new THREE.Quaternion();
	const forward = new THREE.Vector3().crossVectors(left, up).normalize();
	left.crossVectors(up, forward).normalize();
	return new THREE.Quaternion().setFromRotationMatrix(
		new THREE.Matrix4().makeBasis(left, up, forward)
	);
}

/**
 * Snap a rotation to the nearest axis-aligned one when it is within ~15° of it: two upright
 * rigs facing the same way must give EXACTLY identity, not a skew from a lopsided hip.
 * @param {THREE.Quaternion} q
 */
function snapAxisAligned(q) {
	const m = new THREE.Matrix4().makeRotationFromQuaternion(q);
	const e = m.elements;
	/** @type {number[]} */
	const out = new Array(16).fill(0);
	out[15] = 1;
	for (const col of [0, 1, 2]) {
		let best = 0;
		let bestRow = 0;
		for (const row of [0, 1, 2]) {
			const v = e[col * 4 + row];
			if (Math.abs(v) > Math.abs(best)) {
				best = v;
				bestRow = row;
			}
		}
		if (Math.abs(best) < 0.96) return q; // not close to an axis: keep the measured basis
		out[col * 4 + bestRow] = Math.sign(best);
	}
	const snapped = new THREE.Matrix4().fromArray(out);
	if (Math.abs(snapped.determinant() - 1) > 1e-6) return q;
	return new THREE.Quaternion().setFromRotationMatrix(snapped);
}

/** the hips' height above the feet at rest (the size the hips' travel scales by) @param {RigSnapshot} snap @param {{M: THREE.Matrix4[]}} W */
function hipsHeight(snap, W) {
	const hips = bonePos(snap, W, 'hips');
	if (!hips) return 1;
	const feet = ['leftFoot', 'rightFoot', 'leftToes', 'rightToes']
		.map((b) => bonePos(snap, W, b))
		.filter(Boolean);
	const floor = feet.length ? Math.min(...feet.map((p) => /** @type {THREE.Vector3} */ (p).y)) : 0;
	const h = hips.y - floor;
	return h > 1e-6 ? h : Math.max(1e-6, Math.abs(hips.y)) || 1;
}

/**
 * Which source node a track drives: `Hips.quaternion`, `.bones[Hips].quaternion`, a sanitized
 * name. @param {RigSnapshot} snap @param {string} trackName
 */
function trackTarget(snap, trackName) {
	let parsed;
	try {
		parsed = THREE.PropertyBinding.parseTrackName(trackName);
	} catch {
		return null;
	}
	const node = parsed.objectName === 'bones' ? String(parsed.objectIndex ?? '') : parsed.nodeName;
	let i = snap.index.get(node);
	if (i === undefined) {
		const clean = THREE.PropertyBinding.sanitizeNodeName(node);
		i = snap.nodes.findIndex((n) => THREE.PropertyBinding.sanitizeNodeName(n.name) === clean);
		if (i < 0) return null;
	}
	return { node: i, property: parsed.propertyName };
}

/**
 * Retarget `clip` (on the source's nodes) onto the target rig.
 * @param {THREE.AnimationClip} clip
 * @param {RigSnapshot} source @param {RigSnapshot} target
 * @param {{fps?: number, name?: string, hipsTranslation?: boolean}} [opts]
 *   `fps` sampling rate (default 30); `hipsTranslation` false keeps the target's hips where they
 *   rest (a clip used only for its rotations)
 * @returns {THREE.AnimationClip}
 */
export function retargetClip(clip, source, target, opts = {}) {
	const fps = Math.max(1, Math.min(120, opts.fps ?? 30));
	const duration = Math.max(0, clip.duration > 0 ? clip.duration : 0);
	const frames = Math.max(2, Math.round(duration * fps) + 1);
	const times = new Float32Array(frames);
	for (let f = 0; f < frames; f++) times[f] = frames > 1 ? (duration * f) / (frames - 1) : 0;

	// the source's tracks, bound to its nodes
	/** @type {{node: number, property: string, interp: any}[]} */
	const bound = [];
	for (const track of clip.tracks) {
		const hit = trackTarget(source, track.name);
		if (!hit || !['quaternion', 'position', 'scale'].includes(hit.property)) continue;
		bound.push({ ...hit, interp: /** @type {any} */ (track).createInterpolant() });
	}

	const srcRest = restWorld(source);
	const dstRest = restWorld(target);
	// facing: C maps a direction in the source's basis to the same direction in the target's
	const C = snapAxisAligned(
		restBasis(target, dstRest).multiply(restBasis(source, srcRest).invert())
	);
	const Ci = C.clone().invert();
	const scale = hipsHeight(target, dstRest) / hipsHeight(source, srcRest);

	/** the humanoid bones both rigs map, as [source node, target node] */
	/** @type {Map<number, number>} target node -> source node */
	const pairs = new Map();
	for (const [bone, dstName] of Object.entries(target.map)) {
		const srcName = source.map[bone];
		if (!srcName) continue;
		const s = source.index.get(srcName);
		const d = target.index.get(dstName);
		if (s !== undefined && d !== undefined) pairs.set(d, s);
	}
	const srcHips = source.index.get(source.map.hips ?? '');
	const dstHips = target.index.get(target.map.hips ?? '');
	const srcHipsRest =
		srcHips !== undefined ? new THREE.Vector3().setFromMatrixPosition(srcRest.M[srcHips]) : null;
	const dstHipsRest =
		dstHips !== undefined ? new THREE.Vector3().setFromMatrixPosition(dstRest.M[dstHips]) : null;
	const hipsParent = dstHips !== undefined ? target.nodes[dstHips].parent : -1;
	const hipsParentInv =
		hipsParent >= 0 ? dstRest.M[hipsParent].clone().invert() : new THREE.Matrix4();
	const moveHips =
		opts.hipsTranslation !== false &&
		srcHips !== undefined &&
		dstHips !== undefined &&
		bound.some((b) => b.node === srcHips && b.property === 'position');

	/** @type {Map<number, Float32Array>} */
	const quatOut = new Map([...pairs.keys()].map((d) => [d, new Float32Array(frames * 4)]));
	const posOut = moveHips ? new Float32Array(frames * 3) : null;
	const srcRestInv = srcRest.Q.map((q) => q.clone().invert());

	for (let f = 0; f < frames; f++) {
		const t = times[f];
		// the source's locals at t: rest, overwritten by whatever its tracks say
		const locals = source.nodes.map((n) => ({ t: n.t.slice(), q: n.q.slice(), s: n.s.slice() }));
		for (const b of bound) {
			const v = b.interp.evaluate(t);
			const L = locals[b.node];
			if (b.property === 'quaternion') L.q = [v[0], v[1], v[2], v[3]];
			else if (b.property === 'position') L.t = [v[0], v[1], v[2]];
			else L.s = [v[0], v[1], v[2]];
		}
		const W = worldOf(source, (i) => locals[i]);
		// the target, parent-first: a mapped node takes its corrected world rotation, an unmapped
		// one rides its parent at rest
		/** @type {THREE.Quaternion[]} */
		const dstQ = [];
		target.nodes.forEach((n, i) => {
			const parentQ = n.parent >= 0 ? dstQ[n.parent] : new THREE.Quaternion();
			const s = pairs.get(i);
			if (s === undefined) {
				dstQ.push(parentQ.clone().multiply(_q.fromArray(n.q)));
				return;
			}
			// the source bone's world change from rest, carried into the target's facing
			const delta = W.Q[s].clone().multiply(srcRestInv[s]);
			const want = C.clone().multiply(delta).multiply(Ci).multiply(dstRest.Q[i]);
			dstQ.push(want);
			const local = parentQ.clone().invert().multiply(want).normalize();
			const out = /** @type {Float32Array} */ (quatOut.get(i));
			// keep the track on one hemisphere so the interpolation never takes the long way round
			if (f > 0) {
				const dot =
					out[(f - 1) * 4] * local.x +
					out[(f - 1) * 4 + 1] * local.y +
					out[(f - 1) * 4 + 2] * local.z +
					out[(f - 1) * 4 + 3] * local.w;
				if (dot < 0) local.set(-local.x, -local.y, -local.z, -local.w);
			}
			local.toArray(out, f * 4);
		});
		if (posOut && srcHips !== undefined && srcHipsRest && dstHipsRest) {
			const p = new THREE.Vector3()
				.setFromMatrixPosition(W.M[srcHips])
				.sub(srcHipsRest)
				.applyQuaternion(C)
				.multiplyScalar(scale)
				.add(dstHipsRest);
			p.applyMatrix4(hipsParentInv).toArray(posOut, f * 3);
		}
	}

	/** @type {THREE.KeyframeTrack[]} */
	const tracks = [];
	for (const [d, values] of quatOut)
		tracks.push(
			new THREE.QuaternionKeyframeTrack(target.nodes[d].name + '.quaternion', times, values)
		);
	if (posOut && dstHips !== undefined)
		tracks.push(
			new THREE.VectorKeyframeTrack(target.nodes[dstHips].name + '.position', times, posOut)
		);
	return new THREE.AnimationClip(opts.name ?? clip.name, duration, tracks);
}

/**
 * The size ratio a retarget scales the hips' travel by (target / source), for a UI note.
 * @param {RigSnapshot} source @param {RigSnapshot} target
 */
export function retargetScale(source, target) {
	return hipsHeight(target, restWorld(target)) / hipsHeight(source, restWorld(source));
}
