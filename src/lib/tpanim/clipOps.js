// 57 M3 + M8 — operations on `.tpanim` clips: in place, the loop seam check, Loop it, trim, split
// and join with crossfades. Every one takes a TpClip and returns a NEW one (the caller writes it as a
// new clip asset: a different clip is a different file, so a peer that holds the old one still
// holds exactly that). Pure: three's math only, unit-tested in node.
//
// They work on the FRAME GRID (`resample`): every track keyed at each frame of the clip's own fps,
// which is what a trim boundary, a seam and a crossfade window are measured in.

import * as THREE from 'three';
import { frameTimes } from './format.js';

/** @typedef {import('./format.js').TpClip} TpClip */
/** @typedef {import('./format.js').TpTrack} TpTrack */

const KEY_EPS = 1e-5;

/** @param {TpTrack} tr */
function interpolantOf(tr) {
	const T = tr.path === 'rotation' ? THREE.QuaternionKeyframeTrack : THREE.VectorKeyframeTrack;
	const track = new T('n.x', Array.from(tr.times), Array.from(tr.values), tr.interp === 'STEP' ? THREE.InterpolateDiscrete : THREE.InterpolateLinear);
	return /** @type {any} */ (track).createInterpolant();
}

/** @param {TpTrack} tr */
const width = (tr) => (tr.path === 'rotation' ? 4 : 3);

/**
 * Every track sampled at every frame of the clip (0 .. duration at `fps`). STEP tracks stay STEP.
 * @param {TpClip} tp @returns {TpClip}
 */
export function resample(tp) {
	const times = frameTimes(tp);
	const tracks = tp.tracks.map((tr) => {
		const ip = interpolantOf(tr);
		const n = width(tr);
		const values = new Float32Array(times.length * n);
		times.forEach((t, f) => values.set(ip.evaluate(t), f * n));
		return { ...tr, times, values };
	});
	return { ...tp, tracks, frames: times.length - 1 };
}

/** the frame count of a resampled clip @param {TpClip} tp */
const frameCount = (tp) => (tp.tracks[0]?.times.length ?? 1);

// ---- the root ----------------------------------------------------------------------

/** @param {TpClip} tp @param {number} i */
function depthOf(tp, i) {
	let d = 0;
	for (let p = tp.nodes[i].parent; p >= 0; p = tp.nodes[p].parent) d++;
	return d;
}

/**
 * The ROOT a clip travels by: a humanoid's hips, else the shallowest node with a translation
 * track (the rig's root bone). -1 = nothing translates.
 * @param {TpClip} tp @returns {number} track index
 */
export function rootTrackIndex(tp) {
	if (tp.humanoid) return tp.tracks.findIndex((tr) => tr.path === 'translation' && tr.node === /** @type {any} */ (tp.humanoid).hips);
	let best = -1;
	let bestDepth = Infinity;
	tp.tracks.forEach((tr, i) => {
		if (tr.path !== 'translation') return;
		const d = depthOf(tp, tr.node);
		if (d < bestDepth) {
			best = i;
			bestDepth = d;
		}
	});
	return best;
}

/** the parent world matrix of a node in the file's REST pose (its root frame) @param {TpClip} tp @param {number} node */
function parentRestMatrix(tp, node) {
	const chain = [];
	for (let p = tp.nodes[node].parent; p >= 0; p = tp.nodes[p].parent) chain.unshift(p);
	const m = new THREE.Matrix4();
	for (const i of chain) {
		const n = tp.nodes[i];
		m.multiply(new THREE.Matrix4().compose(new THREE.Vector3().fromArray(n.t), new THREE.Quaternion().fromArray(n.r), new THREE.Vector3().fromArray(n.s)));
	}
	return m;
}

/**
 * The root's position per frame in the MODEL frame (metres for a humanoid), or null.
 * @param {TpClip} tp a resampled clip @returns {Float32Array | null} xyz per frame
 */
export function rootPath(tp) {
	const ti = rootTrackIndex(tp);
	if (ti < 0) return null;
	const tr = tp.tracks[ti];
	const m = parentRestMatrix(tp, tr.node);
	const out = new Float32Array(tr.values.length);
	const v = new THREE.Vector3();
	for (let k = 0; k < tr.values.length; k += 3) v.fromArray(tr.values, k).applyMatrix4(m).toArray(out, k);
	return out;
}

/**
 * IN PLACE (M3): the root's horizontal travel removed, its height kept — the walk walks on the spot,
 * so a controller (or a Blend by Speed node) moves the character instead of the clip.
 * @param {TpClip} tp @returns {TpClip}
 */
