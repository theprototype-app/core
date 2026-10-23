// 57 M9 — CLIPS AS FILES: a three AnimationClip as glTF channels, and a clip as its own small file
// (a skeleton + one animation) in the 57 M1 `.tpanim` shape:
//   - humanoid clips are VALID VRM ANIMATION (`VRMC_vrm_animation`, humanBones -> nodes), so the
//     same bytes renamed `.vrma` play in VRM tools;
//   - other clips are a plain GLB holding only the skeleton + one animation;
//   - both carry `extras.theprototype = {format: 1, kind: 'clip', skeleton: {sig, humanoid}, fps,
//     frames, loop, rootMotion, provenance}` (on the glTF root, mirrored on the animation).
// 57-clips (M1) owns the format and its reader; until its writer lands this one writes exactly that
// shape (QUESTIONS-57-chars Q1), and either can replace the other at the union.

import * as THREE from 'three';
import { readGlb, writeGlb, appendAnimations } from './glbEdit.js';
import { frameTimes, skeletonSignature } from './rigSample.js';

/** @typedef {import('./rigSample.js').RestRow} RestRow */
/** @typedef {import('./glbEdit.js').PlainClip} PlainClip */

/**
 * A three clip as plain glTF channels. Smooth (cubic) tracks are resampled to linear at `fps`;
 * morph-target and property tracks are skipped (a rig's clip is bones).
 * @param {THREE.AnimationClip} clip @param {{fps?: number}} [opts] @returns {PlainClip}
 */
export function plainClip(clip, opts = {}) {
	const fps = opts.fps ?? 30;
	/** @type {import('./glbEdit.js').ClipChannel[]} */
	const channels = [];
	for (const track of clip.tracks) {
		let parsed;
		try {
			parsed = THREE.PropertyBinding.parseTrackName(track.name);
		} catch {
			continue;
		}
		const node = parsed.objectName === 'bones' ? String(parsed.objectIndex ?? '') : parsed.nodeName;
		/** @type {'rotation'|'translation'|'scale' | null} */
		const path =
			parsed.propertyName === 'quaternion'
				? 'rotation'
				: parsed.propertyName === 'position'
					? 'translation'
					: parsed.propertyName === 'scale'
						? 'scale'
						: null;
		if (!path || !node) continue;
		const mode = track.getInterpolation();
		if (mode === THREE.InterpolateSmooth) {
			const times = frameTimes(clip.duration, fps);
			const n = path === 'rotation' ? 4 : 3;
			const values = new Float32Array(times.length * n);
			const interp = /** @type {any} */ (track).createInterpolant();
			times.forEach((t, f) => values.set(interp.evaluate(t).subarray(0, n), f * n));
			channels.push({ node, path, times, values });
		} else
			channels.push({
				node,
				path,
				times: new Float32Array(track.times),
				values: new Float32Array(track.values),
				step: mode === THREE.InterpolateDiscrete
			});
	}
	return { name: clip.name, channels };
}

/**
 * Write one clip as its own file: the skeleton (the rig's rest rows; bones and their ancestors)
 * and one animation. With a humanoid map it is VRM Animation.
 * @param {RestRow[]} rows @param {THREE.AnimationClip} clip
 * @param {{map?: Record<string, string> | null, fps?: number, loop?: boolean, rootMotion?: boolean, provenance?: any[]}} [opts]
 * @returns {Uint8Array}
 */
export function writeClipFile(rows, clip, opts = {}) {
	const fps = opts.fps ?? 30;
	/** @type {any[]} */
	const nodes = rows.map((r) => ({ name: r.name, translation: r.t, rotation: r.q, scale: r.s }));
	rows.forEach((r, i) => {
		if (r.parent >= 0) (nodes[r.parent].children = nodes[r.parent].children ?? []).push(i);
	});
	for (const n of nodes) {
		if (n.scale.every((/** @type {number} */ v) => v === 1)) delete n.scale;
		if (n.rotation[0] === 0 && n.rotation[1] === 0 && n.rotation[2] === 0 && n.rotation[3] === 1)
			delete n.rotation;
	}
	const roots = rows.map((r, i) => (r.parent < 0 ? i : -1)).filter((i) => i >= 0);
	const humanoid = !!opts.map && Object.keys(opts.map).length > 0;
	const meta = {
		format: 1,
		kind: 'clip',
		skeleton: { sig: skeletonSignature(rows), humanoid },
		fps,
		frames: Math.max(1, Math.round(clip.duration * fps) + 1),
		loop: opts.loop !== false,
		rootMotion: !!opts.rootMotion,
		provenance: opts.provenance ?? []
	};
	/** @type {any} */
	const json = {
		asset: { version: '2.0', generator: 'theprototype.app' },
		scene: 0,
		scenes: [{ name: clip.name, nodes: roots, extras: { theprototype: meta } }],
		nodes,
		extras: { theprototype: meta }
	};
	if (humanoid) {
		/** @type {Record<string, {node: number}>} */
		const humanBones = {};
		const at = new Map(rows.map((r, i) => [r.name, i]));
		for (const [bone, name] of Object.entries(/** @type {Record<string, string>} */ (opts.map))) {
			const i = at.get(name);
			if (i !== undefined) humanBones[bone] = { node: i };
		}
		json.extensionsUsed = ['VRMC_vrm_animation'];
		json.extensions = { VRMC_vrm_animation: { specVersion: '1.0', humanoid: { humanBones } } };
	}
	const doc = { json, bin: new Uint8Array(0) };
	appendAnimations(doc, [{ ...plainClip(clip, { fps }), extras: { theprototype: meta } }]);
	return writeGlb(doc);
}

/**
 * Add clips to a model's ORIGINAL GLB and keep only the named embedded ones (layout (a); (c) is
 * `clips = []`, `keepEmbedded = []`). Nothing else in the file changes.
 * @param {ArrayBuffer | Uint8Array} bytes @param {THREE.AnimationClip[]} clips @param {string[] | null} keepEmbedded
 * @param {{fps?: number, provenance?: any[]}} [opts] `provenance` is written to the file's extras (57 M7)
 */
export function glbWithClips(bytes, clips, keepEmbedded, opts = {}) {
	const doc = readGlb(bytes);
	if (opts.provenance?.length) {
		const extras = doc.json.extras && typeof doc.json.extras === 'object' ? doc.json.extras : {};
		doc.json.extras = {
			...extras,
			theprototype: { ...(extras.theprototype ?? {}), provenance: opts.provenance }
		};
	}
	const names = (doc.json.animations ?? []).map(
		(/** @type {any} */ a, /** @type {number} */ i) => a.name ?? 'animation_' + i
	);
	if (keepEmbedded) {
		const keep = new Set(keepEmbedded);
		const next = (doc.json.animations ?? []).filter(
			(/** @type {any} */ _, /** @type {number} */ i) => keep.has(names[i])
		);
		if (next.length) doc.json.animations = next;
		else delete doc.json.animations;
	}
	const res = appendAnimations(
		doc,
		clips.map((c) => plainClip(c, opts))
	);
	return { bytes: writeGlb(doc), ...res };
}
