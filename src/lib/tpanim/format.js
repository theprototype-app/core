// 57 M1 — `.tpanim`, a clip as its own small file (fork F1, LOCKED).
//
// TWO SHAPES, ONE CONTAINER (a GLB, so any glTF tool opens either when renamed `.glb`):
//  · HUMANOID clips are valid VRM Animation (`VRMC_vrm_animation` 1.0): renamed `.vrma` they play
//    in VRM tools. They are written in VRM's NORMALIZED space — one node per humanoid bone, named
//    after it, every rest rotation identity, offsets in the model's frame (metres) — so the
//    rotations stored ARE the normalized local rotations, three-vrm's loader reads them back
//    unchanged, and one file plays on any mapped humanoid. The node offsets keep the SOURCE rest
//    pose (an A-pose arm points down), which is what a rest-pose correction (57-chars M2) needs.
//  · Other clips are a plain GLB: the source skeleton's nodes (rest pose) + one animation, bound
//    to a model by NODE NAME (the 36-avatars precedent: one clip file, any rig with those bones).
// Both carry `extras.theprototype` on the glTF root:
//   {format: 1, kind: 'clip', skeleton: {sig, humanoid}, fps, frames, loop, rootMotion, provenance}
// `frames` is the length in frames (duration = frames / fps); `rootMotion` 'moving' | 'inplace'.
//
// Pure: three's math only (no loaders, no DOM, no stores) — the unit suite runs it in node.

import * as THREE from 'three';
import { GlbBuilder, unpackGlb, readAccessor, isGlb } from './glb.js';
import { VRM_HUMAN_BONES, humanParentIn, isVrmHumanBone } from './humanoidBones.js';

export const TPANIM_FORMAT = 1;
export const TPANIM_EXT = 'tpanim';
export const VRMA_EXTENSION = 'VRMC_vrm_animation';
const GENERATOR = 'theprototype .tpanim ' + TPANIM_FORMAT;

/**
 * @typedef {{name: string, parent: number, t: number[], r: number[], s: number[]}} TpNode
 *   a node of the file's skeleton in its REST pose (local TRS); parent -1 = a scene root
 * @typedef {{node: number, path: 'translation'|'rotation'|'scale', times: Float32Array, values: Float32Array, interp: 'LINEAR'|'STEP'}} TpTrack
 * @typedef {{tool?: string, model?: string, version?: string, licence?: string, prompt?: string, date?: string, source?: string}} TpProvenance
 * @typedef {{
 *   name: string, duration: number, fps: number, frames: number, loop: boolean,
 *   rootMotion: 'moving'|'inplace', nodes: TpNode[], tracks: TpTrack[],
 *   humanoid: Record<string, number> | null, sig: string, provenance: TpProvenance | null,
 *   tpExtras: boolean
 * }} TpClip
 *   `humanoid` = VRM bone -> node index (null = a skeleton clip); `tpExtras` = the file carried
 *   our extras (false for a plain .vrma / .glb read as a clip)
 */

const PATHS = { position: 'translation', quaternion: 'rotation', scale: 'scale' };
const PROPS = { translation: 'position', rotation: 'quaternion', scale: 'scale' };

/** three's GLTFLoader renames nodes this way; bind by the same rule @param {string} n */
export const sanitizeName = (n) => THREE.PropertyBinding.sanitizeNodeName(String(n ?? ''));

// ---- signature ----------------------------------------------------------------------

/**
 * The skeleton signature: FNV-1a over the sorted `name<parent` lines of the bone nodes (sanitized
 * names, so a file and the model GLTFLoader built from it agree). Same skeleton = same sig.
 * @param {{name: string, parent: string}[]} pairs @returns {string}
 */
export function signatureOf(pairs) {
	const lines = pairs.map((p) => sanitizeName(p.name) + '<' + sanitizeName(p.parent)).sort();
	let h = 2166136261 >>> 0;
	const text = lines.join('\n');
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 16777619) >>> 0;
	}
	return 'sk1-' + lines.length + '-' + h.toString(16).padStart(8, '0');
}

/** @param {TpNode[]} nodes */
function nodesSig(nodes) {
	return signatureOf(nodes.map((n) => ({ name: n.name, parent: n.parent >= 0 ? nodes[n.parent].name : '' })));
}

/**
 * The bone set of a model (every Bone, plus the non-root ancestors that hold them) — the nodes a
 * skeleton clip written from it carries, and what its signature is taken over.
 * @param {THREE.Object3D} root @returns {THREE.Object3D[]} parent-first
 */
