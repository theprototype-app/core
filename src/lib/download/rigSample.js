// 57 M9 — pose a rig's REST ROWS (animatedImports' capture: {name, parent, t, q, s, bone}) with a
// clip at a time, without touching the scene: the BVH writer and the clip-file writer sample with
// it. Tracks bind by node name (`Hips.quaternion`, `.bones[Hips].quaternion`, sanitized names).

import * as THREE from 'three';

/**
 * @typedef {{name: string, parent: number, t: number[], q: number[], s: number[], bone?: boolean}} RestRow
 */

/**
 * Bind a clip's tracks to rows. @param {RestRow[]} rows @param {THREE.AnimationClip} clip
 * @returns {{row: number, property: 'quaternion'|'position'|'scale', interp: any}[]}
 */
export function bindClip(rows, clip) {
	const exact = new Map(rows.map((r, i) => [r.name, i]));
	const clean = new Map(rows.map((r, i) => [THREE.PropertyBinding.sanitizeNodeName(r.name), i]));
	/** @type {{row: number, property: any, interp: any}[]} */
	const out = [];
	for (const track of clip.tracks) {
		let parsed;
		try {
			parsed = THREE.PropertyBinding.parseTrackName(track.name);
		} catch {
			continue;
		}
		const node = parsed.objectName === 'bones' ? String(parsed.objectIndex ?? '') : parsed.nodeName;
		const row = exact.get(node) ?? clean.get(THREE.PropertyBinding.sanitizeNodeName(node));
		if (row === undefined || !['quaternion', 'position', 'scale'].includes(parsed.propertyName))
			continue;
		out.push({
			row,
			property: parsed.propertyName,
			interp: /** @type {any} */ (track).createInterpolant()
		});
	}
	return out;
}

/**
 * The rows' locals at time t (rest where no track says otherwise).
 * @param {RestRow[]} rows @param {ReturnType<typeof bindClip>} bound @param {number} t
 */
export function localsAt(rows, bound, t) {
	const L = rows.map((r) => ({ t: r.t.slice(), q: r.q.slice(), s: r.s.slice() }));
	for (const b of bound) {
		const v = b.interp.evaluate(t);
		if (b.property === 'quaternion') L[b.row].q = [v[0], v[1], v[2], v[3]];
		else if (b.property === 'position') L[b.row].t = [v[0], v[1], v[2]];
		else L[b.row].s = [v[0], v[1], v[2]];
	}
	return L;
}

/**
 * Root-space world matrices for given locals (rows parent-first).
 * @param {RestRow[]} rows @param {{t: number[], q: number[], s: number[]}[]} L @returns {THREE.Matrix4[]}
 */
export function worldMatrices(rows, L) {
	/** @type {THREE.Matrix4[]} */
	const M = [];
	const v = new THREE.Vector3();
	const q = new THREE.Quaternion();
	const s = new THREE.Vector3();
	rows.forEach((r, i) => {
		const m = new THREE.Matrix4().compose(
			v.fromArray(L[i].t),
			q.fromArray(L[i].q),
			s.fromArray(L[i].s)
		);
		if (r.parent >= 0) m.premultiply(M[r.parent]);
		M.push(m);
	});
	return M;
}

/** frame times for a clip at fps (first and last frame included) @param {number} duration @param {number} fps */
export function frameTimes(duration, fps) {
	const frames = Math.max(1, Math.round(Math.max(0, duration) * fps) + 1);
	const out = new Float32Array(frames);
	for (let f = 0; f < frames; f++) out[f] = frames > 1 ? (duration * f) / (frames - 1) : 0;
	return out;
}

/** a stable signature of a skeleton: bone names + who their parent is (FNV-1a, hex) @param {RestRow[]} rows */
export function skeletonSignature(rows) {
	let h = 0x811c9dc5;
	const text = rows.map((r) => r.name + '>' + (r.parent >= 0 ? rows[r.parent].name : '')).join('|');
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h.toString(16).padStart(8, '0');
}
