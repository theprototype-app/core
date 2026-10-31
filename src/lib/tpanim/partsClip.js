// 57 M12: the PURE half of animate_parts — keys on named parts -> a node-name TpClip. three's math
// only (the model is read, never changed), so the unit suite runs it in node.

import * as THREE from 'three';
import { sanitizeName, signatureOf, TPANIM_FORMAT } from './format.js';

const MAX_TRACKS = 64;
const MAX_KEYS = 512;
/** a rotation segment longer than this is split, so a 360° spin is a spin and not a no-op slerp */
const MAX_STEP_DEG = 90;

/**
 * @typedef {{t: number, pos?: number[], rot?: number[], scale?: number[]}} PartKey
 *   `rot` = Euler degrees [x, y, z] (XYZ) or a quaternion [x, y, z, w]
 * @typedef {{part: string, keys: PartKey[]}} PartTrack
 */

/** @param {any} root @param {string} name */
export function findPart(root, name) {
	const want = String(name ?? '');
	let hit = root.getObjectByName(want) ?? root.getObjectByName(sanitizeName(want));
	if (!hit) {
		const low = want.toLowerCase();
		root.traverse((/** @type {any} */ o) => {
			if (!hit && o !== root && (o.name?.toLowerCase() === low || sanitizeName(o.name).toLowerCase() === sanitizeName(low).toLowerCase())) hit = o;
		});
	}
	return hit && hit !== root ? hit : null;
}

/** @param {number[]} r @returns {THREE.Quaternion} */
function quatOf(r) {
	if (r.length === 4) return new THREE.Quaternion(r[0], r[1], r[2], r[3]).normalize();
	const d = THREE.MathUtils.degToRad;
	return new THREE.Quaternion().setFromEuler(new THREE.Euler(d(r[0] ?? 0), d(r[1] ?? 0), d(r[2] ?? 0), 'XYZ'));
}

/**
 * Euler keys -> quaternion keys, inserting in-between keys wherever one segment turns more than
 * MAX_STEP_DEG (a quaternion slerp takes the SHORT way, so 0° → 360° would not move at all).
 * @param {{t: number, rot: number[]}[]} keys @returns {{t: number, q: THREE.Quaternion}[]}
 */
export function rotationKeys(keys) {
	/** @type {{t: number, q: THREE.Quaternion}[]} */
	const out = [];
	for (let i = 0; i < keys.length; i++) {
		const k = keys[i];
		if (i === 0 || k.rot.length === 4 || keys[i - 1].rot.length === 4) {
			out.push({ t: k.t, q: quatOf(k.rot) });
			continue;
		}
		const a = keys[i - 1].rot;
		const b = k.rot;
		const span = Math.max(...[0, 1, 2].map((c) => Math.abs((b[c] ?? 0) - (a[c] ?? 0))));
		const steps = Math.max(1, Math.ceil(span / MAX_STEP_DEG));
		for (let s = 1; s <= steps; s++) {
			const f = s / steps;
			out.push({ t: keys[i - 1].t + (k.t - keys[i - 1].t) * f, q: quatOf([0, 1, 2].map((c) => (a[c] ?? 0) + ((b[c] ?? 0) - (a[c] ?? 0)) * f)) });
		}
	}
	return out;
}

/**
 * Build the clip (pure: the model is only read). `relative` (default) = keys are offsets from each
 * part's rest pose (pos added, rot turned after the rest, scale multiplied); `absolute` = local values.
 * @param {any} root @param {{clip: string, tracks: PartTrack[], loop?: boolean, mode?: 'relative'|'absolute'}} spec
 * @param {(o: any) => {p: number[], q: number[], s: number[]} | null} [rest]
 * @returns {{tp: import('./format.js').TpClip | null, parts: string[], missing: string[]}}
 */