export function skeletonNodesOf(root) {
	/** @type {Set<THREE.Object3D>} */
	const keep = new Set();
	root.traverse((o) => {
		if (!(/** @type {any} */ (o).isBone)) return;
		for (let p = /** @type {THREE.Object3D | null} */ (o); p && p !== root; p = p.parent) keep.add(p);
	});
	/** @type {THREE.Object3D[]} */
	const out = [];
	root.traverse((o) => keep.has(o) && out.push(o));
	return out;
}

/** a model's skeleton signature ('' = it has no bones) @param {THREE.Object3D} root */
export function modelSignature(root) {
	const nodes = skeletonNodesOf(root);
	if (!nodes.length) return '';
	return signatureOf(nodes.map((o) => ({ name: o.name, parent: o.parent && o.parent !== root ? o.parent.name : '' })));
}

// ---- encode -------------------------------------------------------------------------

/** @param {number[]} v @param {number[]} d */
const isDefault = (v, d) => v.every((x, i) => Math.abs(x - d[i]) < 1e-9);

/**
 * TpClip -> `.tpanim` bytes. Deterministic: the same clip gives the same bytes.
 * @param {TpClip} tp @returns {ArrayBuffer}
 */
export function encodeTpanim(tp) {
	const b = new GlbBuilder();
	const humanoid = !!tp.humanoid;
	/** @type {any[]} */
	const nodes = tp.nodes.map((n) => {
		/** @type {any} */
		const out = { name: n.name };
		if (!isDefault(n.t, [0, 0, 0])) out.translation = n.t.map(Math.fround);
		if (!isDefault(n.r, [0, 0, 0, 1])) out.rotation = n.r.map(Math.fround);
		if (!isDefault(n.s, [1, 1, 1])) out.scale = n.s.map(Math.fround);
		return out;
	});
	tp.nodes.forEach((n, i) => {
		if (n.parent >= 0) (nodes[n.parent].children ??= []).push(i);
	});
	const roots = tp.nodes.map((n, i) => (n.parent < 0 ? i : -1)).filter((i) => i >= 0);
	/** @type {any[]} */
	const channels = [];
	/** @type {any[]} */
	const samplers = [];
	for (const tr of tp.tracks) {
		if (humanoid && tr.path === 'scale') continue; // VRMA allows rotation + hips translation only
		const input = b.addFloats(tr.times, 'SCALAR', true);
		const output = b.addFloats(tr.values, tr.path === 'rotation' ? 'VEC4' : 'VEC3');
		samplers.push({ input, output, interpolation: tr.interp === 'STEP' ? 'STEP' : 'LINEAR' });
		channels.push({ sampler: samplers.length - 1, target: { node: tr.node, path: tr.path } });
	}
	/** @type {any} */
	const json = {
		asset: { version: '2.0', generator: GENERATOR },
		scene: 0,
		scenes: [{ nodes: roots }],
		nodes,
		animations: [{ name: tp.name, channels, samplers }],
		extras: { theprototype: tpExtrasOf(tp) }
	};
	if (humanoid) {
		/** @type {Record<string, {node: number}>} */
		const humanBones = {};
		for (const bone of VRM_HUMAN_BONES) {
			const i = /** @type {any} */ (tp.humanoid)[bone];
			if (Number.isInteger(i)) humanBones[bone] = { node: i };
		}
		json.extensionsUsed = [VRMA_EXTENSION];
		json.extensions = { [VRMA_EXTENSION]: { specVersion: '1.0', humanoid: { humanBones } } };
	}
	return b.finish(json);
}

/** the `extras.theprototype` block @param {TpClip} tp */
export function tpExtrasOf(tp) {
	return {
		format: TPANIM_FORMAT,
		kind: 'clip',
		skeleton: { sig: tp.sig, humanoid: !!tp.humanoid },
		fps: tp.fps,
		frames: tp.frames,
		loop: !!tp.loop,
		rootMotion: tp.rootMotion === 'inplace' ? 'inplace' : 'moving',
		provenance: tp.provenance ?? null
	};
}

// ---- decode -------------------------------------------------------------------------

/**
 * `.tpanim` / `.vrma` / any animated `.glb` bytes -> TpClip (one animation; `animation` picks it).
 * A file without our extras gets them derived (fps from the key spacing, loop off, moving).
 * @param {ArrayBuffer | Uint8Array} bytes @param {{animation?: number}} [opts] @returns {TpClip}
 */
