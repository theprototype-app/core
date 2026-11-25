// 102-boot-diet-2: the TRIANGLE-SOUP helpers every mesh tool shares (read a geometry into tagged
// triangles, write positions / material groups / UVs back, shells), moved verbatim out of faceEdit.js so
// boot code (colliders, VR stretch, the UV editor's snapshot) uses them without loading the face editor.
// Pure apart from THREE and triFrame; faceEdit imports them back and re-exports the public ones.
import * as THREE from 'three';
import { frameOfTris, shellsOf } from './triFrame';

/**
 * Union-find over welded vertex keys: the connected components ("shells") of
 * a triangle soup — a merged-in primitive is one shell, a plane floating off
 * a box is another. Shared by Shell granularity (CL-B) and custom-collider
 * piece splitting (CL-A A8). @param {any[]} tris @returns {number[][]} tri-index groups
 */
export function shellsOfTris(tris) {
	return shellsOf(frameOfTris(tris));
}

/** Carry a MATERIAL SLOT (and M1: the per-corner UVs) onto a triangle. Stored as
 * properties on the triangle array so every op that clones/filters/maps tris
 * keeps them without changing the [v0,v1,v2] shape every caller expects.
 * @param {any} tri @param {number=} mi @param {any=} uv */
export function withSlot(tri, mi, uv) {
	tri.mi = mi || 0;
	if (uv) tri.uv = uv; // M1: per-corner [[u,v],[u,v],[u,v]], absent when untextured
	return tri;
}

/** element index -> material slot, read off a geometry's groups (0 when the
 * geometry is ungrouped) @param {any[]} groups @param {number} count */
export function slotLookup(groups, count) {
	if (!groups?.length) return () => 0;
	const slots = new Int32Array(count);
	for (const group of groups) {
		const start = Math.max(group.start | 0, 0);
		const end = Math.min(start + (group.count | 0), count);
		for (let i = start; i < end; i++) slots[i] = group.materialIndex || 0;
	}
	return (/** @type {number} */ i) => slots[i] || 0;
}

/**
 * Read a geometry into triangles [[Vector3,Vector3,Vector3], ...] (index
 * expanded). Each triangle also carries `mi` — the MATERIAL SLOT it came from
 * (15-G): a merged or imported mesh can wear a material ARRAY, and three draws
 * an array material by walking `geometry.groups`, so a swapped-in geometry with
 * no groups renders NOTHING AT ALL. @param {any} geometry
 */
export function readTriangles(geometry) {
	const pos = geometry.attributes.position;
	const uvAttr = geometry.attributes.uv;
	const index = geometry.index;
	const count = index ? index.count : pos.count;
	const slotAt = slotLookup(geometry.groups, count);
	const tris = [];
	for (let i = 0; i < count; i += 3) {
		const idx = (/** @type {number} */ o) => (index ? index.getX(i + o) : i + o);
		const vert = (/** @type {number} */ o) => {
			const j = idx(o);
			return new THREE.Vector3(pos.getX(j), pos.getY(j), pos.getZ(j));
		};
		const tri = withSlot([vert(0), vert(1), vert(2)], slotAt(i));
		// M1: carry TEXTURE COORDINATES through the edit. Every op used to rebuild
		// the geometry from positions alone, so editing a textured mesh silently
		// destroyed its mapping. `uv` is [[u,v],[u,v],[u,v]] per corner, or absent
		// when the source has no uv attribute (the overwhelmingly common case —
		// nothing extra is computed, stored or sent for those).
		if (uvAttr) tri.uv = [0, 1, 2].map((o) => [uvAttr.getX(idx(o)), uvAttr.getY(idx(o))]);
		tris.push(tri);
	}
	return tris;
}

/**
 * 15-G: the triangles' MATERIAL SLOTS run-length encoded into geometry groups
 * (vertex units, the shape three wants). Returns null when everything is slot 0
 * — a single-material mesh needs no groups at all, so the overwhelmingly common
 * case puts nothing extra on the wire and behaves exactly as before.
 * @param {any[]} tris @returns {any[] | null}
 */
export function trisToGroups(tris) {
	if (!tris.length || !tris.some((t) => (t.mi || 0) > 0)) return null;
	/** @type {any[]} */
	const groups = [];
	let start = 0;
	let slot = tris[0].mi || 0;
	for (let i = 1; i <= tris.length; i++) {
		const next = i < tris.length ? tris[i].mi || 0 : -1;
		if (next === slot) continue;
		groups.push({ start: start * 3, count: (i - start) * 3, materialIndex: slot });
		start = i;
		slot = next;
	}
	return groups;
}

/**
 * M1: the triangles' UVs as a flat array (2 per vertex), or null when the mesh
 * is untextured — the common case then puts nothing extra on the wire, in
 * history, or in the geometry, exactly like `trisToGroups`. A triangle that
 * somehow lost its uv (new geometry an op forgot to tag) contributes zeros
 * rather than a short array: a uv attribute must cover EVERY vertex.
 * @param {any[]} tris @returns {number[] | null}
 */
export function trisToUVs(tris) {
	if (!tris.some((t) => !!t.uv)) return null;
	/** @type {number[]} */
	const uvs = [];
	for (const t of tris)
		for (let c = 0; c < 3; c++) {
			const pair = t.uv ? t.uv[c] : null;
			uvs.push(pair ? pair[0] : 0, pair ? pair[1] : 0);
		}
	return uvs;
}

/** flat positions array for a snapshot message @param {any[]} tris */
export function trisToPositions(tris) {
	/** @type {number[]} */
	const positions = [];
	tris.forEach((t) => t.forEach((/** @type {any} */ v) => positions.push(v.x, v.y, v.z)));
	return positions;
}

/**
 * Scale one axis of a flat xyz positions array about its centroid on that axis
 * (161 stretch). Pure. @param {number[]} positions @param {number} axis 0|1|2
 * @param {number} factor @returns {number[]}
 */
export function stretchPositions(positions, axis, factor) {
	const out = positions.slice();
	const count = out.length / 3;
	if (!count) return out;
	let sum = 0;
	for (let i = axis; i < out.length; i += 3) sum += out[i];
	const center = sum / count;
	for (let i = axis; i < out.length; i += 3) out[i] = center + (out[i] - center) * factor;
	return out;
}
