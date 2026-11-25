// @ts-check
// Roadmap 99 K8 (lane 99-newops): the editor's SMOOTH subdivide (Catmull-Clark) on the op mesh — the kernel's one
// implementation (meshKernel/catmullClark.js, shared with the agent's create_shape `subdivide`) plus the editor's
// two facts: every new quad is its own stored face (authored), and the output view is rebuilt in order-key order
// (the new quads come after every untouched triangle). The picked faces are isolated first (a stored face only
// partly picked is split into its triangles, which keep its stored face), so the cut follows the pick exactly. An
// unpicked neighbour on a split edge gains the edge point as a corner (no T-junction) and keeps its stored face.
// Pure (no three.js, no stores).

import { isolateTriangles, newGroup, buildView } from './opMesh.js';
import { catmullClark } from '../meshKernel/catmullClark.js';
import { MAX_SNAPSHOT, tooLargeMessage } from '../meshBudget.js';

/** @typedef {import('./opMesh.js').OpMesh} OpMesh */

/**
 * `levels` Catmull-Clark levels on the faces under output triangles `tris` (null = the whole mesh).
 * @param {OpMesh} om @param {number[] | null} tris @param {number} levels 1..3
 * Refuses BEFORE running when the result would pass the sync ceiling (each level makes a quad per corner).
 * @returns {{ newTris: number[], created: number[], count: number } | { error: string }}
 */
export function smoothSubdivide(om, tris, levels) {
	const L = Math.max(1, Math.min(3, Math.round(levels) || 1));
	const m = om.mesh;
	// the size first: a face of n corners ends as n * 4^(L-1) quads, two triangles each (an estimate: a partly
	// picked face counts whole)
	let pickedTris = 0;
	let corners = 0;
	const seen = new Set();
	for (const f of tris ? tris.map((t) => om.view.tFace[t]) : m.faceIds()) {
		if (seen.has(f)) continue;
		seen.add(f);
		pickedTris += m.fTriLen[f] || m.fLen[f] - 2;
		corners += m.fLen[f];
	}
	const outTris = om.view.count - pickedTris + 2 * corners * 4 ** (L - 1);
	if (outTris * 9 > MAX_SNAPSHOT) return { error: tooLargeMessage(outTris * 9, 'smooth subdivide') };
	const faces = tris ? [...isolateTriangles(om, tris)] : [...m.faceIds()];
	const { faces: made } = catmullClark(m, L, faces);
	for (const f of made) newGroup(om, f);
	om.view = buildView(om.mesh);
	const fresh = new Set(made);
	/** @type {number[]} */
	const newTris = [];
	for (let t = 0; t < om.view.count; t++) if (fresh.has(om.view.tFace[t])) newTris.push(t);
	return { newTris, created: made, count: om.view.count };
}