export function stripRootMotion(tp) {
	const ti = rootTrackIndex(tp);
	if (ti < 0) return { ...tp, rootMotion: 'inplace' };
	const tr = tp.tracks[ti];
	const m = parentRestMatrix(tp, tr.node);
	const inv = m.clone().invert();
	const v = new THREE.Vector3();
	const first = new THREE.Vector3().fromArray(tr.values, 0).applyMatrix4(m);
	const values = new Float32Array(tr.values.length);
	for (let k = 0; k < tr.values.length; k += 3) {
		v.fromArray(tr.values, k).applyMatrix4(m);
		v.x = first.x;
		v.z = first.z;
		v.applyMatrix4(inv).toArray(values, k);
	}
	const tracks = tp.tracks.map((t, i) => (i === ti ? { ...t, values } : t));
	return { ...tp, tracks, rootMotion: 'inplace' };
}

/**
 * How far the root travels over the clip (model frame): {x, z, distance, speed (m/s)}.
 * @param {TpClip} tp
 */
export function rootTravel(tp) {
	const r = resample(tp);
	const p = rootPath(r);
	if (!p || p.length < 6) return { x: 0, z: 0, distance: 0, speed: 0 };
	const n = p.length;
	const x = p[n - 3] - p[0];
	const z = p[n - 1] - p[2];
	const distance = Math.hypot(x, z);
	return { x, z, distance, speed: tp.duration > 0 ? distance / tp.duration : 0 };
}

// ---- the loop seam -------------------------------------------------------------------

/**
 * THE LOOP SEAM CHECK (M3): how far the last frame is from the first. Rotations as the largest
 * joint angle (degrees, and which joint); the root's height jump (m); travel is NOT a seam for a
 * moving clip (a walk ends further on by design), so only an in-place clip counts its xz.
 * `ok` = under 3° and 2 cm: a loop the eye does not catch.
 * @param {TpClip} tp
 * @returns {{angle: number, node: string, jump: number, ok: boolean}}
 */
export function loopSeam(tp) {
	const r = resample(tp);
	const n = frameCount(r);
	let angle = 0;
	let node = '';
	let jump = 0;
	const a = new THREE.Quaternion();
	const b = new THREE.Quaternion();
	const ri = rootTrackIndex(r);
	r.tracks.forEach((tr, i) => {
		if (tr.path === 'rotation') {
			a.fromArray(tr.values, 0).normalize();
			b.fromArray(tr.values, (n - 1) * 4).normalize();
			const deg = THREE.MathUtils.radToDeg(a.angleTo(b));
			if (deg > angle) {
				angle = deg;
				node = r.nodes[tr.node]?.name ?? '';
			}
		}
	});
	if (ri >= 0) {
		const p = /** @type {Float32Array} */ (rootPath(r));
		const k = (n - 1) * 3;
		const dy = Math.abs(p[k + 1] - p[1]);
		const dxz = r.rootMotion === 'inplace' ? Math.hypot(p[k] - p[0], p[k + 2] - p[2]) : 0;
		jump = Math.max(dy, dxz);
	}
	return { angle, node, jump, ok: angle < 3 && jump < 0.02 };
}

/**
 * LOOP IT (M3): blend the last `blend` seconds into the first frame so the loop has no seam. A
 * moving clip keeps its travel: the root blends toward the START pose shifted by the whole trip.
 * (58's UniMate keyframe pinning does this better when an AI box is set up.)
 * @param {TpClip} tp @param {number} [blend] seconds (default a quarter of the clip, at most 0.4 s)
 * @returns {TpClip}
 */
export function makeLoop(tp, blend) {
	const r = resample(tp);
	const n = frameCount(r);
	const span = Math.max(1, Math.min(n - 1, Math.round((blend ?? Math.min(0.4, tp.duration / 4)) * r.fps)));
	const ri = rootTrackIndex(r);
	const q0 = new THREE.Quaternion();
	const q = new THREE.Quaternion();
	const tracks = r.tracks.map((tr, ti) => {
		const values = Float32Array.from(tr.values);
		const w = width(tr);
		const start = n - 1 - span;
		// the root of a MOVING clip loops onto the START shifted by the whole trip — horizontally, in
		// the model frame (a walk ends further on by design); its height still returns to the start
		/** @type {number[]} */
		let target = Array.from(tr.values.subarray(0, w));
		if (ti === ri && tr.path === 'translation' && r.rootMotion !== 'inplace') {
			const m = parentRestMatrix(r, tr.node);
			const first = new THREE.Vector3().fromArray(tr.values, 0).applyMatrix4(m);
			const last = new THREE.Vector3().fromArray(tr.values, (n - 1) * 3).applyMatrix4(m);
			const goal = first.clone().add(new THREE.Vector3(last.x - first.x, 0, last.z - first.z));
			target = goal.applyMatrix4(m.clone().invert()).toArray();
		}
		for (let f = start + 1; f < n; f++) {
			const k = (f - start) / span; // 0 → 1 over the window, 1 exactly on the last frame
			const e = k * k * (3 - 2 * k);
			if (tr.path === 'rotation') {
				q0.fromArray(tr.values, 0);
				q.fromArray(values, f * 4);
				if (q.dot(q0) < 0) q0.set(-q0.x, -q0.y, -q0.z, -q0.w);
				q.slerp(q0, e).normalize().toArray(values, f * 4);
			} else {
				for (let c = 0; c < w; c++) values[f * w + c] += (target[c] - values[f * w + c]) * e;
			}
		}
		return { ...tr, values };
	});
	return { ...r, tracks, loop: true };
}