export function decodeTpanim(bytes, opts = {}) {
	const { json, bin } = unpackGlb(bytes);
	const anims = json.animations ?? [];
	const ai = opts.animation ?? 0;
	const anim = anims[ai];
	if (!anim) throw new Error('the file holds no animation');
	const used = new Set();
	/** @type {TpNode[]} */
	const nodes = (json.nodes ?? []).map((/** @type {any} */ n, /** @type {number} */ i) => {
		let name = String(n.name ?? '') || 'node_' + i;
		while (used.has(name)) name += '_' + i;
		used.add(name);
		let t = n.translation ?? [0, 0, 0];
		let r = n.rotation ?? [0, 0, 0, 1];
		let s = n.scale ?? [1, 1, 1];
		if (Array.isArray(n.matrix) && n.matrix.length === 16) {
			const p = new THREE.Vector3();
			const q = new THREE.Quaternion();
			const sc = new THREE.Vector3();
			new THREE.Matrix4().fromArray(n.matrix).decompose(p, q, sc);
			t = p.toArray();
			r = q.toArray();
			s = sc.toArray();
		}
		return { name, parent: -1, t: [...t], r: [...r], s: [...s] };
	});
	(json.nodes ?? []).forEach((/** @type {any} */ n, /** @type {number} */ i) => {
		for (const c of n.children ?? []) if (nodes[c]) nodes[c].parent = i;
	});
	/** @type {TpTrack[]} */
	const tracks = [];
	for (const ch of anim.channels ?? []) {
		const node = ch.target?.node;
		const path = ch.target?.path;
		if (!Number.isInteger(node) || !nodes[node] || !(path === 'translation' || path === 'rotation' || path === 'scale')) continue;
		const sampler = anim.samplers?.[ch.sampler];
		if (!sampler) continue;
		const times = readAccessor(json, bin, sampler.input);
		let values = readAccessor(json, bin, sampler.output);
		const n = path === 'rotation' ? 4 : 3;
		if (sampler.interpolation === 'CUBICSPLINE') values = cubicValues(values, n);
		if (values.length !== times.length * n) continue;
		tracks.push({ node, path, times, values, interp: sampler.interpolation === 'STEP' ? 'STEP' : 'LINEAR' });
	}
	const ext = json.extras?.theprototype;
	const tpExtras = !!ext && ext.kind === 'clip';
	const humanBones = json.extensions?.[VRMA_EXTENSION]?.humanoid?.humanBones;
	/** @type {Record<string, number> | null} */
	let humanoid = null;
	if (humanBones && typeof humanBones === 'object') {
		humanoid = {};
		for (const [bone, def] of Object.entries(humanBones))
			if (isVrmHumanBone(bone) && Number.isInteger(/** @type {any} */ (def)?.node) && nodes[/** @type {any} */ (def).node]) humanoid[bone] = /** @type {any} */ (def).node;
		if (!Object.keys(humanoid).length) humanoid = null;
	}
	const duration = tracks.reduce((m, tr) => Math.max(m, tr.times[tr.times.length - 1] ?? 0), 0);
	const fps = tpExtras && Number(ext.fps) > 0 ? Number(ext.fps) : detectFps(tracks);
	return {
		name: String(anim.name ?? '') || 'Clip',
		duration,
		fps,
		frames: tpExtras && Number.isFinite(ext.frames) ? Number(ext.frames) : Math.round(duration * fps),
		loop: tpExtras ? !!ext.loop : false,
		rootMotion: tpExtras && ext.rootMotion === 'inplace' ? 'inplace' : 'moving',
		nodes,
		tracks,
		humanoid,
		sig: tpExtras && typeof ext.skeleton?.sig === 'string' ? ext.skeleton.sig : nodesSig(nodes),
		provenance: tpExtras && ext.provenance && typeof ext.provenance === 'object' ? ext.provenance : null,
		tpExtras
	};
}

/** the animation names a GLB holds (several = one .tpanim each on import) @param {ArrayBuffer | Uint8Array} bytes */
export function glbAnimationNames(bytes) {
	if (!isGlb(bytes)) return [];
	try {
		return (unpackGlb(bytes).json.animations ?? []).map((/** @type {any} */ a, /** @type {number} */ i) => String(a?.name ?? '') || 'Clip ' + (i + 1));
	} catch {
		return [];
	}
}

/** does a GLB hold meshes (a model) or only nodes + animations (a clip file)? @param {ArrayBuffer | Uint8Array} bytes */
export function glbHasMeshes(bytes) {
	try {
		return (unpackGlb(bytes).json.meshes ?? []).length > 0;
	} catch {
		return false;
	}
}

