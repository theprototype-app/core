// @ts-check
// Roadmap 99 K8 (lane 99-newops): BISECT on the op mesh — the kernel's plane cut (meshKernel/bisect.js) plus the
// editor's facts: a split face keeps its stored face for the half that keeps its ID and the other half becomes a
// stored face of its own (authored), a fill is authored too, and the view is rebuilt in order-key order. The pick
// is isolated first (a stored face only partly picked is split into its triangles), so the cut stays inside it;
// an unpicked neighbour on a split edge gains the crossing as a corner (no T-junction). Pure (no three.js, no
// stores).

import { isolateTriangles, newGroup, buildView } from './opMesh.js';
import { bisect } from '../meshKernel/bisect.js';
import { pos, keyOfPos } from './rebuild.js';

/** @typedef {import('./opMesh.js').OpMesh} OpMesh */

/**
 * @param {OpMesh} om @param {number[] | null} tris the picked output triangles (null = the whole mesh)
 * @param {{ point: ArrayLike<number>, normal: ArrayLike<number> }} plane in the mesh's own (local) space
 * @param {{ clear?: 'inner' | 'outer' | null, fill?: boolean }} [options]
 * @returns {{ cutKeys: string[], crossings: number, removed: number, filled: number, count: number } | { error: string }}
 */
export function bisectRegion(om, tris, plane, options = {}) {
	const m = om.mesh;
	if (!(Math.hypot(plane.normal[0], plane.normal[1], plane.normal[2]) > 1e-12)) return { error: 'Bisect: the plane has no direction' };
	const faces = tris ? [...isolateTriangles(om, tris)] : null;
	// the editor's weld cell is 1e-4: a vertex closer than a tenth of that to the plane counts as on it
	const r = bisect(m, plane, { faces, clear: options.clear ?? null, fill: !!options.fill, eps: 1e-5 });
	if (!r.cutVertices.length && !r.cutEdges.length && !r.removed.length)
		return { error: 'Bisect: the plane does not cross the ' + (tris ? 'selection' : 'mesh') };
	if (r.removed.length && !m.faceIds().length) return { error: 'Bisect: that would clear every face of the mesh' };
	for (const f of r.newFaces) if (m.hasFace(f)) newGroup(om, f);
	for (const f of r.filled) newGroup(om, f);
	om.view = buildView(m);
	const cutKeys = r.cutEdges.map((e) => {
		const a = keyOfPos(pos(om, m.eVert[e * 2]));
		const b = keyOfPos(pos(om, m.eVert[e * 2 + 1]));
		return a < b ? a + '|' + b : b + '|' + a;
	});
	return { cutKeys, crossings: r.cutVertices.length, removed: r.removed.length, filled: r.filled.length, count: om.view.count };
}