// ---- trim / split / join -------------------------------------------------------------

/**
 * TRIM (M8): the part between two times, re-based to start at 0.
 * @param {TpClip} tp @param {number} from seconds @param {number} to seconds @param {string} [name]
 * @returns {TpClip}
 */
export function trimClip(tp, from, to, name) {
	const r = resample(tp);
	const a = Math.max(0, Math.min(from, to));
	const b = Math.min(tp.duration, Math.max(from, to));
	const f0 = Math.round(a * r.fps);
	const f1 = Math.max(f0 + 1, Math.round(b * r.fps));
	const count = f1 - f0 + 1;
	const times = new Float32Array(count);
	for (let i = 0; i < count; i++) times[i] = i / r.fps;
	const tracks = r.tracks.map((tr) => {
		const w = width(tr);
		return { ...tr, times, values: tr.values.slice(f0 * w, (f1 + 1) * w) };
	});
	const duration = (count - 1) / r.fps;
	return { ...r, name: name ?? tp.name, tracks, duration, frames: count - 1, loop: false };
}

/**
 * SPLIT (M8): two clips at a time (the frame at the cut ends the first and starts the second).
 * @param {TpClip} tp @param {number} at seconds @returns {[TpClip, TpClip]}
 */
export function splitClip(tp, at) {
	return [trimClip(tp, 0, at, tp.name + ' A'), trimClip(tp, at, tp.duration, tp.name + ' B')];
}

/**
 * Can these clips be joined? Same humanoid-ness, and skeleton clips must share their nodes by name.
 * @param {TpClip[]} clips @returns {string | null} why not (null = they can)
 */
export function joinProblem(clips) {
	if (clips.length < 2) return 'pick at least two clips';
	const h = !!clips[0].humanoid;
	if (clips.some((c) => !!c.humanoid !== h)) return 'humanoid and skeleton clips cannot be joined';
	if (h) return null;
	const names = new Set(clips[0].nodes.map((n) => n.name));
	for (const c of clips.slice(1)) if (!c.tracks.every((tr) => names.has(c.nodes[tr.node].name))) return '"' + c.name + '" is for another skeleton';
	return null;
}

/**
 * JOIN (M8): the clips one after another, with a crossfade of `fade` seconds at each seam (the end
 * of one blends into the start of the next; 58's UniMate in-betweening makes a real transition when
 * an AI box is set up). The root keeps travelling: each clip starts where the last one ended (xz).
 * The first clip's skeleton and fps are kept.
 * @param {TpClip[]} clips @param {number} fade seconds @param {string} [name] @returns {TpClip}
 */