/** CUBICSPLINE stores [inTangent, value, outTangent] per key: keep the values @param {Float32Array} v @param {number} n */
function cubicValues(v, n) {
	const keys = v.length / (3 * n);
	const out = new Float32Array(keys * n);
	for (let k = 0; k < keys; k++) for (let c = 0; c < n; c++) out[k * n + c] = v[k * 3 * n + n + c];
	return out;
}

/**
 * The sample rate the keys were baked at: the smallest key spacing, snapped to a common rate.
 * @param {{times: Float32Array}[]} tracks @returns {number}
 */
export function detectFps(tracks) {
	let d = Infinity;
	for (const tr of tracks)
		for (let i = 1; i < tr.times.length; i++) {
			const dt = tr.times[i] - tr.times[i - 1];
			if (dt > 1e-4 && dt < d) d = dt;
		}
	if (!Number.isFinite(d)) return 30;
	const raw = 1 / d;
	for (const common of [24, 25, 30, 48, 50, 60, 90, 120]) if (Math.abs(raw - common) / common < 0.03) return common;
	return Math.min(240, Math.max(1, Math.round(raw)));
}

// ---- three <-> TpClip -----------------------------------------------------------------

/**
 * A model's clip -> a skeleton TpClip. `root` must be in its REST pose (a fresh parse, or rest
 * restored); the file carries the model's whole bone set (so its signature matches the model's)
 * plus any other node a track animates (57 M12 parts).
 * @param {THREE.Object3D} root @param {THREE.AnimationClip} clip
 * @param {{fps?: number, loop?: boolean, rootMotion?: 'moving'|'inplace', provenance?: TpProvenance | null, name?: string, rest?: (o: THREE.Object3D) => {p: number[], q: number[], s: number[]} | null}} [opts]
 * @returns {TpClip}
 */
export function tpFromThreeClip(root, clip, opts = {}) {
	/** @type {Map<string, THREE.Object3D>} */
	const byName = new Map();
	root.traverse((o) => {
		if (o !== root && !byName.has(o.name)) byName.set(o.name, o);
	});
	/** @type {{obj: THREE.Object3D, path: 'translation'|'rotation'|'scale', track: THREE.KeyframeTrack}[]} */
	const bound = [];
	for (const track of clip.tracks) {
		const parsed = THREE.PropertyBinding.parseTrackName(track.name);
		const prop = /** @type {keyof typeof PATHS} */ (parsed.propertyName);
		const path = /** @type {'translation'|'rotation'|'scale' | undefined} */ (PATHS[prop]);
		if (!path) continue; // morph weights, material props: not in a clip file
		const key = parsed.objectName === 'bones' && parsed.objectIndex !== undefined ? String(parsed.objectIndex) : parsed.nodeName;
		const obj = byName.get(key) ?? byName.get(sanitizeName(key));
		if (!obj) continue;
		bound.push({ obj, path, track });
	}
	/** @type {Set<THREE.Object3D>} */
	const keep = new Set(skeletonNodesOf(root));
	for (const { obj } of bound) for (let p = /** @type {THREE.Object3D | null} */ (obj); p && p !== root; p = p.parent) keep.add(p);
	/** @type {THREE.Object3D[]} */
	const list = [];
	root.traverse((o) => keep.has(o) && list.push(o));
	const index = new Map(list.map((o, i) => [o, i]));
	/** @type {TpNode[]} */
	const nodes = list.map((o) => {
		const r = opts.rest?.(o);
		return {
			name: o.name,
			parent: o.parent && index.has(o.parent) ? /** @type {number} */ (index.get(o.parent)) : -1,
			t: r ? [...r.p] : o.position.toArray(),
			r: r ? [...r.q] : o.quaternion.toArray(),
			s: r ? [...r.s] : o.scale.toArray()
		};
	});
	/** @type {TpTrack[]} */
	const tracks = bound.map(({ obj, path, track }) => ({
		node: /** @type {number} */ (index.get(obj)),
		path,
		times: Float32Array.from(track.times),
		values: Float32Array.from(track.values),
		interp: /** @type {'LINEAR'|'STEP'} */ (track.getInterpolation() === THREE.InterpolateDiscrete ? 'STEP' : 'LINEAR')
	}));
	const duration = clip.duration > 0 ? clip.duration : tracks.reduce((m, tr) => Math.max(m, tr.times[tr.times.length - 1] ?? 0), 0);
	const fps = opts.fps ?? detectFps(tracks);
	const bones = skeletonNodesOf(root);
	return {
		name: opts.name ?? (clip.name || 'Clip'),
		duration,
		fps,
		frames: Math.round(duration * fps),
		loop: !!opts.loop,
		rootMotion: opts.rootMotion ?? 'moving',
		nodes,
		tracks,
		humanoid: null,
		sig: bones.length ? modelSignature(root) : nodesSig(nodes),
		provenance: opts.provenance ?? null,
		tpExtras: true
	};
}