export function buildPartsClip(root, spec, rest) {
	const relative = spec.mode !== 'absolute';
	const restOf = (/** @type {any} */ o) => rest?.(o) ?? { p: o.position.toArray(), q: o.quaternion.toArray(), s: o.scale.toArray() };
	/** @type {any[]} */
	const found = [];
	const missing = [];
	for (const tr of (spec.tracks ?? []).slice(0, MAX_TRACKS)) {
		const node = findPart(root, tr?.part);
		if (!node) {
			missing.push(String(tr?.part ?? ''));
			continue;
		}
		const keys = (Array.isArray(tr.keys) ? tr.keys : [])
			.filter((k) => k && Number.isFinite(Number(k.t)))
			.map((k) => ({ ...k, t: Math.max(0, Number(k.t)) }))
			.sort((a, b) => a.t - b.t)
			.slice(0, MAX_KEYS);
		if (keys.length) found.push({ node, keys });
	}
	if (!found.length) return { tp: null, parts: [], missing };
	// the nodes: every animated part + its ancestors up to (not including) the model root
	/** @type {Set<any>} */
	const keep = new Set();
	for (const { node } of found) for (let p = node; p && p !== root; p = p.parent) keep.add(p);
	/** @type {any[]} */
	const list = [];
	root.traverse((/** @type {any} */ o) => keep.has(o) && list.push(o));
	const index = new Map(list.map((o, i) => [o, i]));
	const nodes = list.map((o) => {
		const r = restOf(o);
		return { name: o.name, parent: o.parent && index.has(o.parent) ? /** @type {number} */ (index.get(o.parent)) : -1, t: [...r.p], r: [...r.q], s: [...r.s] };
	});
	/** @type {import('./format.js').TpTrack[]} */
	const tracks = [];
	let duration = 0;
	for (const { node, keys } of found) {
		const r = restOf(node);
		const ni = /** @type {number} */ (index.get(node));
		const pos = keys.filter((/** @type {any} */ k) => Array.isArray(k.pos) && k.pos.length === 3);
		const rot = keys.filter((/** @type {any} */ k) => Array.isArray(k.rot) && (k.rot.length === 3 || k.rot.length === 4));
		const scl = keys.filter((/** @type {any} */ k) => Array.isArray(k.scale) && (k.scale.length === 3 || k.scale.length === 1));
		if (pos.length) {
			const values = pos.flatMap((/** @type {any} */ k) => (relative ? k.pos.map((/** @type {number} */ v, /** @type {number} */ c) => r.p[c] + Number(v)) : k.pos.map(Number)));
			tracks.push({ node: ni, path: 'translation', times: Float32Array.from(pos.map((/** @type {any} */ k) => k.t)), values: Float32Array.from(values), interp: 'LINEAR' });
		}
		if (rot.length) {
			const restQ = new THREE.Quaternion().fromArray(r.q);
			const qk = rotationKeys(rot);
			/** @type {number[]} */
			const values = [];
			const prev = new THREE.Quaternion();
			qk.forEach(({ q }, i) => {
				const v = relative ? restQ.clone().multiply(q) : q.clone();
				if (i && v.dot(prev) < 0) v.set(-v.x, -v.y, -v.z, -v.w); // keep the hemisphere: no flip mid-spin
				prev.copy(v);
				values.push(...v.toArray());
			});
			tracks.push({ node: ni, path: 'rotation', times: Float32Array.from(qk.map((k) => k.t)), values: Float32Array.from(values), interp: 'LINEAR' });
		}
		if (scl.length) {
			const values = scl.flatMap((/** @type {any} */ k) => {
				const v = k.scale.length === 1 ? [k.scale[0], k.scale[0], k.scale[0]] : k.scale;
				return relative ? v.map((/** @type {number} */ x, /** @type {number} */ c) => r.s[c] * Number(x)) : v.map(Number);
			});
			tracks.push({ node: ni, path: 'scale', times: Float32Array.from(scl.map((/** @type {any} */ k) => k.t)), values: Float32Array.from(values), interp: 'LINEAR' });
		}
		duration = Math.max(duration, keys[keys.length - 1].t);
	}
	if (!tracks.length || duration <= 0) return { tp: null, parts: found.map((f) => f.node.name), missing };
	const fps = 30;
	return {
		tp: {
			name: String(spec.clip || 'Parts').slice(0, 80),
			duration,
			fps,
			frames: Math.round(duration * fps),
			loop: spec.loop !== false,
			rootMotion: 'moving',
			nodes,
			tracks,
			humanoid: null,
			sig: signatureOf(nodes.map((n) => ({ name: n.name, parent: n.parent >= 0 ? nodes[n.parent].name : '' }))),
			provenance: { tool: 'animate_parts', version: String(TPANIM_FORMAT), date: new Date().toISOString().slice(0, 10) },
			tpExtras: true
		},
		parts: found.map((f) => f.node.name),
		missing
	};
}