export function joinClips(clips, fade, name) {
	const why = joinProblem(clips);
	if (why) throw new Error(why);
	const base = resample(clips[0]);
	const fps = base.fps;
	const parts = clips.map((c, i) => (i === 0 ? base : resample({ ...c, fps })));
	/** node name -> index in the joined clip, track key = name|path */
	const nodeIndex = new Map(base.nodes.map((n, i) => [n.name, i]));
	const keys = [];
	/** @type {Map<string, {node: number, path: TpTrack['path'], interp: TpTrack['interp']}>} */
	const meta = new Map();
	for (const p of parts)
		for (const tr of p.tracks) {
			const nm = p.nodes[tr.node].name;
			const key = nm + '|' + tr.path;
			if (!meta.has(key) && nodeIndex.has(nm)) {
				meta.set(key, { node: /** @type {number} */ (nodeIndex.get(nm)), path: tr.path, interp: tr.interp });
				keys.push(key);
			}
		}
	const fadeFrames = Math.max(0, Math.round(fade * fps));
	// frame offsets: each part starts `fadeFrames` before the previous one ends
	/** @type {{at: number, overlap: number, len: number}[]} */
	const starts = [];
	let at = 0;
	for (let i = 0; i < parts.length; i++) {
		const len = frameCount(parts[i]);
		const overlap = i === 0 ? 0 : Math.min(fadeFrames, len - 1, frameCount(parts[i - 1]) - 1);
		at -= overlap;
		starts.push({ at, overlap, len });
		at += len - 1;
	}
	const total = at + 1;
	const times = new Float32Array(total);
	for (let f = 0; f < total; f++) times[f] = f / fps;
	const rootKey = (() => {
		const ri = rootTrackIndex(base);
		return ri >= 0 ? base.nodes[base.tracks[ri].node].name + '|translation' : null;
	})();
	const q = new THREE.Quaternion();
	const q2 = new THREE.Quaternion();
	/** @type {TpTrack[]} */
	const tracks = keys.map((key) => {
		const m = /** @type {any} */ (meta.get(key));
		const w = m.path === 'rotation' ? 4 : 3;
		const values = new Float32Array(total * w);
		/** @type {Float32Array[]} each part's values for this track (rest/identity when it lacks it) */
		const per = parts.map((p) => {
			const tr = p.tracks.find((t) => p.nodes[t.node].name + '|' + t.path === key);
			if (tr) return Float32Array.from(tr.values);
			const n = p.nodes.find((x) => x.name === key.split('|')[0]);
			const rest = m.path === 'rotation' ? n?.r ?? [0, 0, 0, 1] : m.path === 'translation' ? n?.t ?? [0, 0, 0] : n?.s ?? [1, 1, 1];
			const out = new Float32Array(frameCount(p) * w);
			for (let f = 0; f < frameCount(p); f++) out.set(rest, f * w);
			return out;
		});
		// the root keeps travelling: shift each part so it starts where the previous one is at the seam
		if (key === rootKey) {
			// in the MODEL frame (the root's parent may be a turned, scaled Armature), then back
			const pm = parentRestMatrix(base, m.node);
			const inv = pm.clone().invert();
			const v = new THREE.Vector3();
			const toModel = (/** @type {Float32Array} */ a) => {
				for (let k = 0; k < a.length; k += 3) v.fromArray(a, k).applyMatrix4(pm).toArray(a, k);
			};
			per.forEach(toModel);
			for (let i = 1; i < parts.length; i++) {
				const prev = per[i - 1];
				const seamPrev = (starts[i].at - starts[i - 1].at) * 3; // the previous part's frame at our first frame
				const dx = prev[seamPrev] - per[i][0];
				const dz = prev[seamPrev + 2] - per[i][2];
				for (let k = 0; k < per[i].length; k += 3) {
					per[i][k] += dx;
					per[i][k + 2] += dz;
				}
			}
			for (const a of per) for (let k = 0; k < a.length; k += 3) v.fromArray(a, k).applyMatrix4(inv).toArray(a, k);
		}
		for (let i = 0; i < parts.length; i++) {
			const { at: s, overlap, len } = starts[i];
			for (let f = 0; f < len; f++) {
				const g = s + f;
				if (i > 0 && f < overlap) {
					// inside the seam: blend the previous part's tail into this part's head
					const k = (f + 1) / (overlap + 1);
					const e = k * k * (3 - 2 * k);
					if (w === 4) {
						q.fromArray(values, g * 4);
						q2.fromArray(per[i], f * 4);
						if (q.dot(q2) < 0) q2.set(-q2.x, -q2.y, -q2.z, -q2.w);
						q.slerp(q2, e).normalize().toArray(values, g * 4);
					} else for (let c = 0; c < w; c++) values[g * w + c] += (per[i][f * w + c] - values[g * w + c]) * e;
				} else values.set(per[i].subarray(f * w, (f + 1) * w), g * w);
			}
		}
		return { node: m.node, path: m.path, times, values, interp: m.interp };
	});
	return { ...base, name: name ?? clips.map((c) => c.name).join(' + '), tracks, duration: (total - 1) / fps, frames: total - 1, loop: false };
}

/**
 * The largest per-frame jump of any joint across a clip (degrees) — what "no snap" means for a
 * join or a crossfade: a seam that snaps shows up as a frame far above the clip's own motion.
 * @param {TpClip} tp @returns {{angle: number, frame: number}}
 */
export function maxFrameJump(tp) {
	const r = resample(tp);
	const n = frameCount(r);
	let angle = 0;
	let frame = 0;
	const a = new THREE.Quaternion();
	const b = new THREE.Quaternion();
	for (const tr of r.tracks) {
		if (tr.path !== 'rotation') continue;
		for (let f = 1; f < n; f++) {
			a.fromArray(tr.values, (f - 1) * 4).normalize();
			b.fromArray(tr.values, f * 4).normalize();
			const d = THREE.MathUtils.radToDeg(a.angleTo(b));
			if (d > angle + KEY_EPS) {
				angle = d;
				frame = f;
			}
		}
	}
	return { angle, frame };
}