/**
 * TpClip -> an AnimationClip bound by node name (the file's own skeleton, or a model with those
 * bones). A humanoid clip's tracks then target its humanoid-named nodes — bind it to a model with
 * `bindHumanoid` instead.
 * @param {TpClip} tp @returns {THREE.AnimationClip}
 */
export function tpToThreeClip(tp) {
	const tracks = tp.tracks.map((tr) => makeTrack(sanitizeName(tp.nodes[tr.node].name) + '.' + PROPS[tr.path], tr));
	return new THREE.AnimationClip(tp.name, tp.duration, tracks);
}

/** @param {string} name @param {TpTrack} tr */
function makeTrack(name, tr) {
	const T = tr.path === 'rotation' ? THREE.QuaternionKeyframeTrack : THREE.VectorKeyframeTrack;
	return new T(name, Array.from(tr.times), Array.from(tr.values), tr.interp === 'STEP' ? THREE.InterpolateDiscrete : THREE.InterpolateLinear);
}

// ---- sampling -------------------------------------------------------------------------

/** the frame times a clip is resampled at (0 .. duration, `frames` + 1 of them) @param {TpClip} tp */
export function frameTimes(tp) {
	const n = Math.max(1, Math.round(tp.duration * tp.fps));
	const out = new Float32Array(n + 1);
	for (let i = 0; i <= n; i++) out[i] = Math.min(tp.duration, i / tp.fps);
	return out;
}

/**
 * Pose the file's own skeleton at time t: local TRS per node (rest where nothing is keyed).
 * @param {TpClip} tp @param {any[]} interps from `interpolants(tp)` @param {number} t
 * @returns {{p: THREE.Vector3, q: THREE.Quaternion, s: THREE.Vector3}[]}
 */
function poseAt(tp, interps, t) {
	const pose = tp.nodes.map((n) => ({ p: new THREE.Vector3().fromArray(n.t), q: new THREE.Quaternion().fromArray(n.r), s: new THREE.Vector3().fromArray(n.s) }));
	tp.tracks.forEach((tr, i) => {
		if (!interps[i]) return; // the rest pose: no interpolants
		const v = interps[i].evaluate(t);
		const target = pose[tr.node];
		if (tr.path === 'rotation') target.q.fromArray(v).normalize();
		else if (tr.path === 'translation') target.p.fromArray(v);
		else target.s.fromArray(v);
	});
	return pose;
}

/** @param {TpClip} tp */
function interpolants(tp) {
	return tp.tracks.map((tr) => /** @type {any} */ (makeTrack('n.' + PROPS[tr.path], tr)).createInterpolant());
}

/** world matrices (in the file's root frame) for a pose @param {TpClip} tp @param {{p: THREE.Vector3, q: THREE.Quaternion, s: THREE.Vector3}[]} pose */
function worldMatrices(tp, pose) {
	/** @type {THREE.Matrix4[]} */
	const world = [];
	tp.nodes.forEach((n, i) => {
		const local = new THREE.Matrix4().compose(pose[i].p, pose[i].q, pose[i].s);
		// nodes are parent-first in every file we write; a foreign file may not be, so recurse
		world[i] = local;
	});
	/** @type {(THREE.Matrix4 | undefined)[]} */
	const done = [];
	/** @param {number} i @returns {THREE.Matrix4} */
	const resolve = (i) => {
		const hit = done[i];
		if (hit) return hit;
		const p = tp.nodes[i].parent;
		const m = p >= 0 ? resolve(p).clone().multiply(world[i]) : world[i];
		done[i] = m;
		return m;
	};
	return tp.nodes.map((_, i) => resolve(i));
}

/** @param {THREE.Matrix4} m */
function rotOf(m) {
	const p = new THREE.Vector3();
	const q = new THREE.Quaternion();
	const s = new THREE.Vector3();
	m.decompose(p, q, s);
	return q;
}

/** @param {THREE.Matrix4} m */
function posOf(m) {
	return new THREE.Vector3().setFromMatrixPosition(m);
}

// ---- humanoid: normalize + bind ------------------------------------------------------

/**
 * A skeleton clip + a humanoid map -> the HUMANOID TpClip (VRMA, normalized). Frame-sampled, so
 * unmapped in-between bones (a twist bone, an extra spine) fold into their humanoid child.
 * @param {TpClip} tp a skeleton clip (its nodes = the source rig in rest)
 * @param {Record<string, string>} map VRM bone -> source node name (57-chars M2 detects these)
 * @returns {TpClip}
 */
export function toHumanoid(tp, map) {
	const byName = new Map(tp.nodes.map((n, i) => [n.name, i]));
	const bySan = new Map(tp.nodes.map((n, i) => [sanitizeName(n.name), i]));
	/** @type {Record<string, number>} */
	const src = {};
	for (const bone of VRM_HUMAN_BONES) {
		const name = map[bone];
		if (!name) continue;
		const i = byName.get(name) ?? bySan.get(sanitizeName(name));
		if (i !== undefined) src[bone] = i;
	}
	if (src.hips === undefined) throw new Error('the humanoid map has no hips');
	const bones = VRM_HUMAN_BONES.filter((b) => src[b] !== undefined);
	const has = (/** @type {string} */ b) => src[b] !== undefined;
	const interps = interpolants(tp);
	const restW = worldMatrices(tp, poseAt(tp, [], 0)); // rest: no tracks applied
	const restQ = bones.map((b) => rotOf(restW[src[b]]));
	const restInv = restQ.map((q) => q.clone().invert());
	const times = frameTimes(tp);
	/** @type {Float32Array[]} */
	const rot = bones.map(() => new Float32Array(times.length * 4));
	const hipsPos = new Float32Array(times.length * 3);
	const at = new Map(bones.map((b, i) => [b, i]));
	times.forEach((t, f) => {
		const w = worldMatrices(tp, poseAt(tp, interps, t));
		/** @type {THREE.Quaternion[]} world delta per bone: D = W(t) * W_rest^-1 */
		const D = bones.map((b, i) => rotOf(w[src[b]]).multiply(restInv[i]));
		bones.forEach((b, i) => {
			const parent = humanParentIn(b, has);
			const n = parent ? D[/** @type {number} */ (at.get(parent))].clone().invert().multiply(D[i]) : D[i].clone();
			n.normalize().toArray(rot[i], f * 4);
		});
		posOf(w[src.hips]).toArray(hipsPos, f * 3);
	});
	const restPos = bones.map((b) => posOf(restW[src[b]]));
	/** @type {TpNode[]} */
	const nodes = bones.map((b, i) => {
		const parent = humanParentIn(b, has);
		const pi = parent ? /** @type {number} */ (at.get(parent)) : -1;
		const off = pi >= 0 ? restPos[i].clone().sub(restPos[pi]) : restPos[i].clone();
		return { name: b, parent: pi, t: off.toArray(), r: [0, 0, 0, 1], s: [1, 1, 1] };
	});
	/** @type {TpTrack[]} */
	const tracks = [];
	bones.forEach((b, i) => {
		if (isConstantIdentity(rot[i])) return; // a bone that never turns needs no track
		tracks.push({ node: i, path: 'rotation', times, values: rot[i], interp: 'LINEAR' });
	});
	tracks.unshift({ node: 0, path: 'translation', times, values: hipsPos, interp: 'LINEAR' });
	/** @type {Record<string, number>} */
	const humanoid = {};
	bones.forEach((b, i) => (humanoid[b] = i));
	return { ...tp, nodes, tracks, humanoid, sig: humanoidSig(bones) };
}

/** a humanoid clip's signature: which humanoid bones it carries @param {string[]} bones */
export function humanoidSig(bones) {
	return 'vrm1-' + signatureOf(bones.map((b) => ({ name: b, parent: humanParentIn(b, (x) => bones.includes(x)) ?? '' }))).slice(4);
}

/** @param {Float32Array} q */
function isConstantIdentity(q) {
	for (let i = 0; i < q.length; i += 4) if (Math.abs(q[i]) > 1e-6 || Math.abs(q[i + 1]) > 1e-6 || Math.abs(q[i + 2]) > 1e-6) return false;
	return true;
}

/**
 * A humanoid clip as NORMALIZED frames, read the way three-vrm's VRMA loader reads it (so a
 * foreign .vrma with non-identity rest rotations means the same thing here as there):
 * per bone n = W(humanParent) * q * W(bone)^-1, hips position through the hips' parent matrix.
 * @param {TpClip} tp @returns {{times: Float32Array, bones: string[], rot: Record<string, Float32Array>, hips: Float32Array | null, restHipsY: number}}
 */
export function humanoidFrames(tp) {
	if (!tp.humanoid) throw new Error('not a humanoid clip');
	const hb = /** @type {Record<string, number>} */ (tp.humanoid);
	const restW = worldMatrices(tp, poseAt(tp, [], 0));
	const bones = VRM_HUMAN_BONES.filter((b) => hb[b] !== undefined);
	const has = (/** @type {string} */ b) => hb[b] !== undefined;
	const times = frameTimes(tp);
	/** @type {Record<string, Float32Array>} */
	const rot = {};
	/** @type {Float32Array | null} */
	let hips = null;
	for (const b of bones) {
		const node = hb[b];
		const trR = tp.tracks.find((tr) => tr.node === node && tr.path === 'rotation');
		const parent = humanParentIn(b, has);
		const parentW = parent ? rotOf(restW[hb[parent]]) : tp.nodes[node].parent >= 0 ? rotOf(restW[tp.nodes[node].parent]) : new THREE.Quaternion();
		const invW = rotOf(restW[node]).invert();
		const out = new Float32Array(times.length * 4);
		const interp = trR ? /** @type {any} */ (makeTrack('n.quaternion', trR)).createInterpolant() : null;
		const restLocal = new THREE.Quaternion().fromArray(tp.nodes[node].r);
		const q = new THREE.Quaternion();
		times.forEach((t, f) => {
			if (interp) q.fromArray(interp.evaluate(t));
			else q.copy(restLocal);
			q.normalize().premultiply(parentW).multiply(invW).normalize().toArray(out, f * 4);
		});
		rot[b] = out;
		if (b === 'hips') {
			const trT = tp.tracks.find((tr) => tr.node === node && tr.path === 'translation');
			const pm = tp.nodes[node].parent >= 0 ? restW[tp.nodes[node].parent] : new THREE.Matrix4();
			const ip = trT ? /** @type {any} */ (makeTrack('n.position', trT)).createInterpolant() : null;
			hips = new Float32Array(times.length * 3);
			const v = new THREE.Vector3();
			times.forEach((t, f) => {
				if (ip) v.fromArray(ip.evaluate(t));
				else v.fromArray(tp.nodes[node].t);
				v.applyMatrix4(pm).toArray(/** @type {Float32Array} */ (hips), f * 3);
			});
		}
	}
	const restHipsY = posOf(restW[hb.hips]).y;
	return { times, bones, rot, hips, restHipsY };
}

/**
 * Bind a humanoid clip to a model: raw-bone tracks for THAT model's skeleton, from its humanoid
 * map and its REST pose (q' = W'(rawParent)^-1 · D(humanParent)^-1 · D(bone) · W'(bone), where D is
 * the clip's normalized world rotation — VRMHumanoidRig's transfer, generalized to rigs with
 * unmapped in-between bones). No rest-pose correction here (an A-pose clip on a T-pose rig keeps
 * its arm angle): that is 57-chars M2's retarget, which may wrap this.
 * @param {TpClip} tp a humanoid clip
 * @param {THREE.Object3D} root the model
 * @param {Record<string, string>} map VRM bone -> the model's node name
 * @param {{rest?: (o: THREE.Object3D) => {p: number[], q: number[], s: number[]} | null, name?: string}} [opts]
 *   `rest` = the model's rest pose per node (defaults to the node's current transform)
 * @returns {THREE.AnimationClip}
 */
export function bindHumanoid(tp, root, map, opts = {}) {
	const fr = humanoidFrames(tp);
	/** @type {Map<string, THREE.Object3D>} */
	const byName = new Map();
	root.traverse((o) => {
		if (o !== root && !byName.has(o.name)) byName.set(o.name, o);
	});
	const find = (/** @type {string} */ n) => byName.get(n) ?? byName.get(sanitizeName(n)) ?? null;
	/** @type {Record<string, THREE.Object3D>} */
	const target = {};
	for (const b of VRM_HUMAN_BONES) {
		const o = map[b] ? find(map[b]) : null;
		if (o) target[b] = o;
	}
	if (!target.hips) throw new Error('the model has no mapped hips');
	// the model's REST world matrices in its root frame
	/** @type {Map<THREE.Object3D, THREE.Matrix4>} */
	const restWorld = new Map();
	/** @param {THREE.Object3D} o @returns {THREE.Matrix4} */
	const worldOf = (o) => {
		const hit = restWorld.get(o);
		if (hit) return hit;
		const r = opts.rest?.(o);
		const local = r
			? new THREE.Matrix4().compose(new THREE.Vector3().fromArray(r.p), new THREE.Quaternion().fromArray(r.q), new THREE.Vector3().fromArray(r.s))
			: new THREE.Matrix4().compose(o.position, o.quaternion, o.scale);
		const m = o.parent && o.parent !== root ? worldOf(o.parent).clone().multiply(local) : local;
		restWorld.set(o, m);
		return m;
	};
	const inClip = new Set(fr.bones);
	const has = (/** @type {string} */ b) => !!target[b];
	const tBones = VRM_HUMAN_BONES.filter((b) => target[b]);
	const n = fr.times.length;
	/** D per VRM bone per frame (bones absent from the clip inherit their parent's) */
	/** @type {Record<string, THREE.Quaternion[]>} */
	const D = {};
	for (const b of VRM_HUMAN_BONES) {
		const parent = /** @type {any} */ (humanParentIn(b, (x) => !!D[x]));
		if (!inClip.has(b) && !parent) continue;
		const list = [];
		for (let f = 0; f < n; f++) {
			const local = inClip.has(b) ? new THREE.Quaternion().fromArray(fr.rot[b], f * 4) : new THREE.Quaternion();
			list.push(parent ? D[parent][f].clone().multiply(local) : local);
		}
		D[b] = list;
	}
	/** @type {THREE.KeyframeTrack[]} */
	const tracks = [];
	const times = Array.from(fr.times);
	for (const b of tBones) {
		if (!D[b]) continue;
		const o = target[b];
		const hp = humanParentIn(b, has);
		const rawParentW = o.parent && o.parent !== root ? rotOf(worldOf(o.parent)) : new THREE.Quaternion();
		const A = rawParentW.clone().invert();
		const B = rotOf(worldOf(o));
		const values = new Float32Array(n * 4);
		for (let f = 0; f < n; f++) {
			const rel = hp && D[hp] ? D[hp][f].clone().invert().multiply(D[b][f]) : D[b][f].clone();
			A.clone().multiply(rel).multiply(B).normalize().toArray(values, f * 4);
		}
		tracks.push(new THREE.QuaternionKeyframeTrack(o.name + '.quaternion', times, Array.from(values)));
	}
	if (fr.hips) {
		const o = target.hips;
		const hipsY = posOf(worldOf(o)).y;
		const scale = fr.restHipsY > 1e-3 && hipsY > 1e-3 ? hipsY / fr.restHipsY : 1;
		const inv = o.parent && o.parent !== root ? worldOf(o.parent).clone().invert() : new THREE.Matrix4();
		const values = new Float32Array(n * 3);
		const v = new THREE.Vector3();
		for (let f = 0; f < n; f++) v.fromArray(fr.hips, f * 3).multiplyScalar(scale).applyMatrix4(inv).toArray(values, f * 3);
		tracks.push(new THREE.VectorKeyframeTrack(o.name + '.position', times, Array.from(values)));
	}
	return new THREE.AnimationClip(opts.name ?? tp.name, tp.duration, tracks);
}

/**
 * How a clip fits a model: 'exact' (same skeleton signature), 'humanoid' (a humanoid clip and the
 * model has a humanoid map), 'partial' (some animated nodes found by name), 'none'.
 * @param {TpClip} tp @param {THREE.Object3D} root @param {Record<string, string> | null} [map]
 * @returns {{fit: 'exact'|'humanoid'|'partial'|'none', matched: number, total: number}}
 */
export function clipFit(tp, root, map) {
	if (tp.humanoid) {
		const ok = !!map?.hips;
		return { fit: ok ? 'humanoid' : 'none', matched: ok ? 1 : 0, total: 1 };
	}
	const names = new Set();
	root.traverse((o) => names.add(sanitizeName(o.name)));
	const animated = [...new Set(tp.tracks.map((tr) => sanitizeName(tp.nodes[tr.node].name)))];
	const matched = animated.filter((n) => names.has(n)).length;
	if (tp.sig && tp.sig === modelSignature(root) && matched === animated.length) return { fit: 'exact', matched, total: animated.length };
	return { fit: matched === 0 ? 'none' : matched === animated.length ? 'exact' : 'partial', matched, total: animated.length };
}

/** facts for a UI row @param {TpClip} tp */
export function clipFacts(tp) {
	return {
		name: tp.name,
		duration: tp.duration,
		fps: tp.fps,
		frames: tp.frames,
		loop: tp.loop,
		rootMotion: tp.rootMotion,
		humanoid: !!tp.humanoid,
		bones: tp.humanoid ? Object.keys(tp.humanoid).length : tp.nodes.length,
		tracks: tp.tracks.length
	};
}
